// Package sip implements telephony (ADR-0046): the workspace's SIP provider account as a LiveKit
// SIPOutboundTrunk, outbound calls that put a phone line into a voice room's LiveKit room, the
// call journal, and the call states from LiveKit webhooks.
package sip

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/redis/rueidis"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/files"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/plans"
	"github.com/calaba/calaba/server/internal/redisx"
	"github.com/calaba/calaba/server/internal/rtc"
	"github.com/calaba/calaba/server/internal/sealbox"
	"github.com/calaba/calaba/server/internal/voice"
)

// Limits and timings (ADR-0046).
const (
	CallsPerHour   = 20 // per workspace
	TestsPerHour   = 5  // connection tests per workspace
	RingingTimeout = 45 * time.Second
	MaxCallTime    = 2 * time.Hour
	testRinging    = 15 * time.Second
	testMaxCall    = 5 * time.Second
	// testDeadline bounds the whole connection test request (the client waits up to 45 s).
	testDeadline = testRinging + 10*time.Second
	journalPage  = 100
)

// Error codes of the telephony API (common.proto).
var (
	errDisabled = httpx.Coded(http.StatusConflict, v1.ErrorCode_ERROR_CODE_SIP_DISABLED, "telephony is off in this workspace")
	errActive   = httpx.Coded(http.StatusConflict, v1.ErrorCode_ERROR_CODE_SIP_CALL_ACTIVE, "the room already has a phone call")
	errNotInVC  = httpx.Conflict("join the room's call first")
)

func numberNotAllowed() *httpx.Error {
	e := httpx.Coded(http.StatusUnprocessableEntity, v1.ErrorCode_ERROR_CODE_SIP_NUMBER_NOT_ALLOWED, "this number may not be called from the workspace")
	e.Field = "number"
	return e
}

// Options tune the service (tests); the zero value is production.
type Options struct {
	// AllowAddr: which provider addresses are acceptable (nil = public addresses only, the
	// link preview policy).
	AllowAddr func(netip.Addr) bool
	// Resolver: DNS for provider host names (nil = net.DefaultResolver).
	Resolver Resolver
	// RingingTimeout / MaxCallTime override the call limits (0 = the constants).
	RingingTimeout, MaxCallTime time.Duration
	// SweepInterval: how often lost calls are looked for (0 = 30 s).
	SweepInterval time.Duration
	// InboundTick: how often inbound deadlines are looked at (0 = 5 s).
	InboundTick time.Duration
}

// Service is telephony.
type Service struct {
	db     *db.DB
	redis  rueidis.Client
	voice  voice.Store
	lk     rtc.LiveKit // nil = LiveKit not configured
	sip    rtc.SIP     // nil = LiveKit not configured
	events events.Publisher
	plans  *plans.Service
	box    *sealbox.Box
	regBox *sealbox.Box   // the registration's passwords (ADR-0121), another purpose than box
	files  *files.Service // voice menu prompts (ADR-0117); nil = prompts answer 503
	opts   Options
	// CallLimit / TestLimit: per workspace (CallsPerHour, TestsPerHour); InboundLimit: inbound
	// calls per workspace (InboundPerHour).
	CallLimit, TestLimit, InboundLimit *redisx.RateLimiter
	// RegLimit: mode / registration credential changes per workspace (RegChangesPerHour).
	RegLimit *redisx.RateLimiter
	// Inbound calls (ADR-0117 step 2): the IVR worker and the token config (SetInbound).
	agent rtc.IVRAgent
	inCfg InboundConfig
	// The registration agent (ADR-0121, SetRegistrar) and its bookkeeping on this replica.
	reg       Registrar
	regLast   regState
	regGone   time.Time // when the sweep first saw no agent (zero = connected)
	regWarned bool
	// Presence announces a user's presence after on_call changed (the gateway).
	Presence func(ctx context.Context, u uuid.UUID)
}

// New wires the service. lk and s may be nil (no LiveKit): settings still work, calls and the
// connection test answer SIP_DISABLED.
func New(d *db.DB, r rueidis.Client, lk rtc.LiveKit, s rtc.SIP, pub events.Publisher, pl *plans.Service, secret []byte, o Options) *Service {
	if o.AllowAddr == nil {
		o.AllowAddr = publicAddr
	}
	if o.Resolver == nil {
		o.Resolver = net.DefaultResolver
	}
	if o.RingingTimeout <= 0 {
		o.RingingTimeout = RingingTimeout
	}
	if o.MaxCallTime <= 0 {
		o.MaxCallTime = MaxCallTime
	}
	if o.SweepInterval <= 0 {
		o.SweepInterval = 30 * time.Second
	}
	return &Service{
		db: d, redis: r, voice: voice.Store{C: r}, lk: lk, sip: s, events: pub, plans: pl,
		box: sealbox.New("calaba/sip-password/v1", secret), regBox: sealbox.New(regPurpose, secret), opts: o,
		CallLimit:    redisx.NewRateLimiter(r, "rl:sip-call:", CallsPerHour, float64(CallsPerHour)/60),
		TestLimit:    redisx.NewRateLimiter(r, "rl:sip-test:", TestsPerHour, float64(TestsPerHour)/60),
		InboundLimit: redisx.NewRateLimiter(r, "rl:sip-in:", InboundPerHour, float64(InboundPerHour)/60),
		RegLimit:     redisx.NewRateLimiter(r, "rl:sip-reg:", RegChangesPerHour, float64(RegChangesPerHour)/60),
	}
}

// publicAddr is unfurl.PublicAddr without the import cycle risk: loopback, private, link-local,
// multicast and unspecified addresses are refused.
func publicAddr(a netip.Addr) bool {
	a = a.Unmap()
	return a.IsValid() && !a.IsLoopback() && !a.IsPrivate() && !a.IsLinkLocalUnicast() && !a.IsLinkLocalMulticast() &&
		!a.IsInterfaceLocalMulticast() && !a.IsMulticast() && !a.IsUnspecified() &&
		!netip.MustParsePrefix("100.64.0.0/10").Contains(a) && !netip.MustParsePrefix("0.0.0.0/8").Contains(a)
}

// SetFiles gives the service the file store for voice menu prompts (ADR-0117).
func (s *Service) SetFiles(f *files.Service) { s.files = f }

// Routes registers the telephony routes.
func (s *Service) Routes(mux httpx.Router, wrap func(http.Handler) http.Handler) {
	mux.Handle("GET /api/workspaces/{id}/sip", wrap(httpx.HandlerFunc(s.getSettings)))
	mux.Handle("PUT /api/workspaces/{id}/sip", wrap(httpx.HandlerFunc(s.putSettings)))
	mux.Handle("POST /api/workspaces/{id}/sip/test", wrap(httpx.HandlerFunc(s.test)))
	mux.Handle("GET /api/workspaces/{id}/calls", wrap(httpx.HandlerFunc(s.journal)))
	mux.Handle("POST /api/rooms/{id}/calls", wrap(httpx.HandlerFunc(s.place)))
	mux.Handle("DELETE /api/rooms/{id}/calls/{cid}", wrap(httpx.HandlerFunc(s.hangup)))
	s.pbxRoutes(mux, wrap)
	s.inboundRoutes(mux, wrap)
}

func uid(r *http.Request) uuid.UUID { return auth.MustFromContext(r.Context()).UserID }

// planAllows refuses telephony outside its plans (Business and on-prem; owner, 02.10, ADR-0046):
// 409 PLAN_LIMIT. Reading the settings and the journal, turning telephony off and hanging up stay
// open, so a downgraded workspace keeps its trunk visible and live calls are not cut.
func (s *Service) planAllows(ctx context.Context, wsID uuid.UUID) error {
	if s.plans == nil {
		return nil
	}
	l, err := s.plans.Effective(ctx, wsID)
	if err != nil {
		return err
	}
	if l.TelephonyDisabled {
		return plans.FeatureError("telephony")
	}
	return nil
}

// manage resolves the workspace of the path for a MANAGE_INTEGRATIONS member (ADR-0048; 404 for
// non-members): telephony settings and the connection test.
func manage(r *http.Request) (uuid.UUID, error) {
	return workspaceWith(r, perm.ManageIntegrations, "MANAGE_INTEGRATIONS")
}

// workspaceWith resolves the workspace of the path for a member holding bit (never a guest).
func workspaceWith(r *http.Request, bit perm.Bits, name string) (uuid.UUID, error) {
	wsID, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return uuid.Nil, err
	}
	bits, role, err := perm.FromContext(r.Context()).Workspace(r.Context(), wsID, uid(r))
	if errors.Is(err, perm.ErrNotMember) {
		return uuid.Nil, httpx.NotFound("workspace")
	}
	if err != nil {
		return uuid.Nil, err
	}
	if role == perm.RoleGuest || !bits.Has(bit) {
		return uuid.Nil, httpx.Forbidden(name + " required")
	}
	return wsID, nil
}

func (s *Service) account(ctx context.Context, q *sqlc.Queries, wsID uuid.UUID) (sqlc.SipAccount, bool, error) {
	a, err := q.GetSipAccount(ctx, wsID)
	if db.IsNotFound(err) {
		return sqlc.SipAccount{WorkspaceID: wsID, Transport: "udp", Port: defaultPort, AllowedPrefixes: []string{}}, false, nil
	}
	return a, err == nil, err
}

var transportToDB = map[v1.SipTransport]string{
	v1.SipTransport_SIP_TRANSPORT_UNSPECIFIED: "udp",
	v1.SipTransport_SIP_TRANSPORT_UDP:         "udp",
	v1.SipTransport_SIP_TRANSPORT_TCP:         "tcp",
	v1.SipTransport_SIP_TRANSPORT_TLS:         "tls",
}

var transportFromDB = map[string]v1.SipTransport{
	"udp": v1.SipTransport_SIP_TRANSPORT_UDP,
	"tcp": v1.SipTransport_SIP_TRANSPORT_TCP,
	"tls": v1.SipTransport_SIP_TRANSPORT_TLS,
}

var transportToLK = map[string]string{"udp": rtc.SIPTransportUDP, "tcp": rtc.SIPTransportTCP, "tls": rtc.SIPTransportTLS}

func settingsPB(a sqlc.SipAccount, saved bool) *v1.SipSettings {
	out := &v1.SipSettings{
		Enabled: a.Enabled, Provider: a.Provider, Host: a.Host, Transport: transportFromDB[a.Transport],
		Username: a.Username, AuthUsername: a.AuthUsername, Port: uint32(max(a.Port, 0)), HasPassword: len(a.PasswordEnc) > 0, CallerId: a.CallerID,
		OutboundPrefix: a.OutboundPrefix, AllowedPrefixes: a.AllowedPrefixes, LastError: a.LastError,
		TrunkSaved: a.TrunkID != "",
	}
	if out.AllowedPrefixes == nil {
		out.AllowedPrefixes = []string{}
	}
	if saved {
		out.UpdatedAt = timestamppb.New(a.UpdatedAt)
		if a.UpdatedBy != nil {
			out.UpdatedBy = a.UpdatedBy.String()
		}
	}
	return out
}

func (s *Service) getSettings(w http.ResponseWriter, r *http.Request) error {
	wsID, err := manage(r)
	if err != nil {
		return err
	}
	a, saved, err := s.account(r.Context(), s.db.Q, wsID)
	if err != nil {
		return err
	}
	out := settingsPB(a, saved || a.LastError != "")
	out.InboundAvailable = s.inboundReady()
	ex, err := loadExchange(r.Context(), s.db.Q, wsID)
	if err != nil {
		return err
	}
	fillInbound(out, a, ex)
	s.fillRegistration(r.Context(), out, a)
	httpx.Write(w, http.StatusOK, &v1.GetSipSettingsResponse{Settings: out})
	return nil
}

// input is a validated PUT body.
type input struct {
	enabled                             bool
	provider, host, transport, username string
	authUsername, callerID, prefix      string
	port                                int32
	allowed                             []string
	password                            *string
}

func (s *Service) validate(ctx context.Context, req *v1.PutSipSettingsRequest) (input, error) {
	in := input{enabled: req.GetEnabled(), password: req.Password}
	var ok bool
	if in.provider, ok = cleanText(req.GetProvider(), 64); !ok {
		return in, httpx.Validation("provider", "provider must be up to 64 characters")
	}
	if in.transport, ok = transportToDB[req.GetTransport()]; !ok {
		return in, httpx.Validation("transport", "transport must be UDP, TCP or TLS")
	}
	if in.username = req.GetUsername(); !usernameOK(in.username) {
		return in, httpx.Validation("username", "username must be up to 128 printable characters without quotes")
	}
	if in.authUsername = req.GetAuthUsername(); !usernameOK(in.authUsername) {
		return in, httpx.Validation("authUsername", "auth username must be up to 128 printable characters without quotes")
	}
	if req.GetPort() > 65535 {
		return in, httpx.Validation("port", "port must be 1 to 65535")
	}
	in.port = int32(req.GetPort()) //nolint:gosec // ≤ 65535, checked above
	if in.password != nil && !passwordOK(*in.password) {
		return in, httpx.Validation("password", "password must be up to 256 bytes without control characters")
	}
	if h := req.GetHost(); h != "" || in.enabled {
		host, err := ParseHost(ctx, s.opts.Resolver, s.opts.AllowAddr, h, in.transport)
		if err != nil {
			return in, httpx.Validation("host", err.Error())
		}
		// The port lives in its own field; a «host:port» still works (ADR-0046).
		if h, p, err := net.SplitHostPort(host); err == nil {
			n, _ := strconv.Atoi(p)
			if in.port != 0 && int32(n) != in.port { //nolint:gosec // ParseHost checked 1..65535
				return in, httpx.Validation("port", "the port in host differs from port")
			}
			host, in.port = h, int32(n) //nolint:gosec // ParseHost checked 1..65535
		}
		in.host = host
	}
	if in.port == 0 {
		in.port = defaultPort
	}
	if c := req.GetCallerId(); c != "" || in.enabled {
		n, ok := NormalizeNumber(c)
		if !ok {
			return in, httpx.Validation("callerId", "caller ID must be a phone number in international format, e.g. +74951234567")
		}
		in.callerID = n
	}
	if in.prefix = req.GetOutboundPrefix(); !dialPrefixRe.MatchString(in.prefix) {
		return in, httpx.Validation("outboundPrefix", "dial prefix is an optional + and up to 8 digits")
	}
	if len(req.GetAllowedPrefixes()) > 50 {
		return in, httpx.Validation("allowedPrefixes", "at most 50 prefixes")
	}
	in.allowed = []string{}
	seen := map[string]bool{}
	for _, p := range req.GetAllowedPrefixes() {
		if !prefixRe.MatchString(p) {
			return in, httpx.Validation("allowedPrefixes", "each prefix is + and 1 to 15 digits, e.g. +7")
		}
		if !seen[p] {
			seen[p] = true
			in.allowed = append(in.allowed, p)
		}
	}
	return in, nil
}

// defaultPort is the SIP port of a provider host unless the settings say otherwise.
const defaultPort = 5060

// trunkAddress is the LiveKit trunk address: the host alone on the default port (LiveKit may
// then use SRV records), else host:port.
func trunkAddress(host string, port int32) string {
	if port == defaultPort || port == 0 {
		return host
	}
	return net.JoinHostPort(host, strconv.Itoa(int(port)))
}

// providerError is a LiveKit refusal of the trunk: 502 SIP_PROVIDER_ERROR, text in last_error.
type providerError struct{ msg string }

func (e *providerError) Error() string { return e.msg }

// lkError classifies a LiveKit SIP API error: a twirp answer is the provider (LiveKit) refusing
// (502 + text), anything else (network) is 503.
func lkError(err error) error {
	var e *rtc.Error
	if errors.As(err, &e) {
		msg := e.Msg
		if msg == "" {
			msg = e.Code
		}
		return &providerError{msg: clip(msg, 500)}
	}
	return httpx.Unavailable(err)
}

func clip(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n])
	}
	return s
}

func (s *Service) putSettings(w http.ResponseWriter, r *http.Request) error {
	wsID, err := manage(r)
	if err != nil {
		return err
	}
	var req v1.PutSipSettingsRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	in, err := s.validate(r.Context(), &req)
	if err != nil {
		return err
	}
	if in.enabled {
		if err := s.planAllows(r.Context(), wsID); err != nil {
			return err
		}
	}
	if in.enabled && s.sip == nil {
		return httpx.Coded(http.StatusConflict, v1.ErrorCode_ERROR_CODE_SIP_DISABLED, "LiveKit is not configured on this server")
	}
	ctx, me := r.Context(), uid(r)
	var saved, before sqlc.SipAccount
	var ws sqlc.Workspace
	disabled := false
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if err := q.LockSipAccount(ctx, wsID); err != nil {
			return err
		}
		cur, _, err := s.account(ctx, q, wsID)
		if err != nil {
			return err
		}
		before = cur
		sealed, plain := cur.PasswordEnc, ""
		switch {
		case in.password == nil && len(cur.PasswordEnc) > 0:
			p, err := s.box.Open(cur.PasswordEnc)
			if err != nil {
				return err
			}
			plain = string(p)
		case in.password != nil && *in.password == "":
			sealed = nil
		case in.password != nil:
			if sealed, err = s.box.Seal([]byte(*in.password)); err != nil {
				return err
			}
			plain = *in.password
		}
		trunkID := cur.TrunkID
		// The inbound trunk follows the caller ID (syncInbound): refuse a number another
		// workspace takes inbound calls on before any LiveKit object changes.
		if in.enabled && cur.InboundEnabled && s.inboundReady() {
			if err := numberFree(ctx, q, sqlc.SipAccount{WorkspaceID: wsID, CallerID: in.callerID}); err != nil {
				return err
			}
			if cur.InboundMode == modeRegister {
				next := cur
				next.Host, next.Username = in.host, in.username
				if err := regFree(ctx, q, next); err != nil {
					return err
				}
			}
		}
		if in.enabled {
			authUser := in.authUsername
			if authUser == "" {
				authUser = in.username
			}
			t := rtc.SIPTrunk{Name: "calab-" + wsID.String(), Metadata: wsID.String(), Address: trunkAddress(in.host, in.port),
				Transport: transportToLK[in.transport], Numbers: []string{in.callerID}, AuthUsername: authUser, AuthPassword: plain}
			var out rtc.SIPTrunk
			if trunkID != "" {
				out, err = s.sip.UpdateSIPOutboundTrunk(ctx, trunkID, t)
				if rtc.IsNotFound(err) { // gone from LiveKit (its Valkey was reset): make it again
					out, err = s.sip.CreateSIPOutboundTrunk(ctx, t)
				}
			} else {
				out, err = s.sip.CreateSIPOutboundTrunk(ctx, t)
			}
			if err != nil {
				return lkError(err)
			}
			if out.ID != "" {
				trunkID = out.ID
			}
			if trunkID == "" {
				return &providerError{msg: "LiveKit returned no trunk id"}
			}
		} else if trunkID != "" && s.sip != nil {
			if err := s.sip.DeleteSIPTrunk(ctx, trunkID); err != nil && !rtc.IsNotFound(err) {
				// Telephony is off either way (enabled = false); the next save retries.
				slog.WarnContext(ctx, "sip: delete trunk", "workspace", wsID, "trunk", trunkID, "err", err)
			} else {
				trunkID = ""
			}
		}
		saved, err = q.PutSipAccount(ctx, sqlc.PutSipAccountParams{
			WorkspaceID: wsID, Provider: in.provider, Host: in.host, Transport: in.transport, Username: in.username,
			AuthUsername: in.authUsername, Port: in.port,
			PasswordEnc: sealed, CallerID: in.callerID, OutboundPrefix: in.prefix, AllowedPrefixes: in.allowed,
			TrunkID: trunkID, Enabled: in.enabled, UpdatedBy: &me,
		})
		if err != nil {
			return err
		}
		// Inbound calls follow (ADR-0117): the trunk takes the new caller ID / host, or goes
		// with telephony switched off.
		if saved, err = s.syncInbound(ctx, q, saved); err != nil {
			return err
		}
		disabled = cur.Enabled && !in.enabled
		ws, err = q.SetWorkspaceSipEnabled(ctx, sqlc.SetWorkspaceSipEnabledParams{ID: wsID, SipEnabled: in.enabled && trunkID != ""})
		return err
	})
	var pe *providerError
	if errors.As(err, &pe) {
		if err := db.GuardExec(context.WithoutCancel(ctx), s.db, func(guarded *sqlc.Queries) error {
			return guarded.SetSipLastError(context.WithoutCancel(ctx), sqlc.SetSipLastErrorParams{WorkspaceID: wsID, LastError: pe.msg})
		}); err != nil {
			slog.WarnContext(ctx, "sip: store last_error", "workspace", wsID, "err", err)
		}
		e := httpx.Coded(http.StatusBadGateway, v1.ErrorCode_ERROR_CODE_SIP_PROVIDER_ERROR, pe.msg)
		return e
	}
	if err != nil {
		return inboundTaken(err)
	}
	slog.InfoContext(ctx, "sip: settings saved", "workspace", wsID, "by", me, "enabled", saved.Enabled, "trunk", saved.TrunkID)
	pw := pbconv.Workspace(ws)
	if err := s.plans.Fill(ctx, pw); err != nil {
		return err
	}
	s.events.Workspace(ctx, wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceUpdate{WorkspaceUpdate: &v1.WorkspaceUpdate{Workspace: pw}}})
	if disabled {
		s.hangupWorkspace(ctx, wsID)
	}
	// The registration follows the credentials, the host and the switch (ADR-0121).
	s.regChanged(ctx, before, saved)
	out := settingsPB(saved, true)
	out.InboundAvailable = s.inboundReady()
	fillInbound(out, saved, nil)
	if ex, err := loadExchange(ctx, s.db.Q, wsID); err == nil {
		fillInbound(out, saved, ex)
	}
	s.fillRegistration(ctx, out, saved)
	httpx.Write(w, http.StatusOK, &v1.PutSipSettingsResponse{Settings: out})
	return nil
}

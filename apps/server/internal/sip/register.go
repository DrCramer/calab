package sip

import (
	"context"
	"crypto/rand"
	"encoding/base32"
	"encoding/base64"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/rtc"
	"github.com/calaba/calaba/server/internal/sipregwire"
)

// Inbound calls over a registration at the provider (ADR-0121). The agent calab-sipreg
// (cmd/sipreg) registers the workspace's account at its provider and hands the INVITEs that come
// over the registration to LiveKit SIP on loopback; from there on a call is the same as in the
// direct mode (ADR-0117). This file is the API's side: the mode and its fields in PUT
// …/sip/inbound, the loopback trunk's parameters, the accounts the agent gets (passwords
// decrypted only here, at the moment they are written to the agent's socket) and the agent's
// reports.

// Inbound modes (sip_accounts.inbound_mode).
const (
	modeDirect   = "direct"
	modeRegister = "register"
)

// Registration limits and defaults (ADR-0121 §2–4).
const (
	RegChangesPerHour   = 10 // mode / credential changes per workspace and hour (each one REGISTERs at the provider)
	defaultRegExpires   = 600
	defaultRegKeepalive = 30
	minRegPassword      = 8
	// loopbackSource: LiveKit SIP sees the agent's INVITEs from here (the trunk's only address).
	loopbackSource = "127.0.0.1"
	// providerCallHeader: the agent's header with the provider's Call-ID, copied into the line's
	// attribute rtc.AttrProviderCallID by the trunk.
	providerCallHeader = "X-Calab-Provider-Call-ID"
	regPurpose         = "calaba/sip-register/v1"
)

// Registrar is the registration agent's hub (internal/sipreg.Hub).
type Registrar interface {
	Configured() bool
	Available(ctx context.Context) bool
	Changed(ctx context.Context, ws uuid.UUID) error
}

// SetRegistrar wires the registration agent (the app, when SIPREG_AGENT_TOKEN is set).
func (s *Service) SetRegistrar(r Registrar) { s.reg = r }

// registerReady: REGISTER mode can be switched on (inbound calls at all, and an agent token).
func (s *Service) registerReady() bool {
	return s.inboundReady() && s.reg != nil && s.reg.Configured()
}

var (
	metricRegistrations = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "calab_sip_registrations", Help: "SIP accounts in REGISTER mode by registration status (ADR-0121).",
	}, []string{"status"})
	metricRegFailures = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "calab_sip_registration_failures_total", Help: "Registrations that turned failed, by reason (ADR-0121).",
	}, []string{"reason"})
	metricRegInvites = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "calab_sip_register_invites_total", Help: "INVITEs over registrations handed to LiveKit SIP, by result (ADR-0121).",
	}, []string{"result"})
)

var modeToDB = map[v1.SipInboundMode]string{v1.SipInboundMode_SIP_INBOUND_MODE_DIRECT: modeDirect, v1.SipInboundMode_SIP_INBOUND_MODE_REGISTER: modeRegister}

var modeFromDB = map[string]v1.SipInboundMode{modeDirect: v1.SipInboundMode_SIP_INBOUND_MODE_DIRECT, modeRegister: v1.SipInboundMode_SIP_INBOUND_MODE_REGISTER}

var regStatusFromDB = map[string]v1.SipRegistrationStatus{
	"off":                        v1.SipRegistrationStatus_SIP_REGISTRATION_STATUS_OFF,
	"unavailable":                v1.SipRegistrationStatus_SIP_REGISTRATION_STATUS_UNAVAILABLE,
	sipregwire.StatusRegistering: v1.SipRegistrationStatus_SIP_REGISTRATION_STATUS_REGISTERING,
	sipregwire.StatusRegistered:  v1.SipRegistrationStatus_SIP_REGISTRATION_STATUS_REGISTERED,
	sipregwire.StatusFailed:      v1.SipRegistrationStatus_SIP_REGISTRATION_STATUS_FAILED,
}

// regInput is the validated registration part of PUT …/sip/inbound.
type regInput struct {
	registrar, domain, authUser string
	expires, keepalive          int32
	password                    *string // nil = keep, "" = drop
}

// parseRegInput validates SipRegistrationInput; nil = keep the saved fields.
func (s *Service) parseRegInput(ctx context.Context, cur sqlc.SipAccount, in *v1.SipRegistrationInput) (regInput, error) {
	out := regInput{registrar: cur.RegRegistrar, domain: cur.RegDomain, authUser: cur.RegAuthUsername, expires: cur.RegExpires, keepalive: cur.RegKeepaliveSec}
	if out.expires == 0 {
		out.expires, out.keepalive = defaultRegExpires, defaultRegKeepalive
	}
	if in == nil {
		return out, nil
	}
	out.registrar, out.domain = "", ""
	if r := strings.TrimSpace(in.GetRegistrar()); r != "" {
		transport := cur.Transport
		if transport == "" {
			transport = "udp"
		}
		h, err := ParseHost(ctx, s.opts.Resolver, s.opts.AllowAddr, r, transport)
		if err != nil {
			return out, httpx.Validation("registrar", "registrar: "+err.Error())
		}
		out.registrar = h
	}
	if d := strings.TrimSuffix(strings.ToLower(strings.TrimSpace(in.GetDomain())), "."); d != "" {
		if _, err := netip.ParseAddr(d); err != nil && (!hostRe.MatchString(d) || len(d) > 253 || !strings.Contains(d, ".")) {
			return out, httpx.Validation("domain", "domain is the provider's SIP domain, e.g. sip.example.com")
		}
		out.domain = d
	}
	switch e := in.GetExpiresSec(); {
	case e == 0:
		out.expires = defaultRegExpires
	case e < 60 || e > 3600:
		return out, httpx.Validation("expiresSec", "the registration interval is 60 to 3600 seconds")
	default:
		out.expires = int32(e) //nolint:gosec // ≤ 3600
	}
	switch k := in.GetKeepaliveSec(); {
	case k == 0:
		out.keepalive = 0
	case k < 15 || k > 120:
		return out, httpx.Validation("keepaliveSec", "the keepalive is off or 15 to 120 seconds")
	default:
		out.keepalive = int32(k) //nolint:gosec // ≤ 120
	}
	if out.authUser = in.GetAuthUsername(); !usernameOK(out.authUser) {
		return out, httpx.Validation("regAuthUsername", "auth username must be up to 128 printable characters without quotes")
	}
	if in.Password != nil {
		p := in.GetPassword()
		if p != "" && (!passwordOK(p) || len(p) < minRegPassword) {
			return out, httpx.Validation("regPassword", "the registration password is 8 to 256 bytes without control characters")
		}
		out.password = &p
	}
	return out, nil
}

// nextRegistration applies the mode and the registration fields of PUT …/sip/inbound to next
// (inside the save's transaction). The fields stay saved in DIRECT mode, so switching back and
// forth keeps them; the Contact token and the loopback trunk's password are made once.
func (s *Service) nextRegistration(ctx context.Context, cur sqlc.SipAccount, next *sqlc.SipAccount, mode string, modeSet bool, in *v1.SipRegistrationInput) error {
	if !modeSet {
		mode = cur.InboundMode
	}
	if mode == "" {
		mode = modeDirect
	}
	next.InboundMode = mode
	ri, err := s.parseRegInput(ctx, cur, in)
	if err != nil {
		return err
	}
	next.RegRegistrar, next.RegDomain, next.RegAuthUsername = ri.registrar, ri.domain, ri.authUser
	next.RegExpires, next.RegKeepaliveSec = ri.expires, ri.keepalive
	if ri.password != nil {
		next.RegPasswordEnc = nil
		if *ri.password != "" {
			if next.RegPasswordEnc, err = s.regBox.Seal([]byte(*ri.password)); err != nil {
				return err
			}
		}
	}
	if mode != modeRegister {
		return nil
	}
	if next.InboundEnabled {
		if !s.registerReady() {
			return errInboundOff("this server has no SIP registration agent (SIPREG_AGENT_TOKEN)")
		}
		if next.Username == "" {
			return httpx.Validation("username", "a registration needs the account's SIP login: set it in the telephony settings")
		}
		if len(next.RegPasswordEnc) == 0 && len(next.PasswordEnc) == 0 {
			return httpx.Validation("regPassword", "a registration needs a password: the account's or its own")
		}
		changed := cur.InboundMode != modeRegister || !cur.InboundEnabled || ri.password != nil ||
			ri.registrar != cur.RegRegistrar || ri.domain != cur.RegDomain || ri.authUser != cur.RegAuthUsername || ri.expires != cur.RegExpires
		if changed {
			if err := s.RegLimit.Take(ctx, cur.WorkspaceID.String()); err != nil {
				if e := httpx.AsError(err); e.Code == v1.ErrorCode_ERROR_CODE_RATE_LIMITED {
					limited := httpx.Coded(http.StatusTooManyRequests, v1.ErrorCode_ERROR_CODE_SIP_RATE_LIMITED, "too many registration changes in this workspace; try again later")
					limited.RetryAfter = e.RetryAfter
					return limited
				}
				return err
			}
		}
	}
	if next.RegContactUser == "" {
		next.RegContactUser = newContactUser()
	}
	if len(next.RegTrunkPasswordEnc) == 0 {
		if next.RegTrunkPasswordEnc, err = s.regBox.Seal([]byte(newTrunkPassword())); err != nil {
			return err
		}
	}
	return nil
}

// regDomain is the account's AOR domain: reg_domain or the host.
func regDomain(a sqlc.SipAccount) string {
	if a.RegDomain != "" {
		return a.RegDomain
	}
	return a.Host
}

// regRegistrar is where the REGISTERs go: reg_registrar or host:port.
func regRegistrar(a sqlc.SipAccount) string {
	if a.RegRegistrar != "" {
		if _, _, err := net.SplitHostPort(a.RegRegistrar); err == nil {
			return a.RegRegistrar
		}
		return net.JoinHostPort(a.RegRegistrar, strconv.Itoa(defaultPort))
	}
	port := a.Port
	if port == 0 {
		port = defaultPort
	}
	return net.JoinHostPort(a.Host, strconv.Itoa(int(port)))
}

// errRegTaken: another workspace registers the same account at its provider.
func errRegTaken() *httpx.Error {
	return httpx.Coded(http.StatusConflict, v1.ErrorCode_ERROR_CODE_SIP_REGISTRATION_TAKEN, "another workspace already registers this SIP account at the provider")
}

// regFree checks that no other workspace registers a's account.
func regFree(ctx context.Context, q *sqlc.Queries, a sqlc.SipAccount) error {
	taken, err := q.SipRegistrationTaken(ctx, sqlc.SipRegistrationTakenParams{WorkspaceID: a.WorkspaceID, Username: a.Username, Domain: regDomain(a)})
	if err != nil {
		return err
	}
	if taken {
		return errRegTaken()
	}
	return nil
}

var tokenEnc = base32.StdEncoding.WithPadding(base32.NoPadding)

// newContactUser is the opaque Contact user part: 26 base32 characters (128 bits), lower case
// (some providers lower-case the Request-URI user).
func newContactUser() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return "c" + strings.ToLower(tokenEnc.EncodeToString(b))
}

// newTrunkPassword is the loopback trunk's digest password (32 random bytes).
func newTrunkPassword() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// registerTrunk fills the loopback trunk of REGISTER mode: INVITEs only from the agent on
// 127.0.0.1, with the trunk's digest credentials.
func (s *Service) registerTrunk(a sqlc.SipAccount, t *rtc.SIPInboundTrunk) error {
	if a.RegContactUser == "" || len(a.RegTrunkPasswordEnc) == 0 {
		return httpx.Conflict("the registration is not set up; save inbound calls again")
	}
	pw, err := s.regBox.Open(a.RegTrunkPasswordEnc)
	if err != nil {
		return err
	}
	t.AllowedAddresses = []string{loopbackSource}
	t.AuthUsername, t.AuthPassword = a.RegContactUser, string(pw)
	t.HeadersToAttributes = map[string]string{providerCallHeader: rtc.AttrProviderCallID}
	return nil
}

// regChanged tells the agent about the workspace (best effort: the agent re-reads every account
// on reconnecting).
func (s *Service) regChanged(ctx context.Context, before, after sqlc.SipAccount) {
	if s.reg == nil || !s.reg.Configured() || (before.InboundMode != modeRegister && after.InboundMode != modeRegister) {
		return
	}
	if err := s.reg.Changed(ctx, after.WorkspaceID); err != nil {
		slog.WarnContext(ctx, "sip: tell the registration agent", "workspace", after.WorkspaceID, "err", err)
	}
}

// maskContact hides the Contact user part (the account's token): «sip:c…@203.0.113.7:5080».
func maskContact(c string) string {
	rest, ok := strings.CutPrefix(c, "sip:")
	if !ok {
		return ""
	}
	user, host, ok := strings.Cut(rest, "@")
	if !ok || user == "" {
		return ""
	}
	if i := strings.IndexByte(host, ';'); i >= 0 {
		host = host[:i]
	}
	return "sip:" + user[:1] + "…@" + strings.TrimSuffix(host, ">")
}

// fillRegistration adds the mode and the registration state to the settings.
func (s *Service) fillRegistration(ctx context.Context, out *v1.SipSettings, a sqlc.SipAccount) {
	out.InboundMode = modeFromDB[a.InboundMode]
	if out.InboundMode == v1.SipInboundMode_SIP_INBOUND_MODE_UNSPECIFIED {
		out.InboundMode = v1.SipInboundMode_SIP_INBOUND_MODE_DIRECT
	}
	out.RegistrationAvailable = s.registerReady()
	if a.InboundMode != modeRegister {
		return
	}
	expires := a.RegExpires
	if expires == 0 {
		expires = defaultRegExpires
	}
	r := &v1.SipRegistration{
		Registrar: a.RegRegistrar, Domain: a.RegDomain, ExpiresSec: uint32(max(expires, 0)), KeepaliveSec: uint32(max(a.RegKeepaliveSec, 0)),
		AuthUsername: a.RegAuthUsername, HasPassword: len(a.RegPasswordEnc) > 0, Status: regStatusFromDB[a.RegStatus], Error: a.RegError,
		ContactMasked: maskContact(a.RegContact),
	}
	live := a.Enabled && a.InboundEnabled && a.InboundTrunkID != ""
	switch {
	case !live:
		r.Status, r.Error, r.ContactMasked = v1.SipRegistrationStatus_SIP_REGISTRATION_STATUS_OFF, "", ""
	case s.reg == nil || !s.reg.Available(ctx):
		r.Status = v1.SipRegistrationStatus_SIP_REGISTRATION_STATUS_UNAVAILABLE
	}
	if r.Status == v1.SipRegistrationStatus_SIP_REGISTRATION_STATUS_REGISTERED {
		if a.RegRegisteredAt != nil {
			r.RegisteredAt = timestamppb.New(*a.RegRegisteredAt)
		}
		if a.RegExpiresAt != nil {
			r.ExpiresAt = timestamppb.New(*a.RegExpiresAt)
		}
	}
	out.Registration = r
}

// ---------------------------------------------------------------- the agent's accounts

// RegAccounts implements sipreg.Source: every live account in REGISTER mode.
func (s *Service) RegAccounts(ctx context.Context) ([]sipregwire.Account, error) {
	if !s.registerReady() {
		return nil, nil
	}
	rows, err := s.db.Q.ListSipRegisterAccounts(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]sipregwire.Account, 0, len(rows))
	for _, a := range rows {
		acc, err := s.regAccount(ctx, a)
		if err != nil {
			slog.WarnContext(ctx, "sip: registration account", "workspace", a.WorkspaceID, "err", err)
			continue
		}
		out = append(out, acc)
	}
	return out, nil
}

// RegAccount implements sipreg.Source.
func (s *Service) RegAccount(ctx context.Context, ws uuid.UUID) (sipregwire.Account, bool, error) {
	if !s.registerReady() {
		return sipregwire.Account{}, false, nil
	}
	a, err := s.db.Q.GetSipAccount(ctx, ws)
	if db.IsNotFound(err) {
		return sipregwire.Account{}, false, nil
	}
	if err != nil {
		return sipregwire.Account{}, false, err
	}
	if a.InboundMode != modeRegister || !a.Enabled || !a.InboundEnabled || a.InboundTrunkID == "" {
		return sipregwire.Account{}, false, nil
	}
	acc, err := s.regAccount(ctx, a)
	return acc, err == nil, err
}

// regAccount decrypts the passwords of a for the agent's socket (nothing else keeps them).
func (s *Service) regAccount(ctx context.Context, a sqlc.SipAccount) (sipregwire.Account, error) {
	authUser, sealed, box := a.RegAuthUsername, a.RegPasswordEnc, s.regBox
	if len(sealed) == 0 {
		sealed, box = a.PasswordEnc, s.box
		if authUser == "" {
			authUser = a.AuthUsername
		}
	}
	if authUser == "" {
		authUser = a.Username
	}
	var pw []byte
	if len(sealed) > 0 {
		var err error
		if pw, err = box.Open(sealed); err != nil {
			return sipregwire.Account{}, err
		}
	}
	tpw, err := s.regBox.Open(a.RegTrunkPasswordEnc)
	if err != nil {
		return sipregwire.Account{}, err
	}
	registrar := regRegistrar(a)
	allowed := []string{}
	if host, _, err := net.SplitHostPort(registrar); err == nil {
		addrs, _ := s.inboundAddresses(ctx, host, nil)
		allowed = append(allowed, addrs...)
	}
	if addrs, err := s.inboundAddresses(ctx, a.Host, a.InboundAllowedCidrs); err == nil {
		for _, v := range addrs {
			if !contains(allowed, v) {
				allowed = append(allowed, v)
			}
		}
	}
	return sipregwire.Account{
		WS: a.WorkspaceID.String(), ContactUser: a.RegContactUser, Registrar: registrar, Domain: regDomain(a), Transport: a.Transport,
		Username: a.Username, AuthUser: authUser, Password: string(pw), Expires: int(a.RegExpires), Keepalive: int(a.RegKeepaliveSec),
		AllowedSources: allowed, Number: a.CallerID, TrunkUser: a.RegContactUser, TrunkPassword: string(tpw),
	}, nil
}

func contains(xs []string, v string) bool {
	for _, x := range xs {
		if x == v {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------- the agent's reports

// cleanReport keeps an agent's text short and printable (it lands in the settings and logs).
func cleanReport(v string, n int) string {
	v = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, v)
	return clip(v, n)
}

// regState remembers the last reported status per workspace on this replica (the WARN on
// registered → failed and the failure counter fire once per transition).
type regState struct {
	mu   sync.Mutex
	last map[uuid.UUID]string
}

// RegistrarEvent applies an event of the registration agent (sipreg.Hub.OnEvent).
func (s *Service) RegistrarEvent(ctx context.Context, ev sipregwire.Event) {
	ws, err := uuid.Parse(ev.WS)
	if err != nil {
		return
	}
	switch ev.Op {
	case sipregwire.OpRegistration:
		s.regReport(ctx, ws, ev)
	case sipregwire.OpInvite:
		metricRegInvites.WithLabelValues("handed").Inc()
		slog.InfoContext(ctx, "sip: inbound INVITE over the registration", "workspace", ws, "provider_call_id", clip(ev.ProviderCallID, 200),
			"leg_b_call_id", clip(ev.LegBCallID, 200), "source", clip(ev.Source, 64))
	case sipregwire.OpInviteResult:
		result := "other"
		switch {
		case ev.Code >= 200 && ev.Code < 300:
			result = "answered"
		case ev.Code == 487:
			result = "cancelled"
		case ev.Code >= 400 && ev.Code < 700:
			result = strconv.Itoa(ev.Code)
		}
		metricRegInvites.WithLabelValues(result).Inc()
	case sipregwire.OpBye:
		slog.InfoContext(ctx, "sip: call over the registration ended", "workspace", ws, "provider_call_id", clip(ev.ProviderCallID, 200), "by", clip(ev.By, 16))
	}
}

func (s *Service) regReport(ctx context.Context, ws uuid.UUID, ev sipregwire.Event) {
	status := ev.Status
	switch status {
	case sipregwire.StatusRegistering, sipregwire.StatusRegistered, sipregwire.StatusFailed:
	default:
		return
	}
	errText, contact := cleanReport(ev.Error, 200), cleanReport(ev.Contact, 300)
	var exp *time.Time
	if status == sipregwire.StatusRegistered && ev.ExpiresAt > 0 {
		t := time.Unix(ev.ExpiresAt, 0)
		exp = &t
	} else {
		contact = ""
	}
	s.regLast.mu.Lock()
	if s.regLast.last == nil {
		s.regLast.last = map[uuid.UUID]string{}
	}
	prev := s.regLast.last[ws]
	s.regLast.last[ws] = status
	s.regLast.mu.Unlock()
	if status == sipregwire.StatusFailed && prev != sipregwire.StatusFailed {
		reason := errText
		if i := strings.IndexAny(reason, " :"); i > 0 {
			reason = reason[:i]
		}
		if reason == "" {
			reason = "unknown"
		}
		metricRegFailures.WithLabelValues(clip(reason, 16)).Inc()
		if prev == sipregwire.StatusRegistered {
			slog.WarnContext(ctx, "sip: registration lost", "workspace", ws, "reg_error", errText)
		}
	}
	if err := db.GuardExec(ctx, s.db, func(q *sqlc.Queries) error {
		_, err := q.SetSipRegStatus(ctx, sqlc.SetSipRegStatusParams{WorkspaceID: ws, RegStatus: status, RegError: errText, RegExpiresAt: exp, RegContact: contact})
		return err
	}); err != nil {
		slog.WarnContext(ctx, "sip: store registration status", "workspace", ws, "err", err)
	}
}

// sweepRegistrations (Sweep): without a connected agent every REGISTER account shows
// «unavailable» (WARN after 2 min); the gauge follows the table.
func (s *Service) sweepRegistrations(ctx context.Context, now time.Time) {
	if s.reg == nil || !s.reg.Configured() {
		return
	}
	if !s.reg.Available(ctx) {
		if s.regGone.IsZero() {
			s.regGone = now
		}
		if err := db.GuardExec(ctx, s.db, func(q *sqlc.Queries) error { return q.SetSipRegUnavailable(ctx) }); err != nil {
			slog.WarnContext(ctx, "sip: mark registrations unavailable", "err", err)
		}
		if now.Sub(s.regGone) >= 2*time.Minute && !s.regWarned {
			s.regWarned = true
			slog.WarnContext(ctx, "sip: the registration agent has been away for 2 min")
		}
	} else {
		s.regGone, s.regWarned = time.Time{}, false
	}
	rows, err := s.db.Q.CountSipRegStatus(ctx)
	if err != nil {
		return
	}
	metricRegistrations.Reset()
	for _, r := range rows {
		metricRegistrations.WithLabelValues(r.RegStatus).Set(float64(r.N))
	}
}

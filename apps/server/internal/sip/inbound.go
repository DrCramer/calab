package sip

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/netip"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/redis/rueidis"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/blob"
	"github.com/calaba/calaba/server/internal/calls"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/ivrwire"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/redisx"
	"github.com/calaba/calaba/server/internal/rtc"
	"github.com/calaba/calaba/server/internal/sipregwire"
)

// Inbound calls on the workspace's number (ADR-0117 §4), step 2. LiveKit SIP takes the
// provider's INVITE for caller_id on the workspace's inbound trunk and its dispatch rule puts
// the line into a LiveKit room of its own («sipin_<workspace>_…»); the participant_joined
// webhook of the line starts the call here: a journal row (direction in), the state in Valkey,
// the IVR worker joins the room, and the entry point is followed by the state machine
// (machine.go). Every later event — the worker's «played» / a key, a deadline of the 5 s tick,
// accept / decline / hang up, the line or the member leaving — runs one transition under the
// call's lock and carries out its Effects. Only in workspaces whose admin switched inbound
// calls on, on a server with LiveKit and the IVR worker token (inboundReady); the provider's
// INVITE comes either straight from the provider (mode direct) or from the registration agent
// (mode register, ADR-0121, register.go).
//
// Valkey keys (inside the namespace):
//
//	sipin:<call id>       JSON inRec, TTL 3 h
//	sipin:due             zset call id → deadline (unix ms): the tick's one ZRANGEBYSCORE
//	sipin:user:<user id>  the call that rings / was answered by the user (busy), TTL 3 h
//	sipin:lock:<call id>  the transition lock (5 s)

// Inbound limits (ADR-0117 §4).
const (
	InboundPerHour  = 60 // calls per workspace and hour
	MaxInboundLive  = 5  // live inbound calls per workspace
	inboundTTL      = 3 * time.Hour
	answerGrace     = 30 * time.Second // the member who answered may reconnect
	inboundTick     = 5 * time.Second
	maxCIDRs        = 20
	inboundRoomSize = 4 // the line, the worker, the member (and a reconnect)
)

// Reasons of inbound calls beyond machine.go.
const (
	reasonAgent    = "agent_unavailable"
	reasonBusyLim  = "busy_limit"
	reasonPlan     = "plan"
	reasonUnwanted = "disabled"
)

// InboundConfig is what inbound calls need besides the exchange: the LiveKit URL clients get
// and the key that signs room tokens (the worker's and the member's), and provider addresses
// every inbound trunk accepts (env SIP_INBOUND_ALLOWED_ADDRESSES).
type InboundConfig struct {
	PublicURL, APIKey, Secret string
	Allowed                   []string
}

// SetInbound wires the IVR worker and the token config (the app, when LiveKit is configured).
func (s *Service) SetInbound(agent rtc.IVRAgent, cfg InboundConfig) {
	s.agent, s.inCfg = agent, cfg
}

func (s *Service) inboundRoutes(mux httpx.Router, wrap func(http.Handler) http.Handler) {
	mux.Handle("PUT /api/workspaces/{id}/sip/inbound", wrap(httpx.HandlerFunc(s.putInbound)))
	mux.Handle("POST /api/sip/inbound/{cid}/accept", wrap(httpx.HandlerFunc(s.acceptInbound)))
	mux.Handle("POST /api/sip/inbound/{cid}/join", wrap(httpx.HandlerFunc(s.joinInbound)))
	mux.Handle("POST /api/sip/inbound/{cid}/decline", wrap(httpx.HandlerFunc(s.declineInbound)))
	mux.Handle("DELETE /api/sip/inbound/{cid}", wrap(httpx.HandlerFunc(s.hangupInbound)))
}

// inboundReady: the server can take inbound calls at all (LiveKit, a worker token).
func (s *Service) inboundReady() bool {
	return s.sip != nil && s.lk != nil && s.agent != nil && s.inCfg.Secret != ""
}

// ---------------------------------------------------------------- settings

// fillInbound adds the inbound part of the settings (the entry point resolved against ex).
func fillInbound(out *v1.SipSettings, a sqlc.SipAccount, ex *exchange) {
	out.InboundEnabled = a.InboundEnabled
	out.InboundAllowedCidrs = a.InboundAllowedCidrs
	if out.InboundAllowedCidrs == nil {
		out.InboundAllowedCidrs = []string{}
	}
	out.InboundSaved = a.InboundTrunkID != "" && a.InboundRuleID != ""
	if ex != nil {
		out.InboundTarget = ex.targetPB(a.InboundKind, a.InboundMenuID, a.InboundExtensionID, a.InboundGroupID)
	} else {
		out.InboundTarget = &v1.SipRouteTarget{Kind: routeKindFromDB[a.InboundKind]}
	}
}

// parseCIDRs validates the provider addresses of PUT …/inbound: public IPs or ranges no wider
// than /16 (IPv4) or /32 (IPv6) — «0.0.0.0/0» would let every scanner's INVITE in.
func parseCIDRs(raw []string, allow func(netip.Addr) bool) ([]string, error) {
	if len(raw) > maxCIDRs {
		return nil, httpx.Validation("allowedCidrs", fmt.Sprintf("at most %d addresses", maxCIDRs))
	}
	out := []string{}
	for _, r := range raw {
		r = strings.TrimSpace(r)
		var p netip.Prefix
		if a, err := netip.ParseAddr(r); err == nil {
			p = netip.PrefixFrom(a.Unmap(), a.Unmap().BitLen())
		} else if p, err = netip.ParsePrefix(r); err != nil {
			return nil, httpx.Validation("allowedCidrs", "each address is an IP address or a CIDR range, e.g. 203.0.113.0/24")
		}
		// An IPv4-mapped range (::ffff:a.b.c.d/n) is the IPv4 range /n-96: «::ffff:128.0.0.0/97»
		// would otherwise pass as a narrow IPv6 range while covering half of the IPv4 internet.
		if p.Addr().Is4In6() {
			if p.Bits() < 96 {
				return nil, httpx.Validation("allowedCidrs", "addresses must be public and ranges no wider than /16 (IPv6: /32)")
			}
			p = netip.PrefixFrom(p.Addr().Unmap(), p.Bits()-96)
		}
		p = p.Masked()
		minBits := 16
		if p.Addr().Is6() {
			minBits = 32
		}
		if p.Bits() < minBits || !allow(p.Addr()) {
			return nil, httpx.Validation("allowedCidrs", "addresses must be public and ranges no wider than /16 (IPv6: /32)")
		}
		if s := p.String(); !slices.Contains(out, s) {
			out = append(out, s)
		}
	}
	return out, nil
}

// inboundNumbers: the trunk's numbers. Providers put the called number into the INVITE with or
// without «+» (and LiveKit SIP v1.14 compares it as sent — assumption, not checked against a
// provider), so both forms of caller_id are listed.
func inboundNumbers(callerID string) []string {
	if bare, ok := strings.CutPrefix(callerID, "+"); ok {
		return []string{callerID, bare}
	}
	return []string{callerID}
}

// inboundAddresses: the provider host's A/AAAA records now (re-resolved on every save), the
// server's SIP_INBOUND_ALLOWED_ADDRESSES and the workspace's ranges.
func (s *Service) inboundAddresses(ctx context.Context, host string, cidrs []string) ([]string, error) {
	out := []string{}
	add := func(v string) {
		if v != "" && !slices.Contains(out, v) {
			out = append(out, v)
		}
	}
	if a, err := netip.ParseAddr(host); err == nil {
		add(a.Unmap().String())
	} else if host != "" {
		lctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		addrs, err := s.opts.Resolver.LookupNetIP(lctx, "ip", host)
		cancel()
		if err != nil {
			slog.InfoContext(ctx, "sip: resolve provider host for inbound", "host", host, "err", err)
		}
		for _, a := range addrs {
			if s.opts.AllowAddr(a) {
				add(a.Unmap().String())
			}
		}
	}
	for _, a := range s.inCfg.Allowed {
		add(strings.TrimSpace(a))
	}
	for _, c := range cidrs {
		add(c)
	}
	if len(out) == 0 {
		return nil, httpx.Validation("allowedCidrs", "the provider host has no public address: add the provider's addresses")
	}
	return out, nil
}

// dropInboundLK deletes the workspace's inbound dispatch rule and trunk in LiveKit (gone ones
// are fine).
func (s *Service) dropInboundLK(ctx context.Context, a sqlc.SipAccount) error {
	if s.sip == nil {
		return nil
	}
	if a.InboundRuleID != "" {
		if err := s.sip.DeleteSIPDispatchRule(ctx, a.InboundRuleID); err != nil && !rtc.IsNotFound(err) {
			return lkError(err)
		}
	}
	if a.InboundTrunkID != "" {
		if err := s.sip.DeleteSIPTrunk(ctx, a.InboundTrunkID); err != nil && !rtc.IsNotFound(err) {
			return lkError(err)
		}
	}
	return nil
}

// errNumberTaken: the caller ID already takes inbound calls in another workspace.
func errNumberTaken() *httpx.Error {
	return httpx.Conflict("this number already takes inbound calls in another workspace")
}

// numberFree checks before the LiveKit objects are touched that no other workspace takes
// inbound calls on a's caller ID.
func numberFree(ctx context.Context, q *sqlc.Queries, a sqlc.SipAccount) error {
	taken, err := q.SipInboundNumberTaken(ctx, sqlc.SipInboundNumberTakenParams{CallerID: a.CallerID, WorkspaceID: a.WorkspaceID})
	if err != nil {
		return err
	}
	if taken {
		return errNumberTaken()
	}
	return nil
}

// inboundTaken maps the unique indexes of inbound caller IDs and of registrations (a concurrent
// save won) to 409.
func inboundTaken(err error) error {
	switch db.UniqueViolation(err) {
	case "sip_accounts_inbound_caller_idx":
		return errNumberTaken()
	case "sip_accounts_reg_account_idx":
		return errRegTaken()
	}
	return err
}

// makeInboundLK creates the inbound trunk and its dispatch rule from the account (in the
// transaction q). A caller ID takes inbound calls in one workspace of the server only: LiveKit
// matches an INVITE by the called number, so another workspace's number would take its calls.
func (s *Service) makeInboundLK(ctx context.Context, q *sqlc.Queries, a sqlc.SipAccount) (trunkID, ruleID string, err error) {
	if err := numberFree(ctx, q, a); err != nil {
		return "", "", err
	}
	ws := a.WorkspaceID.String()
	trunk := rtc.SIPInboundTrunk{Name: "calab-in-" + ws, Metadata: ws, Numbers: inboundNumbers(a.CallerID),
		MaxCallDuration: fmt.Sprintf("%ds", int64(s.opts.MaxCallTime/time.Second))}
	if a.InboundMode == modeRegister {
		// The agent brings the INVITEs over loopback, authenticated with the trunk's own digest.
		if err := regFree(ctx, q, a); err != nil {
			return "", "", err
		}
		if err := s.registerTrunk(a, &trunk); err != nil {
			return "", "", err
		}
	} else {
		addrs, err := s.inboundAddresses(ctx, a.Host, a.InboundAllowedCidrs)
		if err != nil {
			return "", "", err
		}
		trunk.AllowedAddresses = addrs
	}
	t, err := s.sip.CreateSIPInboundTrunk(ctx, trunk)
	if err != nil {
		return "", "", lkError(err)
	}
	if t.ID == "" {
		return "", "", &providerError{msg: "LiveKit returned no inbound trunk id"}
	}
	rule, err := s.sip.CreateSIPDispatchRule(ctx, rtc.SIPDispatchRule{Name: "calab-in-" + ws, Metadata: ws, TrunkIDs: []string{t.ID},
		RoomPrefix: rtc.InboundRoomPrefix(a.WorkspaceID), EmptyTimeout: 30, MaxParticipants: inboundRoomSize})
	if err == nil && rule == "" {
		err = &providerError{msg: "LiveKit returned no dispatch rule id"}
	} else if err != nil {
		err = lkError(err)
	}
	if err != nil {
		if derr := s.sip.DeleteSIPTrunk(ctx, t.ID); derr != nil && !rtc.IsNotFound(derr) {
			slog.WarnContext(ctx, "sip: delete inbound trunk after a refused rule", "trunk", t.ID, "err", derr)
		}
		return "", "", err
	}
	return t.ID, rule, nil
}

// syncInbound re-makes the LiveKit objects of a saved account in the transaction q (telephony
// saved: the caller ID or the host may have changed). Off: they are deleted.
func (s *Service) syncInbound(ctx context.Context, q *sqlc.Queries, a sqlc.SipAccount) (sqlc.SipAccount, error) {
	want := a.Enabled && a.InboundEnabled && s.inboundReady() && (a.InboundMode != modeRegister || s.registerReady())
	if a.InboundTrunkID == "" && a.InboundRuleID == "" && !want {
		return a, nil
	}
	if want {
		if err := numberFree(ctx, q, a); err != nil {
			return a, err
		}
	}
	if err := s.dropInboundLK(ctx, a); err != nil {
		return a, err
	}
	a.InboundTrunkID, a.InboundRuleID = "", ""
	if want {
		var err error
		if a.InboundTrunkID, a.InboundRuleID, err = s.makeInboundLK(ctx, q, a); err != nil {
			return a, err
		}
	}
	return a, q.SetSipInboundLiveKit(ctx, sqlc.SetSipInboundLiveKitParams{WorkspaceID: a.WorkspaceID, InboundTrunkID: a.InboundTrunkID, InboundRuleID: a.InboundRuleID})
}

func errInboundOff(msg string) *httpx.Error {
	return httpx.Coded(http.StatusConflict, v1.ErrorCode_ERROR_CODE_SIP_DISABLED, msg)
}

// putInbound: PUT /api/workspaces/{id}/sip/inbound (sip.proto).
func (s *Service) putInbound(w http.ResponseWriter, r *http.Request) error {
	wsID, err := manage(r)
	if err != nil {
		return err
	}
	var req v1.PutSipInboundRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	ctx, me := r.Context(), uid(r)
	enabled := req.GetEnabled()
	if enabled {
		if err := s.planAllows(ctx, wsID); err != nil {
			return err
		}
		if !s.inboundReady() {
			return errInboundOff("this server does not take inbound calls (LiveKit, IVR worker token)")
		}
	}
	cidrs, err := parseCIDRs(req.GetAllowedCidrs(), s.opts.AllowAddr)
	if err != nil {
		return err
	}
	mode, modeSet := modeToDB[req.GetMode()]
	if !modeSet && req.GetMode() != v1.SipInboundMode_SIP_INBOUND_MODE_UNSPECIFIED {
		return httpx.Validation("mode", "mode is DIRECT or REGISTER")
	}
	var saved, before sqlc.SipAccount
	var ex *exchange
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if err := q.LockSipAccount(ctx, wsID); err != nil {
			return err
		}
		cur, ok, err := s.account(ctx, q, wsID)
		if err != nil {
			return err
		}
		before = cur
		if enabled && (!ok || !cur.Enabled || cur.TrunkID == "") {
			return errInboundOff("switch telephony on first")
		}
		if !ok { // nothing saved, nothing to switch off
			saved = cur
			return nil
		}
		if ex, err = loadExchange(ctx, q, wsID); err != nil {
			return err
		}
		t := dbTarget{kind: "hangup"}
		if req.GetTarget() != nil {
			if t, err = ex.parseTarget(req.GetTarget(), "target", false); err != nil {
				return err
			}
		}
		if enabled && t.kind == "hangup" {
			return httpx.Validation("target", "choose where inbound calls go: a voice menu, a number or a group")
		}
		next := cur
		next.InboundEnabled, next.InboundKind, next.InboundAllowedCidrs = enabled, t.kind, cidrs
		next.InboundMenuID, next.InboundExtensionID, next.InboundGroupID = t.menu, t.ext, t.group
		if err := s.nextRegistration(ctx, cur, &next, mode, modeSet, req.GetRegistration()); err != nil {
			return err
		}
		if enabled {
			if err := numberFree(ctx, q, next); err != nil {
				return err
			}
		}
		if err := s.dropInboundLK(ctx, cur); err != nil {
			return err
		}
		next.InboundTrunkID, next.InboundRuleID = "", ""
		if enabled {
			if next.InboundTrunkID, next.InboundRuleID, err = s.makeInboundLK(ctx, q, next); err != nil {
				return err
			}
		}
		if _, err = q.SetSipInbound(ctx, sqlc.SetSipInboundParams{
			WorkspaceID: wsID, InboundEnabled: enabled, InboundKind: next.InboundKind, InboundMenuID: next.InboundMenuID,
			InboundExtensionID: next.InboundExtensionID, InboundGroupID: next.InboundGroupID, InboundAllowedCidrs: cidrs,
			InboundTrunkID: next.InboundTrunkID, InboundRuleID: next.InboundRuleID, UpdatedBy: &me,
		}); err != nil {
			return err
		}
		regStatus := "off"
		if next.InboundMode == modeRegister && next.InboundTrunkID != "" {
			regStatus = sipregwire.StatusRegistering
			if !s.reg.Available(ctx) {
				regStatus = "unavailable"
			}
		}
		saved, err = q.SetSipRegistration(ctx, sqlc.SetSipRegistrationParams{
			WorkspaceID: wsID, InboundMode: next.InboundMode, RegRegistrar: next.RegRegistrar, RegDomain: next.RegDomain,
			RegExpires: next.RegExpires, RegKeepaliveSec: next.RegKeepaliveSec, RegContactUser: next.RegContactUser,
			RegAuthUsername: next.RegAuthUsername, RegPasswordEnc: next.RegPasswordEnc, RegTrunkPasswordEnc: next.RegTrunkPasswordEnc,
			RegStatus: regStatus,
		})
		return err
	})
	var pe *providerError
	if errors.As(err, &pe) {
		if err := db.GuardExec(context.WithoutCancel(ctx), s.db, func(guarded *sqlc.Queries) error {
			return guarded.SetSipLastError(context.WithoutCancel(ctx), sqlc.SetSipLastErrorParams{WorkspaceID: wsID, LastError: pe.msg})
		}); err != nil {
			slog.WarnContext(ctx, "sip: store last_error", "workspace", wsID, "err", err)
		}
		return httpx.Coded(http.StatusBadGateway, v1.ErrorCode_ERROR_CODE_SIP_PROVIDER_ERROR, pe.msg)
	}
	if err != nil {
		return inboundTaken(err)
	}
	slog.InfoContext(ctx, "sip: inbound saved", "workspace", wsID, "by", me, "enabled", saved.InboundEnabled, "mode", saved.InboundMode,
		"trunk", saved.InboundTrunkID, "rule", saved.InboundRuleID)
	if before.InboundEnabled && !enabled {
		s.hangupInboundWorkspace(ctx, wsID, reasonUnwanted)
	}
	s.regChanged(ctx, before, saved)
	out := settingsPB(saved, true)
	out.InboundAvailable = s.inboundReady()
	fillInbound(out, saved, ex)
	s.fillRegistration(ctx, out, saved)
	httpx.Write(w, http.StatusOK, &v1.PutSipInboundResponse{Settings: out})
	return nil
}

// ---------------------------------------------------------------- state in Valkey

// inRec is the Valkey record of a live inbound call.
type inRec struct {
	ID      uuid.UUID  `json:"id"`
	WS      uuid.UUID  `json:"ws"`
	Room    string     `json:"room"`
	Line    string     `json:"line"`
	EndedBy *uuid.UUID `json:"ended_by,omitempty"`
	// AnswerLeft: when the member who answered left the room (ms; 0 = in it).
	AnswerLeft int64 `json:"answer_left,omitempty"`
	InCall
}

func inKey(id uuid.UUID) string     { return redisx.Key("sipin:" + id.String()) }
func inDueKey() string              { return redisx.Key("sipin:due") }
func inUserKey(u uuid.UUID) string  { return redisx.Key("sipin:user:" + u.String()) }
func inLockKey(id uuid.UUID) string { return redisx.Key("sipin:lock:" + id.String()) }

// presenceKey is the gateway's per-user presence hash (gateway/presence.go presKey): one field
// per live gateway session — «online» for round-robin.
func presenceKey(u uuid.UUID) string { return redisx.Key("presence:" + u.String()) }

var (
	errNoCall   = errors.New("sip: no such inbound call")
	errCallBusy = errors.New("sip: the inbound call is busy")
)

var unlockScript = rueidis.NewLuaScript(`if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`)

func (s *Service) lockCall(ctx context.Context, id uuid.UUID) (func(), error) {
	tok := uuid.NewString()
	for range 75 {
		err := s.redis.Do(ctx, s.redis.B().Set().Key(inLockKey(id)).Value(tok).Nx().Px(5*time.Second).Build()).Error()
		if err == nil {
			return func() {
				_ = unlockScript.Exec(context.WithoutCancel(ctx), s.redis, []string{inLockKey(id)}, []string{tok}).Error()
			}, nil
		}
		if !rueidis.IsRedisNil(err) {
			return nil, err
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(40 * time.Millisecond):
		}
	}
	return nil, errCallBusy
}

func (s *Service) loadRec(ctx context.Context, id uuid.UUID) (inRec, error) {
	raw, err := s.redis.Do(ctx, s.redis.B().Get().Key(inKey(id)).Build()).ToString()
	if rueidis.IsRedisNil(err) {
		return inRec{}, errNoCall
	}
	if err != nil {
		return inRec{}, err
	}
	var r inRec
	if err := json.Unmarshal([]byte(raw), &r); err != nil {
		return inRec{}, err
	}
	return r, nil
}

func (s *Service) saveRec(ctx context.Context, r *inRec) error {
	b, err := json.Marshal(r)
	if err != nil {
		return err
	}
	cmds := rueidis.Commands{s.redis.B().Set().Key(inKey(r.ID)).Value(string(b)).Ex(inboundTTL).Build()}
	if r.Live() && r.Deadline > 0 {
		cmds = append(cmds, s.redis.B().Zadd().Key(inDueKey()).ScoreMember().ScoreMember(float64(r.Deadline), r.ID.String()).Build())
	} else {
		cmds = append(cmds, s.redis.B().Zrem().Key(inDueKey()).Member(r.ID.String()).Build())
	}
	if !r.Live() {
		cmds[0] = s.redis.B().Set().Key(inKey(r.ID)).Value(string(b)).Ex(time.Minute).Build() // late events find it over
	}
	for _, res := range s.redis.DoMulti(ctx, cmds...) {
		if err := res.Error(); err != nil {
			return err
		}
	}
	return nil
}

// liveAvail answers Availability for call from Valkey: online = a live gateway session, busy =
// a one-to-one call (ADR-0034) or another inbound call ringing / answered by the user. Errors
// count as offline and busy (nobody rings rather than a wrong person).
type liveAvail struct {
	ctx    context.Context
	s      *Service
	call   uuid.UUID
	online map[uuid.UUID]bool
	busy   map[uuid.UUID]bool
}

func (a *liveAvail) Online(u uuid.UUID) bool {
	if v, ok := a.online[u]; ok {
		return v
	}
	n, err := a.s.redis.Do(a.ctx, a.s.redis.B().Hlen().Key(presenceKey(u)).Build()).AsInt64()
	a.online[u] = err == nil && n > 0
	return a.online[u]
}

func (a *liveAvail) Busy(u uuid.UUID) bool {
	if v, ok := a.busy[u]; ok {
		return v
	}
	busy := true
	if _, inCall, err := (calls.Store{C: a.s.redis}).Current(a.ctx, u); err == nil && !inCall {
		v, err := a.s.redis.Do(a.ctx, a.s.redis.B().Get().Key(inUserKey(u)).Build()).ToString()
		busy = !rueidis.IsRedisNil(err) && (err != nil || v != a.call.String())
	}
	a.busy[u] = busy
	return busy
}

func (s *Service) env(ctx context.Context, r *inRec) (Env, error) {
	ex, err := loadExchange(ctx, s.db.Q, r.WS)
	if err != nil {
		return Env{}, err
	}
	return Env{PBX: ex.routing(), Avail: &liveAvail{ctx: ctx, s: s, call: r.ID, online: map[uuid.UUID]bool{}, busy: map[uuid.UUID]bool{}}, Now: time.Now()}, nil
}

// withCall runs one transition of a live call under its lock and carries out its effects.
func (s *Service) withCall(ctx context.Context, id uuid.UUID, fn func(r *inRec, e Env, fx *Effects) error) error {
	unlock, err := s.lockCall(ctx, id)
	if err != nil {
		return err
	}
	defer unlock()
	r, err := s.loadRec(ctx, id)
	if err != nil {
		return err
	}
	if !r.Live() {
		return errNoCall
	}
	e, err := s.env(ctx, &r)
	if err != nil {
		return err
	}
	var fx Effects
	if err := fn(&r, e, &fx); err != nil {
		return err
	}
	return s.apply(ctx, &r, &fx)
}

// apply carries out a transition: the worker, the users' busy keys, the journal row, the
// events, the round-robin pointer, the record.
func (s *Service) apply(ctx context.Context, r *inRec, fx *Effects) error {
	ctx = context.WithoutCancel(ctx)
	switch {
	case fx.Hangup != "":
		if err := s.agent.Leave(ctx, r.ID); err != nil {
			slog.WarnContext(ctx, "sip: worker leave", "call", r.ID, "err", err)
		}
		s.closeRoom(ctx, r.Room)
	case fx.Answered:
		if err := s.agent.Leave(ctx, r.ID); err != nil {
			slog.WarnContext(ctx, "sip: worker leave", "call", r.ID, "err", err)
		}
	case fx.Play != nil:
		p := rtc.IVRPlay{FileID: fx.Play.File.String()}
		if fx.Play.Ringback {
			p = rtc.IVRPlay{Builtin: rtc.IVRBuiltinRingback, Loop: true}
		}
		if err := s.agent.Play(ctx, r.ID, p); err != nil {
			slog.WarnContext(ctx, "sip: worker play", "call", r.ID, "err", err)
		}
	case fx.Stop:
		if err := s.agent.Stop(ctx, r.ID); err != nil {
			slog.WarnContext(ctx, "sip: worker stop", "call", r.ID, "err", err)
		}
	}
	keep := func(u uuid.UUID) bool {
		return slices.Contains(r.Ringing, u) || (r.Answered != nil && *r.Answered == u && r.Phase == PhaseActive)
	}
	for _, u := range fx.Stopped {
		if !keep(u) {
			_ = unlockScript.Exec(ctx, s.redis, []string{inUserKey(u)}, []string{r.ID.String()}).Error()
		}
	}
	for _, u := range fx.Rings {
		_ = s.redis.Do(ctx, s.redis.B().Set().Key(inUserKey(u)).Value(r.ID.String()).Ex(inboundTTL).Build()).Error()
	}
	if fx.Hangup != "" && r.Answered != nil {
		_ = unlockScript.Exec(ctx, s.redis, []string{inUserKey(*r.Answered)}, []string{r.ID.String()}).Error()
		s.onCall(ctx, *r.Answered, r.ID, false)
	}
	if fx.Answered && r.Answered != nil {
		s.onCall(ctx, *r.Answered, r.ID, true)
	}
	if fx.Advance != nil {
		if err := db.GuardExec(ctx, s.db, func(q *sqlc.Queries) error {
			return q.SetSipGroupNextPosition(ctx, sqlc.SetSipGroupNextPositionParams{WorkspaceID: r.WS, ID: fx.Advance.Group, NextPosition: int32(fx.Advance.Position)}) //nolint:gosec // ≤ 20 members
		}); err != nil {
			slog.WarnContext(ctx, "sip: round-robin pointer", "group", fx.Advance.Group, "err", err)
		}
	}
	var row sqlc.SipCall
	var err error
	switch {
	case fx.Hangup != "":
		row, err = db.GuardValue(ctx, s.db, func(q *sqlc.Queries) (sqlc.SipCall, error) {
			return q.FinishSipCall(ctx, sqlc.FinishSipCallParams{ID: r.ID, Status: pbconv.SipEnded, Reason: fx.Hangup, EndedBy: r.EndedBy})
		})
		slog.InfoContext(ctx, "sip: inbound call ended", "call", r.ID, "reason", fx.Hangup, "route", strings.Join(r.Route, " → "))
	case fx.Changed && r.Phase != PhaseActive:
		row, err = db.GuardValue(ctx, s.db, func(q *sqlc.Queries) (sqlc.SipCall, error) {
			return q.UpdateSipInboundRinging(ctx, sqlc.UpdateSipInboundRingingParams{ID: r.ID, RingingUserIds: nonNil(r.Ringing),
				Route: clip(strings.Join(r.Route, " → "), 500), Via: clip(r.Via, 64)})
		})
	case !fx.Answered && len(fx.Rings) == 0 && len(fx.Stopped) == 0:
		// Nothing anybody sees changed (a group's look for free members found nobody, the
		// prompt played): no journal read, no SIP_CALL_UPDATE.
		return s.saveRec(ctx, r)
	default:
		row, err = s.db.Q.GetSipCall(ctx, r.ID)
	}
	if err != nil && !db.IsNotFound(err) {
		slog.WarnContext(ctx, "sip: inbound journal row", "call", r.ID, "err", err)
	}
	if err == nil {
		s.announce(ctx, row, r, fx)
	}
	return s.saveRec(ctx, r)
}

func nonNil(u []uuid.UUID) []uuid.UUID {
	if u == nil {
		return []uuid.UUID{}
	}
	return u
}

// announce: SIP_INBOUND_RING to who started ringing, SIP_CALL_UPDATE to everybody else the call
// concerns (stopped ringing, still ringing, answered) on their user channels.
func (s *Service) announce(ctx context.Context, row sqlc.SipCall, r *inRec, fx *Effects) {
	pb := pbconv.SipCall(row)
	for _, u := range fx.Rings {
		s.events.User(ctx, u, &v1.DispatchEvent{Event: &v1.DispatchEvent_SipInboundRing{SipInboundRing: &v1.SipInboundRing{Call: pb}}})
	}
	seen := map[uuid.UUID]bool{}
	for _, u := range fx.Rings {
		seen[u] = true
	}
	to := append(append([]uuid.UUID{}, fx.Stopped...), r.Ringing...)
	if r.Answered != nil {
		to = append(to, *r.Answered)
	}
	for _, u := range to {
		if seen[u] {
			continue
		}
		seen[u] = true
		s.events.User(ctx, u, &v1.DispatchEvent{Event: &v1.DispatchEvent_SipCallUpdate{SipCallUpdate: &v1.SipCallUpdate{Call: pb}}})
	}
}

// onCall marks the member who answered as «on a call» (Presence.on_call, ADR-0034 §3).
func (s *Service) onCall(ctx context.Context, u, call uuid.UUID, on bool) {
	key, val := calls.OnCallKey(u), "sip:"+call.String()
	if on {
		_ = s.redis.Do(ctx, s.redis.B().Set().Key(key).Value(val).Ex(inboundTTL).Build()).Error()
	} else {
		_ = unlockScript.Exec(ctx, s.redis, []string{key}, []string{val}).Error()
	}
	if s.Presence != nil {
		s.Presence(ctx, u)
	}
}

func (s *Service) closeRoom(ctx context.Context, room string) {
	if s.lk == nil || room == "" {
		return
	}
	if err := s.lk.DeleteRoom(ctx, room); err != nil && !rtc.IsNotFound(err) {
		slog.WarnContext(ctx, "sip: close inbound room", "room", room, "err", err)
	}
}

// ---------------------------------------------------------------- LiveKit webhooks

// Inbound implements rtc.SIPHook: events of an inbound call's own LiveKit room.
func (s *Service) Inbound(ctx context.Context, event, room string, p *rtc.Participant) error {
	wid, ok := rtc.ParseInboundRoom(room)
	if !ok {
		return nil
	}
	if event == rtc.EventRoomFinished {
		s.inboundGone(ctx, room, reasonRoomClosed)
		return nil
	}
	if p == nil {
		return nil
	}
	gone := event == rtc.EventParticipantLeft || event == rtc.EventParticipantAborted
	switch {
	case strings.HasPrefix(p.Identity, rtc.InboundLinePrefix):
		if event == rtc.EventParticipantJoined {
			return s.inboundJoined(ctx, wid, room, p)
		}
		if gone {
			s.inboundGone(ctx, room, reasonRemote) // the caller hung up
		}
	case strings.HasPrefix(p.Identity, rtc.AnswerIdentityPrefix):
		user, ok := rtc.ParseAnswerIdentity(p.Identity)
		if !ok || (!gone && event != rtc.EventParticipantJoined) {
			return nil
		}
		row, err := s.db.Q.GetSipCallByLKRoom(ctx, room)
		if err != nil {
			return nil
		}
		err = s.withCall(ctx, row.ID, func(r *inRec, e Env, _ *Effects) error {
			if r.Phase != PhaseActive || r.Answered == nil || *r.Answered != user {
				return nil
			}
			if gone {
				r.AnswerLeft = e.Now.UnixMilli()
				r.Deadline = e.Now.Add(answerGrace).UnixMilli()
			} else {
				r.AnswerLeft, r.Deadline = 0, 0
			}
			return nil
		})
		if err != nil && !errors.Is(err, errNoCall) {
			return err
		}
	}
	return nil
}

// inboundGone ends the call of room (the line left, the room closed).
func (s *Service) inboundGone(ctx context.Context, room, reason string) {
	row, err := s.db.Q.GetSipCallByLKRoom(ctx, room)
	if err != nil || !pbconv.SipCallLive(row.Status) {
		return
	}
	s.endInbound(ctx, row, reason, nil)
}

// endInbound hangs a live inbound call up through its state, or — the state is lost — ends the
// journal row and the room directly.
func (s *Service) endInbound(ctx context.Context, row sqlc.SipCall, reason string, by *uuid.UUID) {
	err := s.withCall(ctx, row.ID, func(r *inRec, _ Env, fx *Effects) error {
		r.EndedBy = by
		r.Hangup(reason, fx)
		return nil
	})
	if errors.Is(err, errNoCall) {
		ctx = context.WithoutCancel(ctx)
		if _, err := db.GuardValue(ctx, s.db, func(q *sqlc.Queries) (sqlc.SipCall, error) {
			return q.FinishSipCall(ctx, sqlc.FinishSipCallParams{ID: row.ID, Status: pbconv.SipEnded, Reason: reason, EndedBy: by})
		}); err != nil && !db.IsNotFound(err) {
			slog.WarnContext(ctx, "sip: finish inbound call", "call", row.ID, "err", err)
		}
		s.closeRoom(ctx, row.LkRoom)
		return
	}
	if err != nil {
		slog.WarnContext(ctx, "sip: end inbound call", "call", row.ID, "err", err)
	}
}

// inboundJoined: the caller's line got into its room — a new inbound call.
func (s *Service) inboundJoined(ctx context.Context, wid uuid.UUID, room string, p *rtc.Participant) error {
	if !s.inboundReady() {
		slog.InfoContext(ctx, "sip: inbound call refused, the server takes none", "room", room)
		s.closeRoom(ctx, room)
		return nil
	}
	if _, err := s.db.Q.GetSipCallByLKRoom(ctx, room); err == nil {
		return nil // a redelivered event
	} else if !db.IsNotFound(err) {
		return err
	}
	number := p.Attributes[rtc.AttrSIPPhoneNumber]
	if n, ok := NormalizeNumber(number); ok {
		number = n
	}
	number = clip(number, 32)
	id, err := uuid.NewV7()
	if err != nil {
		return err
	}
	insert := func(status, reason string) (sqlc.SipCall, error) {
		return db.GuardValue(ctx, s.db, func(q *sqlc.Queries) (sqlc.SipCall, error) {
			return q.InsertSipInboundCall(ctx, sqlc.InsertSipInboundCallParams{ID: id, WorkspaceID: wid, Number: number,
				ParticipantIdentity: p.Identity, SipCallID: p.Attributes[rtc.AttrSIPCallID], LkRoom: room, Status: status, Reason: reason})
		})
	}
	refuse := func(reason string) error {
		slog.InfoContext(ctx, "sip: inbound call refused", "workspace", wid, "room", room, "reason", reason)
		if _, err := insert(pbconv.SipFailed, reason); err != nil && db.UniqueViolation(err) == "" {
			slog.WarnContext(ctx, "sip: journal a refused inbound call", "room", room, "err", err)
		}
		s.closeRoom(ctx, room)
		return nil
	}
	a, saved, err := s.account(ctx, s.db.Q, wid)
	if err != nil {
		return err
	}
	if !saved || !a.Enabled || !a.InboundEnabled || a.InboundTrunkID == "" {
		return refuse(reasonUnwanted)
	}
	if err := s.planAllows(ctx, wid); err != nil {
		var he *httpx.Error
		if errors.As(err, &he) {
			return refuse(reasonPlan)
		}
		return err
	}
	if !s.agent.Available(ctx) {
		return refuse(reasonAgent)
	}
	if err := s.InboundLimit.Take(ctx, wid.String()); err != nil {
		return refuse(reasonBusyLim)
	}
	if n, err := s.db.Q.CountLiveInboundCalls(ctx, wid); err != nil {
		return err
	} else if n >= MaxInboundLive {
		return refuse(reasonBusyLim)
	}
	row, err := insert(pbconv.SipRinging, "")
	if db.UniqueViolation(err) != "" {
		return nil // a concurrent delivery won
	}
	if err != nil {
		return err
	}
	if pc := clip(p.Attributes[rtc.AttrProviderCallID], 200); pc != "" && a.InboundMode == modeRegister {
		if err := db.GuardExec(ctx, s.db, func(q *sqlc.Queries) error {
			return q.SetSipCallProviderCallID(ctx, sqlc.SetSipCallProviderCallIDParams{ID: id, ProviderCallID: pc})
		}); err != nil {
			slog.WarnContext(ctx, "sip: journal the provider call id", "call", id, "err", err)
		}
	}
	slog.InfoContext(ctx, "sip: inbound call", "workspace", wid, "call", id, "room", room, "mode", a.InboundMode)
	rec := inRec{ID: id, WS: wid, Room: room, Line: p.Identity, InCall: InCall{Phase: PhaseMenu}}
	if err := s.saveRec(ctx, &rec); err != nil {
		s.endInbound(ctx, row, reasonError, nil)
		return nil
	}
	tok, err := rtc.JoinToken(s.inCfg.APIKey, s.inCfg.Secret, room, rtc.IVRIdentity(id), "IVR",
		rtc.Permission{CanSubscribe: true, CanPublish: true, CanPublishSources: []rtc.TrackSource{rtc.SourceMicrophone}}, 10*time.Minute)
	if err == nil {
		err = s.agent.Join(ctx, id, room, tok)
	}
	if err != nil {
		slog.WarnContext(ctx, "sip: worker join", "call", id, "err", err)
		s.endInbound(ctx, row, reasonAgent, nil)
		return nil
	}
	entry := routeTarget(a.InboundKind, a.InboundMenuID, a.InboundExtensionID, a.InboundGroupID)
	if err := s.withCall(ctx, id, func(r *inRec, e Env, fx *Effects) error {
		r.Enter(e, entry, fx)
		return nil
	}); err != nil {
		slog.WarnContext(ctx, "sip: inbound entry point", "call", id, "err", err)
		s.endInbound(ctx, row, reasonError, nil)
	}
	return nil
}

// ---------------------------------------------------------------- the worker's events

// AgentEvent applies an event of the IVR worker (ivr.Hub.OnEvent).
func (s *Service) AgentEvent(ctx context.Context, ev ivrwire.Event) {
	id, err := uuid.Parse(ev.Call)
	if err != nil {
		if ev.Op == ivrwire.OpHello {
			slog.InfoContext(ctx, "sip: IVR worker connected", "calls", len(ev.Calls))
		}
		return
	}
	var fn func(r *inRec, e Env, fx *Effects) error
	switch ev.Op {
	case ivrwire.OpPlayed:
		fn = func(r *inRec, e Env, _ *Effects) error { r.PromptDone(e); return nil }
	case ivrwire.OpDTMF:
		if len(ev.Digit) != 1 || !digitRe.MatchString(ev.Digit) {
			return
		}
		fn = func(r *inRec, e Env, fx *Effects) error { r.Digit(e, ev.Digit[0], fx); return nil }
	case ivrwire.OpError, ivrwire.OpLeft:
		// The worker cannot play to the caller any more (a prompt it could not fetch, a lost
		// room): before the answer the caller would hear silence — hang up.
		slog.WarnContext(ctx, "sip: IVR worker", "call", id, "op", ev.Op, "error", ev.Error)
		fn = func(r *inRec, _ Env, fx *Effects) error {
			if r.Phase != PhaseActive {
				r.Hangup(reasonAgent, fx)
			}
			return nil
		}
	default:
		return
	}
	if err := s.withCall(ctx, id, fn); err != nil && !errors.Is(err, errNoCall) {
		slog.WarnContext(ctx, "sip: IVR event", "call", id, "op", ev.Op, "err", err)
	}
}

// ---------------------------------------------------------------- the tick

// RunInbound runs the inbound deadlines every 5 s until ctx ends (only when the server can
// take inbound calls: one ZRANGEBYSCORE per tick while none are live).
func (s *Service) RunInbound(ctx context.Context) {
	if !s.inboundReady() {
		return
	}
	every := s.opts.InboundTick
	if every <= 0 {
		every = inboundTick
	}
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.InboundTick(ctx)
		}
	}
}

// InboundTick handles the calls whose deadline passed: one ZRANGEBYSCORE when there are none.
// Any replica may run it; each call's transition takes its lock and re-checks its deadline.
func (s *Service) InboundTick(ctx context.Context) {
	now := time.Now()
	ids, err := s.redis.Do(ctx, s.redis.B().Zrangebyscore().Key(inDueKey()).Min("-inf").Max(fmt.Sprint(now.UnixMilli())).Limit(0, 100).Build()).AsStrSlice()
	if err != nil || len(ids) == 0 {
		return
	}
	for _, v := range ids {
		id, err := uuid.Parse(v)
		if err != nil {
			continue
		}
		err = s.withCall(ctx, id, func(r *inRec, e Env, fx *Effects) error {
			if r.Phase == PhaseActive {
				if r.AnswerLeft == 0 || e.Now.UnixMilli() < r.Deadline {
					return nil
				}
				// The member who answered did not come back within the grace.
				if _, err := s.lk.GetParticipant(ctx, r.Room, rtc.AnswerIdentity(*r.Answered)); rtc.IsNotFound(err) {
					r.Hangup(reasonLost, fx)
				} else if err == nil {
					r.AnswerLeft, r.Deadline = 0, 0
				}
				return nil
			}
			r.Expire(e, fx)
			return nil
		})
		if errors.Is(err, errNoCall) {
			_ = s.redis.Do(ctx, s.redis.B().Zrem().Key(inDueKey()).Member(v).Build()).Error()
		} else if err != nil {
			slog.WarnContext(ctx, "sip: inbound deadline", "call", id, "err", err)
		}
	}
}

// sweepInbound (Sweep, one instance per period): live inbound rows whose state is lost (Valkey
// reset) or that outlived the 2 h cap end; their rooms close.
func (s *Service) sweepInbound(ctx context.Context, now time.Time) {
	live, err := s.db.Q.ListLiveInboundCalls(ctx, now.Add(-time.Minute))
	if err != nil {
		slog.WarnContext(ctx, "sip: sweep inbound", "err", err)
		return
	}
	for _, c := range live {
		n, err := s.redis.Do(ctx, s.redis.B().Exists().Key(inKey(c.ID)).Build()).AsInt64()
		if err != nil {
			continue
		}
		answered := c.StartedAt
		if c.AnsweredAt != nil {
			answered = *c.AnsweredAt
		}
		switch {
		case n == 0:
			s.endInbound(ctx, c, reasonLost, nil)
		case now.Sub(answered) > s.opts.MaxCallTime+time.Minute:
			s.endInbound(ctx, c, reasonRemote, nil)
		}
	}
}

// hangupInboundWorkspace ends the live inbound calls of a workspace (inbound switched off).
func (s *Service) hangupInboundWorkspace(ctx context.Context, wsID uuid.UUID, reason string) {
	ctx = context.WithoutCancel(ctx)
	live, err := s.db.Q.ListLiveInboundCallsByWorkspace(ctx, wsID)
	if err != nil {
		slog.WarnContext(ctx, "sip: list live inbound calls", "workspace", wsID, "err", err)
		return
	}
	for _, c := range live {
		s.endInbound(ctx, c, reason, nil)
	}
}

// ---------------------------------------------------------------- accept / decline / hang up

// inboundCall resolves {cid} for a member of its workspace (never a guest): 404 otherwise.
func (s *Service) inboundCall(r *http.Request) (sqlc.SipCall, perm.Bits, error) {
	cid, err := httpx.PathUUID(r, "cid", "call")
	if err != nil {
		return sqlc.SipCall{}, 0, err
	}
	ctx := r.Context()
	row, err := s.db.Q.GetSipCall(ctx, cid)
	if db.IsNotFound(err) || (err == nil && row.Direction != "in") {
		return row, 0, httpx.NotFound("call")
	}
	if err != nil {
		return row, 0, err
	}
	bits, role, err := perm.FromContext(ctx).Workspace(ctx, row.WorkspaceID, uid(r))
	if errors.Is(err, perm.ErrNotMember) || (err == nil && role == perm.RoleGuest) {
		return row, 0, httpx.NotFound("call")
	}
	return row, bits, err
}

func rangUser(r *inRec, u uuid.UUID) bool {
	if slices.Contains(r.Ringing, u) || (r.Answered != nil && *r.Answered == u) {
		return true
	}
	return slices.ContainsFunc(r.Rang, func(x Ring) bool { return x.User == u })
}

func errCallOver() error { return httpx.Conflict("the call is over or somebody else answered it") }

// joinFor issues the token of the member who answered for the call's room: microphone and
// listening only (no camera, screen or data in v1).
func (s *Service) joinFor(ctx context.Context, room string, user uuid.UUID) (*v1.JoinVoiceResponse, error) {
	u, err := s.db.Q.GetUser(ctx, user)
	if err != nil {
		return nil, err
	}
	identity := rtc.AnswerIdentity(user)
	tok, err := rtc.JoinToken(s.inCfg.APIKey, s.inCfg.Secret, room, identity, u.DisplayName,
		rtc.Permission{CanSubscribe: true, CanPublish: true, CanPublishSources: []rtc.TrackSource{rtc.SourceMicrophone}}, 10*time.Minute)
	if err != nil {
		return nil, err
	}
	return &v1.JoinVoiceResponse{Url: s.inCfg.PublicURL, Token: tok, Identity: identity, CanSpeak: true}, nil
}

func (s *Service) acceptInbound(w http.ResponseWriter, r *http.Request) error {
	row, _, err := s.inboundCall(r)
	if err != nil {
		return err
	}
	if !s.inboundReady() {
		return httpx.NotFound("call")
	}
	ctx, me := r.Context(), uid(r)
	var room string
	err = s.withCall(ctx, row.ID, func(rec *inRec, e Env, fx *Effects) error {
		if err := rec.Answer(e, me, fx); err != nil {
			if rangUser(rec, me) {
				return errCallOver()
			}
			return httpx.NotFound("call")
		}
		var err error
		row, err = db.GuardValue(ctx, s.db, func(q *sqlc.Queries) (sqlc.SipCall, error) {
			return q.AnswerSipInboundCall(ctx, sqlc.AnswerSipInboundCallParams{ID: rec.ID, UserID: me})
		})
		if db.IsNotFound(err) {
			return errCallOver()
		}
		room = rec.Room
		return err
	})
	if errors.Is(err, errNoCall) {
		return errCallOver()
	}
	if err != nil {
		return err
	}
	slog.InfoContext(ctx, "sip: inbound call answered", "call", row.ID, "by", me)
	join, err := s.joinFor(ctx, room, me)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.SipInboundAcceptResponse{Call: pbconv.SipCall(row), Join: join})
	return nil
}

func (s *Service) joinInbound(w http.ResponseWriter, r *http.Request) error {
	row, _, err := s.inboundCall(r)
	if err != nil {
		return err
	}
	me := uid(r)
	if row.AnsweredBy == nil || *row.AnsweredBy != me || !s.inboundReady() {
		return httpx.NotFound("call")
	}
	if row.Status != pbconv.SipActive {
		return errCallOver()
	}
	join, err := s.joinFor(r.Context(), row.LkRoom, me)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, join)
	return nil
}

func (s *Service) declineInbound(w http.ResponseWriter, r *http.Request) error {
	row, _, err := s.inboundCall(r)
	if err != nil {
		return err
	}
	me := uid(r)
	err = s.withCall(r.Context(), row.ID, func(rec *inRec, e Env, fx *Effects) error {
		if err := rec.Decline(e, me, fx); err != nil {
			if rangUser(rec, me) {
				return errCallOver()
			}
			return httpx.NotFound("call")
		}
		return nil
	})
	if errors.Is(err, errNoCall) {
		return errCallOver()
	}
	if err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Service) hangupInbound(w http.ResponseWriter, r *http.Request) error {
	row, bits, err := s.inboundCall(r)
	if err != nil {
		return err
	}
	me := uid(r)
	mine := row.AnsweredBy != nil && *row.AnsweredBy == me
	if !mine && !bits.Has(perm.ManageIntegrations) {
		return httpx.Forbidden("only the member who answered or MANAGE_INTEGRATIONS may end this call")
	}
	if !pbconv.SipCallLive(row.Status) {
		return errCallOver()
	}
	s.endInbound(r.Context(), row, reasonHangup, &me)
	if row, err = s.db.Q.GetSipCall(r.Context(), row.ID); err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.SipCallResponse{Call: pbconv.SipCall(row)})
	return nil
}

// PromptFile opens a voice menu's prompt for the IVR worker (ivr.Hub.Prompt): only files that
// are some menu's prompt_file_id.
func (s *Service) PromptFile(ctx context.Context, id uuid.UUID) (io.ReadSeekCloser, time.Time, bool, error) {
	if s.files == nil {
		return nil, time.Time{}, false, nil
	}
	f, err := s.db.Q.GetSipPromptFile(ctx, id)
	if db.IsNotFound(err) {
		return nil, time.Time{}, false, nil
	}
	if err != nil {
		return nil, time.Time{}, false, err
	}
	rc, _, err := s.files.Store().Get(ctx, f.Key)
	if errors.Is(err, blob.ErrNotFound) {
		return nil, time.Time{}, false, nil
	}
	if err != nil {
		return nil, time.Time{}, false, err
	}
	return rc, f.CreatedAt, true, nil
}

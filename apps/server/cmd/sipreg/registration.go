package main

import (
	"context"
	"errors"
	"log/slog"
	"math/rand/v2"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/emiago/sipgo/sip"
	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/sipregwire"
)

// registration holds one account's binding at its provider (ADR-0121 §2): REGISTER with
// digest, refresh at half of the granted time, OPTIONS keepalive, backoff on failures, a final
// REGISTER with Expires: 0 when the account goes.
type registration struct {
	ag     *agent
	acc    sipregwire.Account
	callID string // stable per binding
	tag    string

	mu         sync.Mutex
	cseq       uint32
	status     string
	errText    string
	expiresAt  time.Time
	contact    string
	lastReport time.Time
	learned    string // the address the registrar saw (received / rport), "" = our public one

	cancel context.CancelFunc
	done   chan struct{}
	wake   chan struct{} // keepalive lost: register again now
}

func newRegistration(ag *agent, a sipregwire.Account) *registration {
	return &registration{ag: ag, acc: a, callID: uuid.NewString(), tag: sip.GenerateTagN(16), cseq: uint32(rand.IntN(10000)) + 1, //nolint:gosec // not a secret
		done: make(chan struct{}), wake: make(chan struct{}, 1), status: sipregwire.StatusRegistering}
}

var (
	errAuth    = errors.New("auth")
	errTimeout = errors.New("timeout")
)

// codeError is a final failure answer of the registrar.
type codeError struct{ code int }

func (e *codeError) Error() string { return strconv.Itoa(e.code) }

func jitter(d time.Duration) time.Duration {
	f := 0.9 + rand.Float64()*0.2 //nolint:gosec // jitter
	return time.Duration(float64(d) * f)
}

// refreshIn: half of the granted time, but not sooner than minRefresh after now and not later
// than minRefresh before the end, ±10 %.
func refreshIn(granted, minRefresh time.Duration) time.Duration {
	d := granted / 2
	if granted > 2*minRefresh {
		d = min(max(d, minRefresh), granted-minRefresh)
	}
	return jitter(d)
}

// start runs the registration loop until stop.
func (r *registration) start(parent context.Context) {
	ctx, cancel := context.WithCancel(parent)
	r.mu.Lock()
	r.cancel = cancel
	r.mu.Unlock()
	go r.run(ctx)
}

func (r *registration) run(ctx context.Context) {
	defer close(r.done)
	backoff := r.ag.t.backoffMin
	nextResolve := time.Time{}
	r.report(sipregwire.StatusRegistering, "", time.Time{}, "")
	for ctx.Err() == nil {
		if time.Now().After(nextResolve) {
			r.resolve(ctx)
			nextResolve = time.Now().Add(r.ag.t.resolveEvery)
		}
		granted, contact, err := r.register(ctx, r.acc.Expires)
		if ctx.Err() != nil {
			return
		}
		var wait time.Duration
		switch {
		case err == nil:
			backoff = r.ag.t.backoffMin
			r.report(sipregwire.StatusRegistered, "", time.Now().Add(granted), contact)
			if !r.hold(ctx, refreshIn(granted, r.ag.t.minRefresh)) {
				return
			}
			continue
		case errors.Is(err, errAuth):
			r.report(sipregwire.StatusFailed, "auth: the provider refused the login or password", time.Time{}, "")
			wait = r.ag.t.authRetry
		default:
			r.report(sipregwire.StatusFailed, err.Error(), time.Time{}, "")
			wait = jitter(backoff)
			backoff = min(backoff*2, r.ag.t.backoffMax)
		}
		slog.Info("sipreg: registration failed", "ws", r.acc.WS, "user", r.acc.Username, "call_id", r.callID, "error", err.Error(), "retry_in", wait.Round(time.Second))
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
	}
}

// hold waits until the refresh is due, sending keepalives; false = stopped.
func (r *registration) hold(ctx context.Context, d time.Duration) bool {
	refresh := time.NewTimer(d)
	defer refresh.Stop()
	var tick <-chan time.Time
	if r.acc.Keepalive > 0 {
		t := time.NewTicker(time.Duration(r.acc.Keepalive) * time.Second)
		defer t.Stop()
		tick = t.C
	}
	misses := 0
	for {
		select {
		case <-ctx.Done():
			return false
		case <-refresh.C:
			return true
		case <-r.wake:
			return true
		case <-tick:
			if r.keepalive(ctx) {
				misses = 0
				r.heartbeat()
				continue
			}
			if misses++; misses >= 2 {
				slog.Info("sipreg: keepalive lost, registering again", "ws", r.acc.WS, "user", r.acc.Username)
				return true
			}
		}
	}
}

// stop ends the loop; unregister = take the binding off at the provider (Expires: 0).
func (r *registration) stop(unregister bool) {
	r.mu.Lock()
	cancel := r.cancel
	r.mu.Unlock()
	if cancel != nil {
		cancel()
		<-r.done
	}
	if !unregister {
		return
	}
	ctx, done := context.WithTimeout(context.Background(), 4*time.Second)
	defer done()
	if _, _, err := r.register(ctx, 0); err != nil {
		slog.Info("sipreg: unregister", "ws", r.acc.WS, "user", r.acc.Username, "error", err.Error())
	}
}

func (r *registration) transport() string {
	if r.acc.Transport == "tcp" {
		return "TCP"
	}
	return "UDP"
}

// contactURI is our Contact: the opaque user part at the public (or learned) address.
func (r *registration) contactURI() sip.Uri {
	host, port := r.ag.publicIP(), r.ag.port
	r.mu.Lock()
	if r.learned != "" {
		if h, p, err := net.SplitHostPort(r.learned); err == nil {
			n, _ := strconv.Atoi(p)
			host, port = h, n
		}
	}
	r.mu.Unlock()
	params := sip.NewParams()
	params.Add("transport", strings.ToLower(r.transport()))
	return sip.Uri{Scheme: "sip", User: r.acc.ContactUser, Host: host, Port: port, UriParams: params}
}

func (r *registration) nextCSeq() uint32 {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.cseq++
	return r.cseq
}

// request builds REGISTER / OPTIONS towards the registrar for the account's AOR.
func (r *registration) request(method sip.RequestMethod) *sip.Request {
	ruri := sip.Uri{Scheme: "sip", Host: r.acc.Domain}
	req := sip.NewRequest(method, ruri)
	req.SetTransport(r.transport())
	req.SetDestination(r.acc.Registrar)
	req.AppendHeader(r.ag.newVia(r.transport(), r.ag.publicIP()))
	mf := sip.MaxForwardsHeader(70)
	req.AppendHeader(&mf)
	aor := sip.Uri{Scheme: "sip", User: r.acc.Username, Host: r.acc.Domain}
	fp := sip.NewParams()
	fp.Add("tag", r.tag)
	req.AppendHeader(&sip.FromHeader{Address: aor, Params: fp})
	req.AppendHeader(&sip.ToHeader{Address: aor, Params: sip.NewParams()})
	cid := sip.CallIDHeader(r.callID)
	if method != sip.REGISTER {
		cid = sip.CallIDHeader(uuid.NewString())
	}
	req.AppendHeader(&cid)
	req.AppendHeader(&sip.CSeqHeader{SeqNo: r.nextCSeq(), MethodName: method})
	req.AppendHeader(sip.NewHeader("User-Agent", userAgent))
	return req
}

// register sends one REGISTER (answering a digest challenge, a stale nonce once more) and
// returns the granted time and the registered Contact.
func (r *registration) register(ctx context.Context, expires int) (time.Duration, string, error) {
	req := r.request(sip.REGISTER)
	contact := r.contactURI()
	req.AppendHeader(&sip.ContactHeader{Address: contact, Params: sip.NewParams()})
	exp := sip.ExpiresHeader(uint32(max(expires, 0))) //nolint:gosec // ≤ 3600
	req.AppendHeader(&exp)
	req.AppendHeader(sip.NewHeader("Allow", "INVITE, ACK, CANCEL, BYE, OPTIONS, INFO, UPDATE, NOTIFY"))
	req.SetBody(nil)
	answered := 0
	for {
		res, err := r.ag.do(ctx, req, r.ag.t.requestWait*3)
		if err != nil {
			if ctx.Err() != nil {
				return 0, "", ctx.Err()
			}
			return 0, "", errTimeout
		}
		switch {
		case res.StatusCode == sip.StatusUnauthorized || res.StatusCode == sip.StatusProxyAuthRequired:
			chal, perr := pickChallenge(res)
			if perr != nil {
				return 0, "", &codeError{code: res.StatusCode}
			}
			if answered > 0 && !chal.Stale || answered > 1 {
				return 0, "", errAuth
			}
			answered++
			if _, err := authorize(req, res, r.acc.AuthUser, r.acc.Password); err != nil {
				return 0, "", &codeError{code: res.StatusCode}
			}
			r.renew(req)
			continue
		case res.StatusCode == sip.StatusForbidden && answered > 0:
			return 0, "", errAuth
		case res.StatusCode == 423: // Interval Too Brief: take the registrar's Min-Expires
			if h := res.GetHeader("Min-Expires"); h != nil && expires > 0 && answered < 3 {
				if n, err := strconv.Atoi(strings.TrimSpace(h.Value())); err == nil && n > expires && n <= 7200 {
					expires, answered = n, answered+1
					e := sip.ExpiresHeader(uint32(n)) //nolint:gosec // ≤ 7200
					req.ReplaceHeader(&e)
					r.renew(req)
					continue
				}
			}
			return 0, "", &codeError{code: res.StatusCode}
		case !res.IsSuccess():
			return 0, "", &codeError{code: res.StatusCode}
		}
		if expires == 0 {
			return 0, "", nil
		}
		granted := grantedExpires(res, contact, expires)
		if r.learn(res) {
			// We are behind a NAT the registrar sees through: register the address it saw.
			return r.register(ctx, expires)
		}
		return granted, contact.String(), nil
	}
}

// renew makes req a new transaction of the same binding: CSeq + 1, a new Via branch.
func (r *registration) renew(req *sip.Request) {
	req.CSeq().SeqNo = r.nextCSeq()
	req.RemoveHeader("Via")
	req.PrependHeader(r.ag.newVia(r.transport(), r.ag.publicIP()))
}

// grantedExpires: the expires of our Contact in the answer, else its Expires header, else what
// we asked for.
func grantedExpires(res *sip.Response, ours sip.Uri, asked int) time.Duration {
	for _, h := range res.GetHeaders("Contact") {
		c, ok := h.(*sip.ContactHeader)
		if !ok || c.Address.User != ours.User {
			continue
		}
		if v, ok := c.Params.Get("expires"); ok {
			if n, err := strconv.Atoi(v); err == nil && n > 0 {
				return time.Duration(n) * time.Second
			}
		}
	}
	if h := res.GetHeader("Expires"); h != nil {
		if n, err := strconv.Atoi(strings.TrimSpace(h.Value())); err == nil && n > 0 {
			return time.Duration(n) * time.Second
		}
	}
	return time.Duration(asked) * time.Second
}

// learn takes received / rport of the answer's Via when they differ from what we registered
// (RFC 3581): true = register again with that address.
func (r *registration) learn(res *sip.Response) bool {
	via := res.Via()
	if via == nil || r.transport() != "UDP" {
		return false
	}
	host, hok := via.Params.Get("received")
	port, pok := via.Params.Get("rport")
	if !hok || host == "" {
		return false
	}
	if _, err := netip.ParseAddr(host); err != nil {
		return false
	}
	if !pok || port == "" {
		port = strconv.Itoa(r.ag.port)
	}
	seen := net.JoinHostPort(host, port)
	r.mu.Lock()
	defer r.mu.Unlock()
	current := r.learned
	if current == "" {
		current = net.JoinHostPort(r.ag.publicIP(), strconv.Itoa(r.ag.port))
	}
	if seen == current {
		return false
	}
	slog.Warn("sipreg: the registrar sees another address, registering it", "ws", r.acc.WS, "seen", seen)
	r.learned = seen
	return true
}

// keepalive: OPTIONS to the registrar; any answer means it is alive.
func (r *registration) keepalive(ctx context.Context) bool {
	req := r.request(sip.OPTIONS)
	req.SetBody(nil)
	_, err := r.ag.do(ctx, req, r.ag.t.requestWait)
	return err == nil
}

// resolve adds the registrar's addresses to the account's allowed sources.
func (r *registration) resolve(ctx context.Context) {
	host, _, err := net.SplitHostPort(r.acc.Registrar)
	if err != nil {
		return
	}
	if a, err := netip.ParseAddr(host); err == nil {
		r.ag.setResolved(r.acc.WS, []netip.Addr{a})
		return
	}
	lctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	addrs, err := net.DefaultResolver.LookupNetIP(lctx, "ip4", host)
	if err != nil {
		slog.Info("sipreg: resolve registrar", "ws", r.acc.WS, "host", host, "error", err.Error())
		return
	}
	r.ag.setResolved(r.acc.WS, addrs)
}

// report sends the state to the API on a change, and the same state again after heartbeat.
func (r *registration) report(status, errText string, expiresAt time.Time, contact string) {
	r.mu.Lock()
	changed := status != r.status || errText != r.errText || contact != r.contact
	r.status, r.errText, r.expiresAt, r.contact = status, errText, expiresAt, contact
	due := changed || time.Since(r.lastReport) >= r.ag.t.heartbeat
	if due {
		r.lastReport = time.Now()
	}
	ev := r.eventLocked()
	r.mu.Unlock()
	if changed && status == sipregwire.StatusRegistered {
		slog.Info("sipreg: registered", "ws", r.acc.WS, "user", r.acc.Username, "status", status, "call_id", r.callID,
			"expires_in", time.Until(expiresAt).Round(time.Second))
	}
	if due {
		r.ag.emit(ev)
	}
}

func (r *registration) heartbeat() {
	r.mu.Lock()
	due := time.Since(r.lastReport) >= r.ag.t.heartbeat
	if due {
		r.lastReport = time.Now()
	}
	ev := r.eventLocked()
	r.mu.Unlock()
	if due {
		r.ag.emit(ev)
	}
}

func (r *registration) reportNow() {
	r.mu.Lock()
	r.lastReport = time.Now()
	ev := r.eventLocked()
	r.mu.Unlock()
	r.ag.emit(ev)
}

func (r *registration) eventLocked() sipregwire.Event {
	ev := sipregwire.Event{Op: sipregwire.OpRegistration, WS: r.acc.WS, Status: r.status, Error: r.errText, Contact: r.contact}
	if !r.expiresAt.IsZero() {
		ev.ExpiresAt = r.expiresAt.Unix()
	}
	return ev
}

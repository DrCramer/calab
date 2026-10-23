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

// flowExpiresMax caps the registration time in flow mode (ADR-0125): a binding left behind by a
// crashed pod (another NAT port) or a dead flow lives at most this long at the provider.
const flowExpiresMax = 300

// registration holds one account's binding at its provider (ADR-0121 §2): REGISTER with
// digest, refresh at half of the granted time, keepalives, backoff on failures, a final
// REGISTER with Expires: 0 when the account goes. In flow mode (ADR-0125) its Contact is the
// address the registrar sees, and the INVITEs come back over the same flow.
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
	learned    string // the address the registrar saw (received / rport), "" = not known
	dest       string // the registrar's pinned ip:port (resolve), "" = none usable
	localIP    string // our local address towards dest (flow mode, before learned)
	flow       *tcpFlow
	bound      sip.Uri // the Contact the registrar holds (to take it off when ours moves)
	hasBound   bool
	flowTimer  time.Duration // the registrar's Flow-Timer (RFC 5626 §4.4.1)

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
	// errNoAddress: the registrar's name gives no public address (yet).
	errNoAddress = errors.New("dns: the registrar has no public address")
	errConnect   = errors.New("tcp: no connection to the registrar")
	errDropped   = errors.New("tcp: the registrar closed the connection")
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
		if time.Now().After(nextResolve) && r.resolve(ctx) {
			nextResolve = time.Now().Add(r.ag.t.resolveEvery)
		}
		var granted time.Duration
		var contact string
		err := errNoAddress
		if r.destination() != "" {
			if err = r.ensureFlow(ctx); err == nil {
				granted, contact, err = r.register(ctx, r.expires())
			}
		}
		if ctx.Err() != nil {
			return
		}
		var wait time.Duration
		switch {
		case err == nil:
			r.report(sipregwire.StatusRegistered, "", time.Now().Add(granted), contact)
			since := time.Now()
			res := r.hold(ctx, refreshIn(granted, r.ag.t.minRefresh))
			if res == holdStop {
				return
			}
			// A flow that held a while is taken again at once; one that drops right after the
			// registration backs off (a registrar closing every connection is not hammered).
			if res == holdRefresh || time.Since(since) >= time.Minute {
				backoff = r.ag.t.backoffMin
				continue
			}
			err = errDropped
			r.report(sipregwire.StatusFailed, err.Error(), time.Time{}, "")
			wait = jitter(backoff)
			backoff = min(backoff*2, r.ag.t.backoffMax)
		case errors.Is(err, errAuth):
			r.report(sipregwire.StatusFailed, "auth: the provider refused the login or password", time.Time{}, "")
			wait = r.ag.t.authRetry
		default:
			if errors.Is(err, errTimeout) {
				r.closeFlow() // a silent connection: the next attempt dials a new one
			}
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

// expires is the registration time we ask for.
func (r *registration) expires() int {
	if r.ag.flowMode && r.acc.Expires > flowExpiresMax {
		return flowExpiresMax
	}
	return r.acc.Expires
}

type holdResult int

const (
	holdStop     holdResult = iota // stopped
	holdRefresh                    // register again now (due, keepalive lost, the address moved)
	holdFlowDown                   // the TCP flow ended
)

// hold waits until the refresh is due, sending keepalives and watching the flow.
func (r *registration) hold(ctx context.Context, d time.Duration) holdResult {
	refresh := time.NewTimer(d)
	defer refresh.Stop()
	var tick <-chan time.Time
	if every := r.keepaliveEvery(); every > 0 {
		t := time.NewTicker(every)
		defer t.Stop()
		tick = t.C
	}
	var down <-chan struct{}
	if f := r.currentFlow(); f != nil {
		down = f.down
	}
	misses := 0
	for {
		select {
		case <-ctx.Done():
			return holdStop
		case <-refresh.C:
			return holdRefresh
		case <-r.wake:
			return holdRefresh
		case <-down:
			slog.Info("sipreg: flow lost, connecting and registering again", "ws", r.acc.WS, "user", r.acc.Username)
			return holdFlowDown
		case <-tick:
			alive, moved := r.keepalive(ctx)
			if moved {
				return holdRefresh
			}
			if alive {
				misses = 0
				r.heartbeat()
				continue
			}
			if misses++; misses >= 2 {
				slog.Info("sipreg: keepalive lost, registering again", "ws", r.acc.WS, "user", r.acc.Username)
				r.closeFlow()
				return holdRefresh
			}
		}
	}
}

// keepaliveEvery: the account's OPTIONS interval; in flow mode over UDP at most natKeepalive
// (the NAT binding is the only way back to us), and within the registrar's Flow-Timer.
func (r *registration) keepaliveEvery() time.Duration {
	every := time.Duration(r.acc.Keepalive) * time.Second
	if r.ag.flowMode && r.transport() == "UDP" && (every == 0 || every > r.ag.t.natKeepalive) {
		every = r.ag.t.natKeepalive
	}
	r.mu.Lock()
	ft := r.flowTimer
	r.mu.Unlock()
	if ft > 0 && (every == 0 || every > ft*4/5) {
		every = ft * 4 / 5
	}
	return every
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
	defer r.releaseFlow()
	if !unregister || r.destination() == "" {
		return
	}
	ctx, done := context.WithTimeout(context.Background(), 4*time.Second)
	defer done()
	err := r.ensureFlow(ctx)
	if err == nil {
		_, _, err = r.register(ctx, 0)
	}
	if err != nil {
		slog.Info("sipreg: unregister", "ws", r.acc.WS, "user", r.acc.Username, "error", err.Error())
	}
}

func (r *registration) transport() string {
	if r.acc.Transport == "tcp" {
		return "TCP"
	}
	return "UDP"
}

// ---------------------------------------------------------------- the flow and our address

// ensureFlow makes sure a TCP registration has a live flow to its registrar (UDP needs none).
func (r *registration) ensureFlow(ctx context.Context) error {
	if r.transport() != "TCP" {
		return nil
	}
	dest := r.destination()
	r.mu.Lock()
	cur := r.flow
	r.mu.Unlock()
	if cur != nil && cur.dest == dest && !cur.isDown() {
		return nil
	}
	f, err := r.ag.flows.acquire(ctx, dest)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		slog.Info("sipreg: no flow to the registrar", "ws", r.acc.WS, "registrar", dest, "error", err.Error())
		return errConnect
	}
	r.mu.Lock()
	r.flow, r.learned = f, "" // a new connection is a new NAT mapping
	r.mu.Unlock()
	r.ag.flows.release(cur)
	return nil
}

func (r *registration) currentFlow() *tcpFlow {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.flow
}

func (r *registration) closeFlow() {
	if f := r.currentFlow(); f != nil {
		f.close()
	}
}

func (r *registration) releaseFlow() {
	r.mu.Lock()
	f := r.flow
	r.flow = nil
	r.mu.Unlock()
	r.ag.flows.release(f)
}

// sentBy is the address our Contact and Via carry: the one the registrar saw (received /
// rport), else the configured public address (forward mode), else our end of the flow.
func (r *registration) sentBy() (string, int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.learned != "" {
		if ap, err := netip.ParseAddrPort(r.learned); err == nil {
			return ap.Addr().String(), int(ap.Port())
		}
	}
	if pub := r.ag.publicIP(); pub != "" {
		return pub, r.ag.port
	}
	if r.transport() == "TCP" && r.flow != nil && r.flow.local.IsValid() {
		return r.flow.local.Addr().String(), int(r.flow.local.Port())
	}
	if r.localIP != "" {
		return r.localIP, r.ag.port
	}
	return "127.0.0.1", r.ag.port
}

// outbound: RFC 5626 parameters in our Contact (flow mode, unless switched off).
func (r *registration) outbound() bool { return r.ag.flowMode && r.ag.cfg.outbound }

// contactURI is our Contact: the opaque user part at the address the registrar reaches us at.
func (r *registration) contactURI() sip.Uri {
	host, port := r.sentBy()
	params := sip.NewParams()
	params.Add("transport", strings.ToLower(r.transport()))
	if r.outbound() {
		params.Add("ob", "")
	}
	return sip.Uri{Scheme: "sip", User: r.acc.ContactUser, Host: host, Port: port, UriParams: params}
}

// instanceID is stable across restarts (RFC 5626 §4.1): a restarted agent's binding replaces the
// old one at a registrar that supports outbound.
func (r *registration) instanceID() string {
	return uuid.NewSHA1(uuid.NameSpaceOID, []byte("calab-sipreg/"+r.acc.ContactUser)).String()
}

func (r *registration) contactHeader(u sip.Uri) *sip.ContactHeader {
	p := sip.NewParams()
	if r.outbound() {
		p.Add("reg-id", "1")
		p.Add("+sip.instance", `"<urn:uuid:`+r.instanceID()+`>"`)
	}
	return &sip.ContactHeader{Address: u, Params: p}
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
	req.SetDestination(r.destination())
	host, port := r.sentBy()
	req.AppendHeader(newVia(r.transport(), host, port))
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
// returns the granted time and the registered Contact. When the registrar sees us at another
// address than the Contact carried, it registers that address once more (RFC 3581).
func (r *registration) register(ctx context.Context, expires int) (time.Duration, string, error) {
	return r.registerAt(ctx, expires, true)
}

func (r *registration) registerAt(ctx context.Context, expires int, mayLearn bool) (time.Duration, string, error) {
	req := r.request(sip.REGISTER)
	contact := r.contactURI()
	r.mu.Lock()
	bound, hasBound := r.bound, r.hasBound
	r.mu.Unlock()
	if expires == 0 && hasBound {
		contact = bound
	}
	req.AppendHeader(r.contactHeader(contact))
	if expires > 0 && hasBound && bound.String() != contact.String() {
		// The binding at the address we had would get INVITEs nobody receives: off with it.
		sp := sip.NewParams()
		sp.Add("expires", "0")
		req.AppendHeader(&sip.ContactHeader{Address: bound, Params: sp})
	}
	exp := sip.ExpiresHeader(uint32(max(expires, 0))) //nolint:gosec // ≤ 3600
	req.AppendHeader(&exp)
	req.AppendHeader(sip.NewHeader("Allow", "INVITE, ACK, CANCEL, BYE, OPTIONS, INFO, UPDATE, NOTIFY"))
	if r.outbound() {
		req.AppendHeader(sip.NewHeader("Supported", "path, outbound"))
	}
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
			r.mu.Lock()
			r.hasBound = false
			r.mu.Unlock()
			return 0, "", nil
		}
		granted := grantedExpires(res, contact, expires)
		r.mu.Lock()
		r.bound, r.hasBound, r.flowTimer = contact, true, flowTimer(res)
		r.mu.Unlock()
		if mayLearn && r.learn(res) {
			return r.registerAt(ctx, expires, false)
		}
		return granted, contact.String(), nil
	}
}

// renew makes req a new transaction of the same binding: CSeq + 1, a new Via branch.
func (r *registration) renew(req *sip.Request) {
	req.CSeq().SeqNo = r.nextCSeq()
	req.RemoveHeader("Via")
	host, port := r.sentBy()
	req.PrependHeader(newVia(r.transport(), host, port))
}

// grantedExpires: the expires of our Contact in the answer (the same address, else the same
// user part), else its Expires header, else what we asked for.
func grantedExpires(res *sip.Response, ours sip.Uri, asked int) time.Duration {
	var byUser time.Duration
	for _, h := range res.GetHeaders("Contact") {
		c, ok := h.(*sip.ContactHeader)
		if !ok || c.Address.User != ours.User {
			continue
		}
		v, ok := c.Params.Get("expires")
		if !ok {
			continue
		}
		n, err := strconv.Atoi(v)
		if err != nil || n <= 0 {
			continue
		}
		if c.Address.Host == ours.Host && c.Address.Port == ours.Port {
			return time.Duration(n) * time.Second
		}
		if byUser == 0 {
			byUser = time.Duration(n) * time.Second
		}
	}
	if byUser > 0 {
		return byUser
	}
	if h := res.GetHeader("Expires"); h != nil {
		if n, err := strconv.Atoi(strings.TrimSpace(h.Value())); err == nil && n > 0 {
			return time.Duration(n) * time.Second
		}
	}
	return time.Duration(asked) * time.Second
}

// flowTimer is the registrar's Flow-Timer (seconds between keepalives it wants), 0 = none.
func flowTimer(res *sip.Response) time.Duration {
	h := res.GetHeader("Flow-Timer")
	if h == nil {
		return 0
	}
	n, err := strconv.Atoi(strings.TrimSpace(h.Value()))
	if err != nil || n < 5 || n > 3600 {
		return 0
	}
	return time.Duration(n) * time.Second
}

// learn takes received / rport of an answer's Via (RFC 3581) when they differ from the address
// we sent: true = register again with that address. Always in flow mode; over UDP only in
// forward mode (a NAT the registrar sees through).
func (r *registration) learn(res *sip.Response) bool {
	if !r.ag.flowMode && r.transport() != "UDP" {
		return false
	}
	via := res.Via()
	if via == nil {
		return false
	}
	host, hok := via.Params.Get("received")
	if !hok || host == "" {
		host = via.Host
	}
	port, pok := via.Params.Get("rport")
	if !pok || port == "" {
		if !hok || via.Port == 0 {
			return false
		}
		port = strconv.Itoa(via.Port)
	}
	a, err := netip.ParseAddr(host)
	if err != nil {
		return false
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return false
	}
	seen := netip.AddrPortFrom(a.Unmap(), uint16(n)).String() //nolint:gosec // 1..65535
	h, p := r.sentBy()
	if seen == net.JoinHostPort(h, strconv.Itoa(p)) {
		return false
	}
	slog.Info("sipreg: the registrar sees us at another address, registering it", "ws", r.acc.WS, "seen", seen)
	r.mu.Lock()
	r.learned = seen
	r.mu.Unlock()
	return true
}

// keepalive: OPTIONS to the registrar; any answer means it is alive, and its Via tells whether
// the NAT moved us (moved = register the new address now).
func (r *registration) keepalive(ctx context.Context) (alive, moved bool) {
	req := r.request(sip.OPTIONS)
	req.SetBody(nil)
	// Not longer than the interval: two lost keepalives re-register within two intervals.
	res, err := r.ag.do(ctx, req, min(r.ag.t.requestWait, r.keepaliveEvery()))
	if err != nil {
		return false, false
	}
	return true, r.learn(res)
}

// resolve pins the registrar's address and adds its addresses to the account's allowed
// sources; false = no usable answer (the last pinned address stays). A literal IP is the API's
// (checked there); a name is re-resolved here, so only public addresses are taken: a name that
// later points at loopback or a private network (DNS rebinding) never gets our REGISTER, nor
// becomes an allowed source.
func (r *registration) resolve(ctx context.Context) bool {
	host, port, err := net.SplitHostPort(r.acc.Registrar)
	if err != nil {
		return false
	}
	if a, err := netip.ParseAddr(host); err == nil {
		r.setDest(r.acc.Registrar)
		r.ag.setResolved(r.acc.WS, []netip.Addr{a})
		return true
	}
	lctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	addrs, err := net.DefaultResolver.LookupNetIP(lctx, "ip4", host)
	if err != nil {
		slog.Info("sipreg: resolve registrar", "ws", r.acc.WS, "host", host, "error", err.Error())
		return false
	}
	public := addrs[:0]
	for _, a := range addrs {
		if a = a.Unmap(); publicAddr(a) {
			public = append(public, a)
		}
	}
	if len(public) == 0 {
		slog.Warn("sipreg: the registrar resolves to no public address", "ws", r.acc.WS, "host", host)
		r.setDest("")
		r.ag.setResolved(r.acc.WS, nil)
		return false
	}
	r.setDest(net.JoinHostPort(public[0].String(), port))
	r.ag.setResolved(r.acc.WS, public)
	return true
}

func (r *registration) setDest(d string) {
	local := ""
	if d != "" && r.ag.flowMode {
		local = localIPToward(r.ag.cfg.bind, d)
	}
	r.mu.Lock()
	r.dest, r.localIP = d, local
	r.mu.Unlock()
}

func (r *registration) destination() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.dest
}

// publicAddr: a globally routable unicast address (not loopback, private, link-local, CGNAT,
// multicast or unspecified) — the API's rule for provider addresses (internal/sip).
func publicAddr(a netip.Addr) bool {
	a = a.Unmap()
	return a.IsValid() && !a.IsLoopback() && !a.IsPrivate() && !a.IsLinkLocalUnicast() && !a.IsLinkLocalMulticast() &&
		!a.IsInterfaceLocalMulticast() && !a.IsMulticast() && !a.IsUnspecified() &&
		!netip.MustParsePrefix("100.64.0.0/10").Contains(a) && !netip.MustParsePrefix("0.0.0.0/8").Contains(a)
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
			"contact", contact, "expires_in", time.Until(expiresAt).Round(time.Second))
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

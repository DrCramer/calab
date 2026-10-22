package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/netip"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/emiago/sipgo"
	"github.com/emiago/sipgo/sip"
	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/sipregwire"
)

const userAgent = "Calab-sipreg"

// timings are the protocol's clocks (ADR-0121 §2); tests shorten them.
type timings struct {
	legBNoAnswer  time.Duration // no answer at all from LiveKit SIP → 503 to the provider
	legBFinal     time.Duration // the whole leg-B INVITE transaction
	authRetry     time.Duration // after the provider refused our credentials
	backoffMin    time.Duration
	backoffMax    time.Duration
	minRefresh    time.Duration // refresh not sooner / not later than this before the end
	heartbeat     time.Duration // re-report an unchanged registration state
	ackWait       time.Duration // how long the 2xx to the provider is retransmitted without an ACK
	requestWait   time.Duration // one non-INVITE transaction
	resolveEvery  time.Duration // the registrar's addresses are re-resolved
	invitesPerMin int           // per source address
	pendingMax    int           // unfinished INVITEs per account
	notFoundPerS  int           // 404 answers per second and source address
}

func defaultTimings() timings {
	return timings{
		legBNoAnswer: 8 * time.Second, legBFinal: 60 * time.Second, authRetry: 5 * time.Minute,
		backoffMin: 5 * time.Second, backoffMax: 300 * time.Second, minRefresh: 30 * time.Second, heartbeat: 10 * time.Minute,
		ackWait: 32 * time.Second, requestWait: 10 * time.Second, resolveEvery: 24 * time.Hour,
		invitesPerMin: 60, pendingMax: 10, notFoundPerS: 10,
	}
}

type agentConfig struct {
	bind     string
	port     int // 0 = any (tests)
	publicIP string
	livekit  string // LiveKit SIP host:port
	tcp      bool
	timings  *timings // nil = defaultTimings
}

// account is one registered SIP account and what INVITEs over it may come from.
type account struct {
	sipregwire.Account
	allow    atomic.Pointer[[]netip.Prefix] // AllowedSources ∪ the registrar's resolved addresses (read without ag.mu)
	reg      *registration
	pending  atomic.Int32 // unfinished INVITE transactions
	resolved []netip.Prefix
}

func (a *account) allows(ip netip.Addr) bool {
	p := a.allow.Load()
	if p == nil {
		return false
	}
	for _, p := range *p {
		if p.Contains(ip) {
			return true
		}
	}
	return false
}

// agent is the SIP side: one UDP (and TCP) listener for the registrations, the provider's
// INVITEs and leg B to LiveKit SIP.
type agent struct {
	cfg  agentConfig
	t    timings
	ua   *sipgo.UserAgent
	srv  *sipgo.Server
	cli  *sipgo.Client
	udp  net.PacketConn
	tcpL net.Listener
	port int
	// laddr: the listener's local address, so every request leaves from the registered port.
	laddr   sip.Addr
	lkAddr  string // LiveKit SIP host:port
	lkLocal string // our address as LiveKit SIP sees it (loopback)
	public  atomic.Value
	emit    func(sipregwire.Event)
	ctx     context.Context
	cancel  context.CancelFunc

	mu        sync.Mutex
	accounts  map[string]*account // by workspace
	byContact map[string]*account
	allow     atomic.Pointer[[]netip.Prefix] // the union the read filter checks
	calls     map[string]*call               // by either leg's Call-ID
	rate      *rateWindow                    // INVITEs of accounts per source
	noise     *rateWindow                    // 404 answers and dropped-INVITE logs (kept apart: a flood there never refuses an INVITE)
}

func newAgent(cfg agentConfig) (*agent, error) {
	t := defaultTimings()
	if cfg.timings != nil {
		t = *cfg.timings
	}
	quiet := slog.New(slog.NewTextHandler(io.Discard, nil)) // sipgo logs whole messages: never ours
	sip.SetDefaultLogger(quiet)
	ctx, cancel := context.WithCancel(context.Background())
	ag := &agent{cfg: cfg, t: t, accounts: map[string]*account{}, byContact: map[string]*account{}, calls: map[string]*call{},
		lkAddr: cfg.livekit, ctx: ctx, cancel: cancel, rate: newRateWindow(), noise: newRateWindow(), emit: func(sipregwire.Event) {}}
	ag.public.Store(cfg.publicIP)
	empty := []netip.Prefix{}
	ag.allow.Store(&empty)
	ua, err := sipgo.NewUA(sipgo.WithUserAgent(userAgent),
		sipgo.WithUserAgentTransportLayerOptions(sip.WithTransportLayerReadFilter(ag.readFilter), sip.WithTransportLayerLogger(quiet)),
		sipgo.WithUserAgentTransactionLayerOptions(sip.WithTransactionLayerLogger(quiet), sip.WithTransactionLayerUnhandledResponseHandler(ag.strayResponse)))
	if err != nil {
		cancel()
		return nil, err
	}
	ag.ua = ua
	if ag.srv, err = sipgo.NewServer(ua, sipgo.WithServerLogger(quiet)); err != nil {
		cancel()
		return nil, err
	}
	if ag.cli, err = sipgo.NewClient(ua, sipgo.WithClientLogger(quiet)); err != nil {
		cancel()
		return nil, err
	}
	lkHost, _, _ := net.SplitHostPort(cfg.livekit)
	ag.lkLocal = cfg.publicIP
	if a, err := netip.ParseAddr(lkHost); err == nil && a.IsLoopback() {
		ag.lkLocal = lkHost
	}
	ag.routes()
	var lc net.ListenConfig
	udp, err := lc.ListenPacket(ctx, "udp4", net.JoinHostPort(cfg.bind, strconv.Itoa(cfg.port)))
	if err != nil {
		cancel()
		return nil, err
	}
	ag.udp = udp
	la := udp.LocalAddr().(*net.UDPAddr)
	ag.port = la.Port
	ag.laddr = sip.Addr{IP: la.IP, Port: la.Port}
	go func() { _ = ag.srv.ServeUDP(udp) }()
	if cfg.tcp {
		l, err := lc.Listen(ctx, "tcp4", net.JoinHostPort(cfg.bind, strconv.Itoa(ag.port)))
		if err != nil {
			_ = udp.Close()
			cancel()
			return nil, err
		}
		ag.tcpL = &filteredListener{Listener: l, ok: ag.sourceAllowed}
		go func() { _ = ag.srv.ServeTCP(ag.tcpL) }()
	}
	return ag, nil
}

func (ag *agent) listenAddr() string { return ag.udp.LocalAddr().String() }

func (ag *agent) publicIP() string { return ag.public.Load().(string) }

// shutdown unregisters every account (best effort, a few seconds) and closes the listeners.
func (ag *agent) shutdown() {
	ag.mu.Lock()
	regs := make([]*registration, 0, len(ag.accounts))
	for _, a := range ag.accounts {
		if a.reg != nil {
			regs = append(regs, a.reg)
		}
	}
	ag.mu.Unlock()
	var wg sync.WaitGroup
	for _, r := range regs {
		wg.Add(1)
		go func() { defer wg.Done(); r.stop(true) }()
	}
	wg.Wait()
	ag.cancel()
	_ = ag.udp.Close()
	if ag.tcpL != nil {
		_ = ag.tcpL.Close()
	}
	_ = ag.ua.Close()
}

// ---------------------------------------------------------------- the source filter

// sourceAllowed: a provider's address (some account's sources) or loopback (LiveKit SIP).
func (ag *agent) sourceAllowed(ip netip.Addr) bool {
	ip = ip.Unmap()
	if ip.IsLoopback() {
		return true
	}
	for _, p := range *ag.allow.Load() {
		if p.Contains(ip) {
			return true
		}
	}
	return false
}

// readFilter drops every packet from an address that is not a provider's before it is parsed:
// no answer at all (a scanner learns nothing, and no UDP answer goes to a forged source).
// It never returns an error: that would stop the listener.
func (ag *agent) readFilter(p sip.TransportReadProps, data []byte) ([]byte, error) {
	ap, err := netip.ParseAddrPort(p.RemoteAddr.String())
	if err != nil {
		return nil, nil
	}
	if !ag.sourceAllowed(ap.Addr()) {
		// A provider calling from an address it did not register from would be lost silently:
		// name the source of a dropped INVITE (once a minute per address, ten a minute in all),
		// so it can be added to the workspace's provider addresses.
		// The global budget first: a spoofed flood from many addresses adds no keys.
		if bytes.HasPrefix(data, []byte("INVITE ")) && ag.noise.allow("drop:*", 10, time.Minute) && ag.noise.allow("drop:"+ap.Addr().String(), 1, time.Minute) {
			slog.Info("sipreg: INVITE from an unknown address dropped", "source", ap.Addr().String())
		}
		return nil, nil
	}
	return data, nil
}

// filteredListener closes TCP connections of unknown sources at once.
type filteredListener struct {
	net.Listener
	ok func(netip.Addr) bool
}

func (l *filteredListener) Accept() (net.Conn, error) {
	for {
		c, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		if ap, err := netip.ParseAddrPort(c.RemoteAddr().String()); err == nil && l.ok(ap.Addr()) {
			return c, nil
		}
		_ = c.Close()
	}
}

func parsePrefixes(srcs []string) []netip.Prefix {
	out := make([]netip.Prefix, 0, len(srcs))
	for _, s := range srcs {
		if a, err := netip.ParseAddr(s); err == nil {
			a = a.Unmap()
			out = append(out, netip.PrefixFrom(a, a.BitLen()))
		} else if p, err := netip.ParsePrefix(s); err == nil {
			out = append(out, p.Masked())
		}
	}
	return out
}

// rebuildAllow recomputes the union of sources (under ag.mu).
func (ag *agent) rebuildAllow() {
	all := []netip.Prefix{}
	for _, a := range ag.accounts {
		list := append(parsePrefixes(a.AllowedSources), a.resolved...)
		a.allow.Store(&list)
		all = append(all, list...)
	}
	ag.allow.Store(&all)
}

// setResolved records the registrar's current addresses of an account (they may answer and
// send INVITEs).
func (ag *agent) setResolved(ws string, addrs []netip.Addr) {
	ag.mu.Lock()
	defer ag.mu.Unlock()
	a, ok := ag.accounts[ws]
	if !ok {
		return
	}
	a.resolved = a.resolved[:0]
	for _, x := range addrs {
		x = x.Unmap()
		a.resolved = append(a.resolved, netip.PrefixFrom(x, x.BitLen()))
	}
	ag.rebuildAllow()
}

// ---------------------------------------------------------------- the API's commands

// sameRegistration: nothing the registration depends on changed (the sources may have).
func sameRegistration(a, b sipregwire.Account) bool {
	return a.ContactUser == b.ContactUser && a.Registrar == b.Registrar && a.Domain == b.Domain && a.Transport == b.Transport &&
		a.Username == b.Username && a.AuthUser == b.AuthUser && a.Password == b.Password && a.Expires == b.Expires && a.Keepalive == b.Keepalive
}

func (ag *agent) apply(_ context.Context, cmd sipregwire.Command) {
	switch cmd.Op {
	case sipregwire.OpSnapshot:
		keep := map[string]bool{}
		for _, a := range cmd.Accounts {
			keep[a.WS] = true
			ag.setAccount(a)
		}
		ag.mu.Lock()
		var gone []string
		for ws := range ag.accounts {
			if !keep[ws] {
				gone = append(gone, ws)
			}
		}
		ag.mu.Unlock()
		for _, ws := range gone {
			ag.delAccount(ws)
		}
		slog.Info("sipreg: accounts", "count", len(cmd.Accounts))
	case sipregwire.OpAccountSet:
		if cmd.Account != nil {
			ag.setAccount(*cmd.Account)
		}
	case sipregwire.OpAccountDel:
		ag.delAccount(cmd.WS)
	}
}

func validAccount(a sipregwire.Account) error {
	if _, err := uuid.Parse(a.WS); err != nil {
		return errors.New("bad workspace id")
	}
	if len(a.ContactUser) < 16 || a.Domain == "" || a.Username == "" || a.Number == "" || a.TrunkUser == "" {
		return errors.New("incomplete account")
	}
	if _, _, err := net.SplitHostPort(a.Registrar); err != nil {
		return fmt.Errorf("bad registrar: %w", err)
	}
	if a.Transport != "udp" && a.Transport != "tcp" {
		return errors.New("transport must be udp or tcp")
	}
	return nil
}

func (ag *agent) setAccount(a sipregwire.Account) {
	if err := validAccount(a); err != nil {
		slog.Warn("sipreg: account refused", "account", a, "err", err)
		return
	}
	ag.mu.Lock()
	cur, ok := ag.accounts[a.WS]
	if ok && sameRegistration(cur.Account, a) {
		cur.Account = a // the sources, the number or the trunk credentials
		ag.byContact[a.ContactUser] = cur
		ag.rebuildAllow()
		ag.mu.Unlock()
		return
	}
	var old *registration
	if ok {
		old = cur.reg
		delete(ag.byContact, cur.ContactUser)
	}
	acc := &account{Account: a}
	if ok {
		acc.resolved = cur.resolved
	}
	acc.reg = newRegistration(ag, a)
	ag.accounts[a.WS] = acc
	ag.byContact[a.ContactUser] = acc
	ag.rebuildAllow()
	ag.mu.Unlock()
	if old != nil {
		// Another registrar or another login: take the old binding off first.
		old.stop(!sameBinding(old.acc, a))
	}
	acc.reg.start(ag.ctx)
}

// sameBinding: the provider would keep one binding for both (same AOR and Contact).
func sameBinding(a, b sipregwire.Account) bool {
	return a.Registrar == b.Registrar && a.Domain == b.Domain && a.Username == b.Username && a.ContactUser == b.ContactUser
}

func (ag *agent) delAccount(ws string) {
	ag.mu.Lock()
	cur, ok := ag.accounts[ws]
	if ok {
		delete(ag.accounts, ws)
		delete(ag.byContact, cur.ContactUser)
		ag.rebuildAllow()
	}
	ag.mu.Unlock()
	if ok && cur.reg != nil {
		cur.reg.stop(true)
		ag.emit(sipregwire.Event{Op: sipregwire.OpRegistration, WS: ws, Status: sipregwire.StatusOff})
	}
}

func (ag *agent) reportAll() {
	ag.mu.Lock()
	regs := make([]*registration, 0, len(ag.accounts))
	for _, a := range ag.accounts {
		regs = append(regs, a.reg)
	}
	ag.mu.Unlock()
	for _, r := range regs {
		r.reportNow()
	}
}

// watchPublicIP re-checks the public address every 10 min; a change re-registers everything.
func (ag *agent) watchPublicIP(ctx context.Context, find func(context.Context) (string, error)) {
	t := time.NewTicker(10 * time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		ip, err := find(ctx)
		if err != nil || ip == ag.publicIP() {
			continue
		}
		slog.Warn("sipreg: public IP changed, registering again", "public", ip)
		ag.public.Store(ip)
		ag.mu.Lock()
		accs := make([]sipregwire.Account, 0, len(ag.accounts))
		for _, a := range ag.accounts {
			accs = append(accs, a.Account)
		}
		ag.mu.Unlock()
		for _, a := range accs {
			ag.delAccountQuiet(a.WS)
			ag.setAccount(a)
		}
	}
}

func (ag *agent) delAccountQuiet(ws string) {
	ag.mu.Lock()
	cur, ok := ag.accounts[ws]
	if ok {
		delete(ag.accounts, ws)
		delete(ag.byContact, cur.ContactUser)
	}
	ag.mu.Unlock()
	if ok {
		cur.reg.stop(false)
	}
}

// ---------------------------------------------------------------- requests

// prebuilt sends a request exactly as built here; over UDP from the listener's address (the
// registered port: the provider's NAT binding and source checks see one address). TCP dials
// out from an ephemeral port and the connection is reused for the answers.
func (ag *agent) prebuilt(_ *sipgo.Client, r *sip.Request) error {
	if sip.NetworkToLower(r.Transport()) == "udp" {
		r.Laddr = ag.laddr
	}
	return nil
}

// newVia is our Via for a request towards host (the provider or LiveKit SIP).
func (ag *agent) newVia(transport, host string) *sip.ViaHeader {
	p := sip.NewParams()
	p.Add("branch", sip.GenerateBranch())
	p.Add("rport", "")
	return &sip.ViaHeader{ProtocolName: "SIP", ProtocolVersion: "2.0", Transport: transport, Host: host, Port: ag.port, Params: p}
}

// do runs a non-INVITE (or a whole INVITE) client transaction until its final response.
func (ag *agent) do(ctx context.Context, req *sip.Request, wait time.Duration) (*sip.Response, error) {
	ctx, cancel := context.WithTimeout(ctx, wait)
	defer cancel()
	tx, err := ag.cli.TransactionRequest(ctx, req, ag.prebuilt)
	if err != nil {
		return nil, err
	}
	defer tx.Terminate()
	for {
		select {
		case res := <-tx.Responses():
			if res.IsProvisional() {
				continue
			}
			return res, nil
		case <-tx.Done():
			if err := tx.Err(); err != nil {
				return nil, err
			}
			return nil, errors.New("transaction ended without an answer")
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
}

// strayResponse: a 2xx of a leg-B INVITE retransmitted after its transaction: ACK again.
func (ag *agent) strayResponse(res *sip.Response) {
	cs := res.CSeq()
	if cs == nil || cs.MethodName != sip.INVITE || !res.IsSuccess() || res.CallID() == nil || res.To() == nil {
		return
	}
	ag.mu.Lock()
	c := ag.calls[string(*res.CallID())]
	ag.mu.Unlock()
	src, err := netip.ParseAddrPort(res.Source())
	if c != nil && c.b.callID == string(*res.CallID()) && err == nil && ag.fromLiveKit(src.Addr().Unmap()) {
		c.ackB(res)
	}
}

// ---------------------------------------------------------------- rate windows

// rateWindow counts events per key in fixed windows (INVITEs per minute, 404s per second).
type rateWindow struct {
	mu        sync.Mutex
	hits      map[string]*rateCount
	lastSweep time.Time
}

type rateCount struct {
	start time.Time
	n     int
}

// rateKeysMax bounds the keys a window holds: a flood from many (spoofed) addresses must not
// grow it without end; past it, new keys are refused until the next sweep.
const rateKeysMax = 16384

func newRateWindow() *rateWindow { return &rateWindow{hits: map[string]*rateCount{}} }

// allow counts one event of key and reports whether it is within limit per window.
func (w *rateWindow) allow(key string, limit int, window time.Duration) bool {
	now := time.Now()
	w.mu.Lock()
	defer w.mu.Unlock()
	// Old keys are swept at most once a second (not on every event: a flood would make each
	// event a scan of the whole map).
	if len(w.hits) > 4096 && now.Sub(w.lastSweep) >= time.Second {
		w.lastSweep = now
		for k, c := range w.hits {
			if now.Sub(c.start) > time.Minute {
				delete(w.hits, k)
			}
		}
	}
	c, ok := w.hits[key]
	if !ok && len(w.hits) >= rateKeysMax {
		return false
	}
	if !ok || now.Sub(c.start) >= window {
		w.hits[key] = &rateCount{start: now, n: 1}
		return true
	}
	c.n++
	return c.n <= limit
}

// maskNumber keeps the last 4 digits of a phone number for logs (ADR-0121 §4).
func maskNumber(n string) string {
	if len(n) <= 4 {
		return "…"
	}
	return "…" + n[len(n)-4:]
}

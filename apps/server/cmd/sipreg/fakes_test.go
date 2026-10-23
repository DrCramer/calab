package main

import (
	"context"
	"net"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/emiago/sipgo"
	"github.com/emiago/sipgo/sip"
	"github.com/icholy/digest"

	"github.com/calaba/calaba/server/internal/sipregwire"
)

// In-process fakes on sipgo (ADR-0121 §7): a provider (registrar with digest, OPTIONS, a UAC
// calling the registered Contact) and LiveKit SIP (a UAS on loopback with a 407 challenge).

const (
	provUser = "130098"
	provPass = "provider-secret"
	lkUser   = "ctrunkuser"
	lkPass   = "trunk-secret-trunk-secret"
	number   = "+74951234567"
	caller   = "79161234567"
	offerSDP = "v=0\r\no=- 1 1 IN IP4 203.0.113.50\r\ns=-\r\nc=IN IP4 203.0.113.50\r\nt=0 0\r\nm=audio 40000 RTP/AVP 0 101\r\na=rtpmap:0 PCMU/8000\r\n"
	answerSD = "v=0\r\no=- 2 2 IN IP4 141.105.69.177\r\ns=-\r\nc=IN IP4 141.105.69.177\r\nt=0 0\r\nm=audio 10002 RTP/AVP 0 101\r\na=rtpmap:0 PCMU/8000\r\n"
)

type endpoint struct {
	ua   *sipgo.UserAgent
	srv  *sipgo.Server
	cli  *sipgo.Client
	conn net.PacketConn
	addr string
	port int
}

func newEndpoint(t *testing.T) *endpoint {
	t.Helper()
	var lc net.ListenConfig
	conn, err := lc.ListenPacket(t.Context(), "udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ua, err := sipgo.NewUA()
	if err != nil {
		t.Fatal(err)
	}
	srv, err := sipgo.NewServer(ua)
	if err != nil {
		t.Fatal(err)
	}
	addr := conn.LocalAddr().String()
	_, ps, _ := net.SplitHostPort(addr)
	port, _ := strconv.Atoi(ps)
	cli, err := sipgo.NewClient(ua, sipgo.WithClientHostname("127.0.0.1"), sipgo.WithClientPort(port), sipgo.WithClientConnectionAddr(addr))
	if err != nil {
		t.Fatal(err)
	}
	e := &endpoint{ua: ua, srv: srv, cli: cli, conn: conn, addr: addr, port: port}
	t.Cleanup(func() { _ = conn.Close(); _ = ua.Close() })
	return e
}

func (e *endpoint) serve() { go func() { _ = e.srv.ServeUDP(e.conn) }() }

func challenge(realm, nonce string, stale bool) *digest.Challenge {
	return &digest.Challenge{Realm: realm, Nonce: nonce, Algorithm: "MD5", QOP: []string{"auth"}, Stale: stale}
}

func digestOK(req *sip.Request, header, user, pass string, chal *digest.Challenge) bool {
	h := req.GetHeader(header)
	if h == nil {
		return false
	}
	cred, err := digest.ParseCredentials(h.Value())
	if err != nil || cred.Username != user || cred.Nonce != chal.Nonce {
		return false
	}
	want, err := digest.Digest(chal, digest.Options{Method: string(req.Method), URI: cred.URI, Username: user, Password: pass, Cnonce: cred.Cnonce, Count: cred.Nc})
	return err == nil && want.Response == cred.Response
}

// ---------------------------------------------------------------- the provider

type fakeProvider struct {
	*endpoint
	t *testing.T

	mu        sync.Mutex
	mode      string // "ok", "reject" (401 forever), "fail" (503)
	staleNext bool   // the next answered REGISTER gets 401 stale=true
	expires   int
	nonce     int
	chal      *digest.Challenge
	registers []*sip.Request
	contact   sip.Uri
	options   int
	dropOpts  bool
	nat       string // received:rport the answers report ("" = the real source)
	tcp       bool

	regs chan *sip.Request // accepted REGISTERs
	byes chan *sip.Request
	dua  *sipgo.DialogUA
}

func newProvider(t *testing.T) *fakeProvider {
	e := newEndpoint(t)
	p := setupProvider(t, e)
	e.serve()
	return p
}

// tcpProbe is the TCP provider's listener: it keeps the accepted connections (to drop them)
// and counts the agent's CRLF pings, swallowing them on demand (no pong).
type tcpProbe struct {
	net.Listener
	mu      sync.Mutex
	conns   []net.Conn
	pings   atomic.Int32
	swallow atomic.Bool
}

func (l *tcpProbe) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	pc := &probeConn{Conn: c, l: l}
	l.mu.Lock()
	l.conns = append(l.conns, pc)
	l.mu.Unlock()
	return pc, nil
}

func (l *tcpProbe) accepted() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.conns)
}

// dropAll closes every connection the agent opened (the provider or a NAT drops the flow).
func (l *tcpProbe) dropAll() {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, c := range l.conns {
		_ = c.Close()
	}
}

type probeConn struct {
	net.Conn
	l *tcpProbe
}

func (c *probeConn) Read(b []byte) (int, error) {
	for {
		n, err := c.Conn.Read(b)
		if n == 4 && string(b[:4]) == "\r\n\r\n" {
			c.l.pings.Add(1)
			if c.l.swallow.Load() && err == nil {
				continue
			}
		}
		return n, err
	}
}

// newTCPProvider is a provider on TCP only: it can reach the agent solely over the connection
// the agent dialed (the agent listens on no TCP port in flow mode).
func newTCPProvider(t *testing.T) (*fakeProvider, *tcpProbe) {
	t.Helper()
	var lc net.ListenConfig
	l, err := lc.Listen(t.Context(), "tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ua, err := sipgo.NewUA()
	if err != nil {
		t.Fatal(err)
	}
	srv, err := sipgo.NewServer(ua)
	if err != nil {
		t.Fatal(err)
	}
	cli, err := sipgo.NewClient(ua, sipgo.WithClientHostname("127.0.0.1"))
	if err != nil {
		t.Fatal(err)
	}
	addr := l.Addr().String()
	_, ps, _ := net.SplitHostPort(addr)
	port, _ := strconv.Atoi(ps)
	probe := &tcpProbe{Listener: l}
	t.Cleanup(func() { _ = l.Close(); _ = ua.Close() })
	p := setupProvider(t, &endpoint{ua: ua, srv: srv, cli: cli, addr: addr, port: port})
	p.tcp = true
	go func() { _ = srv.ServeTCP(probe) }()
	return p, probe
}

func setupProvider(t *testing.T, e *endpoint) *fakeProvider {
	p := &fakeProvider{endpoint: e, t: t, mode: "ok", expires: 60, regs: make(chan *sip.Request, 32), byes: make(chan *sip.Request, 8)}
	p.dua = &sipgo.DialogUA{Client: p.cli, ContactHDR: sip.ContactHeader{Address: sip.Uri{Scheme: "sip", User: "prov", Host: "127.0.0.1", Port: p.port}}}
	p.srv.OnRegister(p.onRegister)
	p.srv.OnOptions(func(req *sip.Request, tx sip.ServerTransaction) {
		p.mu.Lock()
		p.options++
		drop := p.dropOpts
		p.mu.Unlock()
		if !drop {
			_ = tx.Respond(p.natted(sip.NewResponseFromRequest(req, 200, "OK", nil)))
		}
	})
	p.srv.OnBye(func(req *sip.Request, tx sip.ServerTransaction) {
		_ = tx.Respond(sip.NewResponseFromRequest(req, 200, "OK", nil))
		p.byes <- req
	})
	return p
}

// natted makes the answer say the request came from p.nat (a NAT in front of the agent).
func (p *fakeProvider) natted(res *sip.Response) *sip.Response {
	p.mu.Lock()
	nat := p.nat
	p.mu.Unlock()
	if nat == "" {
		return res
	}
	host, port, _ := net.SplitHostPort(nat)
	if via := res.Via(); via != nil {
		via.Params.Add("received", host)
		via.Params.Add("rport", port)
	}
	return res
}

func (p *fakeProvider) setNAT(addr string) {
	p.mu.Lock()
	p.nat = addr
	p.mu.Unlock()
}

func (p *fakeProvider) onRegister(req *sip.Request, tx sip.ServerTransaction) {
	p.mu.Lock()
	p.registers = append(p.registers, req)
	mode, stale := p.mode, false
	if mode == "fail" {
		p.mu.Unlock()
		_ = tx.Respond(sip.NewResponseFromRequest(req, 503, "Service Unavailable", nil))
		return
	}
	ok := p.chal != nil && digestOK(req, "Authorization", provUser, provPass, p.chal)
	if ok && p.staleNext {
		p.staleNext, ok, stale = false, false, true
	}
	if !ok || mode == "reject" {
		p.nonce++
		p.chal = challenge("plusofon", "n"+strconv.Itoa(p.nonce), stale)
		res := sip.NewResponseFromRequest(req, 401, "Unauthorized", nil)
		res.AppendHeader(sip.NewHeader("WWW-Authenticate", p.chal.String()))
		p.mu.Unlock()
		_ = tx.Respond(res)
		return
	}
	res := sip.NewResponseFromRequest(req, 200, "OK", nil)
	for _, h := range req.GetHeaders("Contact") {
		ct, ok := h.(*sip.ContactHeader)
		if !ok {
			continue
		}
		if v, _ := ct.Params.Get("expires"); v == "0" {
			continue
		}
		p.contact = ct.Address
		c := &sip.ContactHeader{Address: ct.Address, Params: sip.NewParams()}
		c.Params.Add("expires", strconv.Itoa(p.expires))
		res.AppendHeader(c)
	}
	p.mu.Unlock()
	_ = tx.Respond(p.natted(res))
	p.regs <- req
}

func (p *fakeProvider) setMode(m string) {
	p.mu.Lock()
	p.mode = m
	p.mu.Unlock()
}

func (p *fakeProvider) registerCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.registers)
}

func (p *fakeProvider) registeredContact() sip.Uri {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.contact
}

// call sends an INVITE to the registered Contact.
func (p *fakeProvider) call(ctx context.Context, t *testing.T) *sipgo.DialogClientSession {
	t.Helper()
	contact := p.registeredContact()
	contact.UriParams = nil
	if p.tcp {
		contact.UriParams = sip.NewParams()
		contact.UriParams.Add("transport", "tcp")
	}
	fp := sip.NewParams()
	fp.Add("tag", sip.GenerateTagN(10))
	from := &sip.FromHeader{Address: sip.Uri{Scheme: "sip", User: caller, Host: "voice.plusofon.test"}, Params: fp}
	ct := sip.ContentTypeHeader("application/sdp")
	sess, err := p.dua.Invite(ctx, contact, []byte(offerSDP), from, &ct,
		sip.NewHeader("P-Asserted-Identity", "<sip:+"+caller+"@voice.plusofon.test>"), sip.NewHeader("Supported", "timer"),
		sip.NewHeader("Session-Expires", "1800;refresher=uac"))
	if err != nil {
		t.Fatal(err)
	}
	return sess
}

// ---------------------------------------------------------------- LiveKit SIP

type fakeLiveKit struct {
	*endpoint
	mu      sync.Mutex
	mode    string // "answer", "ring" (180 until cancelled), "silent"
	chal    *digest.Challenge
	nonce   int
	noAuth  int // INVITEs without (valid) credentials
	invites chan *sip.Request
	acks    chan *sip.Request
	byes    chan *sip.Request
	infos   chan *sip.Request
	cancels chan *sip.Request
	sess    chan *sipgo.DialogServerSession
	cache   *sipgo.DialogServerCache
}

func newLiveKit(t *testing.T) *fakeLiveKit {
	lk := &fakeLiveKit{endpoint: newEndpoint(t), mode: "answer", invites: make(chan *sip.Request, 8), acks: make(chan *sip.Request, 8),
		byes: make(chan *sip.Request, 8), infos: make(chan *sip.Request, 8), cancels: make(chan *sip.Request, 8), sess: make(chan *sipgo.DialogServerSession, 8)}
	lk.cache = sipgo.NewDialogServerCache(lk.cli, sip.ContactHeader{Address: sip.Uri{Scheme: "sip", User: "livekit", Host: "127.0.0.1", Port: lk.port}})
	lk.srv.OnInvite(lk.onInvite)
	lk.srv.OnAck(func(req *sip.Request, tx sip.ServerTransaction) {
		_ = lk.cache.ReadAck(req, tx)
		lk.acks <- req
	})
	lk.srv.OnBye(func(req *sip.Request, tx sip.ServerTransaction) {
		if err := lk.cache.ReadBye(req, tx); err != nil {
			_ = tx.Respond(sip.NewResponseFromRequest(req, 200, "OK", nil))
		}
		lk.byes <- req
	})
	lk.srv.OnInfo(func(req *sip.Request, tx sip.ServerTransaction) {
		_ = tx.Respond(sip.NewResponseFromRequest(req, 200, "OK", nil))
		lk.infos <- req
	})
	lk.serve()
	return lk
}

func (lk *fakeLiveKit) onInvite(req *sip.Request, tx sip.ServerTransaction) {
	lk.mu.Lock()
	mode := lk.mode
	if mode == "silent" {
		lk.mu.Unlock()
		return
	}
	if toTag(req) != "" { // a re-INVITE
		lk.mu.Unlock()
		lk.invites <- req
		res := sip.NewResponseFromRequest(req, 200, "OK", []byte(answerSD))
		_ = tx.Respond(res)
		return
	}
	if lk.chal == nil || !digestOK(req, "Proxy-Authorization", lkUser, lkPass, lk.chal) {
		lk.noAuth++
		lk.nonce++
		lk.chal = &digest.Challenge{Realm: "sip.livekit.cloud", Nonce: "lk" + strconv.Itoa(lk.nonce), Algorithm: "MD5"}
		res := sip.NewResponseFromRequest(req, 407, "Unauthorized", nil)
		res.AppendHeader(sip.NewHeader("Proxy-Authenticate", lk.chal.String()))
		lk.mu.Unlock()
		_ = tx.Respond(res)
		return
	}
	lk.mu.Unlock()
	lk.invites <- req
	sess, err := lk.cache.ReadInvite(req, tx)
	if err != nil {
		return
	}
	if st, ok := tx.(*sip.ServerTx); ok {
		st.OnCancel(func(r *sip.Request) { lk.cancels <- r })
	}
	_ = sess.Respond(180, "Ringing", nil)
	if mode == "ring" {
		<-tx.Done()
		return
	}
	ct := sip.ContentTypeHeader("application/sdp")
	go func() { lk.sess <- sess }()
	_ = sess.Respond(200, "OK", []byte(answerSD), &ct)
}

// ---------------------------------------------------------------- the agent

func fastTimings() *timings {
	t := defaultTimings()
	t.legBNoAnswer, t.legBFinal, t.authRetry = 400*time.Millisecond, 5*time.Second, time.Hour
	t.backoffMin, t.backoffMax, t.minRefresh = 100*time.Millisecond, 400*time.Millisecond, 200*time.Millisecond
	t.ackWait, t.requestWait = 3*time.Second, 2*time.Second
	t.natKeepalive, t.pongWait = 300*time.Millisecond, 300*time.Millisecond
	return &t
}

type testAgent struct {
	*agent
	events chan sipregwire.Event
}

// newTestAgent is an agent in flow mode (ADR-0125, the default); newForwardAgent one with a
// public address (forward mode).
func newTestAgent(t *testing.T, lk *fakeLiveKit) *testAgent {
	t.Helper()
	return startAgent(t, agentConfig{bind: "127.0.0.1", livekit: lk.addr, outbound: true, timings: fastTimings()})
}

func newForwardAgent(t *testing.T, lk *fakeLiveKit) *testAgent {
	t.Helper()
	return startAgent(t, agentConfig{bind: "127.0.0.1", publicIP: "127.0.0.1", livekit: lk.addr, tcp: true, timings: fastTimings()})
}

func startAgent(t *testing.T, cfg agentConfig) *testAgent {
	t.Helper()
	ag, err := newAgent(cfg)
	if err != nil {
		t.Fatal(err)
	}
	ta := &testAgent{agent: ag, events: make(chan sipregwire.Event, 64)}
	ag.emit = func(ev sipregwire.Event) {
		select {
		case ta.events <- ev:
		default:
		}
	}
	t.Cleanup(ag.shutdown)
	return ta
}

func testAccount(p *fakeProvider) sipregwire.Account {
	return sipregwire.Account{
		WS: "0190e4a1-0000-7000-8000-000000000001", ContactUser: "cabcdefghijklmnopqrstuvwxyz", Registrar: p.addr, Domain: "voice.plusofon.test",
		Transport: "udp", Username: provUser, AuthUser: provUser, Password: provPass, Expires: 600, Keepalive: 0,
		AllowedSources: []string{"127.0.0.1"}, Number: number, TrunkUser: lkUser, TrunkPassword: lkPass,
	}
}

// wait reads events until one matches.
func (ta *testAgent) wait(t *testing.T, what string, ok func(sipregwire.Event) bool) sipregwire.Event {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case ev := <-ta.events:
			if ok(ev) {
				return ev
			}
		case <-deadline:
			t.Fatalf("no %s event", what)
		}
	}
}

func recv[T any](t *testing.T, ch <-chan T, what string) T {
	t.Helper()
	select {
	case v := <-ch:
		return v
	case <-time.After(5 * time.Second):
		t.Fatalf("no %s", what)
	}
	var zero T
	return zero
}

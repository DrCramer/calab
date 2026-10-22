package main

import (
	"context"
	"net"
	"strconv"
	"sync"
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

	regs chan *sip.Request // accepted REGISTERs
	byes chan *sip.Request
	dua  *sipgo.DialogUA
}

func newProvider(t *testing.T) *fakeProvider {
	p := &fakeProvider{endpoint: newEndpoint(t), t: t, mode: "ok", expires: 60, regs: make(chan *sip.Request, 32), byes: make(chan *sip.Request, 8)}
	p.dua = &sipgo.DialogUA{Client: p.cli, ContactHDR: sip.ContactHeader{Address: sip.Uri{Scheme: "sip", User: "prov", Host: "127.0.0.1", Port: p.port}}}
	p.srv.OnRegister(p.onRegister)
	p.srv.OnOptions(func(req *sip.Request, tx sip.ServerTransaction) {
		p.mu.Lock()
		p.options++
		drop := p.dropOpts
		p.mu.Unlock()
		if !drop {
			_ = tx.Respond(sip.NewResponseFromRequest(req, 200, "OK", nil))
		}
	})
	p.srv.OnBye(func(req *sip.Request, tx sip.ServerTransaction) {
		_ = tx.Respond(sip.NewResponseFromRequest(req, 200, "OK", nil))
		p.byes <- req
	})
	p.serve()
	return p
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
	if ct := req.Contact(); ct != nil {
		p.contact = ct.Address
		c := &sip.ContactHeader{Address: ct.Address, Params: sip.NewParams()}
		c.Params.Add("expires", strconv.Itoa(p.expires))
		res.AppendHeader(c)
	}
	p.mu.Unlock()
	_ = tx.Respond(res)
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
	return &t
}

type testAgent struct {
	*agent
	events chan sipregwire.Event
}

func newTestAgent(t *testing.T, lk *fakeLiveKit) *testAgent {
	t.Helper()
	ag, err := newAgent(agentConfig{bind: "127.0.0.1", port: 0, publicIP: "127.0.0.1", livekit: lk.addr, timings: fastTimings()})
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

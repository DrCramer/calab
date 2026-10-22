package main

import (
	"context"
	"net"
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/emiago/sipgo"
	"github.com/emiago/sipgo/sip"

	"github.com/calaba/calaba/server/internal/sipregwire"
)

func isStatus(st string) func(sipregwire.Event) bool {
	return func(ev sipregwire.Event) bool { return ev.Op == sipregwire.OpRegistration && ev.Status == st }
}

// REGISTER with digest (a stale nonce answered again), the Contact is the opaque token at our
// address, the refresh at half of the granted time, Expires: 0 when the account goes.
func TestRegistration(t *testing.T) {
	p, lk := newProvider(t), newLiveKit(t)
	ag := newTestAgent(t, lk)
	p.mu.Lock()
	p.expires, p.staleNext = 1, true
	p.mu.Unlock()
	acc := testAccount(p)
	ag.apply(context.Background(), sipregwire.Command{Op: sipregwire.OpSnapshot, Accounts: []sipregwire.Account{acc}})
	ev := ag.wait(t, "registered", isStatus(sipregwire.StatusRegistered))
	if !strings.HasPrefix(ev.Contact, "sip:"+acc.ContactUser+"@127.0.0.1:") || ev.ExpiresAt == 0 {
		t.Fatalf("registered: %+v", ev)
	}
	first := recv(t, p.regs, "REGISTER")
	if first.Recipient.String() != "sip:voice.plusofon.test" || first.From().Address.User != provUser || first.To().Address.User != provUser {
		t.Fatalf("REGISTER: %s", first.StartLine())
	}
	if h := first.GetHeader("Authorization"); h == nil || strings.Contains(h.Value(), provPass) {
		t.Fatal("no digest answer, or the password in clear")
	}
	if c := p.registeredContact(); c.User != acc.ContactUser || c.Port != ag.port {
		t.Fatalf("contact %v", c)
	}
	// 401 → answered → 401 stale → answered again → 200: three REGISTERs, one binding.
	if n := p.registerCount(); n < 3 {
		t.Fatalf("REGISTERs: %d", n)
	}
	second := recv(t, p.regs, "refresh")
	if string(*second.CallID()) != string(*first.CallID()) || second.CSeq().SeqNo <= first.CSeq().SeqNo {
		t.Fatal("a refresh is a new binding")
	}
	before := p.registerCount()
	ag.apply(context.Background(), sipregwire.Command{Op: sipregwire.OpAccountDel, WS: acc.WS})
	ag.wait(t, "off", isStatus(sipregwire.StatusOff))
	p.mu.Lock()
	last := p.registers[len(p.registers)-1]
	p.mu.Unlock()
	if p.registerCount() <= before || last.GetHeader("Expires") == nil || last.GetHeader("Expires").Value() != "0" {
		t.Fatalf("no unregister: %v", last.GetHeader("Expires"))
	}
}

// A refused password is «failed / auth» and is not retried at once (the provider would block
// us); a 5xx backs off and retries.
func TestRegistrationFailures(t *testing.T) {
	p, lk := newProvider(t), newLiveKit(t)
	ag := newTestAgent(t, lk)
	p.setMode("reject")
	acc := testAccount(p)
	ag.apply(context.Background(), sipregwire.Command{Op: sipregwire.OpAccountSet, Account: &acc})
	ev := ag.wait(t, "auth failure", isStatus(sipregwire.StatusFailed))
	if !strings.HasPrefix(ev.Error, "auth") {
		t.Fatalf("error %q", ev.Error)
	}
	n := p.registerCount()
	time.Sleep(500 * time.Millisecond)
	if p.registerCount() != n {
		t.Fatal("retried right after an auth failure")
	}

	p2 := newProvider(t)
	p2.setMode("fail")
	acc2 := testAccount(p2)
	acc2.WS, acc2.ContactUser = "0190e4a1-0000-7000-8000-000000000002", "czyxwvutsrqponmlkjihgfedcba"
	ag.apply(context.Background(), sipregwire.Command{Op: sipregwire.OpAccountSet, Account: &acc2})
	ev = ag.wait(t, "503", func(ev sipregwire.Event) bool { return ev.WS == acc2.WS && ev.Status == sipregwire.StatusFailed })
	if ev.Error != "503" {
		t.Fatalf("error %q", ev.Error)
	}
	deadline := time.Now().Add(3 * time.Second)
	for p2.registerCount() < 3 && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	if p2.registerCount() < 3 {
		t.Fatalf("no backoff retries: %d", p2.registerCount())
	}
	p2.setMode("ok")
	ag.wait(t, "recovered", func(ev sipregwire.Event) bool { return ev.WS == acc2.WS && ev.Status == sipregwire.StatusRegistered })
}

// Two OPTIONS without an answer: register again at once.
func TestKeepalive(t *testing.T) {
	p, lk := newProvider(t), newLiveKit(t)
	ag := newTestAgent(t, lk)
	acc := testAccount(p)
	acc.Keepalive = 1
	p.mu.Lock()
	p.expires = 3600
	p.mu.Unlock()
	ag.apply(context.Background(), sipregwire.Command{Op: sipregwire.OpAccountSet, Account: &acc})
	ag.wait(t, "registered", isStatus(sipregwire.StatusRegistered))
	recv(t, p.regs, "REGISTER")
	deadline := time.Now().Add(5 * time.Second)
	for {
		p.mu.Lock()
		opts := p.options
		if opts > 0 {
			p.dropOpts = true
		}
		p.mu.Unlock()
		if opts > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("no keepalive")
		}
		time.Sleep(50 * time.Millisecond)
	}
	recv(t, p.regs, "REGISTER after a lost keepalive")
}

func registered(t *testing.T) (*fakeProvider, *fakeLiveKit, *testAgent) {
	t.Helper()
	p, lk := newProvider(t), newLiveKit(t)
	ag := newTestAgent(t, lk)
	acc := testAccount(p)
	ag.apply(context.Background(), sipregwire.Command{Op: sipregwire.OpSnapshot, Accounts: []sipregwire.Account{acc}})
	ag.wait(t, "registered", isStatus(sipregwire.StatusRegistered))
	return p, lk, ag
}

// The B2BUA (ADR-0121 §2): leg B to LiveKit SIP with the trunk's digest, the workspace's number
// as the callee, the caller and the provider's Call-ID carried over, the SDP untouched both
// ways; ACK, INFO (DTMF) and BYE cross; a session refresh is answered here.
func TestCallFromProvider(t *testing.T) {
	p, lk, ag := registered(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	sess := p.call(ctx, t)
	if err := sess.WaitAnswer(ctx, sipgo.AnswerOptions{}); err != nil {
		t.Fatal(err)
	}
	if string(sess.InviteResponse.Body()) != answerSD {
		t.Fatalf("answer SDP changed: %q", sess.InviteResponse.Body())
	}
	if c := sess.InviteResponse.Contact(); c == nil || c.Address.User != testAccount(p).ContactUser {
		t.Fatalf("contact of the answer: %v", sess.InviteResponse.Contact())
	}
	if h := sess.InviteResponse.GetHeader("Session-Expires"); h == nil || h.Value() != "1800;refresher=uac" {
		t.Fatalf("session timer: %v", h)
	}
	if err := sess.Ack(ctx); err != nil {
		t.Fatal(err)
	}
	inv := recv(t, lk.invites, "INVITE on leg B")
	if inv.Recipient.User != number || inv.To().Address.User != number || inv.From().Address.User != caller {
		t.Fatalf("leg B INVITE: %s from %v to %v", inv.StartLine(), inv.From(), inv.To())
	}
	provCallID := string(*sess.InviteRequest.CallID())
	if h := inv.GetHeader(providerCallHeader); h == nil || h.Value() != provCallID || string(*inv.CallID()) == provCallID {
		t.Fatalf("provider call id: %v", h)
	}
	if h := inv.GetHeader("P-Asserted-Identity"); h == nil || !strings.Contains(h.Value(), caller) {
		t.Fatal("P-Asserted-Identity not carried")
	}
	if string(inv.Body()) != offerSDP {
		t.Fatalf("offer SDP changed: %q", inv.Body())
	}
	if lk.noAuth != 1 {
		t.Fatalf("challenges: %d", lk.noAuth)
	}
	recv(t, lk.acks, "ACK on leg B")
	ev := ag.wait(t, "invite", func(ev sipregwire.Event) bool { return ev.Op == sipregwire.OpInvite })
	if ev.ProviderCallID != provCallID || ev.LegBCallID != string(*inv.CallID()) || ev.From != caller {
		t.Fatalf("invite event: %+v", ev)
	}
	if ev := ag.wait(t, "invite_result", func(ev sipregwire.Event) bool { return ev.Op == sipregwire.OpInviteResult }); ev.Code != 200 {
		t.Fatalf("result %+v", ev)
	}

	// DTMF over INFO goes to LiveKit SIP.
	info := sip.NewRequest(sip.INFO, sess.InviteResponse.Contact().Address)
	ct := sip.ContentTypeHeader("application/dtmf-relay")
	info.AppendHeader(&ct)
	info.SetBody([]byte("Signal=5\r\nDuration=160\r\n"))
	if res, err := sess.Do(ctx, info); err != nil || res.StatusCode != 200 {
		t.Fatalf("INFO: %v %v", res, err)
	}
	if got := recv(t, lk.infos, "INFO on leg B"); !strings.Contains(string(got.Body()), "Signal=5") {
		t.Fatalf("INFO body %q", got.Body())
	}

	// A session refresh (re-INVITE, same SDP) is answered by the agent.
	re := sip.NewRequest(sip.INVITE, sess.InviteResponse.Contact().Address)
	re.AppendHeader(&ct)
	sdpCT := sip.ContentTypeHeader("application/sdp")
	re.ReplaceHeader(&sdpCT)
	re.SetBody([]byte(offerSDP))
	if res, err := sess.Do(ctx, re); err != nil || res.StatusCode != 200 || string(res.Body()) != answerSD {
		t.Fatalf("refresh: %v %v", res, err)
	}
	select {
	case r := <-lk.invites:
		t.Fatalf("a refresh reached LiveKit: %s", r.StartLine())
	case <-time.After(200 * time.Millisecond):
	}

	if err := sess.Bye(ctx); err != nil {
		t.Fatal(err)
	}
	recv(t, lk.byes, "BYE on leg B")
	if ev := ag.wait(t, "bye", func(ev sipregwire.Event) bool { return ev.Op == sipregwire.OpBye }); ev.By != "provider" {
		t.Fatalf("bye %+v", ev)
	}
}

// LiveKit SIP hangs up (DeleteRoom in the API): the provider gets the BYE.
func TestCallEndedByLiveKit(t *testing.T) {
	p, lk, ag := registered(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	sess := p.call(ctx, t)
	if err := sess.WaitAnswer(ctx, sipgo.AnswerOptions{}); err != nil {
		t.Fatal(err)
	}
	_ = sess.Ack(ctx)
	lkSess := recv(t, lk.sess, "leg B session")
	recv(t, lk.acks, "ACK")
	if err := lkSess.Bye(ctx); err != nil {
		t.Fatal(err)
	}
	bye := recv(t, p.byes, "BYE to the provider")
	if string(*bye.CallID()) != string(*sess.InviteRequest.CallID()) {
		t.Fatal("BYE of another dialog")
	}
	if ev := ag.wait(t, "bye", func(ev sipregwire.Event) bool { return ev.Op == sipregwire.OpBye }); ev.By != "livekit" {
		t.Fatalf("bye %+v", ev)
	}
}

// The provider cancels while it rings: CANCEL crosses to leg B, the provider gets 487.
func TestCallCancelled(t *testing.T) {
	p, lk, ag := registered(t)
	lk.mu.Lock()
	lk.mode = "ring"
	lk.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	sess := p.call(ctx, t)
	wctx, stop := context.WithCancel(ctx)
	ringing := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- sess.WaitAnswer(wctx, sipgo.AnswerOptions{OnResponse: func(res *sip.Response) error {
			if res.StatusCode == 180 {
				close(ringing)
			}
			return nil
		}})
	}()
	recv(t, ringing, "180")
	stop()
	if err := <-done; err == nil {
		t.Fatal("answered after CANCEL")
	}
	recv(t, lk.cancels, "CANCEL on leg B")
	if ev := ag.wait(t, "invite_result", func(ev sipregwire.Event) bool { return ev.Op == sipregwire.OpInviteResult }); ev.Code != 487 {
		t.Fatalf("result %+v", ev)
	}
}

// LiveKit SIP does not answer at all: 503 to the provider after the leg-B timeout.
func TestLiveKitSilent(t *testing.T) {
	p, lk, _ := registered(t)
	lk.mu.Lock()
	lk.mode = "silent"
	lk.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	sess := p.call(ctx, t)
	err := sess.WaitAnswer(ctx, sipgo.AnswerOptions{})
	if err == nil || sess.InviteResponse == nil || sess.InviteResponse.StatusCode != 503 {
		t.Fatalf("want 503, got %v %v", sess.InviteResponse, err)
	}
}

// An INVITE to a Contact we do not register: 404 to the provider, nothing to LiveKit.
func TestUnknownContact(t *testing.T) {
	p, lk, _ := registered(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	target := p.registeredContact()
	target.User, target.UriParams = "cnotours", nil
	sess, err := p.dua.Invite(ctx, target, []byte(offerSDP))
	if err != nil {
		t.Fatal(err)
	}
	if err := sess.WaitAnswer(ctx, sipgo.AnswerOptions{}); err == nil || sess.InviteResponse.StatusCode != 404 {
		t.Fatalf("want 404, got %v", err)
	}
	select {
	case r := <-lk.invites:
		t.Fatalf("leaked to LiveKit: %s", r.StartLine())
	default:
	}
}

// Packets of addresses that are not a provider's are dropped before parsing; loopback (LiveKit
// SIP) passes.
func TestReadFilter(t *testing.T) {
	_, lk, ag := registered(t)
	_ = lk
	props := func(addr string) sip.TransportReadProps {
		a, _ := net.ResolveUDPAddr("udp", addr)
		return sip.TransportReadProps{Transport: "udp", RemoteAddr: a}
	}
	data := []byte("INVITE sip:x@y SIP/2.0\r\n\r\n")
	if out, err := ag.readFilter(props("203.0.113.9:5060"), data); out != nil || err != nil {
		t.Fatal("an unknown source passed")
	}
	if out, _ := ag.readFilter(props("127.0.0.1:5060"), data); out == nil {
		t.Fatal("loopback dropped")
	}
	ag.mu.Lock()
	for _, a := range ag.accounts {
		a.AllowedSources = []string{"198.51.100.0/24"}
	}
	ag.rebuildAllow()
	ag.mu.Unlock()
	if out, _ := ag.readFilter(props("198.51.100.77:5060"), data); out == nil {
		t.Fatal("a provider range dropped")
	}
	if !ag.sourceAllowed(netip.MustParseAddr("::ffff:198.51.100.1")) {
		t.Fatal("IPv4-mapped provider address dropped")
	}
	fl := &filteredListener{ok: ag.sourceAllowed}
	if fl.ok(netip.MustParseAddr("192.0.2.1")) {
		t.Fatal("TCP from an unknown source")
	}

	// LiveKit SIP on another host (flow mode in a pod): its address passes the filter and counts
	// as leg B's source; loopback then does not.
	if a, hp, err := resolveLiveKit(t.Context(), "localhost:5060"); err != nil || !a.IsLoopback() || hp != a.String()+":5060" {
		t.Fatalf("resolve localhost: %v %q %v", a, hp, err)
	}
	far := startAgent(t, agentConfig{bind: "127.0.0.1", livekit: "192.0.2.50:5060", timings: fastTimings()})
	if out, _ := far.readFilter(props("192.0.2.50:5060"), data); out == nil || !far.fromLiveKit(netip.MustParseAddr("192.0.2.50")) {
		t.Fatal("LiveKit SIP's address dropped")
	}
	if out, _ := far.readFilter(props("192.0.2.51:5060"), data); out != nil {
		t.Fatal("a neighbour of LiveKit SIP passed")
	}
	if far.fromLiveKit(netip.MustParseAddr("127.0.0.1")) || far.fromLiveKit(netip.MustParseAddr("192.0.2.51")) {
		t.Fatal("another address taken for LiveKit SIP")
	}
}

func TestHelpers(t *testing.T) {
	if d := refreshIn(600*time.Second, 30*time.Second); d < 270*time.Second || d > 330*time.Second {
		t.Fatalf("refresh of 600 s: %v", d)
	}
	if d := refreshIn(60*time.Second, 30*time.Second); d < 27*time.Second || d > 33*time.Second {
		t.Fatalf("refresh of 60 s: %v", d)
	}
	if d := refreshIn(3600*time.Second, 30*time.Second); d > 1980*time.Second {
		t.Fatalf("refresh of 3600 s: %v", d)
	}
	res := sip.NewResponse(401, "Unauthorized")
	res.AppendHeader(sip.NewHeader("WWW-Authenticate", `Digest realm="r", nonce="a", algorithm=MD5, qop="auth"`))
	res.AppendHeader(sip.NewHeader("WWW-Authenticate", `Digest realm="r", nonce="b", algorithm=SHA-256, qop="auth"`))
	res.AppendHeader(sip.NewHeader("WWW-Authenticate", `Digest realm="r", nonce="c", algorithm=SHA-512-256`))
	if c, err := pickChallenge(res); err != nil || c.Algorithm != "SHA-256" {
		t.Fatalf("challenge %v %v", c, err)
	}
	req := sip.NewRequest(sip.REGISTER, sip.Uri{Scheme: "sip", Host: "voice.test"})
	if _, err := authorize(req, res, "u", "secret"); err != nil {
		t.Fatal(err)
	}
	if h := req.GetHeader("Authorization"); h == nil || !strings.Contains(h.Value(), `nonce="b"`) || strings.Contains(h.Value(), "secret") {
		t.Fatalf("authorization %v", h)
	}
	if maskNumber("+79161234567") != "…4567" || maskNumber("12") != "…" {
		t.Fatal("maskNumber")
	}
	w := newRateWindow()
	for i := range 3 {
		if !w.allow("k", 3, time.Minute) {
			t.Fatalf("hit %d refused", i)
		}
	}
	if w.allow("k", 3, time.Minute) {
		t.Fatal("over the limit allowed")
	}
	if err := validAccount(sipregwire.Account{WS: "x"}); err == nil {
		t.Fatal("a bad account accepted")
	}
	// STUN: a Binding Success Response with XOR-MAPPED-ADDRESS 141.105.69.177.
	tx := []byte("0123456789ab")
	resp := []byte{0x01, 0x01, 0x00, 0x0c, 0x21, 0x12, 0xa4, 0x42}
	resp = append(resp, tx...)
	resp = append(resp, 0x00, 0x20, 0x00, 0x08, 0x00, 0x01, 0x00, 0x00)
	ip := []byte{141, 105, 69, 177}
	cookie := []byte{0x21, 0x12, 0xa4, 0x42}
	for i := range ip {
		resp = append(resp, ip[i]^cookie[i])
	}
	if got, err := parseStunResponse(resp, tx); err != nil || got != "141.105.69.177" {
		t.Fatalf("stun %q %v", got, err)
	}
	if _, err := parseStunResponse(resp, []byte("another-txid")); err == nil {
		t.Fatal("a foreign transaction accepted")
	}
}

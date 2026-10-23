package main

import (
	"context"
	"net"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/emiago/sipgo"
	"github.com/emiago/sipgo/sip"

	"github.com/calaba/calaba/server/internal/sipregwire"
)

// Flow mode (ADR-0125): no public address, no inbound port — the registrar's INVITEs come back
// over the connection / binding the registration keeps open.

// TestMain sets sipgo's global logger before any fake starts goroutines that read it.
func TestMain(m *testing.M) {
	quietSIPLogs()
	os.Exit(m.Run())
}

// contacts are a request's Contact headers (sip.Request.Contact is only the last one).
func contacts(req *sip.Request) []*sip.ContactHeader {
	var out []*sip.ContactHeader
	for _, h := range req.GetHeaders("Contact") {
		if c, ok := h.(*sip.ContactHeader); ok {
			out = append(out, c)
		}
	}
	return out
}

// bindingOf: the Contact that is registered (not taken off with expires=0).
func bindingOf(req *sip.Request) *sip.ContactHeader {
	for _, c := range contacts(req) {
		if v, _ := c.Params.Get("expires"); v != "0" {
			return c
		}
	}
	return nil
}

// takenOff: the request takes the Contact on host:port off.
func takenOff(req *sip.Request, host string, port int) bool {
	for _, c := range contacts(req) {
		if v, _ := c.Params.Get("expires"); v == "0" && c.Address.Host == host && c.Address.Port == port {
			return true
		}
	}
	return false
}

func tcpAccount(p *fakeProvider) sipregwire.Account {
	acc := testAccount(p)
	acc.Transport = "tcp"
	return acc
}

// waitFor polls cond for up to 5 s.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		if cond() {
			return
		}
	}
	t.Fatalf("timed out: %s", what)
}

// Over TCP the agent dials the registrar itself and registers its end of that connection with
// the RFC 5626 parameters; the provider's INVITE arrives over the same connection (the agent
// listens on no TCP port), is answered over it and handed to LiveKit SIP; LiveKit's BYE goes
// back to the provider over the flow too.
func TestTCPFlowCall(t *testing.T) {
	p, probe := newTCPProvider(t)
	lk := newLiveKit(t)
	ag := newTestAgent(t, lk)
	if ag.tcpL != nil {
		t.Fatal("a TCP listener in flow mode")
	}
	acc := tcpAccount(p)
	ag.apply(context.Background(), sipregwire.Command{Op: sipregwire.OpAccountSet, Account: &acc})
	ev := ag.wait(t, "registered", isStatus(sipregwire.StatusRegistered))
	reg := recv(t, p.regs, "REGISTER")
	if reg.Transport() != "TCP" || probe.accepted() != 1 {
		t.Fatalf("REGISTER over %s, %d connections", reg.Transport(), probe.accepted())
	}
	_, srcPort, _ := net.SplitHostPort(reg.Source())
	ct := bindingOf(reg)
	if ct == nil || ct.Address.User != acc.ContactUser || strconv.Itoa(ct.Address.Port) != srcPort || !ct.Address.UriParams.Has("ob") {
		t.Fatalf("contact %v, the flow's port %s", ct, srcPort)
	}
	if v, _ := ct.Params.Get("reg-id"); v != "1" {
		t.Fatalf("reg-id %q", v)
	}
	if v, _ := ct.Params.Get("+sip.instance"); !strings.HasPrefix(v, `"<urn:uuid:`) {
		t.Fatalf("+sip.instance %q", v)
	}
	if h := reg.GetHeader("Supported"); h == nil || !strings.Contains(h.Value(), "outbound") {
		t.Fatal("no Supported: outbound")
	}
	if !strings.Contains(ev.Contact, ";transport=tcp") {
		t.Fatalf("reported contact %q", ev.Contact)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	sess := p.call(ctx, t)
	if err := sess.WaitAnswer(ctx, sipgo.AnswerOptions{}); err != nil {
		t.Fatal(err)
	}
	if string(sess.InviteResponse.Body()) != answerSD {
		t.Fatalf("answer SDP %q", sess.InviteResponse.Body())
	}
	if err := sess.Ack(ctx); err != nil {
		t.Fatal(err)
	}
	recv(t, lk.invites, "INVITE on leg B")
	lkSess := recv(t, lk.sess, "leg B session")
	recv(t, lk.acks, "ACK on leg B")
	if err := lkSess.Bye(ctx); err != nil {
		t.Fatal(err)
	}
	if bye := recv(t, p.byes, "BYE to the provider"); bye.Transport() != "TCP" {
		t.Fatalf("BYE over %s", bye.Transport())
	}
	if n := probe.accepted(); n != 1 {
		t.Fatalf("%d connections: not all over the flow", n)
	}
}

// The connection drops: the agent dials again at once, registers the new end and takes the
// old Contact off (Expires 0); CRLF pings keep the flow alive, and a registrar that stops
// answering them loses the flow (dial + register again).
func TestTCPFlowReconnect(t *testing.T) {
	p, probe := newTCPProvider(t)
	lk := newLiveKit(t)
	ag := newTestAgent(t, lk)
	acc := tcpAccount(p)
	p.mu.Lock()
	p.expires = 3600
	p.mu.Unlock()
	ag.apply(context.Background(), sipregwire.Command{Op: sipregwire.OpAccountSet, Account: &acc})
	ag.wait(t, "registered", isStatus(sipregwire.StatusRegistered))
	first := recv(t, p.regs, "REGISTER")

	waitFor(t, "a CRLF ping", func() bool { return probe.pings.Load() > 0 })
	probe.dropAll()
	second := recv(t, p.regs, "REGISTER after the drop")
	if second.Source() == first.Source() || probe.accepted() != 2 {
		t.Fatalf("not a new connection: %s / %s (%d)", first.Source(), second.Source(), probe.accepted())
	}
	if string(*second.CallID()) != string(*first.CallID()) {
		t.Fatal("a new binding after the reconnect")
	}
	old := bindingOf(first).Address
	if !takenOff(second, old.Host, old.Port) || bindingOf(second).Address.Port == old.Port {
		t.Fatal("the old Contact is not taken off")
	}

	// The pongs stop (after the new flow saw one): the flow is given up and registered anew
	// over a third connection.
	pinged := probe.pings.Load()
	waitFor(t, "a ping on the new flow", func() bool { return probe.pings.Load() > pinged })
	time.Sleep(100 * time.Millisecond) // its pong is back
	probe.swallow.Store(true)
	recv(t, p.regs, "REGISTER after the lost pong")
	if probe.accepted() != 3 {
		t.Fatalf("connections: %d", probe.accepted())
	}
}

// Contact from what the registrar sees (Via received / rport, RFC 3581), not from a configured
// address; a keepalive that shows another mapping registers it again at once.
func TestContactFromReceived(t *testing.T) {
	p, lk := newProvider(t), newLiveKit(t)
	ag := newTestAgent(t, lk)
	p.setNAT("198.51.100.20:40000")
	p.mu.Lock()
	p.expires = 3600
	p.mu.Unlock()
	acc := testAccount(p)
	ag.apply(context.Background(), sipregwire.Command{Op: sipregwire.OpAccountSet, Account: &acc})
	ev := ag.wait(t, "registered", isStatus(sipregwire.StatusRegistered))
	if !strings.HasPrefix(ev.Contact, "sip:"+acc.ContactUser+"@198.51.100.20:40000;") {
		t.Fatalf("contact %q", ev.Contact)
	}
	local := recv(t, p.regs, "REGISTER with the local address")
	if c := bindingOf(local); c == nil || c.Address.Host != "127.0.0.1" || c.Address.Port != ag.port {
		t.Fatalf("first contact %v", c)
	}
	natted := recv(t, p.regs, "REGISTER with the seen address")
	if h := natted.Via(); h.Host != "198.51.100.20" || h.Port != 40000 {
		t.Fatalf("Via %v", h)
	}
	if c := bindingOf(natted); c == nil || c.Address.Host != "198.51.100.20" || c.Address.Port != 40000 {
		t.Fatalf("contact %v", c)
	}
	if !takenOff(natted, "127.0.0.1", ag.port) {
		t.Fatal("the local Contact is not taken off")
	}

	// The NAT maps us anew (conntrack flushed): the next OPTIONS tells, REGISTER follows.
	p.setNAT("198.51.100.20:40001")
	moved := recv(t, p.regs, "REGISTER after the mapping moved")
	if c := bindingOf(moved); c == nil || c.Address.Port != 40001 || !takenOff(moved, "198.51.100.20", 40000) {
		t.Fatalf("contact after the move %v", c)
	}
}

// Over UDP in flow mode keepalives run even with the account's keepalive off: the NAT binding
// is the only way back; the time asked for is capped.
func TestUDPFlowKeepalive(t *testing.T) {
	p, lk := newProvider(t), newLiveKit(t)
	ag := newTestAgent(t, lk)
	acc := testAccount(p)
	acc.Keepalive, acc.Expires = 0, 3600
	p.mu.Lock()
	p.expires = 3600
	p.mu.Unlock()
	ag.apply(context.Background(), sipregwire.Command{Op: sipregwire.OpAccountSet, Account: &acc})
	ag.wait(t, "registered", isStatus(sipregwire.StatusRegistered))
	reg := recv(t, p.regs, "REGISTER")
	if h := reg.GetHeader("Expires"); h == nil || h.Value() != strconv.Itoa(flowExpiresMax) {
		t.Fatalf("expires %v", h)
	}
	start := time.Now()
	waitFor(t, "three OPTIONS", func() bool {
		p.mu.Lock()
		defer p.mu.Unlock()
		return p.options >= 3
	})
	if el := time.Since(start); el > 3*time.Second {
		t.Fatalf("keepalives too rare: %v", el)
	}
}

// Forward mode (SIP_REGISTRAR_PUBLIC_IP): Contact = that address and the agent's port, no
// RFC 5626 parameters, the TCP listener is there; a call works as before.
func TestForwardMode(t *testing.T) {
	p, lk := newProvider(t), newLiveKit(t)
	ag := newForwardAgent(t, lk)
	if ag.tcpL == nil {
		t.Fatal("no TCP listener in forward mode")
	}
	acc := testAccount(p)
	ag.apply(context.Background(), sipregwire.Command{Op: sipregwire.OpAccountSet, Account: &acc})
	ag.wait(t, "registered", isStatus(sipregwire.StatusRegistered))
	reg := recv(t, p.regs, "REGISTER")
	c := bindingOf(reg)
	if c == nil || c.Address.Host != "127.0.0.1" || c.Address.Port != ag.port || c.Address.UriParams.Has("ob") || c.Params.Has("reg-id") {
		t.Fatalf("contact %v", c)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	sess := p.call(ctx, t)
	if err := sess.WaitAnswer(ctx, sipgo.AnswerOptions{}); err != nil {
		t.Fatal(err)
	}
	_ = sess.Ack(ctx)
	recv(t, lk.invites, "INVITE on leg B")
	if err := sess.Bye(ctx); err != nil {
		t.Fatal(err)
	}
	recv(t, lk.byes, "BYE on leg B")
}

// Two accounts on one registrar share one flow; the agent's port takes no TCP connection; when
// one account goes, the other keeps the flow (no new connection) and still gets its calls.
func TestTCPFlowShared(t *testing.T) {
	p, probe := newTCPProvider(t)
	lk := newLiveKit(t)
	ag := newTestAgent(t, lk)
	var d net.Dialer
	if c, err := d.DialContext(t.Context(), "tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(ag.port))); err == nil {
		_ = c.Close()
		t.Fatal("the agent's port accepts TCP in flow mode")
	}
	a1, a2 := tcpAccount(p), tcpAccount(p)
	a2.WS, a2.ContactUser = "0190e4a1-0000-7000-8000-000000000002", "c2bcdefghijklmnopqrstuvwxyz"
	seen := map[string]sip.Uri{}
	// One after the other: the fake keeps a single digest nonce.
	for _, a := range []sipregwire.Account{a1, a2} {
		ag.apply(context.Background(), sipregwire.Command{Op: sipregwire.OpAccountSet, Account: &a})
		c := bindingOf(recv(t, p.regs, "REGISTER")).Address
		seen[c.User] = c
	}
	if _, ok := seen[a1.ContactUser]; !ok || len(seen) != 2 || probe.accepted() != 1 {
		t.Fatalf("registered %v over %d connections", seen, probe.accepted())
	}
	ag.apply(context.Background(), sipregwire.Command{Op: sipregwire.OpAccountDel, WS: a1.WS})
	off := recv(t, p.regs, "REGISTER taking a1 off")
	if h := off.GetHeader("Expires"); h == nil || h.Value() != "0" || off.Contact().Address.User != a1.ContactUser {
		t.Fatalf("not a1's removal: %v / %v", h, off.Contact())
	}
	p.mu.Lock()
	p.contact = seen[a2.ContactUser]
	p.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	sess := p.call(ctx, t)
	if err := sess.WaitAnswer(ctx, sipgo.AnswerOptions{}); err != nil {
		t.Fatal(err)
	}
	_ = sess.Ack(ctx)
	recv(t, lk.invites, "INVITE on leg B")
	if n := probe.accepted(); n != 1 {
		t.Fatalf("%d connections after a1 left", n)
	}
}

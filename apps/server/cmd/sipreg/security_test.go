package main

import (
	"context"
	"net"
	"net/netip"
	"strconv"
	"testing"
	"time"

	"github.com/emiago/sipgo/sip"
)

// An INVITE to a registered Contact from a provider's address without From / To / Call-ID
// (sipgo makes a transaction of Via and CSeq alone) is dropped; it must not crash the agent
// and with it every workspace's registration.
func TestMalformedInviteDropped(t *testing.T) {
	p, lk, ag := registered(t)
	contact := p.registeredContact()
	var d net.Dialer
	conn, err := d.DialContext(t.Context(), "udp", ag.listenAddr())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()
	raw := "INVITE sip:" + contact.User + "@127.0.0.1:" + strconv.Itoa(ag.port) + " SIP/2.0\r\n" +
		"Via: SIP/2.0/UDP " + conn.LocalAddr().String() + ";branch=z9hG4bKmalformed1\r\n" +
		"CSeq: 1 INVITE\r\nMax-Forwards: 70\r\nContent-Length: 0\r\n\r\n"
	if _, err := conn.Write([]byte(raw)); err != nil {
		t.Fatal(err)
	}
	time.Sleep(500 * time.Millisecond)
	select {
	case r := <-lk.invites:
		t.Fatalf("a malformed INVITE reached LiveKit: %s", r.StartLine())
	default:
	}
	// Still alive: an unknown Contact gets its 404.
	TestUnknownContact(t)
}

// In-dialog requests are matched by Call-ID and by source: leg A only from the account's
// provider addresses, leg B only from LiveKit SIP.
func TestInDialogSource(t *testing.T) {
	acc := &account{}
	list := []netip.Prefix{netip.MustParsePrefix("198.51.100.0/24")}
	acc.allow.Store(&list)
	c := &call{acc: acc}
	c.a.callID, c.b.callID = "leg-a", "leg-b"
	ag := &agent{calls: map[string]*call{"leg-a": c, "leg-b": c}, lkAddr: "127.0.0.1:5060", lkIP: netip.MustParseAddr("127.0.0.1")}
	bye := func(cid, src string) *sip.Request {
		req := sip.NewRequest(sip.BYE, sip.Uri{Scheme: "sip", User: "x", Host: "127.0.0.1"})
		h := sip.CallIDHeader(cid)
		req.AppendHeader(&h)
		req.SetSource(src)
		return req
	}
	for _, tc := range []struct {
		cid, src string
		want     *leg
	}{
		{"leg-a", "198.51.100.7:5060", &c.a},
		{"leg-a", "127.0.0.1:5060", nil},   // a host process with the provider's Call-ID
		{"leg-a", "203.0.113.5:5060", nil}, // another tenant's provider
		{"leg-b", "127.0.0.1:5060", &c.b},
		{"leg-b", "198.51.100.7:5060", nil}, // the provider with LiveKit's Call-ID
	} {
		got, from, _ := ag.callByID(bye(tc.cid, tc.src))
		if tc.want == nil && got != nil || tc.want != nil && from != tc.want {
			t.Errorf("%s from %s: call %v leg %p, want %p", tc.cid, tc.src, got != nil, from, tc.want)
		}
	}
}

// A registrar name is pinned to a public address: one that resolves to loopback (DNS
// rebinding after the API checked it) gets no REGISTER and adds no allowed source.
func TestRegistrarPublicOnly(t *testing.T) {
	ag := &agent{accounts: map[string]*account{}}
	empty := []netip.Prefix{}
	ag.allow.Store(&empty)
	acc := testAccount(&fakeProvider{endpoint: &endpoint{}})
	acc.Registrar, acc.AllowedSources = "localhost:5060", nil
	ag.accounts[acc.WS] = &account{Account: acc}
	r := newRegistration(ag, acc)
	if r.resolve(context.Background()) || r.destination() != "" || ag.sourceAllowed(netip.MustParseAddr("10.0.0.1")) {
		t.Fatalf("a loopback registrar pinned: %q", r.destination())
	}
	if *ag.allow.Load() != nil && len(*ag.allow.Load()) != 0 {
		t.Fatalf("loopback became an allowed source: %v", *ag.allow.Load())
	}
	acc.Registrar = "203.0.113.9:5060" // a literal is the API's, checked there
	r = newRegistration(ag, acc)
	if !r.resolve(context.Background()) || r.destination() != "203.0.113.9:5060" {
		t.Fatalf("literal registrar: %q", r.destination())
	}
	if !publicAddr(netip.MustParseAddr("141.105.69.177")) || publicAddr(netip.MustParseAddr("169.254.169.254")) ||
		publicAddr(netip.MustParseAddr("100.64.0.1")) || publicAddr(netip.MustParseAddr("::ffff:10.1.2.3")) {
		t.Fatal("publicAddr")
	}
}

// The rate windows hold a bounded number of keys: a flood from many spoofed sources is refused
// once they are full, and known keys keep counting.
func TestRateWindowBounded(t *testing.T) {
	w := newRateWindow()
	if !w.allow("known", 5, time.Minute) {
		t.Fatal("first hit refused")
	}
	for i := range rateKeysMax {
		w.allow("k"+strconv.Itoa(i), 1, time.Minute)
	}
	if len(w.hits) > rateKeysMax {
		t.Fatalf("%d keys", len(w.hits))
	}
	if w.allow("new", 1, time.Minute) {
		t.Fatal("a new key past the bound allowed")
	}
	if !w.allow("known", 5, time.Minute) {
		t.Fatal("a known key refused")
	}
}

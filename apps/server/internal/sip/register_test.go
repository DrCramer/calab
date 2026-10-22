package sip

import (
	"context"
	"net/netip"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/rtc"
	"github.com/calaba/calaba/server/internal/sealbox"
)

func regService() *Service {
	secret := []byte("test-secret-test-secret-test-secret")
	return &Service{
		box: sealbox.New("calaba/sip-password/v1", secret), regBox: sealbox.New(regPurpose, secret),
		opts: Options{AllowAddr: publicAddr, Resolver: fakeDNS{
			"sip.example.com": {netip.MustParseAddr("203.0.113.10")},
			"reg.example.com": {netip.MustParseAddr("198.51.100.7")},
			"lan.example.com": {netip.MustParseAddr("10.0.0.5")},
		}},
	}
}

func str(s string) *string { return &s }

// The registration fields of PUT …/sip/inbound (ADR-0121 §8): public registrars only (SSRF),
// sane intervals, digest-safe logins, passwords of 8+ bytes; nil keeps what is saved.
func TestParseRegInput(t *testing.T) {
	s, ctx := regService(), context.Background()
	cur := sqlc.SipAccount{Transport: "udp", RegRegistrar: "reg.example.com:5070", RegExpires: 900, RegKeepaliveSec: 45, RegAuthUsername: "kept"}
	kept, err := s.parseRegInput(ctx, cur, nil)
	if err != nil || kept.registrar != "reg.example.com:5070" || kept.expires != 900 || kept.keepalive != 45 || kept.authUser != "kept" || kept.password != nil {
		t.Fatalf("nil input: %+v %v", kept, err)
	}
	def, err := s.parseRegInput(ctx, cur, &v1.SipRegistrationInput{})
	if err != nil || def.registrar != "" || def.expires != defaultRegExpires || def.keepalive != 0 {
		t.Fatalf("empty input: %+v %v", def, err)
	}
	ok, err := s.parseRegInput(ctx, cur, &v1.SipRegistrationInput{Registrar: "SIP.example.com", Domain: "Voice.Example.com.", ExpiresSec: 3600,
		KeepaliveSec: 15, AuthUsername: "auth", Password: str("longenough")})
	if err != nil || ok.registrar != "sip.example.com" || ok.domain != "voice.example.com" || ok.expires != 3600 || ok.keepalive != 15 || *ok.password != "longenough" {
		t.Fatalf("valid input: %+v %v", ok, err)
	}
	drop, err := s.parseRegInput(ctx, cur, &v1.SipRegistrationInput{Password: str("")})
	if err != nil || drop.password == nil || *drop.password != "" {
		t.Fatalf("drop password: %+v %v", drop, err)
	}
	for field, in := range map[string]*v1.SipRegistrationInput{
		"registrar":       {Registrar: "lan.example.com"},
		"registrar ":      {Registrar: "127.0.0.1:5060"},
		"registrar  ":     {Registrar: "sip:reg.example.com"},
		"domain":          {Domain: "not a domain"},
		"expiresSec":      {ExpiresSec: 59},
		"expiresSec ":     {ExpiresSec: 3601},
		"keepaliveSec":    {KeepaliveSec: 10},
		"keepaliveSec ":   {KeepaliveSec: 121},
		"regAuthUsername": {AuthUsername: `a"b`},
		"regPassword":     {Password: str("short")},
		"regPassword ":    {Password: str("with\nnewline")},
	} {
		_, err := s.parseRegInput(ctx, cur, in)
		if e := httpx.AsError(err); err == nil || e.Field != strings.TrimSpace(field) {
			t.Errorf("%s: %v", field, err)
		}
	}
}

func TestRegisterHelpers(t *testing.T) {
	re := regexp.MustCompile(`^c[a-z2-7]{26}$`)
	a, b := newContactUser(), newContactUser()
	if !re.MatchString(a) || a == b {
		t.Fatalf("contact users %q %q", a, b)
	}
	if p := newTrunkPassword(); len(p) < 40 {
		t.Fatalf("trunk password %q", p)
	}
	for in, want := range map[string]string{
		"sip:cabcdef@203.0.113.7:5080;transport=udp": "sip:c…@203.0.113.7:5080",
		"<sip:cx@1.2.3.4:5080>":                      "",
		"sip:@1.2.3.4":                               "",
		"":                                           "",
	} {
		if got := maskContact(in); got != want {
			t.Errorf("maskContact(%q) = %q, want %q", in, got, want)
		}
	}
	acc := sqlc.SipAccount{Host: "sip.example.com", Port: 5060}
	if regRegistrar(acc) != "sip.example.com:5060" || regDomain(acc) != "sip.example.com" {
		t.Fatal("defaults of registrar / domain")
	}
	acc.RegRegistrar, acc.RegDomain = "reg.example.com", "voice.example.com"
	if regRegistrar(acc) != "reg.example.com:5060" || regDomain(acc) != "voice.example.com" {
		t.Fatal("own registrar / domain")
	}
	if got := cleanReport("401\x00 bad\npassword", 8); got != "401 badp" {
		t.Fatalf("cleanReport: %q", got)
	}
}

// What the agent gets (ADR-0121 §3): the account's credentials unless the registration has its
// own, the trunk's digest, and the sources INVITEs may come from.
func TestRegAccount(t *testing.T) {
	s, ctx := regService(), context.Background()
	seal := func(b interface{ Seal([]byte) ([]byte, error) }, v string) []byte {
		out, err := b.Seal([]byte(v))
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	ws := uuid.New()
	a := sqlc.SipAccount{
		WorkspaceID: ws, Host: "sip.example.com", Port: 5060, Transport: "udp", Username: "130098", AuthUsername: "",
		PasswordEnc: seal(s.box, "account-pw"), CallerID: "+74951234567", InboundMode: modeRegister, RegExpires: 600, RegKeepaliveSec: 30,
		RegContactUser: "ctoken", RegTrunkPasswordEnc: seal(s.regBox, "trunk-pw"), InboundAllowedCidrs: []string{"198.51.100.0/24"},
		RegRegistrar: "reg.example.com:5070",
	}
	got, err := s.regAccount(ctx, a)
	if err != nil {
		t.Fatal(err)
	}
	if got.WS != ws.String() || got.AuthUser != "130098" || got.Password != "account-pw" || got.TrunkUser != "ctoken" || got.TrunkPassword != "trunk-pw" ||
		got.Registrar != "reg.example.com:5070" || got.Domain != "sip.example.com" || got.Number != "+74951234567" || got.Expires != 600 {
		t.Fatalf("account: %+v", got)
	}
	for _, src := range []string{"198.51.100.7", "203.0.113.10", "198.51.100.0/24"} {
		if !slices.Contains(got.AllowedSources, src) {
			t.Errorf("sources %v miss %s", got.AllowedSources, src)
		}
	}
	if v := got.LogValue().String(); strings.Contains(v, "pw") || strings.Contains(v, "ctoken") {
		t.Fatalf("a secret in the log value: %s", v)
	}
	a.RegAuthUsername, a.RegPasswordEnc = "reguser", seal(s.regBox, "reg-pw")
	if got, err = s.regAccount(ctx, a); err != nil || got.AuthUser != "reguser" || got.Password != "reg-pw" {
		t.Fatalf("own credentials: %+v %v", got, err)
	}
	// A registration password sealed for another purpose does not open.
	a.RegPasswordEnc = seal(s.box, "reg-pw")
	if _, err = s.regAccount(ctx, a); err == nil {
		t.Fatal("a password of another purpose opened")
	}

	var tr rtc.SIPInboundTrunk
	a.RegPasswordEnc = nil
	if err := s.registerTrunk(a, &tr); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(tr.AllowedAddresses, []string{"127.0.0.1"}) || tr.AuthUsername != "ctoken" || tr.AuthPassword != "trunk-pw" ||
		tr.HeadersToAttributes[providerCallHeader] != rtc.AttrProviderCallID {
		t.Fatalf("loopback trunk: %+v", tr)
	}
	a.RegTrunkPasswordEnc = nil
	if err := s.registerTrunk(a, &tr); err == nil {
		t.Fatal("a trunk without its password")
	}
}

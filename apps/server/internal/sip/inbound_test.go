package sip

import (
	"slices"
	"testing"
)

// parseCIDRs (ADR-0117): no range wider than /16 (IPv6 /32), IPv4-mapped ranges counted as IPv4,
// only public addresses.
func TestParseInboundCIDRs(t *testing.T) {
	for _, bad := range []string{"0.0.0.0/0", "::/0", "1.0.0.0/8", "203.0.0.0/15", "2001::/16", "::ffff:128.0.0.0/97",
		"::ffff:203.0.0.0/110", "::ffff:0.0.0.0/96", "10.0.0.0/24", "127.0.0.1", "fe80::1", "not an address"} {
		if _, err := parseCIDRs([]string{bad}, publicAddr); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
	got, err := parseCIDRs([]string{"203.0.113.10", "198.51.100.7/24", "::ffff:203.0.113.0/120", "2001:db8::/32", "198.51.100.0/24"}, publicAddr)
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"203.0.113.10/32", "198.51.100.0/24", "203.0.113.0/24", "2001:db8::/32"}; !slices.Equal(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

package ysync

import (
	"math/rand/v2"
	"testing"
	"time"
)

// The access recheck of a socket comes every RecheckInterval ± 20 %: sockets that connected
// together (a restart) spread over a fifth of the interval each way instead of rechecking in step.
func TestRecheckDelay(t *testing.T) {
	every := 30 * time.Second
	for r, want := range map[float64]time.Duration{0: 24 * time.Second, 0.5: 30 * time.Second} {
		if got := recheckDelay(every, r); got != want {
			t.Fatalf("recheckDelay(%v) = %v, want %v", r, got, want)
		}
	}
	lo, hi := time.Hour, time.Duration(0)
	for i := 0; i < 1000; i++ {
		d := recheckDelay(every, rand.Float64()) //nolint:gosec // jitter
		lo, hi = min(lo, d), max(hi, d)
	}
	if lo < 24*time.Second || hi >= 36*time.Second || hi-lo < 10*time.Second {
		t.Fatalf("1000 sockets recheck between %v and %v", lo, hi)
	}
}

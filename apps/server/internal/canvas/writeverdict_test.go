package canvas

import (
	"errors"
	"testing"

	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/moderation"
	"github.com/calaba/calaba/server/internal/ysync"
)

func TestWriteVerdict(t *testing.T) {
	boom := errors.New("db down")
	ok := func() error { return nil }
	cases := []struct {
		name   string
		policy error
		wr     func() error
		write  bool
		code   int
	}{
		{"allowed", nil, ok, true, 0},
		{"policy refusal", httpx.Forbidden("policy"), ok, false, 0},
		{"policy error", boom, ok, false, ysync.CloseTryAgain},
		{"suspended", nil, func() error { return moderation.ErrSuspended }, false, 0},
		{"writable error", nil, func() error { return boom }, false, ysync.CloseTryAgain},
	}
	for _, c := range cases {
		write, code, _ := writeVerdict(c.policy, c.wr)
		if write != c.write || code != c.code {
			t.Errorf("%s: got (%v,%d), want (%v,%d)", c.name, write, code, c.write, c.code)
		}
	}
}

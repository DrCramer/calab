package boards

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/perm"
)

func TestParseTaskSearch(t *testing.T) {
	for raw, want := range map[string]struct {
		sort string
		desc bool
		err  bool
	}{
		"q=abc":                         {sort: "relevance"},
		"":                              {sort: "updated", desc: true},
		"q=!!!":                         {sort: "updated", desc: true}, // no words: no relevance
		"q=abc&sort=-key":               {sort: "key", desc: true},
		"sort=status":                   {sort: "status"},
		"sort=color":                    {err: true},
		"archived=yes":                  {err: true},
		"state=closed":                  {err: true},
		"cursor=2001":                   {err: true},
		"cursor=-1":                     {err: true},
		"board_id=x":                    {err: true},
		"filter=%7B":                    {err: true},
		"q=" + strings.Repeat("a", 201): {err: true},
	} {
		got, err := parseTaskSearch(httptest.NewRequestWithContext(context.Background(), "GET", "/x?"+raw, nil))
		if (err != nil) != want.err {
			t.Errorf("%q: err %v", raw, err)
			continue
		}
		if !want.err && (got.sort != want.sort || got.desc != want.desc) {
			t.Errorf("%q: sort %q desc %v, want %q %v", raw, got.sort, got.desc, want.sort, want.desc)
		}
	}
}

func TestVisibleOnly(t *testing.T) {
	full, scoped, other := uuid.New(), uuid.New(), uuid.New()
	v := Visible{Full: map[uuid.UUID]perm.Bits{full: perm.ViewBoard}, Scoped: map[uuid.UUID]bool{scoped: true}, CreateOnly: map[uuid.UUID]bool{}, Invited: map[uuid.UUID]bool{}}
	if o, ok := v.Only(full); !ok || len(o.Full) != 1 || len(o.Scoped) != 0 {
		t.Fatalf("full: %v %v", o, ok)
	}
	if o, ok := v.Only(scoped); !ok || len(o.Full) != 0 || !o.Scoped[scoped] {
		t.Fatalf("scoped: %v %v", o, ok)
	}
	if _, ok := v.Only(other); ok {
		t.Fatal("a board not seen")
	}
}

func TestSortOrderKeepsEmptyLast(t *testing.T) {
	for _, s := range []string{"due", "assignee", "priority"} {
		for _, desc := range []bool{false, true} {
			if o := sortOrder(taskSearch{sort: s, desc: desc}, "false", nil); !strings.Contains(o, "NULLS LAST") {
				t.Errorf("%s desc=%v: %s", s, desc, o)
			}
		}
	}
}

// Security review #95: task searches take one of a few process slots, so a burst of
// workspace-wide searches cannot hold the whole database pool; a full set answers 503.
func TestSearchSlotsBound(t *testing.T) {
	s := &Service{searchSlots: make(chan struct{}, 2)}
	ctx := context.Background()
	var rel []func()
	for range 2 {
		r, err := s.searchSlot(ctx, time.Millisecond)
		if err != nil {
			t.Fatalf("free slot: %v", err)
		}
		rel = append(rel, r)
	}
	_, err := s.searchSlot(ctx, 5*time.Millisecond)
	if e := httpx.AsError(err); e == nil || e.Status != http.StatusServiceUnavailable {
		t.Fatalf("full: %v, want 503", err)
	}
	rel[0]()
	r, err := s.searchSlot(ctx, time.Millisecond)
	if err != nil {
		t.Fatalf("released slot: %v", err)
	}
	r()
	rel[1]()
	if len(s.searchSlots) != 0 {
		t.Fatalf("slots held: %d", len(s.searchSlots))
	}
	cctx, cancel := context.WithCancel(ctx)
	cancel()
	for range 2 {
		s.searchSlots <- struct{}{}
	}
	if _, err := s.searchSlot(cctx, time.Second); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled request: %v", err)
	}
	if r, err := (&Service{}).searchSlot(ctx, 0); err != nil || r == nil {
		t.Fatalf("unbounded service: %v", err)
	}
}

func TestIsSearchTimeout(t *testing.T) {
	ctx := context.Background()
	stmt := &pgconn.PgError{Code: "57014"}
	for name, c := range map[string]struct {
		err  error
		want bool
	}{
		"nil":       {nil, false},
		"statement": {stmt, true},
		"wrapped":   {httpx.Unavailable(fmt.Errorf("q: %w", stmt)), true},
		"deadline":  {context.DeadlineExceeded, true},
		"other pg":  {&pgconn.PgError{Code: "42601"}, false},
		"other":     {errors.New("boom"), false},
	} {
		if got := isSearchTimeout(ctx, c.err); got != c.want {
			t.Errorf("%s: %v, want %v", name, got, c.want)
		}
	}
	gone, cancel := context.WithCancel(ctx)
	cancel()
	if isSearchTimeout(gone, stmt) {
		t.Error("a request that ended is not a search timeout")
	}
}

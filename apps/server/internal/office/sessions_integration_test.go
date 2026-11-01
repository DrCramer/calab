//go:build integration

package office

import (
	"context"
	"os"
	"slices"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/redisx"
)

// The Valkey sessions against a real Valkey: join, editors, online, revoke, advance, end, live.
func TestValkeySessions(t *testing.T) {
	url := os.Getenv("TEST_REDIS_URL")
	if url == "" {
		t.Fatal("TEST_REDIS_URL required")
	}
	ctx := context.Background()
	c, err := redisx.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	v := ValkeySessions{C: c, TTL: time.Hour}
	item, f1, f2 := uuid.New(), uuid.New(), uuid.New()
	a, b, viewer := uuid.New(), uuid.New(), uuid.New()
	t.Cleanup(func() { _ = v.End(ctx, item, "k1") })

	s, err := v.Join(ctx, item, Session{Key: "k1", FileID: f1}, a, true)
	if err != nil || s.Key != "k1" || s.FileID != f1 {
		t.Fatalf("join %+v %v", s, err)
	}
	if s, _ = v.Join(ctx, item, Session{Key: "k2", FileID: f2}, b, true); s.Key != "k1" || s.FileID != f1 {
		t.Fatalf("the second open must join the first session: %+v", s)
	}
	if _, err := v.Join(ctx, item, Session{Key: "k2", FileID: f2}, viewer, false); err != nil {
		t.Fatal(err)
	}
	if s, _, _ := v.Get(ctx, item); len(s.Editors) != 2 || len(s.Viewers) != 1 || s.Viewers[0] != viewer {
		t.Fatalf("marks %+v", s)
	}
	if changed, err := v.Online(ctx, item, "k1", []uuid.UUID{b, a, viewer}); !changed || err != nil {
		t.Fatalf("online %v %v", changed, err)
	}
	if changed, _ := v.Online(ctx, item, "k1", []uuid.UUID{viewer, a, b}); changed {
		t.Fatal("the same set reported as a change")
	}
	if changed, _ := v.Online(ctx, item, "other", []uuid.UUID{a}); changed {
		t.Fatal("another key changed the session")
	}
	eds, err := v.EditorsOf(ctx, []uuid.UUID{item, uuid.New()})
	if err != nil || len(eds[item]) != 2 || slices.Contains(eds[item], viewer) {
		t.Fatalf("editors %v %v", eds, err)
	}
	if err := v.Revoke(ctx, item, "k1", []uuid.UUID{b}); err != nil {
		t.Fatal(err)
	}
	if eds, _ = v.EditorsOf(ctx, []uuid.UUID{item}); len(eds[item]) != 1 || eds[item][0] != a {
		t.Fatalf("after revoke %v", eds)
	}
	// A revoked editor stays rechecked; a viewer revoke is a no-op; forget removes every mark.
	if err := v.Revoke(ctx, item, "k1", []uuid.UUID{viewer}); err != nil {
		t.Fatal(err)
	}
	if s, _, _ := v.Get(ctx, item); len(s.Revoked) != 1 || s.Revoked[0] != b || len(s.Viewers) != 1 || len(s.Editors) != 1 {
		t.Fatalf("after revoke %+v", s)
	}
	if err := v.Forget(ctx, item, "k1", []uuid.UUID{b, viewer}); err != nil {
		t.Fatal(err)
	}
	if s, _, _ := v.Get(ctx, item); len(s.Revoked) != 0 || len(s.Viewers) != 0 || len(s.Editors) != 1 {
		t.Fatalf("after forget %+v", s)
	}
	if ok, _ := v.Advance(ctx, item, "k2", f2); ok {
		t.Fatal("advanced with a wrong key")
	}
	if ok, _ := v.Advance(ctx, item, "k1", f2); !ok {
		t.Fatal("advance")
	}
	if s, ok, _ := v.Get(ctx, item); !ok || s.FileID != f2 || s.Key != "k1" {
		t.Fatalf("get %+v", s)
	}
	if live, _ := v.Live(ctx); !slices.Contains(live, item) {
		t.Fatal("not live")
	}
	if err := v.End(ctx, item, "k2"); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := v.Get(ctx, item); !ok {
		t.Fatal("ended by a wrong key")
	}
	if err := v.End(ctx, item, "k1"); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := v.Get(ctx, item); ok {
		t.Fatal("not ended")
	}
	if live, _ := v.Live(ctx); slices.Contains(live, item) {
		t.Fatal("still live")
	}
}

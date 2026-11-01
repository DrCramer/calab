package messages

import (
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// TestCoveringReaders: per message only the runs with after_id < M <= upto_id count, the read
// time is the message time clamped into the run (the earliest covering run wins), and a guest
// author's filter drops people it may not see (ADR-0140 §3, §4).
func TestCoveringReaders(t *testing.T) {
	t0 := time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)
	id := func(m int) uuid.UUID { return db.UUIDv7Floor(t0.Add(time.Duration(m) * time.Minute)) }
	msg := func(m int) sqlc.Message {
		return sqlc.Message{ID: id(m), CreatedAt: t0.Add(time.Duration(m) * time.Minute)}
	}
	ann, bob, eve := uuid.New(), uuid.New(), uuid.New()
	after := func(m int) *uuid.UUID { v := id(m); return &v }
	spans := []sqlc.ListReadSpansCoveringRow{
		// ann: from the start up to m10, opened at 20..21; then (m10, m30] at 40..41.
		{UserID: ann, AfterID: nil, UptoID: id(10), FirstAt: t0.Add(20 * time.Minute), LastAt: t0.Add(21 * time.Minute)},
		{UserID: ann, AfterID: after(10), UptoID: id(30), FirstAt: t0.Add(40 * time.Minute), LastAt: t0.Add(41 * time.Minute)},
		// bob: live at the bottom from m5 up to m30 between 5 and 35 — the message time.
		{UserID: bob, AfterID: after(5), UptoID: id(30), FirstAt: t0.Add(5 * time.Minute), LastAt: t0.Add(35 * time.Minute)},
		// eve: (m10, m30] — overlaps a race duplicate (m20, m30] that came later.
		{UserID: eve, AfterID: after(10), UptoID: id(30), FirstAt: t0.Add(50 * time.Minute), LastAt: t0.Add(50 * time.Minute)},
		{UserID: eve, AfterID: after(20), UptoID: id(30), FirstAt: t0.Add(60 * time.Minute), LastAt: t0.Add(60 * time.Minute)},
	}
	type want struct {
		user uuid.UUID
		at   int
	}
	check := func(name string, m sqlc.Message, allowed map[uuid.UUID]bool, ws ...want) {
		t.Helper()
		got := coveringReaders(m, spans, allowed)
		if len(got) != len(ws) {
			t.Fatalf("%s: %d readers %v, want %v", name, len(got), got, ws)
		}
		for i, w := range ws {
			if got[i].GetUserId() != w.user.String() || !got[i].GetReadAt().AsTime().Equal(t0.Add(time.Duration(w.at)*time.Minute)) {
				t.Fatalf("%s[%d] = %s at %v, want %s at +%dm", name, i, got[i].GetUserId(), got[i].GetReadAt().AsTime(), w.user, w.at)
			}
		}
	}
	check("m3", msg(3), nil, want{ann, 20})                                   // bob's run starts after m5
	check("m10", msg(10), nil, want{bob, 10}, want{ann, 20})                  // the run's upper end counts
	check("m25", msg(25), nil, want{bob, 25}, want{ann, 40}, want{eve, 50})   // eve: the earliest covering run
	check("m25 guest", msg(25), map[uuid.UUID]bool{eve: true}, want{eve, 50}) // a guest author sees only eve
	check("m31", msg(31), nil)                                                // past every run
}

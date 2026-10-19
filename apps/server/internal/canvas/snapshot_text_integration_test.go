//go:build integration

package canvas

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/ysync"
)

// The text of a snapshot may carry a NUL (pasted text): Postgres refuses it in text columns, which
// would fail every compaction of the canvas for good (4000, reconnect, the same post again).
func TestCanvasSnapshotWithNUL(t *testing.T) {
	e := newEnv(t, ysync.Config{SnapshotEvery: time.Microsecond})
	p := e.create(e.alice, "", "Nul")
	a := e.dial(e.alice, p.GetId())
	a.next(frameSnapshot)
	a.send(updateFrame(0, []byte("u1")))
	a.next(frameUpdate)
	a.send(post(1, snapshotMeta{PlainText: "a\x00b", Preview: "c\x00d"}, []byte("state")))
	e.waitSnapshot(p.GetId(), 1)
	it, err := e.d.Q.GetCanvasItemText(context.Background(), uuid.MustParse(p.GetId()))
	if err != nil || it.PlainText != "ab" || it.Preview != "cd" {
		t.Fatalf("text %q preview %q: %v", it.PlainText, it.Preview, err)
	}
}

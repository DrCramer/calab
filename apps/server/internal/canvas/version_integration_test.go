//go:build integration

package canvas

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"sort"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/ysync"
)

// Second review, minor 4: the version rule reads the sha256 kept with the last version (00111)
// and only once a version is due — every stored snapshot used to hash the last version's state
// (≤ 4 MiB) inside the canvas's row lock. A version stored before the column gets its hash once,
// when it is first compared. The rule stays: at most one per VersionEvery, only for a changed state.
func TestCanvasVersionHashKept(t *testing.T) {
	e := newEnv(t, ysync.Config{SnapshotEvery: time.Microsecond})
	ctx := context.Background()
	var skew atomic.Int64
	e.svc.Now = func() time.Time { return time.Now().Add(time.Duration(skew.Load())) }
	p := e.create(e.alice, "", "Hashed")
	id := uuid.MustParse(p.GetId())
	a := e.dial(e.alice, p.GetId())
	a.next(frameSnapshot)
	seq := int64(0)
	step := func(state string) {
		seq++
		a.send(updateFrame(0, []byte{byte(seq)}))
		a.next(frameUpdate)
		a.send(post(seq, snapshotMeta{PlainText: state}, []byte(state)))
		e.waitSnapshot(p.GetId(), seq)
	}
	type version struct {
		n    int
		hash []byte
	}
	versions := func() (v version) {
		t.Helper()
		if err := e.d.Pool.QueryRow(ctx, `SELECT count(*), (SELECT state_hash FROM canvas_versions WHERE canvas_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1)
			FROM canvas_versions WHERE canvas_id = $1`, id).Scan(&v.n, &v.hash); err != nil {
			t.Fatal(err)
		}
		return v
	}
	sum := func(s string) []byte { h := sha256.Sum256([]byte(s)); return h[:] }

	step("one")
	if v := versions(); v.n != 1 || !bytes.Equal(v.hash, sum("one")) {
		t.Fatalf("first version %d %x", v.n, v.hash)
	}
	// A version from before 00111.
	if _, err := e.d.Pool.Exec(ctx, `UPDATE canvas_versions SET state_hash = NULL WHERE canvas_id = $1`, id); err != nil {
		t.Fatal(err)
	}
	// Inside the window nothing is compared: its hash is not even computed.
	step("two")
	if v := versions(); v.n != 1 || v.hash != nil {
		t.Fatalf("inside the window: %d versions, hash %x", v.n, v.hash)
	}
	// Past it, the same state as the last version: no version, and the old one has its hash now.
	skew.Store(int64(11 * time.Minute))
	step("one")
	if v := versions(); v.n != 1 || !bytes.Equal(v.hash, sum("one")) {
		t.Fatalf("unchanged past the window: %d versions, hash %x", v.n, v.hash)
	}
	// A changed state: a version, with its hash.
	step("three")
	if v := versions(); v.n != 2 || !bytes.Equal(v.hash, sum("three")) {
		t.Fatalf("changed past the window: %d versions, hash %x", v.n, v.hash)
	}

	// What it saves per stored snapshot of a 4 MiB canvas: the old query hashed the last version.
	big := e.create(e.alice, "", "Big")
	state := make([]byte, MaxState)
	_, _ = rand.Read(state)
	if _, err := e.d.Q.InsertCanvasVersion(ctx, sqlc.InsertCanvasVersionParams{CanvasID: uuid.MustParse(big.GetId()), State: state, Authors: []uuid.UUID{}}); err != nil {
		t.Fatal(err)
	}
	median := func(f func() error) time.Duration {
		ds := make([]time.Duration, 7)
		for i := range ds {
			t0 := time.Now()
			if err := f(); err != nil {
				t.Fatal(err)
			}
			ds[i] = time.Since(t0)
		}
		sort.Slice(ds, func(i, j int) bool { return ds[i] < ds[j] })
		return ds[len(ds)/2]
	}
	bid := uuid.MustParse(big.GetId())
	before := median(func() error {
		var h []byte
		var vid uuid.UUID
		var at time.Time
		return e.d.Pool.QueryRow(ctx, `SELECT id, created_at, sha256(state) FROM canvas_versions WHERE canvas_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, bid).Scan(&vid, &at, &h)
	})
	after := median(func() error { _, err := e.d.Q.LastCanvasVersion(ctx, bid); return err })
	t.Logf("LastCanvasVersion of a 4 MiB version: before %v, after %v (median of 7)", before, after)
}

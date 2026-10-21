//go:build integration

package canvas

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/ysync"
)

// Two writers exchange updates concurrently: each gets its own back with the server's seq and
// the other's, both replicas end with the same bytes; a reconnecting reader and a late joiner
// reach the same document from the snapshot and the updates.
func TestCanvasSyncConvergence(t *testing.T) {
	e := newEnv(t, ysync.Config{})
	p := e.create(e.alice, "", "Live")
	a, b := e.dial(e.alice, p.GetId()), e.dial(e.bob, p.GetId())
	var ra, rb replica
	for c, r := range map[*client]*replica{a: &ra, b: &rb} {
		f := c.next(frameSnapshot)
		if frameSeq(f) != 0 || !bytes.Equal(f[9:], ysync.EmptyState) {
			t.Fatalf("empty canvas snapshot %x", f)
		}
		r.apply(t, f)
	}
	// Interleaved edits of the two clients (the server serialises them under one seq).
	const each = 8
	for i := 0; i < each; i++ {
		a.send(updateFrame(0, []byte(fmt.Sprintf("a%d;", i))))
		b.send(updateFrame(0, []byte(fmt.Sprintf("b%d;", i))))
	}
	for i := 0; i < 2*each; i++ {
		ra.apply(t, a.next(frameUpdate))
		rb.apply(t, b.next(frameUpdate))
	}
	if !bytes.Equal(ra.doc, rb.doc) || ra.last != 2*each {
		t.Fatalf("diverged:\n%q\n%q", ra.doc, rb.doc)
	}
	// Per-sender order is kept inside the common order.
	for _, who := range []string{"a", "b"} {
		at := -1
		for i := 0; i < each; i++ {
			k := bytes.Index(ra.doc, []byte(fmt.Sprintf("%s%d;", who, i)))
			if k < 0 || k < at {
				t.Fatalf("%s%d out of order in %q", who, i, ra.doc)
			}
			at = k
		}
	}
	// Awareness is relayed, never stored.
	a.send([]byte{frameAwareness, 7, 7})
	if f := b.next(frameAwareness); !bytes.Equal(f, []byte{frameAwareness, 7, 7}) {
		t.Fatalf("awareness %x", f)
	}
	// A late joiner and a reconnecting socket get the same document.
	late := e.dial(e.bob, p.GetId())
	var rl replica
	late.catchUp(&rl, 2*each)
	if !bytes.Equal(rl.doc, ra.doc) {
		t.Fatalf("late joiner: %q, want %q", rl.doc, ra.doc)
	}
	// Compaction: the snapshot through 10 holds the first ten updates, the later ones follow it.
	prefix := bytes.Clone(ysync.EmptyState)
	for _, u := range storedUpdates(t, e, p.GetId(), 10) {
		prefix = append(prefix, u...)
	}
	a.send(post(10, snapshotMeta{PlainText: "x"}, prefix))
	b.quiet(a) // a's post was handled before its probe
	again := e.dial(e.alice, p.GetId())
	var rr replica
	again.catchUp(&rr, 2*each)
	if !bytes.Equal(rr.doc, ra.doc) {
		t.Fatalf("after compaction: %q, want %q", rr.doc, ra.doc)
	}
	// Awareness did not become content.
	var n int
	if err := e.d.Pool.QueryRow(context.Background(), `SELECT count(*) FROM canvas_updates WHERE canvas_id = $1`, p.GetId()).Scan(&n); err != nil || n != 2*each-10 {
		t.Fatalf("updates left %d %v", n, err)
	}
}

// storedUpdates returns the first n stored updates of a canvas (before they are compacted).
func storedUpdates(t *testing.T, e *env, id string, n int) [][]byte {
	t.Helper()
	rows, err := e.d.Q.ListCanvasUpdatesSince(context.Background(), sqlc.ListCanvasUpdatesSinceParams{CanvasID: uuid.MustParse(id), Lim: int32(n)}) //nolint:gosec // small
	if err != nil {
		t.Fatal(err)
	}
	out := make([][]byte, len(rows))
	for i, r := range rows {
		out[i] = r.Data
	}
	return out
}

// WRITE vs view only: a member without WRITE receives but may not send; the limits of the
// protocol: 20 updates a second, 2 snapshots at once, 64 KiB per update, 10 sockets per person;
// a bot, a folder, a missing canvas.
func TestCanvasSyncLimits(t *testing.T) {
	e := newEnv(t, ysync.Config{})
	p := e.create(e.alice, "", "Limits")
	e.must(200, e.alice, "PUT", item(p.GetId())+"/permissions", &v1.UpdateCanvasPermissionsRequest{Entries: []*v1.CanvasPermissionEntry{
		{TargetType: user, TargetId: e.bob.String(), Deny: uint64(perm.CanvasWrite)}}}, nil)
	w0 := e.dial(e.alice, p.GetId())
	w0.next(frameSnapshot)
	ro := e.dial(e.bob, p.GetId())
	ro.next(frameSnapshot)
	// The view-only socket still gets what the writer does …
	w0.send(updateFrame(0, []byte("u1")))
	w0.next(frameUpdate)
	if f := ro.next(frameUpdate); string(f[9:]) != "u1" {
		t.Fatalf("view-only socket got %x", f)
	}
	// … but its own awareness is dropped (not an error), its UPDATE and SNAPSHOT_POST close it.
	ro.send([]byte{frameAwareness, 1})
	ro.send(updateFrame(0, []byte("nope"))) // handled after the awareness above
	ro.closed(ysync.CloseForbidden)
	x := e.dial(e.alice, p.GetId())
	x.next(frameSnapshot)
	x.next(frameUpdate)
	w0.quiet(x) // nothing of the view-only socket's awareness came before the probe
	ro2 := e.dial(e.bob, p.GetId())
	ro2.next(frameSnapshot)
	ro2.next(frameUpdate)
	ro2.send(post(0, snapshotMeta{PlainText: "stolen"}, []byte{1}))
	ro2.closed(ysync.CloseForbidden)
	var stored, txt string
	if err := e.d.Pool.QueryRow(context.Background(), `SELECT (SELECT count(*) FROM canvas_updates WHERE canvas_id = $1)::text, plain_text FROM canvas_items WHERE id = $1`, p.GetId()).Scan(&stored, &txt); err != nil || stored != "1" || txt != "" {
		t.Fatalf("a view-only socket changed the canvas: %s %q %v", stored, txt, err)
	}
	// Flood.
	w := e.dial(e.alice, p.GetId())
	w.next(frameSnapshot)
	for i := 0; i < 40; i++ {
		if err := w.ws.Write(context.Background(), websocket.MessageBinary, updateFrame(0, []byte{byte(i)})); err != nil {
			break
		}
	}
	w.closed(ysync.CloseRate)
	// Snapshots: 2 at once, then one per 2 s.
	sp := e.dial(e.alice, p.GetId())
	sp.next(frameSnapshot)
	for i := 0; i < 3; i++ {
		if err := sp.ws.Write(context.Background(), websocket.MessageBinary, post(0, snapshotMeta{}, []byte{0, 0})); err != nil {
			break
		}
	}
	sp.closed(ysync.CloseRate)
	// An update over 64 KiB, a text frame, an unknown frame.
	big := e.dial(e.alice, p.GetId())
	big.next(frameSnapshot)
	big.send(updateFrame(0, make([]byte, ysync.MaxUpdate+1)))
	big.closed(ysync.CloseBadFrame)
	odd := e.dial(e.alice, p.GetId())
	odd.next(frameSnapshot)
	odd.send([]byte{9})
	odd.closed(ysync.CloseBadFrame)
	// Ten sockets per person per canvas.
	var cs []*client
	for i := 0; i < 8; i++ { // w0 and x make ten
		c := e.dial(e.alice, p.GetId())
		c.next(frameSnapshot)
		cs = append(cs, c)
	}
	e.dial(e.alice, p.GetId()).closed(ysync.CloseRate)
	for _, c := range cs {
		_ = c.ws.Close(websocket.StatusNormalClosure, "")
	}
	// Who may not even look: the guest, an outsider, a bad token, a bot (v2), a folder, nothing.
	e.dial(e.guest, p.GetId()).closed(ysync.CloseForbidden)
	e.dial(e.outsider, p.GetId()).closed(ysync.CloseForbidden)
	e.dialToken(e.srv, "bad", p.GetId()).closed(ysync.CloseAuth)
	e.dialToken(e.srv, "bot:"+e.alice.String(), p.GetId()).closed(ysync.CloseForbidden)
	dir := e.mkdir(e.alice, "", "Folder")
	e.dial(e.alice, dir.GetId()).closed(ysync.CloseNotFound)
	e.dial(e.alice, uuid.NewString()).closed(ysync.CloseNotFound)
	// Trashed: gone for the socket opened before as well (kick → recheck).
	live := e.dial(e.bob, p.GetId())
	live.next(frameSnapshot)
	live.next(frameUpdate)
	e.must(200, e.alice, "POST", item(p.GetId())+"/trash", nil, nil)
	live.closed(ysync.CloseNotFound)
	e.dial(e.alice, p.GetId()).closed(ysync.CloseNotFound)
	e.must(200, e.alice, "POST", item(p.GetId())+"/restore", nil, nil)
	// Restricting closes the sockets of those who lost the canvas.
	again := e.dial(e.bob, p.GetId())
	again.next(frameSnapshot)
	again.next(frameUpdate)
	e.must(200, e.alice, "PUT", item(p.GetId())+"/permissions", &v1.UpdateCanvasPermissionsRequest{Restricted: proto.Bool(true)}, nil)
	again.closed(ysync.CloseForbidden)
}

// COMPACT_REQUEST past the threshold; SNAPSHOT_POST compacts and updates the text, preview and
// size; versions at most every VersionEvery and only for a changed state, at most 50; a stale
// snapshot is ignored; a snapshot over 4 MiB is dropped, one over 2 MiB (the Wiki's limit) is
// stored.
func TestCanvasSyncCompaction(t *testing.T) {
	e := newEnv(t, ysync.Config{CompactUpdates: 3, CompactCheckEvery: -1, VersionEvery: time.Millisecond, SnapshotEvery: time.Microsecond})
	ctx := context.Background()
	p := e.create(e.alice, "", "Notes")
	a, b := e.dial(e.alice, p.GetId()), e.dial(e.bob, p.GetId())
	a.next(frameSnapshot)
	b.next(frameSnapshot)
	for i := 1; i <= 4; i++ {
		a.send(updateFrame(0, []byte{'u', byte(i)}))
		a.next(frameUpdate)
		b.next(frameUpdate)
	}
	a.next(frameCompact) // after the 4th (> 3)
	b.quiet(a)           // only the writer that crossed it is asked
	e.ev.take()
	// The snapshot through 4, a silent compaction (no frame to anyone): updates ≤ 4 gone, text,
	// preview and size set.
	state := []byte("state-1")
	a.send(post(4, snapshotMeta{PlainText: "Hello world", Preview: "Hello  world"}, state))
	b.quiet(a) // a's post was handled before its probe: nothing came to b
	a.quiet(b) // … nor back to a
	var n int
	if err := e.d.Pool.QueryRow(ctx, `SELECT count(*) FROM canvas_updates WHERE canvas_id = $1`, p.GetId()).Scan(&n); err != nil || n != 0 {
		t.Fatalf("updates left %d %v", n, err)
	}
	it, err := e.d.Q.GetCanvasItemText(ctx, uuid.MustParse(p.GetId()))
	if err != nil || it.PlainText != "Hello world" || it.Preview != "Hello world" || it.DocSize != int32(len(state)) { //nolint:gosec // 7 bytes
		t.Fatalf("canvas after snapshot: %+v %v", it, err)
	}
	// The tree gets the new preview.
	previewed := false
	for _, ev := range e.ev.take() {
		if ev.GetCanvasItemUpsert().GetItem().GetPreview() == "Hello world" {
			previewed = true
		}
	}
	if !previewed {
		t.Fatal("no CANVAS_ITEM_UPSERT for the preview")
	}
	var vs v1.CanvasVersionsResponse
	e.must(200, e.bob, "GET", item(p.GetId())+"/versions", nil, &vs)
	if len(vs.GetVersions()) != 1 || len(vs.GetVersions()[0].GetAuthorIds()) != 1 || vs.GetVersions()[0].GetSize() != uint32(len(state)) { //nolint:gosec // 7 bytes
		t.Fatalf("versions: %v", &vs)
	}
	w := e.call(e.bob, "GET", item(p.GetId())+"/versions/"+vs.GetVersions()[0].GetId(), nil)
	if w.Code != 200 || !bytes.Equal(w.Body.Bytes(), state) || w.Header().Get("Content-Type") != "application/octet-stream" {
		t.Fatalf("version state: %d %q", w.Code, w.Body.String())
	}
	e.must(404, e.guest, "GET", item(p.GetId())+"/versions/"+vs.GetVersions()[0].GetId(), nil, nil)
	e.must(404, e.bob, "GET", item(p.GetId())+"/versions/"+uuid.NewString(), nil, nil)
	// Stale (through < stored) and ahead (through ≥ next_seq) snapshots are ignored.
	a.send(post(2, snapshotMeta{PlainText: "old"}, []byte("old")))
	a.send(post(99, snapshotMeta{PlainText: "ahead"}, []byte("ahead")))
	b.quiet(a)
	a.quiet(b)
	// A stale broadcast post (an oversized edit) is relayed with through 0, not stored, and the
	// poster is asked for a fresh snapshot.
	a.send(post(2, snapshotMeta{PlainText: "big", Broadcast: true}, []byte("big")))
	if f := b.next(frameSnapshot); frameSeq(f) != 0 || string(f[9:]) != "big" {
		t.Fatalf("relayed stale snapshot %x", f)
	}
	a.next(frameCompact)
	if it, _ := e.d.Q.GetCanvasItemText(ctx, uuid.MustParse(p.GetId())); it.PlainText != "Hello world" {
		t.Fatalf("a stale snapshot was stored: %q", it.PlainText)
	}
	// The same state again: no new version; another update, then a broadcast post: the others
	// get the state as a SNAPSHOT, the poster nothing.
	a.send(updateFrame(0, []byte("u5")))
	a.next(frameUpdate)
	b.next(frameUpdate)
	a.send(post(5, snapshotMeta{PlainText: "Hello world", Broadcast: true}, state))
	if f := b.next(frameSnapshot); frameSeq(f) != 5 || !bytes.Equal(f[9:], state) {
		t.Fatalf("broadcast snapshot %x", f)
	}
	a.quiet(b)
	e.must(200, e.bob, "GET", item(p.GetId())+"/versions", nil, &vs)
	if len(vs.GetVersions()) != 1 {
		t.Fatalf("a version without a change: %d", len(vs.GetVersions()))
	}
	// A changed state is a new version, newest first.
	a.send(updateFrame(0, []byte("u6")))
	a.next(frameUpdate)
	b.next(frameUpdate)
	a.send(post(6, snapshotMeta{PlainText: "Hello again"}, []byte("state-3")))
	b.quiet(a)
	e.must(200, e.bob, "GET", item(p.GetId())+"/versions", nil, &vs)
	if len(vs.GetVersions()) != 2 || vs.GetVersions()[0].GetSize() != 7 {
		t.Fatalf("versions after a change: %v", &vs)
	}
	var act v1.CanvasActivityPage
	e.must(200, e.alice, "GET", item(p.GetId())+"/activity", nil, &act)
	versions := 0
	for _, x := range act.GetActivities() {
		if x.GetKind() == v1.CanvasActivityKind_CANVAS_ACTIVITY_KIND_VERSION {
			versions++
		}
	}
	if versions != 2 {
		t.Fatalf("version entries in the journal: %d", versions)
	}
	// Sizes: 3 MiB is stored (the Wiki stops at 2), 4 MiB + 1 is dropped without closing.
	three := bytes.Repeat([]byte{'z'}, 3<<20)
	a.send(updateFrame(0, []byte("u7")))
	a.next(frameUpdate)
	b.next(frameUpdate)
	a.send(post(7, snapshotMeta{PlainText: "three"}, three))
	b.quiet(a)
	if it, _ := e.d.Q.GetCanvasItemText(ctx, uuid.MustParse(p.GetId())); it.DocSize != int32(len(three)) { //nolint:gosec // 3 MiB
		t.Fatalf("a 3 MiB snapshot: size %d", it.DocSize)
	}
	a.send(post(7, snapshotMeta{PlainText: "huge"}, make([]byte, MaxState+1)))
	b.quiet(a)
	if it, _ := e.d.Q.GetCanvasItemText(ctx, uuid.MustParse(p.GetId())); it.PlainText != "three" {
		t.Fatalf("a snapshot over 4 MiB was stored: %q", it.PlainText)
	}
	// 50 versions at most.
	for i := 0; i < 55; i++ {
		if _, err := e.d.Q.InsertCanvasVersion(ctx, sqlc.InsertCanvasVersionParams{CanvasID: uuid.MustParse(p.GetId()), State: []byte{byte(i)}, Authors: []uuid.UUID{}}); err != nil {
			t.Fatal(err)
		}
		if _, err := e.d.Q.PruneCanvasVersions(ctx, uuid.MustParse(p.GetId())); err != nil {
			t.Fatal(err)
		}
	}
	if err := e.d.Pool.QueryRow(ctx, `SELECT count(*) FROM canvas_versions WHERE canvas_id = $1`, p.GetId()).Scan(&n); err != nil || n != MaxVersions {
		t.Fatalf("versions kept: %d %v", n, err)
	}
}

// Versions are written at most once per VersionEvery (10 minutes by default).
func TestCanvasVersionEvery(t *testing.T) {
	e := newEnv(t, ysync.Config{SnapshotEvery: time.Microsecond})
	var skew atomic.Int64
	e.svc.Now = func() time.Time { return time.Now().Add(time.Duration(skew.Load())) }
	p := e.create(e.alice, "", "Slow")
	a := e.dial(e.alice, p.GetId())
	a.next(frameSnapshot)
	for i := 1; i <= 3; i++ {
		a.send(updateFrame(0, []byte{byte(i)}))
		a.next(frameUpdate)
		a.send(post(int64(i), snapshotMeta{PlainText: fmt.Sprint("v", i)}, []byte{'s', byte(i)}))
	}
	e.waitSnapshot(p.GetId(), 3)
	var vs v1.CanvasVersionsResponse
	e.must(200, e.alice, "GET", item(p.GetId())+"/versions", nil, &vs)
	if len(vs.GetVersions()) != 1 {
		t.Fatalf("versions within the window: %d", len(vs.GetVersions()))
	}
	// Moving the clock past the window lets the next changed state through.
	skew.Store(int64(11 * time.Minute))
	a.send(updateFrame(0, []byte{4}))
	a.next(frameUpdate)
	a.send(post(4, snapshotMeta{PlainText: "v4"}, []byte{'s', 4}))
	e.waitSnapshot(p.GetId(), 4)
	e.must(200, e.alice, "GET", item(p.GetId())+"/versions", nil, &vs)
	if len(vs.GetVersions()) != 2 {
		t.Fatalf("versions after the window: %d", len(vs.GetVersions()))
	}
}

// meta.objects: a snapshot of a document the client reports empty (objects 0) is stored but starts
// no history; with objects ≥ 1 the version rules apply; without the field (an older client) the
// behaviour is what it was.
func TestCanvasEmptyDocumentNoVersion(t *testing.T) {
	e := newEnv(t, ysync.Config{VersionEvery: time.Millisecond, SnapshotEvery: time.Microsecond})
	ctx := context.Background()
	p := e.create(e.alice, "", "Blank")
	a := e.dial(e.alice, p.GetId())
	a.next(frameSnapshot)
	versions := func() int {
		var vs v1.CanvasVersionsResponse
		e.must(200, e.alice, "GET", item(p.GetId())+"/versions", nil, &vs)
		return len(vs.GetVersions())
	}
	obj := func(n int) *int { return &n }
	step := func(seq int64, meta snapshotMeta, state []byte) {
		a.send(updateFrame(0, []byte{byte(seq)})) //nolint:gosec // seq ≤ 4
		a.next(frameUpdate)
		a.send(post(seq, meta, state))
		e.waitSnapshot(p.GetId(), seq)
	}
	// An empty Yjs document of the client is 26 bytes, not the 2-byte empty update.
	blank := bytes.Repeat([]byte{0}, 26)
	step(1, snapshotMeta{Objects: obj(0)}, blank)
	if it, err := e.d.Q.GetCanvasItemText(ctx, uuid.MustParse(p.GetId())); err != nil || it.DocSize != 26 {
		t.Fatalf("the empty snapshot is not kept: %+v %v", it, err)
	}
	if n := versions(); n != 0 {
		t.Fatalf("a version of an empty document: %d", n)
	}
	// Objects on the canvas: the first version.
	step(2, snapshotMeta{PlainText: "a", Objects: obj(1)}, []byte("one"))
	if n := versions(); n != 1 {
		t.Fatalf("versions with an object: %d", n)
	}
	// Emptied again: stored, no version (a changed state, the window long over).
	step(3, snapshotMeta{Objects: obj(0)}, blank)
	if n := versions(); n != 1 {
		t.Fatalf("a version of the emptied document: %d", n)
	}
	// An older client sends no count: a changed state is a version as before.
	step(4, snapshotMeta{PlainText: "b"}, []byte("two"))
	if n := versions(); n != 2 {
		t.Fatalf("versions without the field: %d", n)
	}
}

// Two server instances (one database, one Valkey): sockets on different instances get each
// other's updates and awareness through canvas:<id>.
func TestCanvasSyncAcrossInstances(t *testing.T) {
	e := newEnv(t, ysync.Config{})
	p := e.create(e.alice, "", "Shared")
	other := New(e.d, e.ev)
	other.EnableSync(e.rc, fakeAuth{}, nil, ysync.Config{})
	mux := http.NewServeMux()
	other.Routes(mux, func(h http.Handler) http.Handler { return h })
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	a := e.dial(e.alice, p.GetId())
	a.next(frameSnapshot)
	b := e.dialToken(srv, e.bob.String(), p.GetId())
	b.next(frameSnapshot) // sent only after the second instance's SUBSCRIBE was confirmed
	a.send(updateFrame(0, []byte("x1")))
	a.next(frameUpdate)
	if f := b.next(frameUpdate); frameSeq(f) != 1 || string(f[9:]) != "x1" {
		t.Fatalf("relayed %x", f)
	}
	b.send(updateFrame(0, []byte("y1")))
	if f := a.next(frameUpdate); frameSeq(f) != 2 || string(f[9:]) != "y1" {
		t.Fatalf("relayed back %x", f)
	}
	b.next(frameUpdate)
	b.send([]byte{frameAwareness, 1})
	a.next(frameAwareness)
	// A trash on the first instance closes the sockets of the second (ctlRecheck over Redis).
	e.must(200, e.alice, "POST", item(p.GetId())+"/trash", nil, nil)
	b.closed(ysync.CloseNotFound)
}

// A frame lost between instances (published before the subscription, or dropped) is filled from
// the database by the next update's sequence check.
func TestCanvasSyncGapCatchUp(t *testing.T) {
	e := newEnv(t, ysync.Config{})
	p := e.create(e.alice, "", "Gaps")
	a := e.dial(e.alice, p.GetId())
	a.next(frameSnapshot)
	// Updates written behind the sockets' back (another instance whose publish was lost).
	for _, d := range []string{"g1", "g2"} {
		if _, err := e.d.Q.AppendCanvasUpdate(context.Background(), sqlc.AppendCanvasUpdateParams{CanvasID: uuid.MustParse(p.GetId()), Data: []byte(d)}); err != nil {
			t.Fatal(err)
		}
	}
	a.send(updateFrame(0, []byte("g3")))
	for want := int64(1); want <= 3; want++ {
		if f := a.next(frameUpdate); frameSeq(f) != want {
			t.Fatalf("seq %d, want %d", frameSeq(f), want)
		}
	}
}

// waitSnapshot waits until the stored snapshot of a canvas reaches through (posts are silent).
func (e *env) waitSnapshot(id string, through int64) {
	e.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if seq, err := e.d.Q.GetCanvasSnapshotSeq(context.Background(), uuid.MustParse(id)); err == nil && seq >= through {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	e.t.Fatalf("snapshot through %d not stored", through)
}

// The hard ceiling of the updates after the snapshot (ysync Config.CeilingUpdates / CeilingBytes,
// shared with the Wiki): at it an UPDATE is dropped (not stored, not relayed), every socket with
// WRITE — not a view-only one — gets COMPACT_REQUEST once per cooldown, a snapshot lifts it, and a
// socket that keeps sending past CeilingGrace is closed 4012.
func TestCanvasSyncCeiling(t *testing.T) {
	e := newEnv(t, ysync.Config{CeilingUpdates: 3, CeilingGrace: 400 * time.Millisecond, CompactCheckEvery: -1, SnapshotEvery: time.Microsecond})
	ctx := context.Background()
	p := e.create(e.alice, "", "Ceiling")
	e.must(200, e.alice, "PUT", item(p.GetId())+"/permissions", &v1.UpdateCanvasPermissionsRequest{Entries: []*v1.CanvasPermissionEntry{
		{TargetType: user, TargetId: e.bob.String(), Deny: uint64(perm.CanvasWrite)}}}, nil)
	a, a2, w, ro := e.dial(e.alice, p.GetId()), e.dial(e.alice, p.GetId()), e.dial(e.alice, p.GetId()), e.dial(e.bob, p.GetId())
	a.next(frameSnapshot)
	a2.next(frameSnapshot)
	w.next(frameSnapshot)
	ro.next(frameSnapshot)
	count := func() int {
		var n int
		if err := e.d.Pool.QueryRow(ctx, `SELECT count(*) FROM canvas_updates WHERE canvas_id = $1`, p.GetId()).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	for i := 1; i <= 3; i++ {
		a.send(updateFrame(0, []byte{'u', byte(i)}))
		a.next(frameUpdate)
		a2.next(frameUpdate)
		w.next(frameUpdate)
		ro.next(frameUpdate)
	}
	// The 4th is over the ceiling: dropped, and the writers (not the view-only socket) are asked
	// to compact.
	a.send(updateFrame(0, []byte("u4")))
	a.next(frameCompact)
	a2.next(frameCompact)
	w.next(frameCompact)
	ro.quiet(a2) // nothing of the 4th update, no COMPACT_REQUEST
	w.next(frameAwareness)
	if n := count(); n != 3 {
		t.Fatalf("updates stored at the ceiling: %d", n)
	}
	// Within the cooldown no second request, and the update is still refused.
	a.send(updateFrame(0, []byte("u5")))
	a2.quiet(a)
	w.next(frameAwareness)
	ro.next(frameAwareness) // the probe reaches the view-only socket too
	if n := count(); n != 3 {
		t.Fatalf("updates stored at the ceiling: %d", n)
	}
	// Past the grace the socket that keeps sending is closed.
	time.Sleep(500 * time.Millisecond)
	a.send(updateFrame(0, []byte("u6")))
	a.closed(ysync.CloseCeiling)
	// A snapshot through 3 of a socket without refused updates lifts the ceiling silently: it holds
	// nothing the others lack (the refused updates come back with their socket's reconnect).
	a2.send(post(3, snapshotMeta{PlainText: "compacted"}, []byte("state")))
	ro.quiet(a2)
	w.next(frameAwareness)
	// The next update is stored under seq 4 and relayed.
	a2.send(updateFrame(0, []byte("u7")))
	if f := a2.next(frameUpdate); frameSeq(f) != 4 || string(f[9:]) != "u7" {
		t.Fatalf("update after the snapshot %x", f)
	}
	w.next(frameUpdate)
	ro.next(frameUpdate)
	// A later snapshot is not relayed either.
	a2.send(post(4, snapshotMeta{PlainText: "again"}, []byte("state2")))
	a2.send(updateFrame(0, []byte("u8")))
	a2.next(frameUpdate)
	if f := w.next(frameUpdate); string(f[9:]) != "u8" {
		t.Fatalf("snapshot relayed without a refusal: %x", f)
	}
	if n := count(); n != 1 {
		t.Fatalf("updates after the snapshot: %d", n)
	}
}

// The byte ceiling: an update that would take the stored bytes past it is refused; one that fits
// is stored (from a socket without a refused update: the refused one's next update reconnects it,
// TestCanvasSyncCeilingRefusedWriters).
func TestCanvasSyncCeilingBytes(t *testing.T) {
	e := newEnv(t, ysync.Config{CeilingBytes: 10, CompactCheckEvery: -1})
	p := e.create(e.alice, "", "Ceiling bytes")
	a, b := e.dial(e.alice, p.GetId()), e.dial(e.alice, p.GetId())
	a.next(frameSnapshot)
	b.next(frameSnapshot)
	for i := 0; i < 2; i++ {
		a.send(updateFrame(0, []byte("1234")))
		a.next(frameUpdate)
		b.next(frameUpdate)
	}
	a.send(updateFrame(0, []byte("1234"))) // 12 > 10
	a.next(frameCompact)
	b.next(frameCompact)
	b.send(updateFrame(0, []byte("12"))) // 10 fits
	if f := b.next(frameUpdate); frameSeq(f) != 3 {
		t.Fatalf("update %x", f)
	}
}

// ceilingRoom is a canvas at its update ceiling (CeilingUpdates 3) with two writers A (alice) and
// B (the owner) and a reader C (bob without CANVAS_WRITE): A's three updates are stored, its fourth
// ("a4") is refused and both writers are asked to compact.
func (e *env) ceilingRoom(name string) (id string, a, b, c *client) {
	e.t.Helper()
	p := e.create(e.alice, "", name)
	id = p.GetId()
	e.must(200, e.alice, "PUT", item(id)+"/permissions", &v1.UpdateCanvasPermissionsRequest{Entries: []*v1.CanvasPermissionEntry{
		{TargetType: user, TargetId: e.bob.String(), Deny: uint64(perm.CanvasWrite)}}}, nil)
	a, b, c = e.dial(e.alice, id), e.dial(e.owner, id), e.dial(e.bob, id)
	for _, x := range []*client{a, b, c} {
		x.next(frameSnapshot)
	}
	for i := 1; i <= 3; i++ {
		a.send(updateFrame(0, []byte(fmt.Sprintf("u%d", i))))
		for _, x := range []*client{a, b, c} {
			x.next(frameUpdate)
		}
	}
	a.send(updateFrame(0, []byte("a4")))
	a.next(frameCompact)
	b.next(frameCompact)
	c.quiet(b) // the reader gets neither "a4" nor a COMPACT_REQUEST
	a.next(frameAwareness)
	return id, a, b, c
}

// wantFrame reads the next frame of c and checks its type, seq and body.
func wantFrame(c *client, typ byte, seq int64, body string) {
	c.t.Helper()
	if f := c.next(typ); frameSeq(f) != seq || string(f[9:]) != body {
		c.t.Fatalf("frame %d seq %d %q, want seq %d %q", f[0], frameSeq(f), f[9:], seq, body)
	}
}

// M3 of the second review: an UPDATE refused at the ceiling reaches every socket and the storage
// however the writers' snapshots interleave. The states are opaque here: "stateA" holds A's refused
// "a4", "stateB" does not.
func TestCanvasSyncCeilingRefusedWriters(t *testing.T) {
	e := newEnv(t, ysync.Config{CeilingUpdates: 3, CompactCheckEvery: -1, SnapshotEvery: time.Microsecond})
	ctx := context.Background()
	// storeBehind stores a snapshot through 3 as another instance would whose ctlCompacted never
	// arrived: the ceiling is lifted and A was not told.
	storeBehind := func(id string) {
		t.Helper()
		doc := uuid.MustParse(id)
		if _, err := e.d.Q.UpsertCanvasSnapshot(ctx, sqlc.UpsertCanvasSnapshotParams{CanvasID: doc, State: []byte("stateB"), ThroughSeq: 3}); err != nil {
			t.Fatal(err)
		}
		if _, err := e.d.Q.DeleteCanvasUpdatesThrough(ctx, sqlc.DeleteCanvasUpdatesThroughParams{CanvasID: doc, ThroughSeq: 3}); err != nil {
			t.Fatal(err)
		}
	}
	t.Run("the other writer's snapshot first", func(t *testing.T) {
		id, a, b, c := e.ceilingRoom("B first")
		// B's snapshot lifts the ceiling silently; A is told to reconnect.
		b.send(post(3, snapshotMeta{PlainText: "b"}, []byte("stateB")))
		a.closed(ysync.CloseTryAgain)
		c.quiet(b)
		// The client's replay after the reconnect: what the stored snapshot lacks.
		a2 := e.dial(e.alice, id)
		wantFrame(a2, frameSnapshot, 3, "stateB")
		a2.send(updateFrame(0, []byte("a4")))
		for _, x := range []*client{a2, b, c} {
			wantFrame(x, frameUpdate, 4, "a4")
		}
		late := e.dial(e.alice, id)
		wantFrame(late, frameSnapshot, 3, "stateB")
		wantFrame(late, frameUpdate, 4, "a4")
	})
	t.Run("its own snapshot first", func(t *testing.T) {
		id, a, b, c := e.ceilingRoom("A first")
		// A's snapshot is stored under a seq of its own (4) and relayed; A gets the seq alone.
		a.send(post(3, snapshotMeta{PlainText: "a"}, []byte("stateA")))
		if f := a.next(frameUpdate); frameSeq(f) != 4 || !bytes.Equal(f[9:], ysync.EmptyState) {
			t.Fatalf("the poster's position %x", f)
		}
		wantFrame(b, frameSnapshot, 4, "stateA")
		wantFrame(c, frameSnapshot, 4, "stateA")
		// B's snapshot from the older base (posted before it got A's) is stale: the storage keeps a4.
		b.send(post(3, snapshotMeta{PlainText: "b"}, []byte("stateB")))
		c.quiet(b)
		a.next(frameAwareness)
		wantFrame(e.dial(e.bob, id), frameSnapshot, 4, "stateA")
		// A is an ordinary writer again.
		a.send(updateFrame(0, []byte("a5")))
		for _, x := range []*client{a, b, c} {
			wantFrame(x, frameUpdate, 5, "a5")
		}
	})
	t.Run("the other's snapshot stored, then its own", func(t *testing.T) {
		id, a, b, c := e.ceilingRoom("B stored, A after")
		storeBehind(id)
		// A's post from before B's snapshot is behind it: relayed (the others get a4 now) with
		// through 0, not stored, and A is asked again.
		a.send(post(2, snapshotMeta{PlainText: "a"}, []byte("stateA")))
		wantFrame(b, frameSnapshot, 0, "stateA")
		wantFrame(c, frameSnapshot, 0, "stateA")
		a.next(frameCompact)
		// Its next one holds every stored update: stored under seq 4 and relayed.
		a.send(post(3, snapshotMeta{PlainText: "a"}, []byte("stateA")))
		if f := a.next(frameUpdate); frameSeq(f) != 4 {
			t.Fatalf("the poster's position %x", f)
		}
		wantFrame(b, frameSnapshot, 4, "stateA")
		wantFrame(c, frameSnapshot, 4, "stateA")
		wantFrame(e.dial(e.bob, id), frameSnapshot, 4, "stateA")
	})
	t.Run("the ceiling lifted, then its next update", func(t *testing.T) {
		id, a, b, c := e.ceilingRoom("A updates after the lift")
		storeBehind(id)
		// "a5" may build on the refused "a4": not stored, A reconnects and replays both.
		a.send(updateFrame(0, []byte("a5")))
		a.closed(ysync.CloseTryAgain)
		c.quiet(b)
		a2 := e.dial(e.alice, id)
		wantFrame(a2, frameSnapshot, 3, "stateB")
		a2.send(updateFrame(0, []byte("a4a5")))
		for _, x := range []*client{a2, b, c} {
			wantFrame(x, frameUpdate, 4, "a4a5")
		}
	})
}

// A run of refusals ends after 2 × CeilingGrace without one: a socket refused long ago gets the
// whole grace again before 4012.
func TestCanvasSyncCeilingGraceRun(t *testing.T) {
	e := newEnv(t, ysync.Config{CeilingUpdates: 1, CeilingGrace: 400 * time.Millisecond, CompactCheckEvery: -1})
	p := e.create(e.alice, "", "Grace")
	a, b := e.dial(e.alice, p.GetId()), e.dial(e.alice, p.GetId())
	a.next(frameSnapshot)
	b.next(frameSnapshot)
	a.send(updateFrame(0, []byte("u1")))
	a.next(frameUpdate)
	b.next(frameUpdate)
	a.send(updateFrame(0, []byte("u2"))) // refused: the run starts
	a.next(frameCompact)
	b.next(frameCompact)
	time.Sleep(1000 * time.Millisecond)  // quiet for longer than twice the grace: the run is over
	a.send(updateFrame(0, []byte("u3"))) // refused, a new run (no 4012)
	a.quiet(b)
	time.Sleep(200 * time.Millisecond)
	a.send(updateFrame(0, []byte("u4"))) // still inside the new run's grace
	a.quiet(b)
	time.Sleep(250 * time.Millisecond)
	a.send(updateFrame(0, []byte("u5"))) // the same run, past its grace
	a.closed(ysync.CloseCeiling)
}

// Another instance's count of the updates is forgotten when a snapshot is stored elsewhere
// (ctlCompacted): within its 2 s cache it no longer refuses what the lifted ceiling admits, and its
// socket with a refused update reconnects and resends it.
func TestCanvasSyncCeilingLiftedAcrossInstances(t *testing.T) {
	cfg := ysync.Config{CeilingUpdates: 3, CompactCheckEvery: 2 * time.Second, SnapshotEvery: time.Microsecond}
	e := newEnv(t, cfg)
	p := e.create(e.alice, "", "Lifted")
	other := New(e.d, e.ev)
	other.EnableSync(e.rc, fakeAuth{}, nil, cfg)
	mux := http.NewServeMux()
	other.Routes(mux, func(h http.Handler) http.Handler { return h })
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	a := e.dial(e.alice, p.GetId())
	a.next(frameSnapshot)
	b, b2 := e.dialToken(srv, e.bob.String(), p.GetId()), e.dialToken(srv, e.bob.String(), p.GetId())
	b.next(frameSnapshot)
	b2.next(frameSnapshot)
	for i := 1; i <= 3; i++ {
		a.send(updateFrame(0, []byte(fmt.Sprintf("u%d", i))))
		for _, x := range []*client{a, b, b2} {
			x.next(frameUpdate)
		}
	}
	b.send(updateFrame(0, []byte("b4"))) // the second instance reads 3 and caches it: refused
	for _, x := range []*client{a, b, b2} {
		x.next(frameCompact)
	}
	a.send(post(3, snapshotMeta{PlainText: "a"}, []byte("stateA")))
	b.closed(ysync.CloseTryAgain) // the second instance heard of the snapshot
	b2.send(updateFrame(0, []byte("b5")))
	wantFrame(b2, frameUpdate, 4, "b5")
	wantFrame(a, frameUpdate, 4, "b5")
	// B's replay.
	b3 := e.dialToken(srv, e.bob.String(), p.GetId())
	wantFrame(b3, frameSnapshot, 3, "stateA")
	wantFrame(b3, frameUpdate, 4, "b5")
	b3.send(updateFrame(0, []byte("b4")))
	for _, x := range []*client{a, b2, b3} {
		wantFrame(x, frameUpdate, 5, "b4")
	}
}

// The ceiling holds across instances: the count is the database's, and the COMPACT_REQUEST
// reaches the writers on the other instance through Redis.
func TestCanvasSyncCeilingAcrossInstances(t *testing.T) {
	cfg := ysync.Config{CeilingUpdates: 2, CompactCheckEvery: -1}
	e := newEnv(t, cfg)
	p := e.create(e.alice, "", "Shared ceiling")
	other := New(e.d, e.ev)
	other.EnableSync(e.rc, fakeAuth{}, nil, cfg)
	mux := http.NewServeMux()
	other.Routes(mux, func(h http.Handler) http.Handler { return h })
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	a := e.dial(e.alice, p.GetId())
	a.next(frameSnapshot)
	b := e.dialToken(srv, e.bob.String(), p.GetId())
	b.next(frameSnapshot)
	a.send(updateFrame(0, []byte("x1")))
	a.next(frameUpdate)
	b.next(frameUpdate)
	b.send(updateFrame(0, []byte("y1"))) // stored by the second instance
	a.next(frameUpdate)
	b.next(frameUpdate)
	a.send(updateFrame(0, []byte("x2"))) // over the ceiling
	a.next(frameCompact)
	b.next(frameCompact)
	b.send(updateFrame(0, []byte("y2")))
	a.quiet(b)
	var n int
	if err := e.d.Pool.QueryRow(context.Background(), `SELECT count(*) FROM canvas_updates WHERE canvas_id = $1`, p.GetId()).Scan(&n); err != nil || n != 2 {
		t.Fatalf("updates stored: %d %v", n, err)
	}
}

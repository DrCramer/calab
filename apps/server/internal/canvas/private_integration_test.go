//go:build integration

package canvas

import (
	"context"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/canvasacl"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/ysync"
)

// A restricted item («Только выбранные») is not seen by the administrator nor the workspace
// owner (ADR-0126 §2, addendum 2026-10-14): 404 on it and its subitems, not in listings, paths,
// search, versions, the workspace journal or the events they get; their «empty the trash» skips
// it; the people let in see it.
func TestCanvasPrivateItemHiddenFromAdmins(t *testing.T) {
	e := newEnv(t, ysync.Config{})
	ctx := context.Background()
	ws := "/api/workspaces/" + e.ws.String()
	design := uuid.New()
	if _, err := e.d.Pool.Exec(ctx, `INSERT INTO workspace_roles (id, workspace_id, name, position, permissions) VALUES ($1, $2, 'Design', 5, 0)`, design, e.ws); err != nil {
		t.Fatal(err)
	}
	if _, err := e.d.Pool.Exec(ctx, `INSERT INTO member_roles (workspace_id, user_id, role_id) VALUES ($1, $2, $3)`, e.ws, e.bob, design); err != nil {
		t.Fatal(err)
	}
	m, err := perm.NewResolver(e.d.Q).Member(ctx, e.ws, e.admin)
	if err != nil {
		t.Fatal(err)
	}
	adminSees := func(levels []*v1.CanvasAccessLevel) bool {
		return len(levels) > 0 && perm.ComputeCanvasItemIn(m, canvasacl.FromLevels(levels)).Has(perm.CanvasView)
	}
	e.mkdir(e.alice, "", "Open")
	salaries := e.mkdir(e.alice, "", "Salaries")
	ledger := e.create(e.alice, salaries.GetId(), "Ledger")
	if _, err := e.d.Pool.Exec(ctx, `UPDATE canvas_items SET plain_text = 'budget salaries' WHERE id = $1`, ledger.GetId()); err != nil {
		t.Fatal(err)
	}
	e.ev.take()
	e.must(200, e.alice, "PUT", item(salaries.GetId())+"/permissions", &v1.UpdateCanvasPermissionsRequest{Restricted: proto.Bool(true),
		Entries: []*v1.CanvasPermissionEntry{
			{TargetType: role, TargetId: design.String(), Allow: uint64(perm.CanvasView | perm.CanvasWrite)},
			{TargetType: user, TargetId: e.guest.String(), Allow: uint64(perm.CanvasView)},
		}}, nil)
	// The admin saw the item before and not after: the gateway sends it CANVAS_ITEM_REMOVE.
	var restrict *v1.CanvasItemUpsert
	for _, ev := range e.ev.take() {
		if u := ev.GetCanvasItemUpsert(); u != nil && u.GetItem().GetId() == salaries.GetId() {
			restrict = u
		}
	}
	if restrict == nil || !adminSees(restrict.GetAccessBefore()) || adminSees(restrict.GetAccess()) {
		t.Fatalf("restrict event: %v", restrict)
	}
	sub := e.mkdir(e.alice, salaries.GetId(), "2026")
	evs := e.ev.take()
	if len(evs) == 0 {
		t.Fatal("no events inside")
	}
	for _, ev := range evs {
		if u := ev.GetCanvasItemUpsert(); u != nil && adminSees(u.GetAccess()) {
			t.Fatalf("an event of a private item would reach the admin: %v", ev)
		}
	}

	for _, u := range []uuid.UUID{e.admin, e.owner} {
		for _, id := range []string{salaries.GetId(), sub.GetId(), ledger.GetId()} {
			e.must(404, u, "GET", item(id), nil, nil)
			e.must(404, u, "GET", item(id)+"/path", nil, nil)
			e.must(404, u, "GET", item(id)+"/activity", nil, nil)
			e.must(404, u, "GET", item(id)+"/versions", nil, nil)
			e.dial(u, id).closed(ysync.CloseForbidden)
			e.must(404, u, "GET", item(id)+"/permissions", nil, nil)
			e.must(404, u, "PATCH", item(id), &v1.UpdateCanvasItemRequest{Name: proto.String("x")}, nil)
			e.must(404, u, "POST", item(id)+"/trash", nil, nil)
		}
		e.must(404, u, "GET", ws+"/canvas/items?parent="+salaries.GetId(), nil, nil)
		if got := e.names(u, ""); !slices.Equal(got, []string{"Open"}) {
			t.Fatalf("%v lists %v", u, got)
		}
		var found v1.SearchResponse
		e.must(200, u, "GET", "/api/search?scope="+e.ws.String()+"&type=canvas&q=salaries", nil, &found)
		if hits := found.GetSections()[0].GetItems(); len(hits) != 0 {
			t.Fatalf("%v found the private item: %v", u, hits)
		}
	}
	// Let in by role (bob, editing) and by name (the guest, view only).
	e.must(200, e.bob, "GET", item(sub.GetId()), nil, nil)
	e.mkdir(e.bob, salaries.GetId(), "Bob's")
	e.must(200, e.guest, "GET", item(sub.GetId()), nil, nil)
	if got := e.names(e.bob, ""); len(got) != 2 {
		t.Fatalf("bob lists %v", got)
	}
	// The workspace journal of the admin names nothing of the private item.
	journal := func(u uuid.UUID) []string {
		t.Helper()
		var act v1.CanvasActivityPage
		e.must(200, u, "GET", ws+"/canvas/activity?limit=2", nil, &act)
		var titles []string
		for {
			for _, a := range act.GetActivities() {
				titles = append(titles, a.GetItemName())
				if a.GetBefore().GetFields()["parent_name"].GetStringValue() == "Salaries" || a.GetAfter().GetFields()["parent_name"].GetStringValue() == "Salaries" {
					titles = append(titles, "parent:Salaries")
				}
			}
			if act.GetNextCursor() == "" {
				return titles
			}
			cur := act.GetNextCursor()
			act.Reset()
			e.must(200, u, "GET", ws+"/canvas/activity?limit=2&cursor="+cur, nil, &act)
		}
	}
	private := []string{"Salaries", "2026", "Bob's", "parent:Salaries"}
	if got := journal(e.admin); !slices.Contains(got, "Open") || slices.ContainsFunc(got, func(n string) bool { return slices.Contains(private, n) }) {
		t.Fatalf("the admin's journal: %v", got)
	}
	// Trash: the admin neither lists nor empties the private item; its owner does.
	gone := e.mkdir(e.bob, "", "Old")
	e.must(200, e.bob, "POST", item(gone.GetId())+"/trash", nil, nil)
	e.must(200, e.alice, "POST", item(salaries.GetId())+"/trash", nil, nil)
	if got := e.names(e.admin, "trashed=1"); !slices.Equal(got, []string{"Old"}) {
		t.Fatalf("the admin's trash: %v", got)
	}
	var emptied v1.EmptyCanvasTrashResponse
	e.must(200, e.admin, "POST", ws+"/canvas/trash/empty", nil, &emptied)
	if emptied.GetDeleted() != 1 {
		t.Fatalf("the admin emptied %v", &emptied)
	}
	if got := e.names(e.alice, "trashed=1"); !slices.Equal(got, []string{"Salaries"}) {
		t.Fatalf("alice's trash after the admin's: %v", got)
	}
	e.must(204, e.alice, "DELETE", item(salaries.GetId()), nil, nil)
	// Deleted forever: its entries stay out of the admin's journal (private), the open one shows.
	got := journal(e.admin)
	if slices.ContainsFunc(got, func(n string) bool { return slices.Contains(private, n) }) || !slices.Contains(got, "Old") {
		t.Fatalf("the admin's journal after the delete: %v", got)
	}
}

// An administrator let in by name is an ordinary member there (owner, 14.10): with editing it
// edits, but neither opens the access dialog nor changes the structure of another's item; its
// sync socket is refused until it is let in; the workspace owner, not let in, still gets 404.
func TestCanvasPrivateItemAdminLetIn(t *testing.T) {
	e := newEnv(t, ysync.Config{})
	p := e.mkdir(e.alice, "", "Board notes")
	cv := e.create(e.alice, p.GetId(), "Sprint board")
	e.must(200, e.alice, "PUT", item(p.GetId())+"/permissions", &v1.UpdateCanvasPermissionsRequest{Restricted: proto.Bool(true)}, nil)
	e.dial(e.admin, cv.GetId()).closed(ysync.CloseForbidden)
	e.dial(e.owner, cv.GetId()).closed(ysync.CloseForbidden)
	e.must(200, e.alice, "PUT", item(p.GetId())+"/permissions", &v1.UpdateCanvasPermissionsRequest{
		Entries: []*v1.CanvasPermissionEntry{{TargetType: user, TargetId: e.admin.String(), Allow: uint64(perm.CanvasView)}}}, nil)
	var seen v1.CanvasItemResponse
	e.must(200, e.admin, "GET", item(p.GetId()), nil, &seen)
	if seen.GetItem().GetMyBits() != uint64(perm.CanvasView) {
		t.Fatalf("the admin with VIEW: %b", seen.GetItem().GetMyBits())
	}
	// Let in with VIEW only, the admin's socket on the canvas below is view only.
	ro := e.dial(e.admin, cv.GetId())
	ro.next(frameSnapshot)
	ro.send(updateFrame(0, []byte("x")))
	ro.closed(ysync.CloseForbidden)
	e.must(403, e.admin, "GET", item(p.GetId())+"/permissions", nil, nil)
	e.must(200, e.alice, "PUT", item(p.GetId())+"/permissions", &v1.UpdateCanvasPermissionsRequest{
		Entries: []*v1.CanvasPermissionEntry{{TargetType: user, TargetId: e.admin.String(), Allow: uint64(perm.CanvasView | perm.CanvasWrite)}}}, nil)
	seen.Reset()
	e.must(200, e.admin, "GET", item(p.GetId()), nil, &seen)
	if seen.GetItem().GetMyBits() != uint64(perm.CanvasView|perm.CanvasWrite) {
		t.Fatalf("the admin with WRITE: %b", seen.GetItem().GetMyBits())
	}
	rw := e.dial(e.admin, cv.GetId())
	rw.next(frameSnapshot)
	rw.send(updateFrame(0, []byte("x")))
	rw.next(frameUpdate)
	e.must(403, e.admin, "GET", item(p.GetId())+"/permissions", nil, nil)
	e.must(403, e.admin, "PATCH", item(p.GetId()), &v1.UpdateCanvasItemRequest{Name: proto.String("x")}, nil)
	e.must(403, e.admin, "POST", item(p.GetId())+"/trash", nil, nil)
	sub := e.mkdir(e.admin, p.GetId(), "Admin's")
	e.must(200, e.admin, "PATCH", item(sub.GetId()), &v1.UpdateCanvasItemRequest{Name: proto.String("Admin's 2")}, nil)
	e.must(404, e.owner, "GET", item(p.GetId()), nil, nil)
}

// Trashing, deleting forever or moving a item the actor sees does not destroy or carry away a
// private item below it that the actor does not see (owner, 14.10): it is detached to the top
// level first with its owner, content, access and history; the answers name nothing of it.
func TestCanvasPrivateSubtreeSurvivesParent(t *testing.T) {
	e := newEnv(t, ysync.Config{})
	ctx := context.Background()
	ws := "/api/workspaces/" + e.ws.String()
	restrict := func(u uuid.UUID, id string, entries ...*v1.CanvasPermissionEntry) {
		t.Helper()
		e.must(200, u, "PUT", item(id)+"/permissions", &v1.UpdateCanvasPermissionsRequest{Restricted: proto.Bool(true), Entries: entries}, nil)
	}
	get := func(u uuid.UUID, id string) *v1.CanvasItem {
		t.Helper()
		var out v1.CanvasItemResponse
		e.must(200, u, "GET", item(id), nil, &out)
		return out.GetItem()
	}

	// 1. The admin trashes Bob's open item with Alice's private subitem, then deletes it forever:
	// Alice's item stays, at the top level, alive, with the access it had.
	team := e.mkdir(e.bob, "", "Team")
	priv := e.mkdir(e.alice, team.GetId(), "Private")
	restrict(e.alice, priv.GetId(), &v1.CanvasPermissionEntry{TargetType: user, TargetId: e.guest.String(), Allow: uint64(perm.CanvasView)})
	below := e.mkdir(e.alice, priv.GetId(), "Below")
	board := e.create(e.alice, priv.GetId(), "Board")
	if _, err := e.d.Q.AppendCanvasUpdate(ctx, sqlc.AppendCanvasUpdateParams{CanvasID: uuid.MustParse(board.GetId()), Data: []byte("kept")}); err != nil {
		t.Fatal(err)
	}
	e.mkdir(e.bob, team.GetId(), "Plan")
	e.ev.take()
	var trashed v1.CanvasItemResponse
	e.must(200, e.admin, "POST", item(team.GetId())+"/trash", nil, &trashed)
	if b, _ := protojson.Marshal(&trashed); strings.Contains(string(b), "Private") || strings.Contains(string(b), priv.GetId()) {
		t.Fatalf("the trash answer names the private item: %s", b)
	}
	if got := get(e.alice, priv.GetId()); got.GetParentId() != "" || got.GetTrashedAt() != nil || !got.GetRestricted() {
		t.Fatalf("the private item after the trash: %v", got)
	}
	get(e.guest, below.GetId())
	e.must(404, e.admin, "GET", item(priv.GetId()), nil, nil)
	if got := e.names(e.admin, ""); slices.Contains(got, "Private") {
		t.Fatalf("the admin lists %v", got)
	}
	m, _, err := perm.LoadMember(ctx, e.d.Q, e.ws, e.admin)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, ev := range e.ev.take() {
		if u := ev.GetCanvasItemUpsert(); u != nil && u.GetItem().GetId() == priv.GetId() {
			found = true
			if perm.ComputeCanvasItemIn(m, canvasacl.FromLevels(u.GetAccess())).Has(perm.CanvasView) ||
				perm.ComputeCanvasItemIn(m, canvasacl.FromLevels(u.GetAccessBefore())).Has(perm.CanvasView) {
				t.Fatalf("the admin would get the detach event: %v", ev)
			}
		}
	}
	if !found {
		t.Fatal("no event of the detached item")
	}
	e.must(204, e.admin, "DELETE", item(team.GetId()), nil, nil)
	get(e.alice, below.GetId())
	// The content of the detached canvas is intact and its socket works for those let in.
	own := e.dial(e.alice, board.GetId())
	own.next(frameSnapshot)
	if f := own.next(frameUpdate); string(f[9:]) != "kept" {
		t.Fatalf("the detached canvas lost its content: %x", f)
	}
	e.dial(e.guest, board.GetId()).next(frameSnapshot)
	e.dial(e.admin, board.GetId()).closed(ysync.CloseForbidden)
	var act v1.CanvasActivityPage
	e.must(200, e.alice, "GET", item(priv.GetId())+"/activity", nil, &act)
	if len(act.GetActivities()) == 0 || act.GetActivities()[0].GetKind() != v1.CanvasActivityKind_CANVAS_ACTIVITY_KIND_MOVE {
		t.Fatalf("the private item's history: %v", act.GetActivities())
	}

	// 2. Trashed together by Alice, deleted forever by the admin: Alice's private item becomes a
	// trash root of its own, hers to restore.
	box := e.mkdir(e.alice, "", "Box")
	inner := e.mkdir(e.alice, box.GetId(), "Inner")
	restrict(e.alice, inner.GetId())
	e.must(200, e.alice, "POST", item(box.GetId())+"/trash", nil, nil)
	e.must(204, e.admin, "DELETE", item(box.GetId()), nil, nil)
	if got := e.names(e.alice, "trashed=1"); !slices.Equal(got, []string{"Inner"}) {
		t.Fatalf("alice's trash: %v", got)
	}
	e.must(200, e.alice, "POST", item(inner.GetId())+"/restore", nil, nil)

	// 3. Empty trash by the admin: the same.
	box2 := e.mkdir(e.alice, "", "Box2")
	inner2 := e.mkdir(e.alice, box2.GetId(), "Inner2")
	restrict(e.alice, inner2.GetId())
	e.must(200, e.alice, "POST", item(box2.GetId())+"/trash", nil, nil)
	var emptied v1.EmptyCanvasTrashResponse
	e.must(200, e.admin, "POST", ws+"/canvas/trash/empty", nil, &emptied)
	if emptied.GetDeleted() != 1 {
		t.Fatalf("the admin emptied %v", &emptied)
	}
	if got := e.names(e.alice, "trashed=1"); !slices.Equal(got, []string{"Inner2"}) {
		t.Fatalf("alice's trash after the admin's: %v", got)
	}

	// 4. A move carries only what the mover sees.
	src := e.mkdir(e.bob, "", "Src")
	dst := e.mkdir(e.bob, "", "Dst")
	hidden := e.mkdir(e.alice, src.GetId(), "Hidden")
	restrict(e.alice, hidden.GetId())
	e.must(200, e.bob, "PATCH", item(src.GetId()), &v1.UpdateCanvasItemRequest{ParentId: proto.String(dst.GetId())}, nil)
	if got := get(e.alice, hidden.GetId()); got.GetParentId() != "" {
		t.Fatalf("the private item after the move: %v", got)
	}

	// 5. The sweeper: an expired trash root of the admin's holding Alice's private item trashed
	// with it (before this rule; forged): the admin's part goes, Alice's item becomes her own
	// trash root with a fresh retention.
	old := e.mkdir(e.bob, "", "Old")
	kept := e.mkdir(e.alice, old.GetId(), "Kept")
	restrict(e.alice, kept.GetId())
	long := time.Now().Add(-48 * time.Hour)
	if _, err := e.d.Pool.Exec(ctx, `UPDATE canvas_items SET trashed_at = $2, trashed_by = $3, trashed_root = (id = $1)
		WHERE id = $1 OR parent_id = $1`, uuid.MustParse(old.GetId()), long, e.admin); err != nil {
		t.Fatal(err)
	}
	if _, err := e.d.Pool.Exec(ctx, `UPDATE workspaces SET canvas_trash_days = 1 WHERE id = $1`, e.ws); err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.TrashSweep(ctx); err != nil {
		t.Fatal(err)
	}
	e.must(404, e.bob, "GET", item(old.GetId()), nil, nil)
	if got := get(e.alice, kept.GetId()); got.GetParentId() != "" || got.GetTrashedAt() == nil || got.GetTrashedAt().AsTime().Before(time.Now().Add(-time.Hour)) {
		t.Fatalf("the private item after the sweep: %v", got)
	}
}

// A PUT permissions without `restricted` keeps the switch as it is under the row lock: it was
// read before the lock, so a privacy turned on in between must not be overwritten with the old
// value. The interleaving is real: the test holds the row lock with the switch already on, the
// PUT reads the item (switch off), waits for the lock, and runs when the lock is released.
func TestCanvasPermissionsKeepRestrictedSetMeanwhile(t *testing.T) {
	e := newEnv(t, ysync.Config{})
	ctx := context.Background()
	p := e.create(e.alice, "", "Racing")
	tx, err := e.d.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `UPDATE canvas_items SET restricted = true WHERE id = $1`, p.GetId()); err != nil {
		t.Fatal(err)
	}
	done := make(chan int, 1)
	go func() {
		done <- e.call(e.alice, "PUT", item(p.GetId())+"/permissions", &v1.UpdateCanvasPermissionsRequest{}).Code
	}()
	// Wait until the PUT sits on the row lock (it has read the item by then).
	deadline := time.Now().Add(5 * time.Second)
	for {
		var n int
		if err := e.d.Pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%FOR UPDATE%' AND datname = current_database()`).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the PUT never waited for the lock")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if code := <-done; code != 200 {
		t.Fatalf("PUT permissions: %d", code)
	}
	var got v1.CanvasPermissionsResponse
	e.must(200, e.alice, "GET", item(p.GetId())+"/permissions", nil, &got)
	if !got.GetRestricted() {
		t.Fatal("the PUT without restricted switched the privacy off")
	}
}

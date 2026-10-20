//go:build integration

package db_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/dbtest"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/perm"
)

// canvasSeed makes a user and a workspace.
func canvasSeed(ctx context.Context, t *testing.T, d *db.DB) (user, ws uuid.UUID) {
	t.Helper()
	user, ws = uuid.New(), uuid.New()
	if _, err := d.Pool.Exec(ctx, `INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'c')`, user, "canvas-"+user.String()[:8]+"@example.com"); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Pool.Exec(ctx, `INSERT INTO workspaces (id, slug, name, owner_id) VALUES ($1, $2, 'W', $3)`, ws, "canvas-"+ws.String()[:8], user); err != nil {
		t.Fatal(err)
	}
	return user, ws
}

// ADR-0113 §1 (migration 00103): a new workspace's member role carries CANVAS_VIEW | CANVAS_WRITE
// and nothing of CANVAS_MANAGE (the workspace_builtin_roles trigger).
func TestCanvasMemberRoleDefault(t *testing.T) {
	ctx := context.Background()
	d := dbtest.Connect(t)
	_, ws := canvasSeed(ctx, t, d)
	var bits int64
	if err := d.Pool.QueryRow(ctx, `SELECT permissions FROM workspace_roles WHERE workspace_id = $1 AND builtin = 'member'`, ws).Scan(&bits); err != nil {
		t.Fatal(err)
	}
	if got := perm.Bits(uint64(bits)) & perm.Canvas; got != perm.CanvasView|perm.CanvasWrite { //nolint:gosec // bit mask
		t.Fatalf("member canvas bits %d, want VIEW | WRITE", got)
	}
	if perm.Bits(uint64(bits)) != perm.RoleDefaults[perm.RoleMember] { //nolint:gosec // bit mask
		t.Fatalf("member role %d differs from perm.RoleDefaults %d", bits, perm.RoleDefaults[perm.RoleMember])
	}
}

// ADR-0113 §1: the tree, the trash, the content counter and snapshots, versions, overrides and
// the journal of canvas_items and its satellites.
func TestCanvasStorage(t *testing.T) {
	ctx := context.Background()
	d := dbtest.Connect(t)
	q := d.Q
	user, ws := canvasSeed(ctx, t, d)

	folder, err := q.CreateCanvasItem(ctx, sqlc.CreateCanvasItemParams{WorkspaceID: ws, Kind: "folder", Name: "Team", OwnerID: &user})
	if err != nil {
		t.Fatal(err)
	}
	a, err := q.CreateCanvasItem(ctx, sqlc.CreateCanvasItemParams{WorkspaceID: ws, ParentID: &folder.ID, Kind: "canvas", Name: "Roadmap", OwnerID: &user})
	if err != nil {
		t.Fatal(err)
	}
	b, err := q.CreateCanvasItem(ctx, sqlc.CreateCanvasItemParams{WorkspaceID: ws, ParentID: &folder.ID, Kind: "canvas", Name: "Retro", OwnerID: &user})
	if err != nil {
		t.Fatal(err)
	}
	if a.Position != 0 || b.Position != 1 || a.NextSeq != 1 || a.OwnerID == nil || *a.OwnerID != user {
		t.Fatalf("positions %d %d, next_seq %d, owner %v", a.Position, b.Position, a.NextSeq, a.OwnerID)
	}

	// The tree: the top level holds the folder (with children), the folder its two canvases.
	top, err := q.ListCanvasChildren(ctx, sqlc.ListCanvasChildrenParams{WorkspaceID: ws, Lim: 10})
	if err != nil || len(top) != 1 || top[0].CanvasItemHead.ID != folder.ID || !top[0].HasChildren {
		t.Fatalf("top level %+v %v", top, err)
	}
	kids, err := q.ListCanvasChildren(ctx, sqlc.ListCanvasChildrenParams{WorkspaceID: ws, ParentID: &folder.ID, Lim: 10})
	if err != nil || len(kids) != 2 || kids[0].CanvasItemHead.ID != a.ID || kids[1].CanvasItemHead.ID != b.ID || kids[0].HasChildren {
		t.Fatalf("folder children %+v %v", kids, err)
	}
	path, err := q.CanvasItemPath(ctx, b.ID)
	if err != nil || len(path) != 2 || path[0].CanvasItemHead.ID != folder.ID || path[1].CanvasItemHead.ID != b.ID {
		t.Fatalf("path %+v %v", path, err)
	}
	if n, err := q.CountCanvasSubtreeDepth(ctx, folder.ID); err != nil || n != 1 {
		t.Fatalf("subtree depth %d %v", n, err)
	}

	// Content: updates take consecutive seqs; a folder takes none.
	for i, want := range []int64{1, 2, 3} {
		r, err := q.AppendCanvasUpdate(ctx, sqlc.AppendCanvasUpdateParams{CanvasID: a.ID, Data: []byte{byte(i + 1)}, AuthorID: &user})
		if err != nil || r.Seq != want {
			t.Fatalf("append %d: %+v %v", i, r, err)
		}
	}
	if _, err := q.AppendCanvasUpdate(ctx, sqlc.AppendCanvasUpdateParams{CanvasID: folder.ID, Data: []byte{1}}); !db.IsNotFound(err) {
		t.Fatalf("a folder takes no updates: %v", err)
	}
	if _, err := d.Pool.Exec(ctx, `INSERT INTO canvas_updates (canvas_id, seq, data) VALUES ($1, 9, '\x')`, a.ID); err == nil {
		t.Fatal("an empty update must be refused")
	}
	if _, err := d.Pool.Exec(ctx, `INSERT INTO canvas_updates (canvas_id, seq, data) VALUES ($1, 9, $2)`, a.ID, make([]byte, 65537)); err == nil {
		t.Fatal("an update over 64 KiB must be refused")
	}
	since, err := q.CanvasUpdatesSince(ctx, sqlc.CanvasUpdatesSinceParams{CanvasID: a.ID, AfterSeq: 1})
	if err != nil || since.Updates != 2 || since.Bytes != 2 || len(since.Authors) != 1 {
		t.Fatalf("updates since 1: %+v %v", since, err)
	}
	// A snapshot through seq 2; a stale one (through 1) is refused, then the updates it holds go.
	if n, err := q.UpsertCanvasSnapshot(ctx, sqlc.UpsertCanvasSnapshotParams{CanvasID: a.ID, State: []byte("s2"), ThroughSeq: 2, SavedBy: &user}); err != nil || n != 1 {
		t.Fatalf("snapshot: %d %v", n, err)
	}
	if n, err := q.UpsertCanvasSnapshot(ctx, sqlc.UpsertCanvasSnapshotParams{CanvasID: a.ID, State: []byte("s1"), ThroughSeq: 1}); err != nil || n != 0 {
		t.Fatalf("a stale snapshot must be refused: %d %v", n, err)
	}
	if seq, err := q.GetCanvasSnapshotSeq(ctx, a.ID); err != nil || seq != 2 {
		t.Fatalf("snapshot seq %d %v", seq, err)
	}
	if n, err := q.DeleteCanvasUpdatesThrough(ctx, sqlc.DeleteCanvasUpdatesThroughParams{CanvasID: a.ID, ThroughSeq: 2}); err != nil || n != 2 {
		t.Fatalf("deleted updates %d %v", n, err)
	}
	rest, err := q.ListCanvasUpdatesSince(ctx, sqlc.ListCanvasUpdatesSinceParams{CanvasID: a.ID, AfterSeq: 2, Lim: 10})
	if err != nil || len(rest) != 1 || rest[0].Seq != 3 {
		t.Fatalf("updates after the snapshot: %+v %v", rest, err)
	}
	if _, err := d.Pool.Exec(ctx, `INSERT INTO canvas_snapshots (canvas_id, state, through_seq) VALUES ($1, $2, 0) ON CONFLICT (canvas_id) DO UPDATE SET state = EXCLUDED.state`,
		b.ID, make([]byte, 4<<20+1)); err == nil {
		t.Fatal("a snapshot over 4 MiB must be refused")
	}
	// The posted text, preview and size land on a canvas; a folder keeps no content.
	c, err := q.SetCanvasContent(ctx, sqlc.SetCanvasContentParams{ID: a.ID, PlainText: "sprint goals", Preview: "sprint goals", DocSize: 2, UpdatedBy: &user})
	if err != nil || c.DocSize != 2 || c.Preview != "sprint goals" {
		t.Fatalf("content %+v %v", c, err)
	}
	if _, err := q.SetCanvasContent(ctx, sqlc.SetCanvasContentParams{ID: folder.ID, PlainText: "x"}); !db.IsNotFound(err) {
		t.Fatalf("a folder takes no content: %v", err)
	}
	if _, err := d.Pool.Exec(ctx, `UPDATE canvas_items SET preview = 'x' WHERE id = $1`, folder.ID); err == nil {
		t.Fatal("a folder with content must be refused")
	}

	// Versions: the newest 50 stay, the hash tells whether the state changed.
	for i := 0; i < 52; i++ {
		if _, err := q.InsertCanvasVersion(ctx, sqlc.InsertCanvasVersionParams{CanvasID: a.ID, State: []byte{byte(i)}, Authors: []uuid.UUID{user}}); err != nil {
			t.Fatal(err)
		}
	}
	if n, err := q.PruneCanvasVersions(ctx, a.ID); err != nil || n != 2 {
		t.Fatalf("pruned %d %v", n, err)
	}
	vs, err := q.ListCanvasVersions(ctx, sqlc.ListCanvasVersionsParams{CanvasID: a.ID, Lim: 100})
	if err != nil || len(vs) != 50 || vs[0].Size != 1 {
		t.Fatalf("versions %d %v", len(vs), err)
	}
	last, err := q.LastCanvasVersion(ctx, a.ID)
	if want := sha256.Sum256([]byte{51}); err != nil || !bytes.Equal(last.StateHash, want[:]) || last.ID != vs[0].ID {
		t.Fatalf("last version %+v %v", last, err)
	}
	if _, err := q.GetCanvasVersion(ctx, sqlc.GetCanvasVersionParams{ID: last.ID, CanvasID: b.ID}); !db.IsNotFound(err) {
		t.Fatalf("a foreign canvas must not read the version: %v", err)
	}

	// Overrides: VIEW | WRITE only (CANVAS_MANAGE and the wiki bits are refused), not both ways.
	view := int64(perm.CanvasView)
	if err := q.InsertCanvasPermission(ctx, sqlc.InsertCanvasPermissionParams{CanvasID: a.ID, TargetType: "user", TargetID: user.String(), Allow: view, Deny: int64(perm.CanvasWrite)}); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []struct{ allow, deny int64 }{{int64(perm.CanvasManage), 0}, {int64(perm.WikiView), 0}, {view, view}} {
		if err := q.InsertCanvasPermission(ctx, sqlc.InsertCanvasPermissionParams{CanvasID: a.ID, TargetType: "role", TargetID: "r", Allow: bad.allow, Deny: bad.deny}); err == nil {
			t.Fatalf("override %+v must be refused", bad)
		}
	}
	if shared, err := q.ListSharedCanvasItems(ctx, []uuid.UUID{a.ID, b.ID}); err != nil || len(shared) != 1 || shared[0] != a.ID {
		t.Fatalf("shared %v %v", shared, err)
	}
	// The leaving member's overrides go with them.
	if err := q.DeleteUserOverridesInWorkspace(ctx, sqlc.DeleteUserOverridesInWorkspaceParams{WorkspaceID: ws, UserID: user.String()}); err != nil {
		t.Fatal(err)
	}
	if ov, err := q.ListCanvasPermissions(ctx, a.ID); err != nil || len(ov) != 0 {
		t.Fatalf("overrides after the member left: %+v %v", ov, err)
	}

	// Trash and restore of the folder with its canvases.
	at := time.Now().Truncate(time.Microsecond)
	ids, err := q.TrashCanvasSubtree(ctx, sqlc.TrashCanvasSubtreeParams{ID: folder.ID, TrashedAt: at, TrashedBy: &user})
	if err != nil || len(ids) != 3 {
		t.Fatalf("trashed %v %v", ids, err)
	}
	if _, err := q.AppendCanvasUpdate(ctx, sqlc.AppendCanvasUpdateParams{CanvasID: a.ID, Data: []byte{9}}); !db.IsNotFound(err) {
		t.Fatalf("a trashed canvas takes no updates: %v", err)
	}
	roots, err := q.ListCanvasTrash(ctx, sqlc.ListCanvasTrashParams{WorkspaceID: ws, Lim: 10})
	if err != nil || len(roots) != 1 || roots[0].ID != folder.ID {
		t.Fatalf("trash roots %+v %v", roots, err)
	}
	if top, err = q.ListCanvasChildren(ctx, sqlc.ListCanvasChildrenParams{WorkspaceID: ws, Lim: 10}); err != nil || len(top) != 0 {
		t.Fatalf("top level after trash %+v %v", top, err)
	}
	if ids, err = q.RestoreCanvasSubtree(ctx, sqlc.RestoreCanvasSubtreeParams{ID: folder.ID}); err != nil || len(ids) != 3 {
		t.Fatalf("restored %v %v", ids, err)
	}
	if r, err := q.AppendCanvasUpdate(ctx, sqlc.AppendCanvasUpdateParams{CanvasID: a.ID, Data: []byte{9}}); err != nil || r.Seq != 4 {
		t.Fatalf("append after restore %+v %v", r, err)
	}

	// The journal, with the rename entry rewritten in place.
	name := "Roadmap"
	act, err := q.InsertCanvasActivity(ctx, sqlc.InsertCanvasActivityParams{WorkspaceID: ws, ItemID: &a.ID, ItemName: name, ActorID: &user, Kind: "rename"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := q.InsertCanvasActivity(ctx, sqlc.InsertCanvasActivityParams{WorkspaceID: ws, ItemID: &a.ID, ItemName: name, Kind: "bogus"}); err == nil {
		t.Fatal("an unknown journal kind must be refused")
	}
	if got, err := q.LastCanvasActivity(ctx, &a.ID); err != nil || got.ID != act.ID {
		t.Fatalf("last activity %+v %v", got, err)
	}
	if page, err := q.ListWorkspaceCanvasActivity(ctx, sqlc.ListWorkspaceCanvasActivityParams{WorkspaceID: ws, Lim: 10}); err != nil || len(page) != 1 {
		t.Fatalf("workspace journal %+v %v", page, err)
	}

	// Delete forever: the subtree, content and satellites go, the journal keeps its entry.
	if err := q.MarkCanvasSubtreeActivityPrivate(ctx, sqlc.MarkCanvasSubtreeActivityPrivateParams{ID: folder.ID, Restricted: true}); err != nil {
		t.Fatal(err)
	}
	if n, err := q.DeleteCanvasItem(ctx, folder.ID); err != nil || n != 1 {
		t.Fatalf("delete %d %v", n, err)
	}
	var left int
	if err := d.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM canvas_items WHERE workspace_id = $1) + (SELECT count(*) FROM canvas_updates)
		+ (SELECT count(*) FROM canvas_snapshots) + (SELECT count(*) FROM canvas_versions)`, ws).Scan(&left); err != nil || left != 0 {
		t.Fatalf("rows left after delete forever: %d %v", left, err)
	}
	var itemNull, private bool
	if err := d.Pool.QueryRow(ctx, `SELECT item_id IS NULL, private FROM canvas_activity WHERE id = $1`, act.ID).Scan(&itemNull, &private); err != nil || !itemNull || !private {
		t.Fatalf("journal entry after delete forever: item gone %v private %v %v", itemNull, private, err)
	}
	if err := q.SetCanvasTrashDays(ctx, sqlc.SetCanvasTrashDaysParams{ID: ws, Days: ptr(int32(30))}); err != nil {
		t.Fatal(err)
	}
	if days, err := q.GetCanvasTrashDays(ctx, ws); err != nil || days == nil || *days != 30 {
		t.Fatalf("trash days %v %v", days, err)
	}
	if err := q.SetCanvasTrashDays(ctx, sqlc.SetCanvasTrashDaysParams{ID: ws, Days: ptr(int32(0))}); err == nil || !strings.Contains(err.Error(), "canvas_trash_days") {
		t.Fatalf("0 days must be refused (NULL = never): %v", err)
	}
}

func ptr[T any](v T) *T { return &v }

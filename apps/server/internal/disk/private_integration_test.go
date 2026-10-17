//go:build integration

package disk

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
	"github.com/calaba/calaba/server/internal/diskacl"
	"github.com/calaba/calaba/server/internal/perm"
)

// A restricted folder («Только выбранные») is not seen by the administrator nor the workspace
// owner (ADR-0094 §2, addendum 2026-10-14): 404 on it and its subtree, not in listings, paths,
// the workspace journal or the events they get; their «empty the trash» skips it; the people let
// in see it; usage still counts its bytes; its public link keeps working.
func TestDiskPrivateFolderHiddenFromAdmins(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	ws := "/api/workspaces/" + e.ws.String()
	design := uuid.New()
	if _, err := e.d.Pool.Exec(ctx, `INSERT INTO workspace_roles (id, workspace_id, name, position, permissions) VALUES ($1, $2, 'Design', 5, 0)`, design, e.ws); err != nil {
		t.Fatal(err)
	}
	if _, err := e.d.Pool.Exec(ctx, `INSERT INTO member_roles (workspace_id, user_id, role_id) VALUES ($1, $2, $3)`, e.ws, e.bob, design); err != nil {
		t.Fatal(err)
	}
	open := e.folder(e.alice, "", "Open")
	salaries := e.folder(e.alice, "", "Salaries")
	m, err := perm.NewResolver(e.d.Q).Member(ctx, e.ws, e.admin)
	if err != nil {
		t.Fatal(err)
	}
	adminSees := func(levels []*v1.DiskAccessLevel) bool {
		return len(levels) > 0 && perm.ComputeDiskItemIn(m, diskacl.FromLevels(levels)).Has(perm.DiskView)
	}
	e.ev.take()
	e.must(200, e.alice, "PUT", item(salaries.GetId())+"/permissions", &v1.UpdateDiskPermissionsRequest{Restricted: proto.Bool(true),
		Entries: []*v1.DiskPermissionEntry{
			{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_ROLE, TargetId: design.String(), Allow: uint64(perm.DiskView | perm.DiskWrite)},
			{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER, TargetId: e.guest.String(), Allow: uint64(perm.DiskView)},
		}}, nil)
	// The admin saw the folder before and not after: the gateway sends it DISK_ITEM_REMOVE.
	if evs := e.ev.take(); len(evs) != 1 || !adminSees(evs[0].GetDiskItemUpsert().GetAccessBefore()) || adminSees(evs[0].GetDiskItemUpsert().GetAccess()) {
		t.Fatalf("restrict event: %v", evs)
	}
	inner := e.folder(e.alice, salaries.GetId(), "2026")
	pay := e.upload(e.alice, inner.GetId(), "pay.txt", 40)
	var link v1.DiskLinkResponse
	e.must(201, e.alice, "POST", item(pay.GetId())+"/link", &v1.CreateDiskLinkRequest{}, &link)
	// Nothing inside reaches the admin.
	evs := e.ev.take()
	if len(evs) < 2 {
		t.Fatalf("events inside: %v", evs)
	}
	for _, ev := range evs {
		if u := ev.GetDiskItemUpsert(); u == nil || adminSees(u.GetAccess()) {
			t.Fatalf("an event of a private item would reach the admin: %v", ev)
		}
	}

	for _, u := range []uuid.UUID{e.admin, e.owner} {
		for _, id := range []string{salaries.GetId(), inner.GetId(), pay.GetId()} {
			e.must(404, u, "GET", item(id), nil, nil)
			e.must(404, u, "GET", item(id)+"/path", nil, nil)
			e.must(404, u, "GET", item(id)+"/activity", nil, nil)
			e.must(404, u, "GET", item(id)+"/permissions", nil, nil)
			e.must(404, u, "PATCH", item(id), &v1.UpdateDiskItemRequest{Name: proto.String("x")}, nil)
			e.must(404, u, "POST", item(id)+"/trash", nil, nil)
		}
		e.must(404, u, "DELETE", item(pay.GetId())+"/link", nil, nil)
		e.must(404, u, "GET", "/api/files/"+pay.GetFile().GetId(), nil, nil)
		e.must(404, u, "GET", ws+"/disk/items?parent="+salaries.GetId(), nil, nil)
		if got := e.list(u, ""); !slices.Equal(got, []string{"Open"}) {
			t.Fatalf("%v lists %v", u, got)
		}
	}
	// Let in by role (bob, with writing) and by name (the guest, view only).
	e.must(200, e.bob, "GET", item(pay.GetId()), nil, nil)
	e.must(200, e.bob, "GET", item(pay.GetId())+"/path", nil, nil)
	e.upload(e.bob, salaries.GetId(), "bob.txt", 5)
	e.must(200, e.guest, "GET", item(pay.GetId()), nil, nil)
	if got := e.list(e.bob, ""); len(got) != 2 {
		t.Fatalf("bob lists %v", got)
	}
	// The public link keeps working; usage counts the bytes without names.
	if w := e.call(uuid.Nil, "GET", "/api/public/disk/"+link.GetLink().GetCode(), nil, nil); w.Code != 200 {
		t.Fatalf("public link of a private file: %d", w.Code)
	}
	if u := e.usage(); u.GetDiskBytes() != 45 {
		t.Fatalf("usage %v", u)
	}
	// The workspace journal of the admin names nothing of the private folder.
	journal := func(u uuid.UUID) []string {
		t.Helper()
		var act v1.DiskActivityPage
		e.must(200, u, "GET", ws+"/disk/activity?limit=2", nil, &act)
		var names []string
		for {
			for _, a := range act.GetActivities() {
				names = append(names, a.GetItemName())
				if a.GetBefore().GetFields()["parent_name"].GetStringValue() == "Salaries" || a.GetAfter().GetFields()["parent_name"].GetStringValue() == "Salaries" {
					names = append(names, "parent:Salaries")
				}
			}
			if act.GetNextCursor() == "" {
				return names
			}
			cur := act.GetNextCursor()
			act.Reset()
			e.must(200, u, "GET", ws+"/disk/activity?limit=2&cursor="+cur, nil, &act)
		}
	}
	private := []string{"Salaries", "2026", "pay.txt", "bob.txt", "parent:Salaries"}
	if got := journal(e.admin); !slices.Contains(got, "Open") || slices.ContainsFunc(got, func(n string) bool { return slices.Contains(private, n) }) {
		t.Fatalf("the admin's journal: %v", got)
	}
	// Trash: the admin neither lists nor empties the private file; the owner of it does.
	open1 := e.upload(e.bob, open.GetId(), "open.txt", 7)
	e.must(200, e.bob, "POST", item(open1.GetId())+"/trash", nil, nil)
	e.must(200, e.alice, "POST", item(pay.GetId())+"/trash", nil, nil)
	if got := e.list(e.admin, "trashed=1"); !slices.Equal(got, []string{"open.txt"}) {
		t.Fatalf("the admin's trash: %v", got)
	}
	var emptied v1.EmptyDiskTrashResponse
	e.must(200, e.admin, "POST", ws+"/disk/trash/empty", nil, &emptied)
	if emptied.GetDeleted() != 1 {
		t.Fatalf("the admin emptied %v", &emptied)
	}
	if got := e.list(e.alice, "trashed=1"); !slices.Equal(got, []string{"pay.txt"}) {
		t.Fatalf("alice's trash after the admin's: %v", got)
	}
	e.must(204, e.alice, "DELETE", item(pay.GetId()), nil, nil)
	// Deleted forever: its entries stay out of the admin's journal (private), the open one shows.
	got := journal(e.admin)
	if slices.ContainsFunc(got, func(n string) bool { return slices.Contains(private, n) }) || !slices.Contains(got, "open.txt") {
		t.Fatalf("the admin's journal after the delete: %v", got)
	}
	// An admin let in by name with «Правка» is an ordinary member there (owner, 14.10): it sees and
	// writes, but neither opens the access dialog nor changes anyone else's items.
	e.must(200, e.alice, "PUT", item(salaries.GetId())+"/permissions", &v1.UpdateDiskPermissionsRequest{
		Entries: []*v1.DiskPermissionEntry{{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER, TargetId: e.admin.String(), Allow: uint64(perm.DiskView | perm.DiskWrite)}}}, nil)
	var seen v1.DiskItemResponse
	e.must(200, e.admin, "GET", item(salaries.GetId()), nil, &seen)
	if seen.GetItem().GetMyBits() != uint64(perm.DiskView|perm.DiskWrite) {
		t.Fatalf("the admin let in: %b", seen.GetItem().GetMyBits())
	}
	e.must(403, e.admin, "GET", item(salaries.GetId())+"/permissions", nil, nil)
	e.must(403, e.admin, "PATCH", item(inner.GetId()), &v1.UpdateDiskItemRequest{Name: proto.String("x")}, nil)
	e.must(403, e.admin, "POST", item(inner.GetId())+"/trash", nil, nil)
	mine := e.folder(e.admin, salaries.GetId(), "Admin's")
	e.must(200, e.admin, "PATCH", item(mine.GetId()), &v1.UpdateDiskItemRequest{Name: proto.String("Admin's 2")}, nil)
	e.must(404, e.owner, "GET", item(salaries.GetId()), nil, nil)
}

// Trashing, deleting forever or moving a folder the actor sees does not destroy or carry away a
// private folder inside it that the actor does not see (owner, 14.10): it is detached to the root
// first with its owner, files, access and history; the answers name nothing of it.
func TestDiskPrivateSubtreeSurvivesParent(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	ws := "/api/workspaces/" + e.ws.String()
	restrict := func(u uuid.UUID, id string, entries ...*v1.DiskPermissionEntry) {
		t.Helper()
		e.must(200, u, "PUT", item(id)+"/permissions", &v1.UpdateDiskPermissionsRequest{Restricted: proto.Bool(true), Entries: entries}, nil)
	}
	letIn := func(u uuid.UUID, bits perm.Bits) *v1.DiskPermissionEntry {
		return &v1.DiskPermissionEntry{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER, TargetId: u.String(), Allow: uint64(bits)}
	}
	parentOf := func(id string) string {
		t.Helper()
		var it v1.DiskItemResponse
		e.must(200, e.alice, "GET", item(id), nil, &it)
		return it.GetItem().GetParentId()
	}

	// 1. The admin trashes Bob's open folder with Alice's private folder inside, then deletes it
	// forever: Alice's folder and file stay, at the root, alive.
	team := e.folder(e.bob, "", "Team")
	priv := e.folder(e.alice, team.GetId(), "Private")
	restrict(e.alice, priv.GetId(), letIn(e.guest, perm.DiskView))
	secret := e.upload(e.alice, priv.GetId(), "secret.txt", 11)
	e.upload(e.bob, team.GetId(), "plan.txt", 3)
	e.ev.take()
	var trashed v1.DiskItemResponse
	e.must(200, e.admin, "POST", item(team.GetId())+"/trash", nil, &trashed)
	if b, _ := protojson.Marshal(&trashed); strings.Contains(string(b), "Private") || strings.Contains(string(b), priv.GetId()) {
		t.Fatalf("the trash answer names the private folder: %s", b)
	}
	if parentOf(priv.GetId()) != "" {
		t.Fatal("the private folder was not detached to the root")
	}
	var got v1.DiskItemResponse
	e.must(200, e.alice, "GET", item(priv.GetId()), nil, &got)
	if got.GetItem().GetTrashedAt() != nil || !got.GetItem().GetRestricted() {
		t.Fatalf("the private folder after the trash: %v", got.GetItem())
	}
	e.must(200, e.guest, "GET", item(secret.GetId()), nil, nil) // the access it had
	e.must(404, e.admin, "GET", item(priv.GetId()), nil, nil)
	if got := e.list(e.admin, ""); slices.Contains(got, "Private") {
		t.Fatalf("the admin lists %v", got)
	}
	// The events: the detach reaches Alice, not the admin.
	m, _, err := perm.LoadMember(ctx, e.d.Q, e.ws, e.admin)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, ev := range e.ev.take() {
		if u := ev.GetDiskItemUpsert(); u != nil && u.GetItem().GetId() == priv.GetId() {
			found = true
			if perm.ComputeDiskItemIn(m, diskacl.FromLevels(u.GetAccess())).Has(perm.DiskView) ||
				perm.ComputeDiskItemIn(m, diskacl.FromLevels(u.GetAccessBefore())).Has(perm.DiskView) {
				t.Fatalf("the admin would get the detach event: %v", ev)
			}
		}
	}
	if !found {
		t.Fatal("no event of the detached folder")
	}
	e.must(204, e.admin, "DELETE", item(team.GetId()), nil, nil)
	e.must(200, e.alice, "GET", item(secret.GetId()), nil, nil)
	e.must(200, e.alice, "GET", "/api/files/"+secret.GetFile().GetId(), nil, nil)
	var act v1.DiskActivityPage
	e.must(200, e.alice, "GET", item(priv.GetId())+"/activity", nil, &act)
	if len(act.GetActivities()) == 0 || act.GetActivities()[0].GetKind() != v1.DiskActivityKind_DISK_ACTIVITY_KIND_MOVE {
		t.Fatalf("the private folder's history: %v", act.GetActivities())
	}

	// 2. Trashed together by Alice (she sees it), deleted forever by the admin: Alice's private
	// folder becomes a trash root of its own, hers to restore.
	box := e.folder(e.alice, "", "Box")
	inner := e.folder(e.alice, box.GetId(), "Inner")
	restrict(e.alice, inner.GetId())
	file := e.upload(e.alice, inner.GetId(), "f.txt", 5)
	e.must(200, e.alice, "POST", item(box.GetId())+"/trash", nil, nil)
	e.must(204, e.admin, "DELETE", item(box.GetId()), nil, nil)
	if got := e.list(e.alice, "trashed=1"); !slices.Equal(got, []string{"Inner"}) {
		t.Fatalf("alice's trash: %v", got)
	}
	e.must(200, e.alice, "POST", item(inner.GetId())+"/restore", nil, nil)
	e.must(200, e.alice, "GET", item(file.GetId()), nil, nil)

	// 3. Empty trash by the admin: the same.
	box2 := e.folder(e.alice, "", "Box2")
	inner2 := e.folder(e.alice, box2.GetId(), "Inner2")
	restrict(e.alice, inner2.GetId())
	e.must(200, e.alice, "POST", item(box2.GetId())+"/trash", nil, nil)
	var emptied v1.EmptyDiskTrashResponse
	e.must(200, e.admin, "POST", ws+"/disk/trash/empty", nil, &emptied)
	if emptied.GetDeleted() != 1 {
		t.Fatalf("the admin emptied %v", &emptied)
	}
	if got := e.list(e.alice, "trashed=1"); !slices.Equal(got, []string{"Inner2"}) {
		t.Fatalf("alice's trash after the admin's: %v", got)
	}

	// 4. A move carries only what the mover sees; the private folder stays, at the root, under a
	// free name.
	src := e.folder(e.bob, "", "Src")
	dst := e.folder(e.bob, "", "Dst")
	hidden := e.folder(e.alice, src.GetId(), "Private")
	restrict(e.alice, hidden.GetId())
	e.must(200, e.bob, "PATCH", item(src.GetId()), &v1.UpdateDiskItemRequest{ParentId: proto.String(dst.GetId())}, nil)
	var h v1.DiskItemResponse
	e.must(200, e.alice, "GET", item(hidden.GetId()), nil, &h)
	if h.GetItem().GetParentId() != "" || h.GetItem().GetName() != "Private (2)" {
		t.Fatalf("the private folder after the move: %v", h.GetItem())
	}

	// 5. A non-restricted item hidden by a deny keeps that deny at the root: Bob still does not see
	// it, Alice does.
	shared := e.folder(e.bob, "", "Shared")
	notes := e.folder(e.alice, shared.GetId(), "Notes")
	e.must(200, e.alice, "PUT", item(notes.GetId())+"/permissions", &v1.UpdateDiskPermissionsRequest{Entries: []*v1.DiskPermissionEntry{
		{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER, TargetId: e.bob.String(), Deny: uint64(perm.DiskView | perm.DiskWrite)}}}, nil)
	e.must(200, e.bob, "POST", item(shared.GetId())+"/trash", nil, nil)
	e.must(404, e.bob, "GET", item(notes.GetId()), nil, nil)
	if parentOf(notes.GetId()) != "" {
		t.Fatal("notes not detached")
	}

	// 6. The sweeper: an expired trash root of the admin's holding Alice's private folder trashed
	// with it (before this rule; forged) purges the admin's part; Alice's folder becomes her own
	// trash root with a fresh retention.
	old := e.folder(e.bob, "", "Old")
	kept := e.folder(e.alice, old.GetId(), "Kept")
	restrict(e.alice, kept.GetId())
	long := time.Now().Add(-48 * time.Hour)
	if _, err := e.d.Pool.Exec(ctx, `UPDATE disk_items SET trashed_at = $2, trashed_by = $3, trashed_root = (id = $1)
		WHERE id = $1 OR parent_id = $1`, uuid.MustParse(old.GetId()), long, e.admin); err != nil {
		t.Fatal(err)
	}
	if _, err := e.d.Pool.Exec(ctx, `UPDATE workspaces SET disk_trash_days = 1 WHERE id = $1`, e.ws); err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.TrashSweep(ctx); err != nil {
		t.Fatal(err)
	}
	e.must(404, e.bob, "GET", item(old.GetId()), nil, nil)
	var k v1.DiskItemResponse
	e.must(200, e.alice, "GET", item(kept.GetId()), nil, &k)
	if k.GetItem().GetParentId() != "" || k.GetItem().GetTrashedAt() == nil || k.GetItem().GetTrashedAt().AsTime().Before(time.Now().Add(-time.Hour)) {
		t.Fatalf("the private folder after the sweep: %v", k.GetItem())
	}
	if _, err := e.svc.TrashSweep(ctx); err != nil {
		t.Fatal(err)
	}
	e.must(200, e.alice, "GET", item(kept.GetId()), nil, nil)
}

//go:build integration

package disk

import (
	"context"
	"slices"
	"testing"

	"github.com/google/uuid"
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
	// An admin let in by name with writing sees the folder and manages it (the access dialog).
	e.must(200, e.alice, "PUT", item(salaries.GetId())+"/permissions", &v1.UpdateDiskPermissionsRequest{
		Entries: []*v1.DiskPermissionEntry{{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER, TargetId: e.admin.String(), Allow: uint64(perm.DiskView | perm.DiskWrite)}}}, nil)
	var seen v1.DiskItemResponse
	e.must(200, e.admin, "GET", item(salaries.GetId()), nil, &seen)
	if seen.GetItem().GetMyBits() != uint64(perm.Disk) {
		t.Fatalf("the admin let in: %b", seen.GetItem().GetMyBits())
	}
	e.must(200, e.admin, "GET", item(salaries.GetId())+"/permissions", nil, nil)
	e.must(404, e.owner, "GET", item(salaries.GetId()), nil, nil)
}

//go:build integration

package disk

import (
	"context"
	"slices"
	"testing"

	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// «Владелец видит приватное» and «Сделать меня владельцем» (addendum 2026-10-14): a member's
// private folder stays hidden from the owner with the setting off; with it on the owner sees it,
// takes it over once its creator left (409 while they are a member), and trashes / empties /
// deletes it. The admin gets nothing from the setting. The workspace journal records it.
func TestDiskOwnerSeesPrivateTakeOver(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	ws := "/api/workspaces/" + e.ws.String()
	salaries := e.folder(e.alice, "", "Salaries")
	e.must(200, e.alice, "PUT", item(salaries.GetId())+"/permissions", &v1.UpdateDiskPermissionsRequest{Restricted: proto.Bool(true)}, nil)
	pay := e.upload(e.alice, salaries.GetId(), "pay.txt", 10)
	seesPrivate := func(on bool) {
		t.Helper()
		if _, err := e.d.Pool.Exec(ctx, `UPDATE workspaces SET owner_sees_private = $2 WHERE id = $1`, e.ws, on); err != nil {
			t.Fatal(err)
		}
	}
	// Off: 404 for the owner, and the take-over is 404 too (no existence leak).
	e.must(404, e.owner, "GET", item(salaries.GetId()), nil, nil)
	e.must(404, e.owner, "POST", item(salaries.GetId())+"/take-over", nil, nil)
	// On: the owner sees and manages it; the admin still does not.
	seesPrivate(true)
	var got v1.DiskItemResponse
	e.must(200, e.owner, "GET", item(pay.GetId()), nil, &got)
	if got.GetItem().GetMyBits() != uint64(1<<35|1<<36|1<<37) {
		t.Fatalf("owner's bits %b", got.GetItem().GetMyBits())
	}
	if l := e.list(e.owner, ""); !slices.Contains(l, "Salaries") {
		t.Fatalf("owner lists %v", l)
	}
	e.must(404, e.admin, "GET", item(salaries.GetId()), nil, nil)
	// The creator is still a member: 409; anyone but the owner: 404 / 403.
	e.must(409, e.owner, "POST", item(salaries.GetId())+"/take-over", nil, nil)
	e.must(403, e.alice, "POST", item(salaries.GetId())+"/take-over", nil, nil)
	// A public item cannot be taken over.
	open := e.folder(e.bob, "", "Open")
	if _, err := e.d.Pool.Exec(ctx, `DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`, e.ws, e.bob); err != nil {
		t.Fatal(err)
	}
	e.must(409, e.owner, "POST", item(open.GetId())+"/take-over", nil, nil)
	// alice leaves the workspace.
	if _, err := e.d.Pool.Exec(ctx, `DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`, e.ws, e.alice); err != nil {
		t.Fatal(err)
	}
	seesPrivate(false)
	e.must(404, e.owner, "GET", item(salaries.GetId()), nil, nil)
	seesPrivate(true)
	e.ev.take()
	var took v1.DiskItemResponse
	e.must(200, e.owner, "POST", item(salaries.GetId())+"/take-over", nil, &took)
	if took.GetItem().GetOwnerId() != e.owner.String() {
		t.Fatalf("took over: %v", &took)
	}
	if evs := e.ev.take(); len(evs) != 1 || evs[0].GetDiskItemUpsert().GetItem().GetOwnerId() != e.owner.String() {
		t.Fatalf("take-over event: %v", evs)
	}
	var n int
	if err := e.d.Pool.QueryRow(ctx, `SELECT count(*) FROM workspace_audit WHERE workspace_id = $1 AND kind = 'take_over'
		AND subject_type = 'disk_item' AND subject_id = $2 AND actor_id = $3 AND previous_owner_id = $4`, e.ws, salaries.GetId(), e.owner, e.alice).Scan(&n); err != nil || n != 1 {
		t.Fatalf("audit rows %d %v", n, err)
	}
	// The owner keeps it after switching the setting off.
	seesPrivate(false)
	e.must(200, e.owner, "GET", item(salaries.GetId()), nil, nil)
	seesPrivate(true)
	e.must(200, e.owner, "POST", item(pay.GetId())+"/trash", nil, nil)
	var emptied v1.EmptyDiskTrashResponse
	e.must(200, e.owner, "POST", ws+"/disk/trash/empty", nil, &emptied)
	if emptied.GetDeleted() != 1 {
		t.Fatalf("emptied %v", &emptied)
	}
	e.must(200, e.owner, "POST", item(salaries.GetId())+"/trash", nil, nil)
	e.must(204, e.owner, "DELETE", item(salaries.GetId()), nil, nil)
	// The private entries of the deleted folder: in the owner's journal with the setting on only.
	journal := func() []string {
		var act v1.DiskActivityPage
		e.must(200, e.owner, "GET", ws+"/disk/activity?limit=100", nil, &act)
		var names []string
		for _, a := range act.GetActivities() {
			names = append(names, a.GetItemName())
		}
		return names
	}
	if j := journal(); !slices.Contains(j, "Salaries") {
		t.Fatalf("owner's journal (setting on): %v", j)
	}
	seesPrivate(false)
	if j := journal(); slices.Contains(j, "Salaries") || slices.Contains(j, "pay.txt") {
		t.Fatalf("owner's journal (setting off): %v", j)
	}
}

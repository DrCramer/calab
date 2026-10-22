//go:build integration

package app_test

import (
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
)

// TestBoardItemsUnderEditTasks (CBF-73): statuses, labels and milestones of a board are
// created, renamed, reordered and deleted with EDIT_TASKS («edit any task»); the settings and
// the access stay with MANAGE_BOARD, and either bit works without the other.
func TestBoardItemsUnderEditTasks(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	editor := register(t, invite(t, o, wid))
	manager := register(t, invite(t, o, wid))
	b := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Права пунктов", Key: "PIT"}, 201)
	bid := b.GetId()
	setBoardPerms(o, bid, 200, userOv(editor.id, perm.EditTasks, 0), userOv(manager.id, perm.ManageBoard, 0))
	base := "/api/boards/" + bid

	find := func(r *v1.BoardResponse, name string) (status, label, milestone string) {
		t.Helper()
		for _, s := range r.GetBoard().GetStatuses() {
			if s.GetName() == name {
				status = s.GetId()
			}
		}
		for _, l := range r.GetBoard().GetLabels() {
			if l.GetName() == name {
				label = l.GetId()
			}
		}
		for _, m := range r.GetBoard().GetMilestones() {
			if m.GetName() == name {
				milestone = m.GetId()
			}
		}
		return status, label, milestone
	}
	other := b.GetStatuses()[0].GetId()
	renamed := "переименовано"
	first := int32(0)

	// The editor (EDIT_TASKS, no MANAGE_BOARD): every change of the three lists.
	var r v1.BoardResponse
	editor.must(201, "POST", base+"/statuses", &v1.CreateBoardStatusRequest{Name: "Ревью"}, &r)
	sid, _, _ := find(&r, "Ревью")
	editor.must(200, "PATCH", base+"/statuses/"+sid, &v1.UpdateBoardStatusRequest{Name: &renamed, Position: &first}, nil)
	editor.must(201, "POST", base+"/labels", &v1.CreateBoardLabelRequest{Name: "баг", Color: 0xff0000}, &r)
	_, lid, _ := find(&r, "баг")
	editor.must(200, "PATCH", base+"/labels/"+lid, &v1.UpdateBoardLabelRequest{Name: &renamed, Position: &first}, nil)
	editor.must(201, "POST", base+"/milestones", &v1.CreateBoardMilestoneRequest{Name: "Бета"}, &r)
	_, _, mid := find(&r, "Бета")
	editor.must(200, "PATCH", base+"/milestones/"+mid, &v1.UpdateBoardMilestoneRequest{Name: &renamed, Position: &first}, nil)
	if sid == "" || lid == "" || mid == "" {
		t.Fatalf("created items: status %q label %q milestone %q", sid, lid, mid)
	}

	// Without EDIT_TASKS — a member, and a manager with MANAGE_BOARD alone — 403 on each.
	for _, u := range []*user{bob, manager} {
		u.must(403, "POST", base+"/statuses", &v1.CreateBoardStatusRequest{Name: "нет"}, nil)
		u.must(403, "PATCH", base+"/statuses/"+sid, &v1.UpdateBoardStatusRequest{Name: &renamed}, nil)
		u.must(403, "DELETE", base+"/statuses/"+sid+"?move_to="+other, nil, nil)
		u.must(403, "PATCH", base+"/labels/"+lid, &v1.UpdateBoardLabelRequest{Name: &renamed}, nil)
		u.must(403, "DELETE", base+"/labels/"+lid, nil, nil)
		u.must(403, "POST", base+"/milestones", &v1.CreateBoardMilestoneRequest{Name: "нет"}, nil)
		u.must(403, "PATCH", base+"/milestones/"+mid, &v1.UpdateBoardMilestoneRequest{Name: &renamed}, nil)
		u.must(403, "DELETE", base+"/milestones/"+mid, nil, nil)
	}

	// The editor deletes them.
	editor.must(200, "DELETE", base+"/statuses/"+sid+"?move_to="+other, nil, nil)
	editor.must(200, "DELETE", base+"/labels/"+lid, nil, nil)
	editor.must(200, "DELETE", base+"/milestones/"+mid, nil, nil)

	// Settings and access: MANAGE_BOARD only; EDIT_TASKS gives neither.
	name := "Новое имя"
	editor.must(403, "PATCH", base, &v1.UpdateBoardRequest{Name: &name}, nil)
	editor.must(403, "GET", base+"/permissions", nil, nil)
	setBoardPerms(editor, bid, 403, userOv(editor.id, perm.EditTasks|perm.ManageBoard, 0))
	manager.must(200, "PATCH", base, &v1.UpdateBoardRequest{Name: &name}, nil)
	manager.must(200, "GET", base+"/permissions", nil, nil)
	setBoardPerms(manager, bid, 200, userOv(manager.id, perm.ManageBoard, 0))
}

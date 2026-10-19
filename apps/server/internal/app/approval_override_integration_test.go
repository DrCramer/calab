//go:build integration

package app_test

import (
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// Board managers over approvals (ADR-0108).

func voteFor(u musty, taskID, userID string, want int, d v1.TaskApprovalDecision) *v1.Task {
	var r v1.TaskResponse
	u.must(want, "POST", "/api/tasks/"+taskID+"/approval", &v1.TaskApprovalRequest{Decision: d, OnBehalfOf: userID}, &r)
	return r.GetTask()
}

func approverOf(t *testing.T, task *v1.Task, userID string) *v1.TaskApprover {
	t.Helper()
	for _, a := range task.GetApprovers() {
		if a.GetUserId() == userID {
			return a
		}
	}
	t.Fatalf("%s is not an approver of %v", userID, task)
	return nil
}

// entriesOf: the journal entries of a kind, newest first.
func entriesOf(t *testing.T, u musty, taskID, kind string) []*v1.TaskActivity {
	t.Helper()
	var p v1.TaskActivityPage
	u.must(200, "GET", "/api/tasks/"+taskID+"/activity?limit=100", nil, &p)
	var out []*v1.TaskActivity
	for _, it := range p.GetItems() {
		if a := it.GetActivity(); a != nil && a.GetKind() == kind {
			out = append(out, a)
		}
	}
	return out
}

// TestApprovalManagerPowers: MANAGE_BOARD (the owner here) moves a task forward past an
// incomplete approval with an explicit override (journal "approval_override") and records an
// approval on behalf of an approver (recorded_by, journal on_behalf, APPROVED_ON_BEHALF to the
// approver, counted in the quorum); the approver replaces or withdraws it themselves; a manager
// never touches a personal vote; members without MANAGE_BOARD and bots (also on behalf of a
// manager) are refused.
func TestApprovalManagerPowers(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	carol := register(t, invite(t, o, wid))
	dave := register(t, invite(t, o, wid))
	eve := register(t, invite(t, o, wid))
	b := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Override", Key: "OVR", Template: v1.BoardTemplate_BOARD_TEMPLATE_DEVELOPMENT}, 201)
	todo := statusOf(b, v1.BoardStatusType_BOARD_STATUS_TYPE_UNSTARTED)
	doing := statusNamed(b, "В работе")
	done := statusOf(b, v1.BoardStatusType_BOARD_STATUS_TYPE_COMPLETED)
	// bob (a member) creates it: he may edit it, yet has no MANAGE_BOARD.
	task := createTask(t, bob, b.GetId(), &v1.CreateTaskRequest{Title: "Счёт", StatusId: todo, ApproverIds: []string{carol.id, dave.id, eve.id}}, 201)
	id := task.GetId()
	voteTask(carol, id, 200, approve, "")

	gd := dialGW(t)
	gd.identify(dave.token)

	// Members without MANAGE_BOARD: the gate as before, the override and on-behalf refused.
	patchTask(t, bob, id, &v1.UpdateTaskRequest{StatusId: &doing}, 409)
	gateRefused(t, bob.client, 1, 3)
	st := bob.do("PATCH", "/api/tasks/"+id, &v1.UpdateTaskRequest{StatusId: &doing, OverrideApproval: true}, nil)
	wantReason(t, bob.client, st, 403, "APPROVAL_OVERRIDE_DENIED")
	st = bob.do("POST", "/api/tasks/"+id+"/approval", &v1.TaskApprovalRequest{Decision: approve, OnBehalfOf: dave.id}, nil)
	wantReason(t, bob.client, st, 403, "APPROVAL_ON_BEHALF_DENIED")
	// An approver is not a manager either.
	st = carol.do("POST", "/api/tasks/"+id+"/approval", &v1.TaskApprovalRequest{Decision: approve, OnBehalfOf: dave.id}, nil)
	wantReason(t, carol.client, st, 403, "APPROVAL_ON_BEHALF_DENIED")

	// Bots: the bot itself never votes; on behalf of its owner (a manager) the power is closed too.
	bt := createBot(t, o, wid, "managerbot")
	if st, _ := setActsAsOwner(o, wid, bt.id, true); st != 200 {
		t.Fatalf("acts_as_owner: %d", st)
	}
	ob := asOwner(bt)
	wantReason(t, bt.client, bt.do("POST", "/api/tasks/"+id+"/approval", &v1.TaskApprovalRequest{Decision: approve, OnBehalfOf: dave.id}, nil), 403, "BOT_NOT_ALLOWED")
	wantReason(t, ob, ob.do("POST", "/api/tasks/"+id+"/approval", &v1.TaskApprovalRequest{Decision: approve, OnBehalfOf: dave.id}, nil), 403, "BOT_NOT_ALLOWED")
	wantReason(t, ob, ob.do("PATCH", "/api/tasks/"+id, &v1.UpdateTaskRequest{StatusId: &doing, OverrideApproval: true}, nil), 403, "BOT_NOT_ALLOWED")
	ob.must(409, "PATCH", "/api/tasks/"+id, &v1.UpdateTaskRequest{StatusId: &doing}, nil) // the gate as for the owner

	// The manager: no REJECT for someone else, only approvers, never over a personal decision.
	voteFor(o, id, dave.id, 422, reject)
	voteFor(o, id, bob.id, 422, approve)
	voteFor(o, id, "nope", 422, approve)
	voteFor(o, id, carol.id, 409, approve) // carol approved herself
	voteFor(o, id, carol.id, 409, withdraw)

	// Approve on behalf of dave: stored with recorded_by, counted (2 of 3), journaled, notified.
	got := voteFor(o, id, dave.id, 200, approve)
	if a := approverOf(t, got, dave.id); a.GetState() != v1.ApproverState_APPROVER_STATE_APPROVED || a.GetRecordedBy() != o.id {
		t.Fatalf("on behalf: %v", a)
	}
	if a := approverOf(t, got, carol.id); a.GetRecordedBy() != "" {
		t.Fatalf("carol's own vote marked: %v", a)
	}
	if got.GetApprovalState() != v1.TaskApprovalState_TASK_APPROVAL_STATE_PENDING {
		t.Fatalf("2 of 3: %v", got.GetApprovalState())
	}
	n := gd.wait("APPROVED_ON_BEHALF", noticeOf(id, v1.TaskNoticeKind_TASK_NOTICE_KIND_APPROVED_ON_BEHALF)).GetTaskUpdate().GetNotice()
	if n.GetActorId() != o.id {
		t.Fatalf("notice actor %q, want the manager", n.GetActorId())
	}
	acts := entriesOf(t, o, id, "approval")
	last := acts[0]
	if last.GetActorId() != o.id || last.GetAfter().GetFields()["user_id"].GetStringValue() != dave.id ||
		!last.GetAfter().GetFields()["on_behalf"].GetBoolValue() || last.GetAfter().GetFields()["state"].GetStringValue() != "approved" {
		t.Fatalf("on-behalf journal entry %v", last)
	}
	voteFor(o, id, dave.id, 200, approve) // repeated: no change
	if n := len(entriesOf(t, o, id, "approval")); n != len(acts) {
		t.Fatalf("a repeated on-behalf approval journaled again: %d entries, want %d", n, len(acts))
	}

	// The approver withdraws it himself: pending, the mark gone.
	got = voteTask(dave, id, 200, withdraw, "")
	if a := approverOf(t, got, dave.id); a.GetState() != v1.ApproverState_APPROVER_STATE_PENDING || a.GetRecordedBy() != "" {
		t.Fatalf("withdrawn by the approver: %v", a)
	}
	// Recorded again, then confirmed by the approver: his own vote now, the manager may not undo it.
	voteFor(o, id, dave.id, 200, approve)
	got = voteTask(dave, id, 200, approve, "")
	if a := approverOf(t, got, dave.id); a.GetState() != v1.ApproverState_APPROVER_STATE_APPROVED || a.GetRecordedBy() != "" {
		t.Fatalf("confirmed by the approver: %v", a)
	}
	voteFor(o, id, dave.id, 409, withdraw)

	// The override: without it still 409; with it the move goes through and is journaled.
	patchTask(t, o, id, &v1.UpdateTaskRequest{StatusId: &doing}, 409)
	gateRefused(t, o.client, 2, 3)
	moved := patchTask(t, o, id, &v1.UpdateTaskRequest{StatusId: &doing, OverrideApproval: true}, 200)
	if moved.GetStatusId() != doing || moved.GetApprovalState() != v1.TaskApprovalState_TASK_APPROVAL_STATE_PENDING {
		t.Fatalf("overridden: %v", moved)
	}
	ov := entriesOf(t, o, id, "approval_override")
	if len(ov) != 1 || ov[0].GetActorId() != o.id {
		t.Fatalf("approval_override entries %v", ov)
	}
	f := ov[0].GetAfter().GetFields()
	if f["approved"].GetNumberValue() != 2 || f["quorum"].GetNumberValue() != 3 || f["status_id"].GetStringValue() != doing || f["from_status_id"].GetStringValue() != todo {
		t.Fatalf("approval_override after %v", f)
	}
	// An override flag on a move the gate does not hold: no entry.
	patchTask(t, o, id, &v1.UpdateTaskRequest{StatusId: &todo, OverrideApproval: true}, 200)
	if n := len(entriesOf(t, o, id, "approval_override")); n != 1 {
		t.Fatalf("override entries after a backward move: %d", n)
	}

	// On behalf of the last approver: the quorum is reached → APPROVED; withdrawn by the manager → back.
	if st := voteFor(o, id, eve.id, 200, approve).GetApprovalState(); st != v1.TaskApprovalState_TASK_APPROVAL_STATE_APPROVED {
		t.Fatalf("3 of 3 with one on behalf: %v", st)
	}
	patchTask(t, bob, id, &v1.UpdateTaskRequest{StatusId: &doing}, 200)
	got = voteFor(o, id, eve.id, 200, withdraw)
	if a := approverOf(t, got, eve.id); a.GetState() != v1.ApproverState_APPROVER_STATE_PENDING || a.GetRecordedBy() != "" ||
		got.GetApprovalState() != v1.TaskApprovalState_TASK_APPROVAL_STATE_PENDING {
		t.Fatalf("withdrawn by the manager: %v", got)
	}
	// A description change resets the on-behalf approval like any other.
	voteFor(o, id, eve.id, 200, approve)
	desc := "новое"
	reset := patchTask(t, o, id, &v1.UpdateTaskRequest{Description: &desc}, 200)
	if a := approverOf(t, reset, eve.id); a.GetState() != v1.ApproverState_APPROVER_STATE_PENDING || a.GetRecordedBy() != "" {
		t.Fatalf("reset: %v", a)
	}
	// COMPLETED is forward too: the override covers it.
	patchTask(t, o, id, &v1.UpdateTaskRequest{StatusId: &done}, 409)
	patchTask(t, o, id, &v1.UpdateTaskRequest{StatusId: &done, OverrideApproval: true}, 200)
}

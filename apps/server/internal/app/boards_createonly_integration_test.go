//go:build integration

package app_test

import (
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
)

// TestCreateOnlyAccess (CBF-61, ADR-0115): on a closed board «Создавать задачи» allowed without
// «Видеть доску» lets a member create tasks — also through a bot on their behalf with their
// consent (ADR-0111) — and see only their own cards (author, assignee, approver, watcher); the
// rest of the board (other tasks, journal, settings, access, views) stays closed. Bots never
// get it; without CREATE_TASKS creating is refused.
func TestCreateOnlyAccess(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	carol := register(t, invite(t, o, wid))
	dave := register(t, invite(t, o, wid))
	bt := createBot(t, o, wid, "opsa61")
	b := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Документы", Key: "DOC", IsPrivate: true}, 201)
	bid := b.GetId()
	other := createTask(t, o, bid, &v1.CreateTaskRequest{Title: "чужая карточка"}, 201) // DOC-1
	bob.must(404, "GET", "/api/boards/"+bid, nil, nil)
	setBoardPerms(o, bid, 200, creatorOv(o), userOv(bob.id, perm.CreateTasks, 0), userOv(dave.id, perm.ViewBoard|perm.CreateTasks, 0),
		userOv(bt.id, perm.CreateTasks, 0))

	// The board is listed with no card yet: task-scoped, CREATE_TASKS only, no overrides.
	var gbr v1.BoardResponse
	bob.must(200, "GET", "/api/boards/"+bid, nil, &gbr)
	if g := gbr.GetBoard(); !g.GetTaskScoped() || g.GetPermissions() != uint64(perm.CreateTasks) || len(g.GetPermissionOverrides()) != 0 || g.GetOpenTasks() != 0 {
		t.Fatalf("create-only board %v", g)
	}
	if lb := listBoards(t, bob, wid)[bid]; lb == nil || !lb.GetTaskScoped() || lb.GetPermissions() != uint64(perm.CreateTasks) {
		t.Fatalf("listed board %v", lb)
	}
	if ks := taskKeys(listTasks(t, bob, bid, nil)); len(ks) != 0 {
		t.Fatalf("no card yet, got %v", ks)
	}

	// Creates: 201, the author sees and edits the card; someone else's card is 404.
	gb := dialGW(t)
	gb.identify(bob.token)
	mine := createTask(t, bob, bid, &v1.CreateTaskRequest{Title: "мой счёт"}, 201) // DOC-2
	if mine.GetCreatedBy() != bob.id {
		t.Fatalf("author %q", mine.GetCreatedBy())
	}
	gb.wait("TASK_CREATE of the own card", func(e *v1.DispatchEvent) bool { return e.GetTaskCreate().GetTask().GetId() == mine.GetId() })
	bob.must(200, "GET", "/api/tasks/"+mine.GetId(), nil, nil)
	bob.must(200, "GET", "/api/t/DOC-2", nil, nil)
	title := "мой счёт, правка"
	patchTask(t, bob, mine.GetId(), &v1.UpdateTaskRequest{Title: &title}, 200)
	send(t, bob, mine.GetRoomId(), "комментарий", uniq("s"))
	// Notifications reach the author (boards.sees: the card is theirs).
	send(t, o, mine.GetRoomId(), "ответ владельца", uniq("s"))
	gb.wait("COMMENT notice on the own card", func(e *v1.DispatchEvent) bool {
		u := e.GetTaskUpdate()
		return u.GetTask().GetId() == mine.GetId() && u.GetNotice().GetKind() == v1.TaskNoticeKind_TASK_NOTICE_KIND_COMMENT
	})
	bob.must(404, "GET", "/api/tasks/"+other.GetId(), nil, nil)
	bob.must(404, "GET", "/api/t/DOC-1", nil, nil)
	bob.must(404, "GET", "/api/rooms/"+other.GetRoomId()+"/messages", nil, nil)
	patchTask(t, bob, other.GetId(), &v1.UpdateTaskRequest{Title: &title}, 404)
	// A subtask or a neighbour only among the cards they see.
	parent := other.GetId()
	createTask(t, bob, bid, &v1.CreateTaskRequest{Title: "под чужой", ParentId: parent}, 422)
	createTask(t, bob, bid, &v1.CreateTaskRequest{Title: "рядом с чужой", AfterTaskId: other.GetId()}, 422)

	// List, search, «Мои задачи»: only the own card.
	if ks := taskKeys(listTasks(t, bob, bid, nil)); len(ks) != 1 || !ks["DOC-2"] {
		t.Fatalf("list %v", ks)
	}
	var arch v1.ListTasksResponse
	bob.must(200, "GET", "/api/boards/"+bid+"/tasks?archived=1", nil, &arch)
	if len(arch.GetTasks()) != 0 {
		t.Fatal("archived tasks of a create-only board")
	}
	var found v1.SearchTasksResponse
	bob.must(200, "GET", "/api/workspaces/"+wid+"/tasks/search?q=DOC", nil, &found)
	if ks := taskKeys(found.GetTasks()); len(ks) != 1 || !ks["DOC-2"] {
		t.Fatalf("search %v", ks)
	}
	var my v1.MyTasksResponse
	bob.must(200, "GET", "/api/me/tasks?workspace_id="+wid+"&scope=created", nil, &my)
	if ks := taskKeys(my.GetTasks()); !ks["DOC-2"] || ks["DOC-1"] {
		t.Fatalf("my tasks %v", ks)
	}

	// Nothing else of the board: journal, settings, access, views, labels.
	bob.must(403, "GET", "/api/boards/"+bid+"/activity", nil, nil)
	bob.must(403, "GET", "/api/boards/"+bid+"/permissions", nil, nil)
	setBoardPerms(bob, bid, 403)
	name := "моя доска"
	bob.must(403, "PATCH", "/api/boards/"+bid, &v1.UpdateBoardRequest{Name: &name}, nil)
	bob.must(403, "POST", "/api/boards/"+bid+"/views", &v1.CreateBoardViewRequest{Name: "мой"}, nil)
	bob.must(403, "POST", "/api/boards/"+bid+"/labels", &v1.CreateBoardLabelRequest{Name: "нет"}, nil)

	// The other bases still open a card: approver, watcher, assignee.
	appr := createTask(t, o, bid, &v1.CreateTaskRequest{Title: "согласовать"}, 201)
	watch := createTask(t, o, bid, &v1.CreateTaskRequest{Title: "наблюдать"}, 201)
	assg := createTask(t, o, bid, &v1.CreateTaskRequest{Title: "исполнить"}, 201)
	bob.must(404, "GET", "/api/tasks/"+appr.GetId(), nil, nil)
	o.must(200, "PUT", "/api/tasks/"+appr.GetId()+"/approvers", &v1.SetTaskApproversRequest{UserIds: []string{bob.id}}, nil)
	o.must(200, "PUT", "/api/tasks/"+watch.GetId()+"/watchers", &v1.SetTaskWatcherRequest{UserId: bob.id}, nil)
	o.must(200, "PUT", "/api/tasks/"+assg.GetId()+"/assignees", &v1.SetAssigneesRequest{Assignees: []*v1.TaskAssigneeInput{{UserId: bob.id}}}, nil)
	for _, x := range []*v1.Task{appr, watch, assg} {
		bob.must(200, "GET", "/api/tasks/"+x.GetId(), nil, nil)
	}
	patchTask(t, bob, appr.GetId(), &v1.UpdateTaskRequest{Title: &title}, 403) // an approver only votes
	if ks := taskKeys(listTasks(t, bob, bid, nil)); len(ks) != 4 || ks["DOC-1"] {
		t.Fatalf("list with invitations %v", ks)
	}

	// «Видеть доску» ✓ works as before: dave sees every card.
	dave.must(200, "GET", "/api/tasks/"+other.GetId(), nil, nil)
	if ks := taskKeys(listTasks(t, dave, bid, nil)); len(ks) != 5 {
		t.Fatalf("viewer list %v", ks)
	}

	// A bot with the same override is never create-only: the board stays hidden.
	createTask(t, bt, bid, &v1.CreateTaskRequest{Title: "бот сам"}, 404)

	// On behalf (ADR-0111): carol has no right on the board — hidden (404); invited on a card
	// she is task-scoped without CREATE_TASKS — 403; bob with consent — 201, authored by bob.
	carol.must(200, "PUT", "/api/workspaces/"+wid+"/bots/"+bt.id+"/delegations/"+carol.id, nil, nil)
	bob.must(200, "PUT", "/api/workspaces/"+wid+"/bots/"+bt.id+"/delegations/"+bob.id, nil, nil)
	resetBotLimit(t, bt.id)
	oc, ob := asMember(bt, carol.id), asMember(bt, bob.id)
	tasksPath := "/api/boards/" + bid + "/tasks"
	oc.must(404, "POST", tasksPath, &v1.CreateTaskRequest{Title: "от имени Кэрол"}, nil)
	o.must(200, "PUT", "/api/tasks/"+other.GetId()+"/watchers", &v1.SetTaskWatcherRequest{UserId: carol.id}, nil)
	oc.must(403, "POST", tasksPath, &v1.CreateTaskRequest{Title: "от имени Кэрол"}, nil)
	var via v1.TaskResponse
	ob.must(201, "POST", tasksPath, &v1.CreateTaskRequest{Title: "от имени Боба"}, &via)
	if via.GetTask().GetCreatedBy() != bob.id {
		t.Fatalf("on behalf: author %q", via.GetTask().GetCreatedBy())
	}
	bob.must(200, "GET", "/api/tasks/"+via.GetTask().GetId(), nil, nil)
	ob.must(404, "GET", "/api/tasks/"+other.GetId(), nil, nil)

	// Create-only removed: the own card and the board go (the invitations stay).
	setBoardPerms(o, bid, 200, creatorOv(o), userOv(dave.id, perm.ViewBoard|perm.CreateTasks, 0))
	bob.must(404, "GET", "/api/tasks/"+mine.GetId(), nil, nil)
	bob.must(200, "GET", "/api/tasks/"+appr.GetId(), nil, nil)
	createTask(t, bob, bid, &v1.CreateTaskRequest{Title: "уже нельзя"}, 403)
	if lb := listBoards(t, bob, wid)[bid]; lb == nil || lb.GetPermissions() != 0 {
		t.Fatalf("invited-only board %v", lb)
	}
}

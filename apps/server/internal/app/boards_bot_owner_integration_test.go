//go:build integration

package app_test

import (
	"slices"
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
)

// TestBotOwnerIsTaskAuthor (board #136, ADR-0151): a task a bot created for itself counts as its
// owner's own for every author rule — edit and archive / restore with CREATE_TASKS, the
// create-only visibility of ADR-0115 (REST, search, the task room, the gateway) — as long as the
// owner has the board access an author needs. Someone else's bot gives nothing; a deleted bot
// no longer makes its former owner an author. READY lists the recipient's bots.
func TestBotOwnerIsTaskAuthor(t *testing.T) {
	o, _, ws, _ := setupTeam(t)
	wid := ws.GetId()
	carl := register(t, invite(t, o, wid)) // owns a bot (MANAGE_BOTS), no EDIT_TASKS
	dave := register(t, invite(t, o, wid))
	if st, _ := setMemberRoles(o, wid, carl.id, newRole(t, o, wid, "bots", perm.ManageBots).GetId()); st != 200 {
		t.Fatalf("assign MANAGE_BOTS: %d", st)
	}
	mine := createBot(t, carl, wid, "own151")
	theirs := createBot(t, o, wid, "other151")

	// READY: the recipient's own bots only.
	gc := dialGW(t)
	if r := gc.identify(carl.token); !slices.Contains(r.GetMyBotIds(), mine.id) || slices.Contains(r.GetMyBotIds(), theirs.id) {
		t.Fatalf("READY my_bot_ids %v", r.GetMyBotIds())
	}

	// A board where carl, dave and both bots view and create but nobody but o edits any task.
	b := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Боты", Key: "BOW", IsPrivate: true}, 201)
	bid := b.GetId()
	vc := perm.ViewBoard | perm.CreateTasks
	setBoardPerms(o, bid, 200, creatorOv(o), userOv(carl.id, vc, 0), userOv(dave.id, vc, 0),
		userOv(mine.id, vc, 0), userOv(theirs.id, vc, 0))
	byMine := createTask(t, mine, bid, &v1.CreateTaskRequest{Title: "от моего бота"}, 201)
	byTheirs := createTask(t, theirs, bid, &v1.CreateTaskRequest{Title: "от чужого бота"}, 201)
	if byMine.GetCreatedBy() != mine.id {
		t.Fatalf("author %q", byMine.GetCreatedBy())
	}
	title := "правка владельца"
	patchTask(t, carl, byMine.GetId(), &v1.UpdateTaskRequest{Title: &title}, 200)
	patchTask(t, carl, byTheirs.GetId(), &v1.UpdateTaskRequest{Title: &title}, 403)
	patchTask(t, dave, byMine.GetId(), &v1.UpdateTaskRequest{Title: &title}, 403)
	dave.must(403, "POST", "/api/tasks/"+byMine.GetId()+"/archive", nil, nil)
	carl.must(403, "POST", "/api/tasks/"+byTheirs.GetId()+"/archive", nil, nil)
	carl.must(200, "POST", "/api/tasks/"+byMine.GetId()+"/archive", nil, nil)
	carl.must(200, "POST", "/api/tasks/"+byMine.GetId()+"/restore", nil, nil)
	// The owner still needs CREATE_TASKS: view-only, their bot's task is read-only for them.
	setBoardPerms(o, bid, 200, creatorOv(o), userOv(carl.id, perm.ViewBoard, perm.CreateTasks), userOv(mine.id, vc, 0))
	patchTask(t, carl, byMine.GetId(), &v1.UpdateTaskRequest{Title: &title}, 403)
	carl.must(403, "POST", "/api/tasks/"+byMine.GetId()+"/archive", nil, nil)

	// Create-only (ADR-0115): carl sees the cards his bot created, nothing else of the board.
	co := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Заявки", Key: "BOC", IsPrivate: true}, 201)
	cid := co.GetId()
	setBoardPerms(o, cid, 200, creatorOv(o), userOv(carl.id, perm.CreateTasks, 0), userOv(dave.id, perm.CreateTasks, 0),
		userOv(mine.id, vc, 0), userOv(theirs.id, vc, 0))
	foreign := createTask(t, theirs, cid, &v1.CreateTaskRequest{Title: "чужой бот"}, 201) // BOC-1
	own := createTask(t, mine, cid, &v1.CreateTaskRequest{Title: "мой бот"}, 201)         // BOC-2
	gc.wait("TASK_CREATE of the bot's card", func(e *v1.DispatchEvent) bool { return e.GetTaskCreate().GetTask().GetId() == own.GetId() })
	carl.must(200, "GET", "/api/tasks/"+own.GetId(), nil, nil)
	carl.must(200, "GET", "/api/rooms/"+own.GetRoomId()+"/messages", nil, nil)
	patchTask(t, carl, own.GetId(), &v1.UpdateTaskRequest{Title: &title}, 200)
	carl.must(404, "GET", "/api/tasks/"+foreign.GetId(), nil, nil)
	dave.must(404, "GET", "/api/tasks/"+own.GetId(), nil, nil)
	if ks := taskKeys(listTasks(t, carl, cid, nil)); len(ks) != 1 || !ks["BOC-2"] {
		t.Fatalf("create-only list %v", ks)
	}
	var found v1.SearchTasksResponse
	carl.must(200, "GET", "/api/workspaces/"+wid+"/tasks/search?q=BOC", nil, &found)
	if ks := taskKeys(found.GetTasks()); len(ks) != 1 || !ks["BOC-2"] {
		t.Fatalf("search %v", ks)
	}
	// Rights only: «Мои задачи → Созданные» stays what carl created himself.
	var my v1.MyTasksResponse
	carl.must(200, "GET", "/api/me/tasks?workspace_id="+wid+"&scope=created", nil, &my)
	if len(my.GetTasks()) != 0 {
		t.Fatalf("created by me %v", taskKeys(my.GetTasks()))
	}

	// Only in the bot's home workspace: added to another one (by its managers), the bot does
	// not make its owner an author there.
	ws2 := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId()
	carl.must(200, "POST", "/api/invites/"+invite(t, o, ws2)+"/join", nil, nil)
	o.must(201, "POST", "/api/workspaces/"+ws2+"/bots/add", &v1.AddBotRequest{BotUserId: mine.id}, nil)
	away := createBoard(t, o, ws2, &v1.CreateBoardRequest{Name: "Чужое", Key: "BOA", IsPrivate: true}, 201)
	setBoardPerms(o, away.GetId(), 200, creatorOv(o), userOv(carl.id, vc, 0), userOv(mine.id, vc, 0))
	abroad := createTask(t, mine, away.GetId(), &v1.CreateTaskRequest{Title: "в чужом"}, 201)
	patchTask(t, carl, abroad.GetId(), &v1.UpdateTaskRequest{Title: &title}, 403)
	carl.must(403, "POST", "/api/tasks/"+abroad.GetId()+"/archive", nil, nil)

	// The bot deleted: its owner is nobody's author any more.
	setBoardPerms(o, bid, 200, creatorOv(o), userOv(carl.id, vc, 0))
	carl.must(204, "DELETE", "/api/workspaces/"+wid+"/bots/"+mine.id, nil, nil)
	patchTask(t, carl, byMine.GetId(), &v1.UpdateTaskRequest{Title: &title}, 403)
	carl.must(404, "GET", "/api/tasks/"+own.GetId(), nil, nil)
	if ks := taskKeys(listTasks(t, carl, cid, nil)); len(ks) != 0 {
		t.Fatalf("create-only list after the bot's deletion %v", ks)
	}
}

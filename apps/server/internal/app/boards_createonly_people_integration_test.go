//go:build integration

package app_test

import (
	"slices"
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
)

// TestTaskAuthorAddsPeopleByBoardAccess (CBF-51): who adds people to a card on a closed board.
// The reported setup (DOC): the author is a watcher of their old card, and the board grants them
// «Править любые задачи» alone — without «Видеть доску» it gives nothing (ADR-0115), authorship
// counts only for a create-only member, so adding assignees / approvers / watchers is refused
// while calling people by @mention works (ADR-0120). «Создавать задачи» ✓ on top makes them
// create-only: then the author adds people, with or without «Править любые задачи».
func TestTaskAuthorAddsPeopleByBoardAccess(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	carol := register(t, invite(t, o, wid)) // sees the board
	dave := register(t, invite(t, o, wid))  // no access to the board
	b := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Документы", Key: "DOC", IsPrivate: true}, 201)
	bid := b.GetId()
	carolOv := userOv(carol.id, perm.ViewBoard|perm.CreateTasks, 0)
	setBoardPerms(o, bid, 200, creatorOv(o), userOv(bob.id, perm.ViewBoard|perm.CreateTasks, 0), carolOv)
	old := createTask(t, bob, bid, &v1.CreateTaskRequest{Title: "договор"}, 201)
	o.must(200, "PUT", "/api/tasks/"+old.GetId()+"/watchers", &v1.SetTaskWatcherRequest{UserId: bob.id}, nil)

	people := func(id string, want int) {
		t.Helper()
		bob.must(want, "PUT", "/api/tasks/"+id+"/assignees", &v1.SetAssigneesRequest{Assignees: []*v1.TaskAssigneeInput{{UserId: carol.id}, {UserId: dave.id}}}, nil)
		bob.must(want, "PUT", "/api/tasks/"+id+"/approvers", &v1.SetTaskApproversRequest{UserIds: []string{carol.id}}, nil)
		bob.must(want, "PUT", "/api/tasks/"+id+"/watchers", &v1.SetTaskWatcherRequest{UserId: carol.id}, nil)
	}
	mention := func(task *v1.Task, who *user) {
		t.Helper()
		var mr v1.TaskMentionAccessResponse
		bob.must(200, "GET", "/api/tasks/"+task.GetId()+"/mention-access?user_ids="+carol.id+","+who.id, nil, &mr)
		if !slices.Contains(mr.GetSeeIds(), carol.id) || !slices.Contains(mr.GetCardIds(), who.id) {
			t.Fatalf("mention access %v", &mr)
		}
		send(t, bob, task.GetRoomId(), "позову @"+who.id, uniq("m"))
		eventually(t, "the called member becomes a watcher", func() bool { return slices.Contains(watchersOf(t, o, task.GetId()), who.id) })
		who.must(200, "GET", "/api/tasks/"+task.GetId(), nil, nil)
	}

	// «Править любые задачи» alone: the board is seen through the card only, no bits.
	setBoardPerms(o, bid, 200, creatorOv(o), userOv(bob.id, perm.EditTasks, 0), carolOv)
	if lb := listBoards(t, bob, wid)[bid]; lb == nil || !lb.GetTaskScoped() || lb.GetPermissions() != 0 {
		t.Fatalf("edit-only board %v", lb)
	}
	people(old.GetId(), 403)
	mention(old, dave)

	// «Создавать задачи» ✓ too (create-only): the author's own cards accept people.
	for _, bits := range []perm.Bits{perm.CreateTasks | perm.EditTasks, perm.CreateTasks} {
		eve := register(t, invite(t, o, wid))
		setBoardPerms(o, bid, 200, creatorOv(o), userOv(bob.id, bits, 0), carolOv)
		people(old.GetId(), 200)
		mine := createTask(t, bob, bid, &v1.CreateTaskRequest{Title: "счёт"}, 201)
		people(mine.GetId(), 200)
		dave.must(200, "GET", "/api/tasks/"+mine.GetId(), nil, nil)
		mention(mine, eve)
	}
}

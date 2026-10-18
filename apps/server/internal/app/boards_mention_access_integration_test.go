//go:build integration

package app_test

import (
	"net/url"
	"slices"
	"strings"
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
)

// TestTaskMentionAccess (ADR-0076 §5): the commenters' @-list learns who sees the board and who
// would only get the card — without MANAGE_BOARD, through overrides, for task-scoped viewers too.
func TestTaskMentionAccess(t *testing.T) {
	o, bob, ws, room := setupTeam(t)
	wid := ws.GetId()
	carol := register(t, invite(t, o, wid))
	dave := register(t, invite(t, o, wid))
	priv := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Доступ", Key: "MAC", IsPrivate: true}, 201)
	setBoardPerms(o, priv.GetId(), 200, creatorOv(o), userOv(carol.id, perm.ViewBoard|perm.CreateTasks, 0))
	task := createTask(t, o, priv.GetId(), &v1.CreateTaskRequest{Title: "карточка"}, 201)

	var link v1.CreateRoomInviteResponse
	o.must(201, "POST", "/api/rooms/"+room.GetId()+"/invites", &v1.CreateRoomInviteRequest{}, &link)
	anon := &client{t: t, ip: "10.65.9.7"}
	var gj v1.JoinRoomInviteResponse
	anon.must(201, "POST", "/api/room-invites/"+link.GetInvite().GetCode()+"/join", &v1.JoinRoomInviteRequest{Nickname: "Гость"}, &gj)
	guest := gj.GetMe().GetUser().GetId()

	path := "/api/tasks/" + task.GetId() + "/mention-access?user_ids=" + url.QueryEscape(strings.Join([]string{o.id, bob.id, carol.id, dave.id, guest}, ","))
	check := func(who musty, wantSee, wantCard []string) {
		t.Helper()
		var r v1.TaskMentionAccessResponse
		who.must(200, "GET", path, nil, &r)
		see, card := slices.Clone(r.GetSeeIds()), slices.Clone(r.GetCardIds())
		slices.Sort(see)
		slices.Sort(card)
		slices.Sort(wantSee)
		slices.Sort(wantCard)
		if !slices.Equal(see, wantSee) || !slices.Equal(card, wantCard) {
			t.Fatalf("see %v card %v, want %v / %v", see, card, wantSee, wantCard)
		}
	}
	// carol sees the private board through her override (and has no MANAGE_BOARD): bob and dave
	// would get the card only; the guest cannot be called.
	check(carol, []string{o.id, carol.id}, []string{bob.id, dave.id})
	// Outsiders cannot ask; a watcher (task-scoped) can.
	bob.must(404, "GET", path, nil, nil)
	o.must(200, "PUT", "/api/tasks/"+task.GetId()+"/watchers", &v1.SetTaskWatcherRequest{UserId: bob.id}, nil)
	check(bob, []string{o.id, carol.id}, []string{bob.id, dave.id})
	// A bad id is a validation error.
	o.must(422, "GET", "/api/tasks/"+task.GetId()+"/mention-access?user_ids=nope", nil, nil)
}

//go:build integration

package app_test

import (
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
)

// ADR-0109 (CBF-11): the routes opened to bots answer by the bits of the bot's roles exactly as
// for a person — 2xx with the bit, the handler's own 403 (never BOT_NOT_ALLOWED) without it — and
// stay closed on behalf of the owner (ADR-0106).

// wantHandler403 fails unless the last call was the handler's 403, not the route table's.
func wantHandler403(t *testing.T, b *bot, st int, what string) {
	t.Helper()
	if r, _ := errReason(b.client); st != 403 || r == "BOT_NOT_ALLOWED" {
		t.Fatalf("%s without the bit: %d %q, want the handler's 403", what, st, r)
	}
}

// TestBotAPIv3Automations: a bot with MANAGE_BOARD + MANAGE_INTEGRATIONS creates, updates, tests
// and deletes an automation rule, sets, reads and deletes the board's Git, reads the webhook and
// sets the board's access; without the bits each is the normal 403.
func TestBotAPIv3Automations(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	setPlan(t, wid, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_ENTERPRISE}) // automations + board webhooks
	b := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Bot rules", Key: "BRU"}, 201)
	doing := statusOf(b, v1.BoardStatusType_BOARD_STATUS_TYPE_STARTED)
	task := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "for the dry run"}, 201)
	bt := createBot(t, o, wid, "automator")
	rules := "/api/boards/" + b.GetId() + "/rules"
	git := "/api/boards/" + b.GetId() + "/git"
	hook := "/api/boards/" + b.GetId() + "/webhook"
	perms := "/api/boards/" + b.GetId() + "/permissions"
	valid := &v1.CreateBoardRuleRequest{Name: "Bot rule", Trigger: onStatus(doing),
		Actions: []*v1.RuleAction{doPriority(v1.TaskPriority_TASK_PRIORITY_HIGH)}}
	github := &v1.SetBoardGitRequest{Provider: v1.GitProvider_GIT_PROVIDER_GITHUB}

	// A rule made by a person, to show the bot's 403 on PATCH / DELETE / test without the bit.
	ruleOf := createRule(t, o, b.GetId(), valid, 201)

	// No bits: the handlers refuse, the route table does not.
	wantHandler403(t, bt, bt.do("POST", rules, valid, nil), "POST rules")
	bt.must(200, "GET", rules, nil, nil) // a viewer reads them
	name := "renamed"
	wantHandler403(t, bt, bt.do("PATCH", "/api/rules/"+ruleOf.GetId(), &v1.UpdateBoardRuleRequest{Name: &name}, nil), "PATCH rule")
	wantHandler403(t, bt, bt.do("POST", "/api/rules/"+ruleOf.GetId()+"/test", &v1.TestBoardRuleRequest{TaskId: task.GetId()}, nil), "test rule")
	wantHandler403(t, bt, bt.do("DELETE", "/api/rules/"+ruleOf.GetId(), nil, nil), "DELETE rule")
	wantHandler403(t, bt, bt.do("GET", git, nil, nil), "GET git")
	wantHandler403(t, bt, bt.do("PUT", git, github, nil), "PUT git")
	wantHandler403(t, bt, bt.do("GET", hook, nil, nil), "GET webhook")
	wantHandler403(t, bt, bt.do("PUT", perms, &v1.SetBoardPermissionsRequest{Overrides: b.GetPermissionOverrides()}, nil), "PUT board permissions")

	// MANAGE_BOARD on the board: rules and the board's access; Git still needs MANAGE_INTEGRATIONS.
	setBoardPerms(o, b.GetId(), 200, append(b.GetPermissionOverrides(), userOv(bt.id, perm.ManageBoard, 0))...)
	r := createRule(t, bt, b.GetId(), valid, 201)
	if r.GetCreatedBy() != bt.id {
		t.Fatalf("bot rule: %v", r)
	}
	var ur v1.BoardRuleResponse
	bt.must(200, "PATCH", "/api/rules/"+r.GetId(), &v1.UpdateBoardRuleRequest{Name: &name}, &ur)
	if ur.GetRule().GetName() != name {
		t.Fatalf("bot rule update: %v", ur.GetRule())
	}
	var tr v1.RuleTestResponse
	bt.must(200, "POST", "/api/rules/"+r.GetId()+"/test", &v1.TestBoardRuleRequest{TaskId: task.GetId()}, &tr)
	if len(tr.GetActions()) != 1 {
		t.Fatalf("bot dry run: %v", &tr)
	}
	bt.must(204, "DELETE", "/api/rules/"+r.GetId(), nil, nil)
	wantHandler403(t, bt, bt.do("PUT", git, github, nil), "PUT git without MANAGE_INTEGRATIONS")
	bt.must(200, "GET", hook, nil, nil) // MANAGE_BOARD reads the webhook
	var pr v1.BoardPermissionsResponse
	bt.must(200, "PUT", perms, &v1.SetBoardPermissionsRequest{Overrides: append(b.GetPermissionOverrides(),
		userOv(bt.id, perm.ManageBoard, 0), userOv(bob.id, perm.CreateTasks, 0))}, &pr)
	// No escalation: the bot cannot grant a bit it does not hold on the board.
	wantHandler403(t, bt, bt.do("PUT", perms, &v1.SetBoardPermissionsRequest{Overrides: append(b.GetPermissionOverrides(),
		userOv(bt.id, perm.ManageBoard, 0), userOv(bob.id, perm.EditTasks, 0))}, nil), "grant EDIT_TASKS")

	// MANAGE_INTEGRATIONS of the workspace too: the board's Git.
	giveBot(t, o, wid, bt, "Integrations", perm.ManageIntegrations)
	var gr v1.BoardGitResponse
	bt.must(200, "PUT", git, github, &gr)
	if gr.GetSecret() == "" || !gr.GetGit().GetHasSecret() || gr.GetGit().GetCreatedBy() != bt.id {
		t.Fatalf("bot git: %v", &gr)
	}
	var got v1.BoardGitResponse
	bt.must(200, "GET", git, nil, &got)
	if got.GetSecret() != "" || got.GetGit().GetProvider() != v1.GitProvider_GIT_PROVIDER_GITHUB {
		t.Fatalf("bot git read: %v", &got)
	}
	bt.must(204, "DELETE", git, nil, nil)
	bt.must(200, "GET", git, nil, &got)
	if got.GetGit() != nil {
		t.Fatalf("git after delete: %v", &got)
	}

	// On behalf of the owner these stay closed (ADR-0109 does not widen ADR-0106).
	if st, _ := setActsAsOwner(o, wid, bt.id, true); st != 200 {
		t.Fatalf("acts_as_owner: %d", st)
	}
	ob := asOwner(bt)
	wantReason(t, ob, ob.do("POST", rules, valid, nil), 403, "ON_BEHALF_ROUTE")
	wantReason(t, ob, ob.do("GET", git, nil, nil), 403, "ON_BEHALF_ROUTE")
}

// TestBotAPIv3Integrations: web apps, GPTunneL, telephony settings by MANAGE_INTEGRATIONS and
// the calls journal by VIEW_JOURNALS.
func TestBotAPIv3Integrations(t *testing.T) {
	o, _, ws, _ := setupTeam(t)
	wid := ws.GetId()
	base := "/api/workspaces/" + wid
	bt := createBot(t, o, wid, "integrator")
	app := &v1.CreateWorkspaceAppRequest{Name: "Dash", Url: "https://dash.example.com"}

	bt.must(200, "GET", base+"/apps", nil, nil) // members read apps
	wantHandler403(t, bt, bt.do("POST", base+"/apps", app, nil), "POST apps")
	bt.must(200, "GET", base+"/integrations/gptunnel", nil, nil) // members see the pairing
	wantHandler403(t, bt, bt.do("DELETE", base+"/integrations/gptunnel", nil, nil), "unpair GPTunneL")
	wantHandler403(t, bt, bt.do("GET", base+"/sip", nil, nil), "GET sip")
	wantHandler403(t, bt, bt.do("GET", base+"/calls", nil, nil), "calls journal")

	giveBot(t, o, wid, bt, "Integrations", perm.ManageIntegrations)
	var ar v1.CreateWorkspaceAppResponse
	bt.must(201, "POST", base+"/apps", app, &ar)
	bt.must(204, "DELETE", "/api/workspace-apps/"+ar.GetApp().GetId(), nil, nil)
	bt.must(204, "DELETE", base+"/integrations/gptunnel", nil, nil)
	var sr v1.GetSipSettingsResponse
	bt.must(200, "GET", base+"/sip", nil, &sr)
	wantHandler403(t, bt, bt.do("GET", base+"/calls", nil, nil), "calls journal without VIEW_JOURNALS")
	giveBot(t, o, wid, bt, "Journals", perm.ViewJournals)
	bt.must(200, "GET", base+"/calls", nil, nil)
}

// TestBotAPIv3Content: camera backgrounds and the achievements catalog by MANAGE_WORKSPACE,
// grants by MANAGE_MEMBERS.
func TestBotAPIv3Content(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	base := "/api/workspaces/" + wid
	bt := createBot(t, o, wid, "curator")
	bu := &user{client: bt.client, id: bt.id}
	medal := newAchievement(t, o, wid, "Медаль")
	grantReq := &v1.GrantAchievementRequest{AchievementId: medal.GetId(), Note: "от бота"}

	bt.must(200, "GET", base+"/backgrounds", nil, nil)
	bgPic := bgUpload(t, bu, wid, pngBytes(64, 36))
	wantHandler403(t, bt, bt.do("POST", base+"/backgrounds", &v1.CreateBackgroundRequest{Name: "Bot", FileId: bgPic}, nil), "POST backgrounds")
	wantHandler403(t, bt, bt.do("POST", base+"/achievements", &v1.CreateAchievementRequest{Title: "Бот",
		FileId: achievementUpload(t, bu, wid, "m.png", achievementPNG(t, false))}, nil), "POST achievements")
	wantHandler403(t, bt, bt.do("POST", base+"/members/"+bob.id+"/achievements", grantReq, nil), "grant")

	giveBot(t, o, wid, bt, "Workspace", perm.ManageWorkspace)
	var bg v1.CreateBackgroundResponse
	bt.must(201, "POST", base+"/backgrounds", &v1.CreateBackgroundRequest{Name: "Bot", FileId: bgPic}, &bg)
	bt.must(204, "DELETE", base+"/backgrounds/"+bg.GetBackground().GetId(), nil, nil)
	own := newAchievement(t, bu, wid, "От бота")
	title := "Бот+"
	bt.must(200, "PATCH", "/api/achievements/"+own.GetId(), &v1.UpdateAchievementRequest{Title: &title}, nil)
	bt.must(204, "DELETE", "/api/achievements/"+own.GetId(), nil, nil)

	wantHandler403(t, bt, bt.do("POST", base+"/members/"+bob.id+"/achievements", grantReq, nil), "grant without MANAGE_MEMBERS")
	giveBot(t, o, wid, bt, "Members", perm.ManageMembers)
	var g v1.MemberAchievement
	bt.must(201, "POST", base+"/members/"+bob.id+"/achievements", grantReq, &g)
	bt.must(422, "POST", base+"/members/"+bt.id+"/achievements", grantReq, nil) // never to a bot or oneself
	bt.must(204, "DELETE", base+"/members/"+bob.id+"/achievements/"+g.GetId(), nil, nil)
}

// TestBotAPIv3RoomsAndMeetings: a temporary room made permanent by MANAGE_ROOM, meeting
// comments like people (edit — the author, delete — the author or who may change the meeting),
// recordings answer from the handler.
func TestBotAPIv3RoomsAndMeetings(t *testing.T) {
	o, bob, ws, room := setupTeam(t)
	wid := ws.GetId()
	bt := createBot(t, o, wid, "keeper")

	var tr v1.TempRoomResponse
	bt.must(201, "POST", "/api/workspaces/"+wid+"/rooms/temp", &v1.CreateTempRoomRequest{Name: "bot temp", TtlSeconds: 900, Guests: noGuests()}, &tr)
	perm1 := "/api/rooms/" + tr.GetRoom().GetId() + "/make-permanent"
	wantHandler403(t, bt, bt.do("POST", perm1, nil, nil), "make permanent")
	giveBot(t, o, wid, bt, "Rooms", perm.ManageRoom)
	var mp v1.MakeRoomPermanentResponse
	bt.must(200, "POST", perm1, nil, &mp)
	if mp.GetRoom().GetExpiresAt() != nil {
		t.Fatalf("still temporary: %v", mp.GetRoom())
	}

	start := time.Now().Add(48 * time.Hour).Truncate(time.Minute)
	ev := createEvent(t, o, wid, &v1.CreateCalendarEventRequest{Title: "Sync", RoomId: room.GetId(), StartsAt: ts(start),
		EndsAt: ts(start.Add(time.Hour)), Tz: "UTC"})
	comments := "/api/events/" + ev.GetId() + "/comments"
	var bc, pc v1.CalendarEventCommentResponse
	bob.must(201, "POST", comments, &v1.CalendarEventCommentRequest{Body: "от Боба"}, &pc)
	bt.must(201, "POST", comments, &v1.CalendarEventCommentRequest{Body: "от бота"}, &bc)
	if bc.GetComment().GetAuthorId() != bt.id {
		t.Fatalf("bot comment: %v", bc.GetComment())
	}
	var list v1.ListCalendarEventCommentsResponse
	bt.must(200, "GET", comments, nil, &list)
	if len(list.GetComments()) != 2 {
		t.Fatalf("comments: %v", list.GetComments())
	}
	bt.must(200, "PATCH", comments+"/"+bc.GetComment().GetId(), &v1.CalendarEventCommentRequest{Body: "от бота, правка"}, nil)
	wantHandler403(t, bt, bt.do("PATCH", comments+"/"+pc.GetComment().GetId(), &v1.CalendarEventCommentRequest{Body: "чужой"}, nil), "edit another's comment")
	bt.must(204, "DELETE", comments+"/"+bc.GetComment().GetId(), nil, nil)

	// Recordings: the route is open, the handler answers (no such recording here).
	rec := "/api/rooms/" + room.GetId() + "/recordings/01890000-0000-7000-8000-00000000abcd"
	for _, c := range []struct{ method, path string }{{"POST", rec + "/recheck"}, {"POST", rec + "/reupload"}, {"DELETE", rec}} {
		st := bt.do(c.method, c.path, nil, nil)
		if r, _ := errReason(bt.client); r == "BOT_NOT_ALLOWED" || st/100 == 2 {
			t.Fatalf("%s %s: %d %q", c.method, c.path, st, r)
		}
	}
}

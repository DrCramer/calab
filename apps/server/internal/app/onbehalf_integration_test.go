//go:build integration

package app_test

import (
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/app"
)

// A bot acts on behalf of its owner (ADR-0106).

// asOwner is the bot's client with "Calab-On-Behalf: owner".
func asOwner(b *bot) *client {
	return &client{t: b.t, token: b.token, header: http.Header{"Calab-On-Behalf": {"owner"}}}
}

// wantReason checks the last answer of c.
func wantReason(t *testing.T, c *client, st, wantSt int, reason string) {
	t.Helper()
	if got, _ := errReason(c); st != wantSt || got != reason {
		t.Fatalf("status %d reason %q, want %d %q (%s)", st, got, wantSt, reason, c.lastBody)
	}
}

func setActsAsOwner(u *user, wsID, botID string, on bool) (int, *v1.Bot) {
	var r v1.UpdateBotResponse
	st := u.do("PATCH", "/api/workspaces/"+wsID+"/bots/"+botID, &v1.UpdateBotRequest{ActsAsOwner: &on}, &r)
	return st, r.GetBot()
}

// TestOnBehalfOfOwner: only the owner turns it on; the header without the switch, with a
// person's token or with a wrong value is refused (never a silent fallback); on behalf the bot
// votes in an approval and writes messages as the owner with via_bot_id; the forbidden routes;
// the bot must be a member of the workspace, the owner an active member there; turning it off
// and revoking the token stop it at once.
func TestOnBehalfOfOwner(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	adminRole := v1.WorkspaceRole_WORKSPACE_ROLE_ADMIN
	o.must(200, "PATCH", "/api/workspaces/"+wid+"/members/"+bob.id, &v1.UpdateMemberRequest{Role: &adminRole}, nil)
	bt := createBot(t, bob, wid, "assistant") // bob owns it; o manages bots of the workspace too
	ob := asOwner(bt)
	room := textRoom(t, o, wid, "general", false)

	// Off by default: the header is refused, the bot alone still works.
	wantReason(t, ob, ob.do("GET", "/api/workspaces/"+wid, nil, nil), 403, "ON_BEHALF_DISABLED")
	bt.must(200, "GET", "/api/workspaces/"+wid, nil, nil)
	// A person's token with the header, a wrong value.
	pc := &client{t: t, token: bob.token, header: http.Header{"Calab-On-Behalf": {"owner"}}}
	wantReason(t, pc, pc.do("GET", "/api/workspaces/"+wid, nil, nil), 403, "ON_BEHALF_NOT_BOT")
	bad := &client{t: t, token: bt.token, header: http.Header{"Calab-On-Behalf": {"admin"}}}
	wantReason(t, bad, bad.do("GET", "/api/workspaces/"+wid, nil, nil), 400, "ON_BEHALF_INVALID")

	// Only the owner toggles: MANAGE_BOTS (the workspace owner here) gets 403, the bot too.
	st, _ := setActsAsOwner(o, wid, bt.id, true)
	wantReason(t, o.client, st, 403, "ON_BEHALF_OWNER_ONLY")
	on := true
	wantReason(t, bt.client, bt.do("PATCH", "/api/workspaces/"+wid+"/bots/"+bt.id, &v1.UpdateBotRequest{ActsAsOwner: &on}, nil), 403, "BOT_NOT_ALLOWED")
	st, got := setActsAsOwner(bob, wid, bt.id, true)
	if st != 200 || !got.GetActsAsOwner() || got.GetActsAsOwnerSince() == nil {
		t.Fatalf("owner turns it on: %d %v", st, got)
	}
	// Visible to the bot itself and to the managers' list; no self-escalation on behalf.
	var me v1.GetBotMeResponse
	bt.must(200, "GET", "/api/bots/me", nil, &me)
	if !me.GetBot().GetActsAsOwner() {
		t.Fatalf("bot sees %v", me.GetBot())
	}
	var list v1.ListBotsResponse
	o.must(200, "GET", "/api/workspaces/"+wid+"/bots", nil, &list)
	if i := slices.IndexFunc(list.GetBots(), func(b *v1.Bot) bool { return b.GetUser().GetId() == bt.id }); i < 0 || !list.GetBots()[i].GetActsAsOwner() {
		t.Fatalf("managers' list %v", list.GetBots())
	}
	off := false
	wantReason(t, ob, ob.do("PATCH", "/api/workspaces/"+wid+"/bots/"+bt.id, &v1.UpdateBotRequest{ActsAsOwner: &off}, nil), 403, "ON_BEHALF_ROUTE")

	// Who am I on behalf: the owner.
	var whoami v1.GetMeResponse
	ob.must(200, "GET", "/api/me", nil, &whoami)
	if whoami.GetMe().GetUser().GetId() != bob.id {
		t.Fatalf("on behalf /api/me is %s, want the owner %s", whoami.GetMe().GetUser().GetId(), bob.id)
	}

	// The approval vote: the bot itself never votes; on behalf it is the owner's vote, marked.
	b := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "OnBehalf", Key: "OBH"}, 201)
	task := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "Согласовать", ApproverIds: []string{bob.id}}, 201)
	voteTask(bt, task.GetId(), 403, approve, "")
	voted := voteTask(ob, task.GetId(), 200, approve, "")
	if voted.GetApprovalState() != v1.TaskApprovalState_TASK_APPROVAL_STATE_APPROVED ||
		voted.GetApprovers()[0].GetUserId() != bob.id || voted.GetApprovers()[0].GetState() != v1.ApproverState_APPROVER_STATE_APPROVED {
		t.Fatalf("vote on behalf: %v", voted)
	}
	var page v1.TaskActivityPage
	o.must(200, "GET", "/api/tasks/"+task.GetId()+"/activity?limit=100", nil, &page)
	found := false
	for _, it := range page.GetItems() {
		if a := it.GetActivity(); a != nil {
			switch a.GetKind() {
			case "approval":
				found = true
				if a.GetActorId() != bob.id || a.GetViaBotId() != bt.id {
					t.Fatalf("approval entry %v: want actor %s via %s", a, bob.id, bt.id)
				}
			case "created":
				if a.GetViaBotId() != "" {
					t.Fatalf("the owner's own entry is marked: %v", a)
				}
			}
		}
	}
	if !found {
		t.Fatalf("no approval entry in %v", page.GetItems())
	}
	// A direct change of the owner after one through the bot is not merged into it.
	title := "Своими руками"
	patchTask(t, ob, task.GetId(), &v1.UpdateTaskRequest{Title: &title}, 200)
	title2 := "Своими руками 2"
	patchTask(t, bob, task.GetId(), &v1.UpdateTaskRequest{Title: &title2}, 200)
	var titles []string
	o.must(200, "GET", "/api/tasks/"+task.GetId()+"/activity?limit=100", nil, &page)
	for _, it := range page.GetItems() {
		if a := it.GetActivity(); a != nil && a.GetKind() == "title" {
			titles = append(titles, a.GetActorId()+"/"+a.GetViaBotId())
		}
	}
	if !slices.Contains(titles, bob.id+"/"+bt.id) || !slices.Contains(titles, bob.id+"/") {
		t.Fatalf("title entries %v: want one through the bot and one direct", titles)
	}

	// A message on behalf: author = the owner, via_bot_id = the bot; the owner's own has none.
	var cm v1.CreateMessageResponse
	ob.must(201, "POST", "/api/rooms/"+room+"/messages", &v1.CreateMessageRequest{Content: "от имени"}, &cm)
	if m := cm.GetMessage(); m.GetAuthorId() != bob.id || m.GetViaBotId() != bt.id {
		t.Fatalf("message on behalf %v", m)
	}
	if m := send(t, bob, room, "сам", ""); m.GetViaBotId() != "" {
		t.Fatalf("own message marked %v", m)
	}
	var ms v1.ListMessagesResponse
	o.must(200, "GET", "/api/rooms/"+room+"/messages", nil, &ms)
	if i := slices.IndexFunc(ms.GetMessages(), func(m *v1.Message) bool { return m.GetId() == cm.GetMessage().GetId() }); i < 0 || ms.GetMessages()[i].GetViaBotId() != bt.id {
		t.Fatalf("listed message lost via_bot_id: %v", ms.GetMessages())
	}

	// Forbidden even on behalf: the account, bot management, billing, workspace deletion, voice.
	for _, r := range [][2]string{
		{"PATCH", "/api/me"},
		{"GET", "/api/me/sessions"},
		{"PATCH", "/api/me/password"},
		{"PATCH", "/api/me/email"},
		{"POST", "/api/workspaces/" + wid + "/bots/" + bt.id + "/token"},
		{"DELETE", "/api/workspaces/" + wid + "/bots/" + bt.id},
		{"GET", "/api/bots/me"},
		{"GET", "/api/workspaces/" + wid + "/billing"},
		{"DELETE", "/api/workspaces/" + wid},
		{"POST", "/api/workspaces"},
		{"GET", "/api/admin/workspaces"},
		{"POST", "/api/rooms/" + room + "/join"},
	} {
		wantReason(t, ob, ob.do(r[0], r[1], nil, nil), 403, "ON_BEHALF_ROUTE")
	}

	// The bot must be a member of the workspace (else 404, as for any outsider); the owner an
	// active member there (else 403).
	ws2 := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId()
	var j v1.JoinWorkspaceResponse
	bob.must(200, "POST", "/api/invites/"+invite(t, o, ws2)+"/join", nil, &j)
	ob.must(404, "GET", "/api/workspaces/"+ws2+"/rooms", nil, nil)
	o.must(201, "POST", "/api/workspaces/"+ws2+"/bots/add", &v1.AddBotRequest{BotUserId: bt.id}, nil)
	ob.must(200, "GET", "/api/workspaces/"+ws2+"/rooms", nil, nil)
	o.must(204, "DELETE", "/api/workspaces/"+ws2+"/members/"+bob.id, nil, nil)
	wantReason(t, ob, ob.do("GET", "/api/workspaces/"+ws2+"/rooms", nil, nil), 403, "ON_BEHALF_OWNER_NOT_MEMBER")
	room2 := textRoom(t, o, ws2, "general", false)
	wantReason(t, ob, ob.do("POST", "/api/rooms/"+room2+"/messages", &v1.CreateMessageRequest{Content: "x"}, nil), 403, "ON_BEHALF_OWNER_NOT_MEMBER")
	ob.must(200, "GET", "/api/workspaces/"+wid+"/rooms", nil, nil) // still a member of the first one

	// Turned off: refused at once; turned on again; a revoked token is 401.
	if st, got := setActsAsOwner(bob, wid, bt.id, false); st != 200 || got.GetActsAsOwner() || got.GetActsAsOwnerSince() != nil {
		t.Fatalf("off: %d %v", st, got)
	}
	wantReason(t, ob, ob.do("GET", "/api/workspaces/"+wid, nil, nil), 403, "ON_BEHALF_DISABLED")
	if st, _ := setActsAsOwner(bob, wid, bt.id, true); st != 200 {
		t.Fatalf("on again: %d", st)
	}
	ob.must(200, "GET", "/api/workspaces/"+wid, nil, nil)
	bob.must(204, "DELETE", "/api/workspaces/"+wid+"/bots/"+bt.id+"/token", nil, nil)
	ob.must(401, "GET", "/api/workspaces/"+wid, nil, nil)
}

// TestOnBehalfRouteWalk walks every API route on behalf of the owner: a route the tag closes
// answers 403 ON_BEHALF_ROUTE, an open one never does; the tag lists registered routes only.
func TestOnBehalfRouteWalk(t *testing.T) {
	for _, p := range app.OnBehalfRoutePatterns() {
		if !slices.Contains(testApp.Routes, p) {
			t.Errorf("on-behalf table lists %q, which is not registered", p)
		}
	}
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	b := createBot(t, o, ws.GetId(), "walker")
	if st, _ := setActsAsOwner(o, ws.GetId(), b.id, true); st != 200 {
		t.Fatalf("turn on: %d", st)
	}
	ob := asOwner(b)
	fake := "01890000-0000-7000-8000-00000000abcd"
	for _, p := range testApp.Routes {
		method, path, ok := strings.Cut(p, " ")
		if !ok || !strings.HasPrefix(path, "/api/") || app.BotRouteAccess(p) == "public" {
			continue
		}
		for _, name := range []string{"{id}", "{userId}", "{roleId}", "{inviteId}", "{rid}", "{botId}", "{messageId}", "{cid}"} {
			path = strings.ReplaceAll(path, name, fake)
		}
		path = strings.NewReplacer("{code}", "nocode", "{emoji}", "%F0%9F%91%8D", "{ref}", "nobody_bot").Replace(path)
		var st int
		for range 20 {
			st = ob.do(method, path, nil, nil)
			if st != 429 {
				break
			}
			time.Sleep(200 * time.Millisecond)
		}
		reason, _ := errReason(ob)
		// The identity feature routes refuse every bot token before auth (BOT_NOT_ALLOWED).
		denied := st == 403 && (reason == "ON_BEHALF_ROUTE" || reason == "BOT_NOT_ALLOWED")
		if want := !app.OnBehalfAllowed(p); denied != want {
			t.Errorf("%s on behalf: status %d reason %q, want denied=%v", p, st, reason, want)
		}
	}
}

//go:build integration

package app_test

import (
	"crypto/x509"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	lkauth "github.com/livekit/protocol/auth"
	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/app"
	"github.com/calaba/calaba/server/internal/bots"
	"github.com/calaba/calaba/server/internal/perm"
)

// Bots and the Bot API (ADR-0031).

// botHookCAs trusts the TLS test servers of webhook tests (their certificates are added
// before the first delivery to them).
var (
	botHookCAs        = x509.NewCertPool()
	botWebhookOptions = bots.WebhookOptions{
		RootCAs: botHookCAs, Poll: 100 * time.Millisecond,
		Backoff: func(int32) time.Duration { return 150 * time.Millisecond },
		GiveUp:  2 * time.Second,
	}
)

type bot struct {
	*client
	id       string
	username string
	resp     *v1.CreateBotResponse
}

func createBot(t *testing.T, u *user, wsID, name string) *bot {
	t.Helper()
	var r v1.CreateBotResponse
	username := strings.ToLower(strings.ReplaceAll(uniq(name+"_"), "-", "_"))
	u.must(201, "POST", "/api/workspaces/"+wsID+"/bots", &v1.CreateBotRequest{DisplayName: name, Username: username, Description: "test bot"}, &r)
	return &bot{client: &client{t: t, token: r.GetToken()}, id: r.GetBot().GetUser().GetId(), username: username, resp: &r}
}

func textRoom(t *testing.T, u *user, wsID, name string, private bool) string {
	t.Helper()
	var cr v1.CreateRoomResponse
	u.must(201, "POST", "/api/workspaces/"+wsID+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_TEXT, Name: name, IsPrivate: private}, &cr)
	return cr.GetRoom().GetId()
}

func errReason(c *client) (string, v1.ErrorCode) {
	var e v1.ApiError
	_ = protojson.Unmarshal(c.lastBody, &e)
	return e.GetReason(), e.GetCode()
}

// Every registered route has an explicit bot decision, the table has no stale entries, and
// walking all routes with a bot token shows the table is what the server enforces.
func TestBotRouteTable(t *testing.T) {
	for _, p := range testApp.Routes {
		if app.BotRouteAccess(p) == "" {
			t.Errorf("route %q has no bot decision in internal/app/botroutes.go", p)
		}
	}
	for _, p := range app.BotRoutePatterns() {
		if !slices.Contains(testApp.Routes, p) {
			t.Errorf("bot route table lists %q, which is not registered", p)
		}
	}
	for _, p := range app.BotAuditedPatterns() {
		if app.BotRouteAccess(p) != "allow" {
			t.Errorf("audited bot route %q is not open to bots", p)
		}
	}
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	b := createBot(t, o, ws.GetId(), "walker")
	fake := "01890000-0000-7000-8000-00000000abcd"
	for _, p := range testApp.Routes {
		method, path, ok := strings.Cut(p, " ")
		access := app.BotRouteAccess(p)
		if !ok || !strings.HasPrefix(path, "/api/") || (access == "public" && p != "POST /api/auth/logout" && p != "POST /api/room-invites/{code}/join") {
			continue
		}
		for _, name := range []string{"{id}", "{userId}", "{roleId}", "{inviteId}", "{rid}", "{botId}", "{messageId}", "{cid}"} {
			path = strings.ReplaceAll(path, name, fake)
		}
		path = strings.NewReplacer("{code}", "nocode", "{emoji}", "%F0%9F%91%8D", "{ref}", "nobody_bot").Replace(path)
		var st int
		for range 20 {
			st = b.do(method, path, nil, nil)
			if st != 429 {
				break
			}
			time.Sleep(200 * time.Millisecond)
		}
		reason, _ := errReason(b.client)
		denied := st == 403 && reason == "BOT_NOT_ALLOWED"
		if want := access != "allow"; denied != want {
			t.Errorf("%s as a bot: %d %q, want denied=%v", p, st, reason, want)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// Create, token reissue / revoke, delete, the plan limit and adding to another workspace.
func TestBotLifecycle(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	code := invite(t, o, ws.GetId())
	bob := register(t, code)
	base := "/api/workspaces/" + ws.GetId() + "/bots"

	// Members without MANAGE_WORKSPACE cannot create bots; bad input is 422.
	bob.must(403, "POST", base, &v1.CreateBotRequest{DisplayName: "x", Username: "bob_bot"}, nil)
	o.must(422, "POST", base, &v1.CreateBotRequest{DisplayName: "x", Username: "a"}, nil)
	o.must(422, "POST", base, &v1.CreateBotRequest{DisplayName: "", Username: "abc_bot"}, nil)

	b := createBot(t, o, ws.GetId(), "Echo")
	tok := b.token
	if !strings.HasPrefix(tok, "calab_bot_"+b.id+"_") || b.resp.GetBot().GetTokenPrefix() == "" ||
		!strings.HasPrefix(tok, "calab_bot_"+b.id+"_"+b.resp.GetBot().GetTokenPrefix()) {
		t.Fatalf("token %q prefix %q", tok, b.resp.GetBot().GetTokenPrefix())
	}
	if b.resp.GetBot().GetWebhook() == nil || b.resp.GetBot().GetOwnerUserId() != o.id || b.resp.GetBot().GetWorkspaceId() != ws.GetId() {
		t.Fatalf("bot: %v", b.resp.GetBot())
	}
	o.must(409, "POST", base, &v1.CreateBotRequest{DisplayName: "dup", Username: b.username}, nil)

	// The bot is a member (role member), marked is_bot, and knows itself.
	var me v1.GetMeResponse
	b.must(200, "GET", "/api/me", nil, &me)
	if !me.GetMe().GetUser().GetIsBot() || me.GetMe().GetUser().GetId() != b.id || me.GetMe().GetEmail() != "" {
		t.Fatalf("GET /api/me as bot: %v", me.GetMe())
	}
	var bm v1.GetBotMeResponse
	b.must(200, "GET", "/api/bots/me", nil, &bm)
	if bm.GetBot().GetUsername() != b.username {
		t.Fatalf("GET /api/bots/me: %v", bm.GetBot())
	}
	o.must(403, "GET", "/api/bots/me", nil, nil) // people have no bot profile
	var members v1.ListMembersResponse
	bob.must(200, "GET", "/api/workspaces/"+ws.GetId()+"/members", nil, &members)
	found := false
	for _, m := range members.GetMembers() {
		if m.GetUser().GetId() == b.id {
			found = m.GetUser().GetIsBot() && m.GetRole() == v1.WorkspaceRole_WORKSPACE_ROLE_MEMBER
		}
	}
	if !found {
		t.Fatal("the bot is not a member with role member and is_bot")
	}
	var list v1.ListBotsResponse
	o.must(200, "GET", base, nil, &list)
	if len(list.GetBots()) != 1 || list.GetBots()[0].GetUser().GetId() != b.id {
		t.Fatalf("list: %v", list.GetBots())
	}
	bob.must(403, "GET", base, nil, nil)

	// Profile: name and description; other profile settings are not for bots.
	name, desc := "Echo Bot", "Repeats what you say"
	b.must(200, "PATCH", "/api/bots/me", &v1.UpdateBotMeRequest{DisplayName: &name, Description: &desc}, &bm)
	if bm.GetBot().GetUser().GetDisplayName() != name || bm.GetBot().GetDescription() != desc {
		t.Fatalf("PATCH /api/bots/me: %v", bm.GetBot())
	}
	tz := "Europe/Moscow"
	b.must(403, "PATCH", "/api/me", &v1.UpdateMeRequest{Timezone: &tz}, nil)
	b.must(200, "PATCH", "/api/me", &v1.UpdateMeRequest{DisplayName: &name}, nil)

	// Gateway: IDENTIFY with the bot token.
	g := dialGW(t)
	ready := g.identify(tok)
	if !ready.GetMe().GetUser().GetIsBot() || len(ready.GetWorkspaces()) != 1 {
		t.Fatalf("READY of a bot: %v", ready.GetMe())
	}

	// Reissue: the old token dies at once (REST 401, socket 4010), the new one works.
	var re v1.ReissueBotTokenResponse
	bob.must(403, "POST", base+"/"+b.id+"/token", nil, nil)
	o.must(200, "POST", base+"/"+b.id+"/token", nil, &re)
	if re.GetToken() == "" || re.GetToken() == tok {
		t.Fatal("reissue returned no new token")
	}
	b.must(401, "GET", "/api/me", nil, nil)
	if st := g.closeStatus(); st != 4010 {
		t.Fatalf("bot socket after reissue: %d, want 4010", st)
	}
	b.token = re.GetToken()
	b.must(200, "GET", "/api/me", nil, nil)

	// Revoke: no token works until the next reissue.
	o.must(204, "DELETE", base+"/"+b.id+"/token", nil, nil)
	b.must(401, "GET", "/api/me", nil, nil)
	o.must(200, "GET", base, nil, &list)
	if list.GetBots()[0].GetTokenPrefix() != "" || list.GetBots()[0].GetRevokedAt() == nil {
		t.Fatalf("revoked bot: %v", list.GetBots()[0])
	}
	o.must(200, "POST", base+"/"+b.id+"/token", nil, &re)
	b.token = re.GetToken()
	b.must(200, "GET", "/api/me", nil, nil)

	// Plan limit (a custom plan with 2 bots; the free plan's one bot: TestPlanFreeCounts).
	superadminUser(t).must(200, "PUT", "/api/admin/workspaces/"+ws.GetId()+"/plan", &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_CUSTOM,
		Limits: &v1.PlanLimits{Bots: 2}}, nil)
	createBot(t, o, ws.GetId(), "second")
	st, e := o.apiErrBody("POST", base, &v1.CreateBotRequest{DisplayName: "third", Username: strings.ReplaceAll(uniq("third_"), "-", "_")})
	if st != 409 || e.GetReason() != "PLAN_LIMIT" || e.GetLimit() != 2 || e.GetUsed() != 2 {
		t.Fatalf("third bot: %d %v", st, e)
	}

	// Another workspace: its admin adds the bot by username; the bot sees it in its READY.
	ws2 := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	base2 := "/api/workspaces/" + ws2.GetId() + "/bots"
	var prof v1.GetBotMeResponse
	o.must(200, "GET", "/api/bots/"+b.username, nil, &prof)
	if prof.GetBot().GetUser().GetId() != b.id || prof.GetBot().GetWebhook() != nil || prof.GetBot().GetTokenPrefix() != "" ||
		prof.GetBot().GetOwnerUserId() != o.id || prof.GetBot().GetWorkspaceId() != ws.GetId() { // ADR-0106: the owner learns it is theirs
		t.Fatalf("public bot card: %v", prof.GetBot())
	}
	var foreign v1.GetBotMeResponse
	bob.must(200, "GET", "/api/bots/"+b.username, nil, &foreign)
	if foreign.GetBot().GetOwnerUserId() != "" || foreign.GetBot().GetWorkspaceId() != "" || foreign.GetBot().GetActsAsOwner() || foreign.GetBot().GetTokenPrefix() != "" {
		t.Fatalf("public bot card of someone else's bot: %v", foreign.GetBot())
	}
	var added v1.AddBotResponse
	o.must(201, "POST", base2+"/add", &v1.AddBotRequest{Username: b.username}, &added)
	o.must(409, "POST", base2+"/add", &v1.AddBotRequest{BotUserId: b.id}, nil)
	var wl v1.ListWorkspacesResponse
	b.must(200, "GET", "/api/workspaces", nil, &wl)
	if len(wl.GetWorkspaces()) != 2 {
		t.Fatalf("bot workspaces: %d", len(wl.GetWorkspaces()))
	}
	// Tokens are managed at home only; removing it elsewhere only leaves that workspace.
	o.must(403, "POST", base2+"/"+b.id+"/token", nil, nil)
	o.must(204, "DELETE", base2+"/"+b.id, nil, nil)
	b.must(200, "GET", "/api/me", nil, nil)
	b.must(404, "GET", "/api/workspaces/"+ws2.GetId(), nil, nil)

	// Delete at home: token dead, membership gone, the account disabled.
	o.must(204, "DELETE", base+"/"+b.id, nil, nil)
	b.must(401, "GET", "/api/me", nil, nil)
	o.must(200, "GET", base, nil, &list)
	for _, x := range list.GetBots() {
		if x.GetUser().GetId() == b.id {
			t.Fatal("deleted bot still listed")
		}
	}
	o.must(404, "GET", "/api/bots/"+b.id, nil, nil)
}

// Rights come from roles and room overrides as for people; restricted rooms apply; a bot
// cannot be made an admin.
func TestBotPermissions(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	b := createBot(t, o, ws.GetId(), "perm")
	public := textRoom(t, o, ws.GetId(), "public", false)
	secret := textRoom(t, o, ws.GetId(), "secret", true)
	o.must(200, "PUT", "/api/rooms/"+secret+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: []*v1.RoomPermissionOverride{
		{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_ROLE, TargetId: "member", Deny: uint64(perm.ViewRoom)},
	}}, nil)

	b.must(201, "POST", "/api/rooms/"+public+"/messages", &v1.CreateMessageRequest{Content: "hi"}, nil)
	b.must(404, "GET", "/api/rooms/"+secret+"/messages", nil, nil)
	b.must(404, "POST", "/api/rooms/"+secret+"/messages", &v1.CreateMessageRequest{Content: "hi"}, nil)
	b.must(403, "POST", "/api/workspaces/"+ws.GetId()+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_TEXT, Name: "x"}, nil)
	if got := visibleRooms(t, &user{client: b.client}, ws.GetId()); got[secret] != nil || got[public] == nil {
		t.Fatalf("bot sees: %v", got)
	}

	// A custom role gives MANAGE_ROOM; a personal override opens the private room.
	role := newRole(t, o, ws.GetId(), "bots", perm.ManageRoom)
	if st, _ := setMemberRoles(o, ws.GetId(), b.id, role.GetId()); st != 200 {
		t.Fatalf("assign role to bot: %d", st)
	}
	b.must(201, "POST", "/api/workspaces/"+ws.GetId()+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_TEXT, Name: "made-by-bot"}, nil)
	o.must(200, "PUT", "/api/rooms/"+secret+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: []*v1.RoomPermissionOverride{
		{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_ROLE, TargetId: "member", Deny: uint64(perm.ViewRoom)},
		{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER, TargetId: b.id, Allow: uint64(perm.ViewRoom)},
	}}, nil)
	b.must(200, "GET", "/api/rooms/"+secret+"/messages", nil, nil)

	// Restricted (ADR-0029): only the personal allow opens it, as for people.
	restricted := true
	o.must(200, "PATCH", "/api/rooms/"+secret, &v1.UpdateRoomRequest{Restricted: &restricted}, nil)
	b.must(200, "GET", "/api/rooms/"+secret+"/messages", nil, nil)
	o.must(200, "PUT", "/api/rooms/"+secret+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: []*v1.RoomPermissionOverride{
		{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_ROLE, TargetId: "member", Deny: uint64(perm.ViewRoom)},
	}}, nil)
	b.must(404, "GET", "/api/rooms/"+secret+"/messages", nil, nil)

	// Never an admin or a guest by built-in role.
	admin := v1.WorkspaceRole_WORKSPACE_ROLE_ADMIN
	o.must(422, "PATCH", "/api/workspaces/"+ws.GetId()+"/members/"+b.id, &v1.UpdateMemberRequest{Role: &admin}, nil)
	var roles v1.ListRolesResponse
	o.must(200, "GET", "/api/workspaces/"+ws.GetId()+"/roles", nil, &roles)
	for _, r := range roles.GetRoles() {
		if r.GetBuiltin() == v1.WorkspaceRole_WORKSPACE_ROLE_ADMIN {
			if st, _ := setMemberRoles(o, ws.GetId(), b.id, r.GetId()); st != 422 {
				t.Fatalf("admin role for a bot: %d, want 422", st)
			}
		}
	}
}

// Commands: registered by the bot, parsed from messages, delivered with Message.command to
// that bot only; composer hints per room.
func TestBotCommands(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	bob := register(t, invite(t, o, ws.GetId()))
	b := createBot(t, o, ws.GetId(), "dice")
	room := textRoom(t, o, ws.GetId(), "games", false)

	b.must(422, "PUT", "/api/bots/me/commands", &v1.SetBotCommandsRequest{Commands: []*v1.BotCommand{{Name: "bad name"}}}, nil)
	b.must(422, "PUT", "/api/bots/me/commands", &v1.SetBotCommandsRequest{Commands: []*v1.BotCommand{{Name: "a"}, {Name: "A"}}}, nil)
	var sc v1.SetBotCommandsResponse
	b.must(200, "PUT", "/api/bots/me/commands", &v1.SetBotCommandsRequest{Commands: []*v1.BotCommand{
		{Name: "/roll", Description: "Roll dice"}, {Name: "help", Description: "Help"},
	}}, &sc)
	if len(sc.GetCommands()) != 2 || sc.GetCommands()[0].GetName() != "roll" {
		t.Fatalf("commands: %v", sc.GetCommands())
	}
	var hints v1.ListRoomBotCommandsResponse
	bob.must(200, "GET", "/api/rooms/"+room+"/bot-commands", nil, &hints)
	if len(hints.GetBots()) != 1 || hints.GetBots()[0].GetUsername() != b.username || len(hints.GetBots()[0].GetCommands()) != 2 {
		t.Fatalf("hints: %v", hints.GetBots())
	}

	gb, gh := dialGW(t), dialGW(t)
	gb.identify(b.token)
	gh.identify(bob.token)

	var cr v1.CreateMessageResponse
	bob.must(201, "POST", "/api/rooms/"+room+"/messages", &v1.CreateMessageRequest{Content: "/roll 2d6"}, &cr)
	if cr.GetMessage().GetCommand() != nil {
		t.Fatal("the author's response carries the command")
	}
	isMsg := func(id string) func(*v1.DispatchEvent) bool {
		return func(e *v1.DispatchEvent) bool { return e.GetMessageCreate().GetMessage().GetId() == id }
	}
	got := gb.wait("command for the bot", isMsg(cr.GetMessage().GetId())).GetMessageCreate().GetMessage().GetCommand()
	if got.GetBotUserId() != b.id || got.GetName() != "roll" || got.GetArgs() != "2d6" {
		t.Fatalf("bot got command %v", got)
	}
	if c := gh.wait("plain message for people", isMsg(cr.GetMessage().GetId())).GetMessageCreate().GetMessage().GetCommand(); c != nil {
		t.Fatalf("a person got the command: %v", c)
	}
	// Explicit username, an unregistered command; plain text and unknown bots are no commands.
	bob.must(201, "POST", "/api/rooms/"+room+"/messages", &v1.CreateMessageRequest{Content: "/Stats@" + strings.ToUpper(b.username) + " all"}, &cr)
	got = gb.wait("addressed command", isMsg(cr.GetMessage().GetId())).GetMessageCreate().GetMessage().GetCommand()
	if got.GetName() != "stats" || got.GetArgs() != "all" {
		t.Fatalf("addressed command: %v", got)
	}
	for _, text := range []string{"/unknown", "roll /roll", "/roll@nobody_bot 1"} {
		bob.must(201, "POST", "/api/rooms/"+room+"/messages", &v1.CreateMessageRequest{Content: text}, &cr)
		if c := gb.wait(text, isMsg(cr.GetMessage().GetId())).GetMessageCreate().GetMessage().GetCommand(); c != nil {
			t.Fatalf("%q became a command: %v", text, c)
		}
	}
	// The bot's own messages are never commands.
	b.must(201, "POST", "/api/rooms/"+room+"/messages", &v1.CreateMessageRequest{Content: "/roll 1d20"}, &cr)
	if c := gb.wait("own message", isMsg(cr.GetMessage().GetId())).GetMessageCreate().GetMessage().GetCommand(); c != nil {
		t.Fatalf("own message became a command: %v", c)
	}
}

// Webhook: https only, deliveries signed, commands included, retries, disabled after the
// give-up time of failures.
func TestBotWebhook(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	bob := register(t, invite(t, o, ws.GetId()))
	b := createBot(t, o, ws.GetId(), "hook")
	room := textRoom(t, o, ws.GetId(), "hooks", false)
	b.must(200, "PUT", "/api/bots/me/commands", &v1.SetBotCommandsRequest{Commands: []*v1.BotCommand{{Name: "ping"}}}, nil)

	type got struct {
		body []byte
		sig  string
		id   string
	}
	var (
		mu     sync.Mutex
		deliv  []got
		failed bool
	)
	ts := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		defer mu.Unlock()
		deliv = append(deliv, got{body, r.Header.Get("X-Calab-Signature"), r.Header.Get("X-Calab-Delivery")})
		if failed {
			w.WriteHeader(http.StatusInternalServerError)
		}
	}))
	defer ts.Close()
	botHookCAs.AddCert(ts.Certificate())
	secret := "0123456789abcdef-secret"

	b.must(422, "PUT", "/api/bots/me/webhook", &v1.SetBotWebhookRequest{Url: strings.Replace(ts.URL, "https", "http", 1), Secret: secret}, nil)
	b.must(422, "PUT", "/api/bots/me/webhook", &v1.SetBotWebhookRequest{Url: ts.URL, Secret: "short"}, nil)
	o.must(403, "PUT", "/api/bots/me/webhook", &v1.SetBotWebhookRequest{Url: ts.URL, Secret: secret}, nil)
	var wr v1.BotWebhookResponse
	b.must(200, "PUT", "/api/bots/me/webhook", &v1.SetBotWebhookRequest{Url: ts.URL + "/calab", Secret: secret}, &wr)
	if !wr.GetWebhook().GetEnabled() || wr.GetWebhook().GetUrl() != ts.URL+"/calab" {
		t.Fatalf("webhook: %v", wr.GetWebhook())
	}

	var cr v1.CreateMessageResponse
	bob.must(201, "POST", "/api/rooms/"+room+"/messages", &v1.CreateMessageRequest{Content: "/ping now"}, &cr)
	waitFor := func(what string, pred func([]got) bool) []got {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			mu.Lock()
			cp := slices.Clone(deliv)
			mu.Unlock()
			if pred(cp) {
				return cp
			}
			time.Sleep(50 * time.Millisecond)
		}
		t.Fatalf("timeout waiting for %s", what)
		return nil
	}
	ds := waitFor("delivery", func(g []got) bool { return len(g) >= 1 })
	d := ds[0]
	if d.sig != bots.Sign([]byte(secret), d.body) {
		t.Fatalf("signature %q does not match the body", d.sig)
	}
	var upd v1.BotWebhookUpdate
	if err := protojson.Unmarshal(d.body, &upd); err != nil {
		t.Fatal(err)
	}
	m := upd.GetEvent().GetMessageCreate().GetMessage()
	if upd.GetId() != d.id || upd.GetBotUserId() != b.id || m.GetId() != cr.GetMessage().GetId() ||
		m.GetCommand().GetName() != "ping" || m.GetCommand().GetArgs() != "now" {
		t.Fatalf("delivery: %s", d.body)
	}
	var raw map[string]any // plain JSON for any HTTP server
	if err := json.Unmarshal(d.body, &raw); err != nil || raw["event"] == nil {
		t.Fatalf("body is not JSON with an event: %v", err)
	}
	// The bot's own messages are not delivered back; reactions of others are.
	b.must(201, "POST", "/api/rooms/"+room+"/messages", &v1.CreateMessageRequest{Content: "pong"}, nil)
	bob.must(204, "PUT", "/api/messages/"+cr.GetMessage().GetId()+"/reactions/%F0%9F%91%8D", nil, nil)
	ds = waitFor("reaction", func(g []got) bool { return len(g) >= 2 })
	for _, x := range ds {
		if strings.Contains(string(x.body), `"pong"`) {
			t.Fatal("the bot's own message was delivered to it")
		}
	}

	// Failures: retried, then the webhook is disabled after the give-up time.
	mu.Lock()
	failed = true
	n0 := len(deliv)
	mu.Unlock()
	bob.must(201, "POST", "/api/rooms/"+room+"/messages", &v1.CreateMessageRequest{Content: "anyone?"}, nil)
	waitFor("retries", func(g []got) bool { return len(g) >= n0+3 })
	deadline := time.Now().Add(8 * time.Second)
	for {
		b.must(200, "GET", "/api/bots/me/webhook", nil, &wr)
		if !wr.GetWebhook().GetEnabled() {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("webhook not disabled: %v", wr.GetWebhook())
		}
		time.Sleep(200 * time.Millisecond)
	}
	if wr.GetWebhook().GetDisabledAt() == nil || wr.GetWebhook().GetLastError() != "HTTP 500" || wr.GetWebhook().GetPending() != 0 {
		t.Fatalf("disabled webhook: %v", wr.GetWebhook())
	}
	var bm v1.GetBotMeResponse
	o.must(200, "GET", "/api/workspaces/"+ws.GetId()+"/bots", nil, nil)
	b.must(200, "GET", "/api/bots/me", nil, &bm)
	if bm.GetBot().GetWebhook().GetEnabled() {
		t.Fatal("bot profile shows the webhook enabled")
	}
	// Setting it again re-enables; deleting removes it.
	b.must(200, "PUT", "/api/bots/me/webhook", &v1.SetBotWebhookRequest{Url: ts.URL, Secret: secret}, &wr)
	if !wr.GetWebhook().GetEnabled() || wr.GetWebhook().GetDisabledAt() != nil {
		t.Fatalf("re-enabled: %v", wr.GetWebhook())
	}
	b.must(204, "DELETE", "/api/bots/me/webhook", nil, nil)
	b.must(200, "GET", "/api/bots/me/webhook", nil, &wr)
	if wr.GetWebhook().GetUrl() != "" {
		t.Fatalf("deleted webhook: %v", wr.GetWebhook())
	}
}

// DMs with bots, blocking, and the per-bot message limit.
func TestBotDMBlockAndLimits(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	bob := register(t, invite(t, o, ws.GetId()))
	b := createBot(t, o, ws.GetId(), "dm")

	var dm v1.CreateDmResponse
	b.must(201, "POST", "/api/dms", &v1.CreateDmRequest{UserId: bob.id}, &dm)
	rid := dm.GetDm().GetRoom().GetId()
	b.must(201, "POST", "/api/rooms/"+rid+"/messages", &v1.CreateMessageRequest{Content: "hello"}, nil)

	bob.must(204, "POST", "/api/me/blocked-bots/"+b.id, nil, nil)
	bob.must(204, "POST", "/api/me/blocked-bots/"+b.id, nil, nil) // idempotent
	b.must(403, "POST", "/api/me/blocked-bots/"+bob.id, nil, nil) // bots cannot block
	bob.must(404, "POST", "/api/me/blocked-bots/"+o.id, nil, nil) // only bots can be blocked
	var bl v1.ListBlockedBotsResponse
	bob.must(200, "GET", "/api/me/blocked-bots", nil, &bl)
	if !slices.Contains(bl.GetBotUserIds(), b.id) {
		t.Fatalf("blocked: %v", bl.GetBotUserIds())
	}
	if st, e := b.apiErrBody("POST", "/api/rooms/"+rid+"/messages", &v1.CreateMessageRequest{Content: "still there?"}); st != 403 || e.GetCode() != v1.ErrorCode_ERROR_CODE_BOT_BLOCKED {
		t.Fatalf("message to a blocker: %d %v", st, e)
	}
	// The person still writes to the bot.
	bob.must(201, "POST", "/api/rooms/"+rid+"/messages", &v1.CreateMessageRequest{Content: "no"}, nil)
	bob.must(204, "DELETE", "/api/me/blocked-bots/"+b.id, nil, nil)
	b.must(201, "POST", "/api/rooms/"+rid+"/messages", &v1.CreateMessageRequest{Content: "sorry"}, nil)

	// BOT_MESSAGES_PER_MIN (20): counted across rooms (each room has its own 5 / 5 s limit).
	var roomsList []string
	for i := range 5 {
		roomsList = append(roomsList, textRoom(t, o, ws.GetId(), "r"+string(rune('a'+i)), false))
	}
	sent, limited := 2, false // "hello" and "sorry" above (refused messages do not count)
	for i := 0; i < 25 && !limited; i++ {
		st := b.do("POST", "/api/rooms/"+roomsList[i%5]+"/messages", &v1.CreateMessageRequest{Content: "spam"}, nil)
		switch st {
		case 201:
			sent++
		case 429:
			limited = true
		default:
			t.Fatalf("message %d: %d", i, st)
		}
	}
	if !limited || sent != 20 {
		t.Fatalf("bot message limit: limited=%v after %d messages, want 20", limited, sent)
	}
}

// BOT_RATE_PER_SEC: requests beyond the burst get 429.
func TestBotRequestLimit(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	b := createBot(t, o, ws.GetId(), "rate")
	limited := 0
	for range 45 {
		if b.do("GET", "/api/bots/me", nil, nil) == 429 {
			limited++
		}
	}
	if limited == 0 {
		t.Fatal("45 requests in a burst were not limited (30 per second)")
	}
}

// Voice: a bot joins like a person; its LiveKit identity is its user id and token id, and a
// revoked token removes it from the call.
func TestBotVoiceJoin(t *testing.T) {
	liveKitUp(t)
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	b := createBot(t, o, ws.GetId(), "voice")
	var cr v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+ws.GetId()+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_VOICE, Name: "voice"}, &cr)
	rid := cr.GetRoom().GetId()
	var j v1.JoinVoiceResponse
	b.must(200, "POST", "/api/rooms/"+rid+"/join", nil, &j)
	if j.GetUrl() == "" || !j.GetCanSpeak() || !strings.HasPrefix(j.GetIdentity(), b.id+":") {
		t.Fatalf("join: %v", &j)
	}
	v, err := lkauth.ParseAPIToken(j.GetToken())
	if err != nil {
		t.Fatal(err)
	}
	_, grants, err := v.Verify("secret")
	if err != nil || grants.Identity != j.GetIdentity() || !grants.Video.RoomJoin || grants.Video.RoomAdmin {
		t.Fatalf("grants: %+v %v", grants, err)
	}
	// Revoking the token disconnects the bot's device.
	o.must(204, "DELETE", "/api/workspaces/"+ws.GetId()+"/bots/"+b.id+"/token", nil, nil)
	deadline := time.Now().Add(5 * time.Second)
	for !lkRec.wasRemoved(j.GetIdentity()) {
		if time.Now().After(deadline) {
			t.Fatal("revoked bot was not removed from LiveKit")
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// A blocked bot does not mention its blocker; a bot writes in DMs only to people of the
// workspaces it shares with them now (security review of ADR-0031).
func TestBotBlockMentionsAndSharedWorkspace(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	bob := register(t, invite(t, o, ws.GetId()))
	b := createBot(t, o, ws.GetId(), "pinger")
	room := textRoom(t, o, ws.GetId(), "ping", false)
	mentions := func() int {
		var out v1.ListMessagesResponse
		bob.must(200, "GET", "/api/me/mentions", nil, &out)
		return len(out.GetMessages())
	}

	bob.must(204, "POST", "/api/me/blocked-bots/"+b.id, nil, nil)
	b.must(201, "POST", "/api/rooms/"+room+"/messages", &v1.CreateMessageRequest{Content: "hi @" + bob.id}, nil)
	if n := mentions(); n != 0 {
		t.Fatalf("mentions from a blocked bot: %d, want 0", n)
	}
	bob.must(204, "DELETE", "/api/me/blocked-bots/"+b.id, nil, nil)
	b.must(201, "POST", "/api/rooms/"+room+"/messages", &v1.CreateMessageRequest{Content: "hi again @" + bob.id}, nil)
	if n := mentions(); n != 1 {
		t.Fatalf("mentions after unblocking: %d, want 1", n)
	}

	var dm v1.CreateDmResponse
	b.must(201, "POST", "/api/dms", &v1.CreateDmRequest{UserId: bob.id}, &dm)
	rid := dm.GetDm().GetRoom().GetId()
	b.must(201, "POST", "/api/rooms/"+rid+"/messages", &v1.CreateMessageRequest{Content: "hello"}, nil)
	o.must(204, "DELETE", "/api/workspaces/"+ws.GetId()+"/members/"+bob.id, nil, nil)
	b.must(403, "POST", "/api/rooms/"+rid+"/messages", &v1.CreateMessageRequest{Content: "still here?"}, nil)
	b.must(404, "POST", "/api/dms", &v1.CreateDmRequest{UserId: bob.id}, nil)
	// The person may still write to the bot in the existing DM.
	bob.must(201, "POST", "/api/rooms/"+rid+"/messages", &v1.CreateMessageRequest{Content: "bye"}, nil)
}

// Stickers (ADR-0030, ADR-0031 §3): a bot lists packs, installs them for itself and sends
// stickers; managing packs needs MANAGE_STICKERS, as for people.
func TestBotStickers(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	b := createBot(t, o, ws.GetId(), "stick")
	bu := &user{client: b.client, id: b.id}
	room := textRoom(t, o, ws.GetId(), "chat", false)
	p := createPack(t, o, ws.GetId(), "Faces")
	_, up, _ := uploadStickers(t, o, p.GetId(), stickerFile{"😀", "s.webp", stickerFixture(t, "sun.webp")})
	sid := up.GetAdded()[0].GetId()

	b.must(200, "GET", "/api/workspaces/"+ws.GetId()+"/sticker-packs", nil, nil)
	b.must(200, "GET", "/api/sticker-packs/"+p.GetId(), nil, nil)
	b.must(200, "PUT", "/api/me/sticker-packs/"+p.GetId(), nil, nil)
	b.must(200, "GET", "/api/me/sticker-packs", nil, nil)
	var cr v1.CreateMessageResponse
	b.must(201, "POST", "/api/rooms/"+room+"/messages", &v1.CreateMessageRequest{StickerId: sid, Nonce: uniq("n")}, &cr)
	if cr.GetMessage().GetSticker().GetId() != sid {
		t.Fatalf("bot sticker message: %v", cr.GetMessage())
	}

	// Without MANAGE_STICKERS: 403 from the handler (not BOT_NOT_ALLOWED).
	b.must(403, "POST", "/api/workspaces/"+ws.GetId()+"/sticker-packs", &v1.CreateStickerPackRequest{Name: "Bot"}, nil)
	if reason, _ := errReason(b.client); reason == "BOT_NOT_ALLOWED" {
		t.Fatalf("sticker pack creation closed to bots by the route table")
	}
	role := newRole(t, o, ws.GetId(), "bot-stickers", perm.ManageStickers)
	if st, _ := setMemberRoles(o, ws.GetId(), b.id, role.GetId()); st != 200 {
		t.Fatalf("assign sticker role to bot: %d", st)
	}
	bp := createPack(t, bu, ws.GetId(), "Bot pack")
	if st, res, e := uploadStickers(t, bu, bp.GetId(), stickerFile{"🌀", "o.webp", stickerFixture(t, "orbit.webp")}); st != 201 || len(res.GetAdded()) != 1 {
		t.Fatalf("bot upload: %d %v", st, e)
	}
	b.must(204, "DELETE", "/api/sticker-packs/"+bp.GetId(), nil, nil)
}

//go:build integration

package app_test

import (
	"bytes"
	"context"
	"io"
	"mime/multipart"
	"net/http"
	"slices"
	"testing"

	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/redisx"
)

// A bot acts on behalf of a member who consented (ADR-0111).

// resetBotLimit empties the bot's request bucket (BOT_RATE_PER_SEC, 30 at once): the on-behalf
// tests make more requests with one token than a burst allows on a fast machine.
func resetBotLimit(t *testing.T, botID string) {
	t.Helper()
	_ = testRedis.Do(context.Background(), testRedis.B().Del().Key(redisx.Key("rl:bot:req:"+botID)).Build()).Error()
}

// asMember is the bot's client with "Calab-On-Behalf: <user id>".
func asMember(b *bot, userID string) *client {
	return &client{t: b.t, token: b.token, header: http.Header{"Calab-On-Behalf": {userID}}}
}

func botState(t *testing.T, c musty, wsID, botID string) *v1.GetBotResponse {
	t.Helper()
	var r v1.GetBotResponse
	c.must(200, "GET", "/api/workspaces/"+wsID+"/bots/"+botID, nil, &r)
	return &r
}

// inviteMessage is the bot's DM to u carrying the consent invitation (its newest message).
func inviteMessage(t *testing.T, u *user, botID string) *v1.Message {
	t.Helper()
	var dl v1.ListDmsResponse
	u.must(200, "GET", "/api/dms", nil, &dl)
	i := slices.IndexFunc(dl.GetDms(), func(d *v1.DmSummary) bool { return d.GetPeer().GetId() == botID })
	if i < 0 {
		t.Fatalf("no DM with the bot: %v", dl.GetDms())
	}
	var ms v1.ListMessagesResponse
	u.must(200, "GET", "/api/rooms/"+dl.GetDms()[i].GetRoom().GetId()+"/messages", nil, &ms)
	if len(ms.GetMessages()) == 0 {
		t.Fatal("empty DM")
	}
	m := ms.GetMessages()[len(ms.GetMessages())-1]
	if m.GetAuthorId() != botID {
		t.Fatalf("newest DM message %v is not the bot's", m)
	}
	return m
}

// uploadOnBehalf uploads a small file with the bot's token on behalf of member (multipart).
func uploadOnBehalf(t *testing.T, b *bot, member, path string) *v1.FileMeta {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	fw, _ := mw.CreateFormFile("file", "scan.txt")
	_, _ = fw.Write([]byte("invoice 42"))
	_ = mw.Close()
	req, _ := http.NewRequestWithContext(context.Background(), "POST", srv.URL+path, &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+b.token)
	req.Header.Set("Calab-On-Behalf", member)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 201 && resp.StatusCode != 200 {
		t.Fatalf("upload on behalf: %d %s", resp.StatusCode, raw)
	}
	var r v1.UploadFileResponse
	if err := protojson.Unmarshal(raw, &r); err != nil {
		t.Fatal(err)
	}
	return r.GetFile()
}

func press(u *user, m *v1.Message, button, nonce string) int {
	return u.do("POST", "/api/messages/"+m.GetId()+"/interactions",
		&v1.CreateMessageInteractionRequest{ButtonId: button, KeyboardRevision: m.GetKeyboardRevision(), Nonce: m.GetId() + ":" + nonce}, nil)
}

// TestOnBehalfOfMember: without the member's own consent the header is refused (never the bot
// itself); nobody grants it for another member (admins, the bot's owner, the inviter); the
// invitation is the bot's DM whose «Принять» only the invitee's click accepts; on behalf the
// task, its comment and the journal are the member's with via_bot_id; nothing outside the
// workspace; revocation, a guest role and enforced SSO stop it at once.
func TestOnBehalfOfMember(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	carol := register(t, invite(t, o, wid))
	bt := createBot(t, o, wid, "opsa") // the workspace owner owns the bot and manages bots
	oc := asMember(bt, carol.id)
	board := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Docs", Key: "DOC"}, 201)
	newTask := &v1.CreateTaskRequest{Title: "Счёт от поставщика"}
	tasksPath := "/api/boards/" + board.GetId() + "/tasks"

	// No consent: refused, never a request of the bot itself.
	wantReason(t, oc, oc.do("POST", tasksPath, newTask, nil), 403, "ON_BEHALF_NO_CONSENT")
	wantReason(t, oc, oc.do("GET", "/api/workspaces/"+wid, nil, nil), 403, "ON_BEHALF_NO_CONSENT")
	// A malformed value, the bot's own id, a person's token with a member's id.
	bad := &client{t: t, token: bt.token, header: http.Header{"Calab-On-Behalf": {"not-a-uuid"}}}
	wantReason(t, bad, bad.do("GET", "/api/workspaces/"+wid, nil, nil), 400, "ON_BEHALF_INVALID")
	self := asMember(bt, bt.id)
	wantReason(t, self, self.do("GET", "/api/workspaces/"+wid, nil, nil), 400, "ON_BEHALF_INVALID")
	pc := &client{t: t, token: bob.token, header: http.Header{"Calab-On-Behalf": {carol.id}}}
	wantReason(t, pc, pc.do("GET", "/api/workspaces/"+wid, nil, nil), 403, "ON_BEHALF_NOT_BOT")

	// Nobody grants it for another member: the workspace owner (also the bot's owner), a member,
	// the bot itself.
	grantPath := "/api/workspaces/" + wid + "/bots/" + bt.id + "/delegations/" + carol.id
	wantReason(t, o.client, o.do("PUT", grantPath, nil, nil), 403, "ON_BEHALF_SELF_ONLY")
	wantReason(t, bob.client, bob.do("PUT", grantPath, nil, nil), 403, "ON_BEHALF_SELF_ONLY")
	wantReason(t, bt.client, bt.do("PUT", grantPath, nil, nil), 403, "BOT_NOT_ALLOWED")
	if got := botState(t, bt, wid, bt.id).GetOnBehalfUserIds(); len(got) != 0 {
		t.Fatalf("consents without the member: %v", got)
	}

	// The owner invites carol: the bot DMs her the suggestion naming him, for her only.
	var st v1.GetBotResponse
	o.must(200, "POST", "/api/workspaces/"+wid+"/bots/"+bt.id+"/delegation-invites", &v1.InviteBotDelegationRequest{UserIds: []string{carol.id}}, &st)
	if len(st.GetInvites()) != 1 || st.GetInvites()[0].GetUserId() != carol.id || st.GetInvites()[0].GetInvitedBy() != o.id {
		t.Fatalf("invites %v", st.GetInvites())
	}
	m := inviteMessage(t, carol, bt.id)
	if k := m.GetInlineKeyboard(); len(k.GetRows()) != 1 || !slices.Equal(k.GetAllowedUserIds(), []string{carol.id}) {
		t.Fatalf("invitation keyboard %v", k)
	}
	// The inviter cannot accept for her (not even a reader of her DM); a third member cannot
	// cancel the invitation; the bot cannot press.
	if s := press(o, m, "delegation_accept", "o"); s == 200 {
		t.Fatal("the inviter accepted for the invitee")
	}
	if s := bt.do("POST", "/api/messages/"+m.GetId()+"/interactions", &v1.CreateMessageInteractionRequest{ButtonId: "delegation_accept", KeyboardRevision: m.GetKeyboardRevision(), Nonce: "b"}, nil); s == 200 {
		t.Fatal("the bot accepted")
	}
	wantReason(t, bob.client, bob.do("DELETE", "/api/workspaces/"+wid+"/bots/"+bt.id+"/delegation-invites/"+carol.id, nil, nil), 403, "ON_BEHALF_SELF_ONLY")
	wantReason(t, oc, oc.do("POST", tasksPath, newTask, nil), 403, "ON_BEHALF_NO_CONSENT")

	// Her own click accepts: the invitation closes, the consent counts.
	if s := press(carol, m, "delegation_accept", "c"); s != 200 {
		t.Fatalf("accept: %d %s", s, carol.lastBody)
	}
	st = *botState(t, carol, wid, bt.id)
	if !slices.Equal(st.GetOnBehalfUserIds(), []string{carol.id}) || len(st.GetInvites()) != 0 || st.GetDelegations()[0].GetSince() == nil {
		t.Fatalf("after accept: %v", &st)
	}
	if closed := inviteMessage(t, carol, bt.id); closed.GetInlineKeyboard() != nil && len(closed.GetInlineKeyboard().GetRows()) > 0 {
		t.Fatalf("the invitation kept its buttons: %v", closed)
	}
	if !slices.Equal(botState(t, bt, wid, bt.id).GetOnBehalfUserIds(), []string{carol.id}) {
		t.Fatal("the bot does not see whom it may act for")
	}

	// On her behalf: the task is hers (created_by), the journal and the comment are marked.
	task := createTask(t, oc, board.GetId(), newTask, 201)
	if task.GetCreatedBy() != carol.id {
		t.Fatalf("created_by %s, want the member %s", task.GetCreatedBy(), carol.id)
	}
	var page v1.TaskActivityPage
	o.must(200, "GET", "/api/tasks/"+task.GetId()+"/activity?limit=100", nil, &page)
	if i := slices.IndexFunc(page.GetItems(), func(it *v1.TaskActivityItem) bool { return it.GetActivity().GetKind() == "created" }); i < 0 ||
		page.GetItems()[i].GetActivity().GetActorId() != carol.id || page.GetItems()[i].GetActivity().GetViaBotId() != bt.id {
		t.Fatalf("created entry: %v", page.GetItems())
	}
	var cm v1.CreateMessageResponse
	oc.must(201, "POST", "/api/rooms/"+task.GetRoomId()+"/messages", &v1.CreateMessageRequest{Content: "скан во вложении"}, &cm)
	if cm.GetMessage().GetAuthorId() != carol.id || cm.GetMessage().GetViaBotId() != bt.id {
		t.Fatalf("comment on behalf %v", cm.GetMessage())
	}
	// An attachment: her upload in the workspace, on her comment.
	file := uploadOnBehalf(t, bt, carol.id, "/api/workspaces/"+wid+"/files")
	oc.must(201, "POST", "/api/rooms/"+task.GetRoomId()+"/messages", &v1.CreateMessageRequest{AttachmentIds: []string{file.GetId()}}, &cm)
	if cm.GetMessage().GetAuthorId() != carol.id || len(cm.GetMessage().GetAttachments()) != 1 {
		t.Fatalf("attachment on behalf %v", cm.GetMessage())
	}
	oc.must(200, "PUT", "/api/tasks/"+task.GetId()+"/watchers", &v1.SetTaskWatcherRequest{UserId: bob.id}, nil)

	// Nothing outside the workspace, and the routes closed on behalf of the owner stay closed.
	for _, r := range [][2]string{
		{"GET", "/api/me"},
		{"GET", "/api/dms"},
		{"GET", "/api/me/tasks"},
		{"PATCH", "/api/me"},
		{"POST", "/api/dms"},
		{"GET", "/api/workspaces/" + wid + "/bots/" + bt.id},
		{"PUT", grantPath},
		{"POST", "/api/workspaces/" + wid + "/bots/" + bt.id + "/token"},
		{"GET", "/api/workspaces/" + wid + "/billing"},
		// The workspace's access control (ADR-0111 §3): no roles, bans or invitations that would
		// outlive the consent, even for an admin's consent.
		{"PUT", "/api/workspaces/" + wid + "/members/" + bt.id + "/roles"},
		{"POST", "/api/workspaces/" + wid + "/invites"},
		{"POST", "/api/workspaces/" + wid + "/bans"},
		{"PATCH", "/api/workspaces/" + wid},
	} {
		wantReason(t, oc, oc.do(r[0], r[1], nil, nil), 403, "ON_BEHALF_ROUTE")
	}

	resetBotLimit(t, bt.id)
	// Revocation is immediate; she may give it again herself.
	carol.must(200, "DELETE", grantPath, nil, nil)
	wantReason(t, oc, oc.do("POST", tasksPath, newTask, nil), 403, "ON_BEHALF_NO_CONSENT")
	carol.must(200, "PUT", grantPath, nil, nil)
	createTask(t, oc, board.GetId(), newTask, 201)

	// A guest role stops it; a guest neither consents nor is invited; a bot is never a target.
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := testDB.Pool.Exec(context.Background(), sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`UPDATE workspace_members SET role = 'guest' WHERE workspace_id = $1 AND user_id = $2`, wid, carol.id)
	wantReason(t, oc, oc.do("POST", tasksPath, newTask, nil), 403, "ON_BEHALF_NO_CONSENT")
	wantReason(t, carol.client, carol.do("PUT", grantPath, nil, nil), 403, "ON_BEHALF_NOT_ELIGIBLE")
	wantReason(t, o.client, o.do("POST", "/api/workspaces/"+wid+"/bots/"+bt.id+"/delegation-invites",
		&v1.InviteBotDelegationRequest{UserIds: []string{carol.id}}, nil), 422, "ON_BEHALF_NOT_ELIGIBLE")
	exec(`UPDATE workspace_members SET role = 'member' WHERE workspace_id = $1 AND user_id = $2`, wid, carol.id)
	createTask(t, oc, board.GetId(), newTask, 201)
	other := createBot(t, o, wid, "opsa_two")
	o.must(422, "POST", "/api/workspaces/"+wid+"/bots/"+bt.id+"/delegation-invites", &v1.InviteBotDelegationRequest{UserIds: []string{other.id}}, nil)
	ob := asMember(bt, other.id)
	wantReason(t, ob, ob.do("GET", "/api/workspaces/"+wid, nil, nil), 403, "ON_BEHALF_NO_CONSENT")

	// A declined invitation: bob's click closes it without a consent.
	o.must(200, "POST", "/api/workspaces/"+wid+"/bots/"+bt.id+"/delegation-invites", &v1.InviteBotDelegationRequest{UserIds: []string{bob.id}}, nil)
	if s := press(bob, inviteMessage(t, bob, bt.id), "delegation_decline", "d"); s != 200 {
		t.Fatalf("decline: %d %s", s, bob.lastBody)
	}
	if st := botState(t, bob, wid, bt.id); len(st.GetInvites()) != 0 || slices.Contains(st.GetOnBehalfUserIds(), bob.id) {
		t.Fatalf("after decline: %v", st)
	}

	// Enforced SSO closes it (the bot cannot present the person's own sign-in).
	exec(`INSERT INTO workspace_identity_policies (workspace_id, mode) VALUES ($1, 'enforced')
		ON CONFLICT (workspace_id) DO UPDATE SET mode = 'enforced'`, wid)
	wantReason(t, oc, oc.do("POST", tasksPath, newTask, nil), 403, "ON_BEHALF_IDENTITY_POLICY")
	exec(`UPDATE workspace_identity_policies SET mode = 'off' WHERE workspace_id = $1`, wid)

	resetBotLimit(t, bt.id)
	// A consent is per workspace: another workspace shared by carol and the bot stays closed
	// until she consents there too, and the bot reads each workspace's own list.
	ws2 := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId()
	var j v1.JoinWorkspaceResponse
	carol.must(200, "POST", "/api/invites/"+invite(t, o, ws2)+"/join", nil, &j)
	o.must(201, "POST", "/api/workspaces/"+ws2+"/bots/add", &v1.AddBotRequest{BotUserId: bt.id}, nil)
	wantReason(t, oc, oc.do("GET", "/api/workspaces/"+ws2+"/rooms", nil, nil), 403, "ON_BEHALF_NO_CONSENT")
	if got := botState(t, bt, ws2, bt.id).GetOnBehalfUserIds(); len(got) != 0 {
		t.Fatalf("the bot reads the consents of its home workspace in another one: %v", got)
	}
	carol.must(200, "PUT", "/api/workspaces/"+ws2+"/bots/"+bt.id+"/delegations/"+carol.id, nil, nil)
	oc.must(200, "GET", "/api/workspaces/"+ws2+"/rooms", nil, nil)
	if got := botState(t, bt, ws2, bt.id).GetOnBehalfUserIds(); !slices.Equal(got, []string{carol.id}) {
		t.Fatalf("consents in the second workspace: %v", got)
	}
	// Leaving a workspace ends the consent there for good (coming back does not revive it);
	// the other workspace's consent is untouched.
	o.must(204, "DELETE", "/api/workspaces/"+ws2+"/members/"+carol.id, nil, nil)
	wantReason(t, oc, oc.do("GET", "/api/workspaces/"+ws2+"/rooms", nil, nil), 403, "ON_BEHALF_OWNER_NOT_MEMBER")
	carol.must(200, "POST", "/api/invites/"+invite(t, o, ws2)+"/join", nil, &j)
	wantReason(t, oc, oc.do("GET", "/api/workspaces/"+ws2+"/rooms", nil, nil), 403, "ON_BEHALF_NO_CONSENT")
	createTask(t, oc, board.GetId(), newTask, 201)
}

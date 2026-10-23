//go:build integration

package app_test

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/bots"
	"github.com/calaba/calaba/server/internal/redisx"
)

// A bot asks a member for its own consent (CBF-41, ADR-0119): the same DM as ADR-0111 §5, the
// text names the bot; only the invitee's own click grants; the bot gets BOT_DELEGATION.

// delegationHook is a bot webhook that collects BOT_DELEGATION deliveries.
func delegationHook(t *testing.T, b *bot) <-chan *v1.BotDelegationChange {
	t.Helper()
	got := make(chan *v1.BotDelegationChange, 16)
	secret := strings.Repeat("d", 32)
	hook := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if r.Header.Get("X-Calab-Signature") != bots.Sign([]byte(secret), body) {
			w.WriteHeader(401)
			return
		}
		var u v1.BotWebhookUpdate
		if err := protojson.Unmarshal(body, &u); err != nil {
			w.WriteHeader(400)
			return
		}
		if d := u.GetEvent().GetBotDelegation(); d != nil {
			if d.GetId() != u.GetId() || d.GetBotUserId() != b.id {
				t.Errorf("delivery %s carries %v", u.GetId(), d)
			}
			got <- d
		}
	}))
	t.Cleanup(hook.Close)
	botHookCAs.AddCert(hook.Certificate())
	b.must(200, "PUT", "/api/bots/me/webhook", &v1.SetBotWebhookRequest{Url: hook.URL, Secret: secret}, nil)
	return got
}

func wantDelegation(t *testing.T, got <-chan *v1.BotDelegationChange, ws, user, state string) {
	t.Helper()
	select {
	case d := <-got:
		if d.GetWorkspaceId() != ws || d.GetUserId() != user || d.GetState() != state || d.GetAt() == nil {
			t.Fatalf("BOT_DELEGATION %v, want %s of %s in %s", d, state, user, ws)
		}
	case <-time.After(10 * time.Second):
		t.Fatalf("no BOT_DELEGATION %s of %s", state, user)
	}
}

func TestBotAsksForConsent(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	carol := register(t, invite(t, o, wid))
	dave := register(t, invite(t, o, wid))
	bt := createBot(t, o, wid, "opsa_asks")
	other := createBot(t, o, wid, "opsa_other")
	hook := delegationHook(t, bt)
	invitePath := func(botID string) string { return "/api/workspaces/" + wid + "/bots/" + botID + "/delegation-invites" }
	ask := func(c *client, botID string, req *v1.InviteBotDelegationRequest, want int) *v1.GetBotResponse {
		t.Helper()
		var r v1.GetBotResponse
		if st := c.do("POST", invitePath(botID), req, &r); st != want {
			t.Fatalf("invite as %s: %d, want %d (%s)", botID, st, want, c.lastBody)
		}
		return &r
	}
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := testDB.Pool.Exec(context.Background(), sql, args...); err != nil {
			t.Fatal(err)
		}
	}

	// Not a target: the bot itself, another bot, a guest. No asking for another bot.
	ask(bt.client, bt.id, &v1.InviteBotDelegationRequest{UserIds: []string{bt.id}}, 422)
	ask(bt.client, bt.id, &v1.InviteBotDelegationRequest{UserIds: []string{other.id}}, 422)
	if r, _ := errReason(bt.client); r != "ON_BEHALF_NOT_ELIGIBLE" {
		t.Fatalf("another bot as target: %s", bt.lastBody)
	}
	exec(`UPDATE workspace_members SET role = 'guest' WHERE workspace_id = $1 AND user_id = $2`, wid, dave.id)
	wantReason(t, bt.client, bt.do("POST", invitePath(bt.id), &v1.InviteBotDelegationRequest{UserIds: []string{dave.id}}, nil), 422, "ON_BEHALF_NOT_ELIGIBLE")
	wantReason(t, bt.client, bt.do("POST", invitePath(other.id), &v1.InviteBotDelegationRequest{UserIds: []string{carol.id}}, nil), 403, "BOT_NOT_ALLOWED")
	// A bot with a guest role asks nobody.
	exec(`UPDATE workspace_members SET role = 'guest' WHERE workspace_id = $1 AND user_id = $2`, wid, other.id)
	wantReason(t, other.client, other.do("POST", invitePath(other.id), &v1.InviteBotDelegationRequest{UserIds: []string{carol.id}}, nil), 403, "ON_BEHALF_NOT_ELIGIBLE")
	ask(bt.client, bt.id, &v1.InviteBotDelegationRequest{UserIds: []string{carol.id}, Reason: strings.Repeat("я", 201)}, 422)

	// The bot asks carol: the DM names the bot, the reason is plain text (no mention of the owner,
	// no link, no markup); the answer links the message without any token.
	r := ask(bt.client, bt.id, &v1.InviteBotDelegationRequest{UserIds: []string{carol.id},
		Reason: "чтобы заявки шли под вашим именем @" + o.id + " https://evil.example/x **жирно**\nвторая строка"}, 200)
	if len(r.GetInvites()) != 1 || r.GetInvites()[0].GetInvitedBy() != bt.id || len(r.GetSent()) != 1 {
		t.Fatalf("invite by the bot: %v", r)
	}
	sent := r.GetSent()[0]
	m := inviteMessage(t, carol, bt.id)
	if !sent.GetCreated() || sent.GetUserId() != carol.id || sent.GetMessageId() != m.GetId() || sent.GetRoomId() != m.GetRoomId() ||
		sent.GetUrl() != "https://app.example.com/m/"+m.GetRoomId()+"/"+m.GetId() {
		t.Fatalf("sent %v for message %v", sent, m)
	}
	if c := m.GetContent(); strings.Contains(c, "@") || strings.Contains(c, "://") || strings.Contains(c, "*") || !strings.Contains(c, "чтобы заявки шли под вашим именем") || !strings.Contains(c, "вторая строка") {
		t.Fatalf("invitation text: %q", c)
	}
	// Asking again: one pending invitation, the same message.
	r = ask(bt.client, bt.id, &v1.InviteBotDelegationRequest{UserIds: []string{carol.id}}, 200)
	if len(r.GetInvites()) != 1 || len(r.GetSent()) != 1 || r.GetSent()[0].GetCreated() || r.GetSent()[0].GetMessageId() != m.GetId() {
		t.Fatalf("second ask: %v", r)
	}
	if again := inviteMessage(t, carol, bt.id); again.GetId() != m.GetId() {
		t.Fatal("a second invitation message")
	}

	// Nobody but carol accepts: not the bot, not another member; the bot neither cancels nor
	// grants; its consent list stays empty.
	if st := bt.do("POST", "/api/messages/"+m.GetId()+"/interactions", &v1.CreateMessageInteractionRequest{ButtonId: "delegation_accept", KeyboardRevision: m.GetKeyboardRevision(), Nonce: "bot"}, nil); st == 200 {
		t.Fatal("the bot accepted for the member")
	}
	if st := press(bob, m, "delegation_accept", "bob"); st == 200 {
		t.Fatal("another member accepted")
	}
	wantReason(t, bt.client, bt.do("DELETE", invitePath(bt.id)+"/"+carol.id, nil, nil), 403, "BOT_NOT_ALLOWED")
	wantReason(t, bt.client, bt.do("PUT", "/api/workspaces/"+wid+"/bots/"+bt.id+"/delegations/"+carol.id, nil, nil), 403, "BOT_NOT_ALLOWED")
	if got := botState(t, bt, wid, bt.id).GetOnBehalfUserIds(); len(got) != 0 {
		t.Fatalf("consent without the member's click: %v", got)
	}

	// Her click grants; the bot learns it at once.
	if st := press(carol, m, "delegation_accept", "carol"); st != 200 {
		t.Fatalf("accept: %d %s", st, carol.lastBody)
	}
	wantDelegation(t, hook, wid, carol.id, "granted")
	// On her behalf the bot cannot ask anyone (closed on behalf).
	oc := asMember(bt, carol.id)
	wantReason(t, oc, oc.do("POST", invitePath(bt.id), &v1.InviteBotDelegationRequest{UserIds: []string{bob.id}}, nil), 403, "ON_BEHALF_ROUTE")
	carol.must(200, "DELETE", "/api/workspaces/"+wid+"/bots/"+bt.id+"/delegations/"+carol.id, nil, nil)
	wantDelegation(t, hook, wid, carol.id, "revoked")

	// Bob declines: the bot learns it and may not ask him again for 7 days (nor may a person);
	// his own consent is still his to give.
	resetBotLimit(t, bt.id)
	ask(bt.client, bt.id, &v1.InviteBotDelegationRequest{UserIds: []string{bob.id}}, 200)
	if st := press(bob, inviteMessage(t, bob, bt.id), "delegation_decline", "decline"); st != 200 {
		t.Fatalf("decline: %d %s", st, bob.lastBody)
	}
	wantDelegation(t, hook, wid, bob.id, "declined")
	wantReason(t, bt.client, bt.do("POST", invitePath(bt.id), &v1.InviteBotDelegationRequest{UserIds: []string{bob.id}}, nil), 409, "DELEGATION_INVITE_DECLINED")
	var e v1.ApiError
	if err := protojson.Unmarshal(bt.lastBody, &e); err != nil || e.GetUsed() == 0 || e.GetLimit() != 7*24*3600 {
		t.Fatalf("cooldown details: %s", bt.lastBody)
	}
	wantReason(t, o.client, o.do("POST", invitePath(bt.id), &v1.InviteBotDelegationRequest{UserIds: []string{bob.id}}, nil), 409, "DELEGATION_INVITE_DECLINED")
	// With another member in the request, bob is skipped and carol is asked.
	r = ask(bt.client, bt.id, &v1.InviteBotDelegationRequest{UserIds: []string{bob.id, carol.id}}, 200)
	if len(r.GetSent()) != 1 || r.GetSent()[0].GetUserId() != carol.id {
		t.Fatalf("cooldown with another member: %v", r.GetSent())
	}
	bob.must(200, "PUT", "/api/workspaces/"+wid+"/bots/"+bt.id+"/delegations/"+bob.id, nil, nil)
	wantDelegation(t, hook, wid, bob.id, "granted")
	// Carol declines in the dialog (DELETE by the invitee): remembered the same way.
	carol.must(200, "DELETE", invitePath(bt.id)+"/"+carol.id, nil, nil)
	wantDelegation(t, hook, wid, carol.id, "declined")
	wantReason(t, bt.client, bt.do("POST", invitePath(bt.id), &v1.InviteBotDelegationRequest{UserIds: []string{carol.id}}, nil), 409, "DELEGATION_INVITE_DECLINED")

	// The inviter's limit is the bot's own: an empty bucket answers 429.
	exec(`DELETE FROM bot_delegation_declines WHERE bot_id = $1`, bt.id)
	exec(`UPDATE workspace_members SET role = 'member' WHERE workspace_id = $1 AND user_id = $2`, wid, dave.id)
	lim := redisx.NewRateLimiter(testRedis, "rl:bot-delegation-invite:", 20, 0.5)
	for range 20 {
		_ = lim.Take(context.Background(), bt.id)
	}
	resetBotLimit(t, bt.id)
	ask(bt.client, bt.id, &v1.InviteBotDelegationRequest{UserIds: []string{dave.id}}, 429)
}

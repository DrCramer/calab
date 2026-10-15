//go:build integration

package messages

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/dbtest"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/redisx"
)

// sent is one published event and where it went (uuid.Nil user = a workspace channel).
type sent struct {
	user uuid.UUID
	ev   *v1.DispatchEvent
}

type contactRecorder struct {
	mu  sync.Mutex
	out []sent
}

func (r *contactRecorder) add(u uuid.UUID, ev *v1.DispatchEvent) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.out = append(r.out, sent{u, ev})
}
func (r *contactRecorder) Workspace(_ context.Context, _ uuid.UUID, ev *v1.DispatchEvent) {
	r.add(uuid.Nil, ev)
}
func (r *contactRecorder) User(_ context.Context, u uuid.UUID, ev *v1.DispatchEvent) { r.add(u, ev) }
func (r *contactRecorder) Workspaces(_ context.Context, _ []uuid.UUID, ev *v1.DispatchEvent) {
	r.add(uuid.Nil, ev)
}
func (r *contactRecorder) WorkspaceEvents(_ context.Context, _ uuid.UUID, evs []*v1.DispatchEvent) {
	for _, ev := range evs {
		r.add(uuid.Nil, ev)
	}
}
func (r *contactRecorder) SessionRevoked(context.Context, uuid.UUID, string) {}
func (r *contactRecorder) take() []sent {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := r.out
	r.out = nil
	return out
}

// contactEnv: a workspace with the owner Olga (phone, verified email), the member Carl (no
// phone, unverified email), the bot Helper (webhook on) and its DMs with both, plus a text room.
type contactEnv struct {
	t                *testing.T
	d                *db.DB
	ev               *contactRecorder
	mux              *http.ServeMux
	ws, room         uuid.UUID
	olga, carl, bot  uuid.UUID
	olgaDM, carlDM   uuid.UUID
	olgaPhone, olgaE string
	carlE            string
}

func newContactEnv(t *testing.T) *contactEnv {
	t.Helper()
	ctx := context.Background()
	d := dbtest.Connect(t)
	redisURL := os.Getenv("TEST_REDIS_URL")
	if redisURL == "" {
		t.Fatal("TEST_REDIS_URL required")
	}
	rc, err := redisx.Connect(ctx, redisURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(rc.Close)
	e := &contactEnv{t: t, d: d, ev: &contactRecorder{}, mux: http.NewServeMux()}
	h := NewHandlers(d, e.ev, redisx.NewRateLimiter(rc, "test-contact:"+uuid.NewString()+":", 100, 6000))
	h.Routes(e.mux, func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			u := uuid.MustParse(r.Header.Get("X-Test-User"))
			c := auth.WithIdentity(r.Context(), auth.Identity{UserID: u, SessionID: uuid.New(), IsBot: r.Header.Get("X-Test-Bot") != ""})
			next.ServeHTTP(w, r.WithContext(perm.WithResolver(c, d.Q)))
		})
	})
	tag := uuid.NewString()[:8]
	e.olgaPhone, e.olgaE, e.carlE = "+79990001122", "olga-"+tag+"@contact.test", "carl-"+tag+"@contact.test"
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := d.Pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("%v\n%s", err, sql)
		}
	}
	e.olga, e.carl, e.bot = uuid.New(), uuid.New(), uuid.New()
	exec(`INSERT INTO users (id, email, display_name, phone, email_verified_at) VALUES ($1, $2, 'Olga', $3, now())`, e.olga, e.olgaE, e.olgaPhone)
	exec(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'Carl')`, e.carl, e.carlE)
	exec(`INSERT INTO users (id, display_name, is_bot) VALUES ($1, 'Helper', true)`, e.bot)
	e.ws = uuid.New()
	exec(`INSERT INTO workspaces (id, slug, name, owner_id) VALUES ($1, $2, 'Contacts', $3)`, e.ws, "ct-"+e.ws.String()[:12], e.olga)
	for u, role := range map[uuid.UUID]string{e.olga: "owner", e.carl: "member", e.bot: "member"} {
		if _, err := d.Q.AddMember(ctx, sqlc.AddMemberParams{WorkspaceID: e.ws, UserID: u, Role: role}); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO bots (user_id, owner_user_id, workspace_id, username, token_id, token_hash, webhook_url, webhook_secret_enc)
	      VALUES ($1, $2, $3, $4, $5, '\x01', 'https://bot.test/hook', '\x01')`, e.bot, e.olga, e.ws, "helper_"+tag, uuid.New())
	e.room = uuid.New()
	exec(`INSERT INTO rooms (id, workspace_id, type, name) VALUES ($1, $2, 'text', 'general')`, e.room, e.ws)
	dm := func(a, b uuid.UUID) uuid.UUID {
		lo, hi := a.String(), b.String()
		if hi < lo {
			lo, hi = hi, lo
		}
		key := lo + ":" + hi
		r, err := d.Q.CreateDMRoom(ctx, &key)
		if err != nil {
			t.Fatal(err)
		}
		if err := d.Q.AddDMMembers(ctx, sqlc.AddDMMembersParams{RoomID: r.ID, UserIds: []uuid.UUID{a, b}}); err != nil {
			t.Fatal(err)
		}
		return r.ID
	}
	e.olgaDM, e.carlDM = dm(e.olga, e.bot), dm(e.carl, e.bot)
	return e
}

func (e *contactEnv) call(user uuid.UUID, isBot bool, method, path string, body proto.Message) *httptest.ResponseRecorder {
	e.t.Helper()
	var rd *bytes.Reader
	if body != nil {
		raw, err := protojson.Marshal(body)
		if err != nil {
			e.t.Fatal(err)
		}
		rd = bytes.NewReader(raw)
	} else {
		rd = bytes.NewReader(nil)
	}
	r := httptest.NewRequestWithContext(context.Background(), method, path, rd)
	r.Header.Set("X-Test-User", user.String())
	if isBot {
		r.Header.Set("X-Test-Bot", "1")
	}
	w := httptest.NewRecorder()
	e.mux.ServeHTTP(w, r)
	return w
}

// must asserts the status (and the ApiError reason when given) and decodes the answer.
func (e *contactEnv) must(want int, reason string, user uuid.UUID, isBot bool, method, path string, body, out proto.Message) {
	e.t.Helper()
	w := e.call(user, isBot, method, path, body)
	if w.Code != want {
		e.t.Fatalf("%s %s: %d %s, want %d", method, path, w.Code, w.Body.String(), want)
	}
	if reason != "" {
		var apiErr v1.ApiError
		if err := protojson.Unmarshal(w.Body.Bytes(), &apiErr); err != nil || apiErr.GetReason() != reason {
			e.t.Fatalf("%s %s: %s, want reason %s", method, path, w.Body.String(), reason)
		}
	}
	if out != nil {
		if err := protojson.Unmarshal(w.Body.Bytes(), out); err != nil {
			e.t.Fatal(err)
		}
	}
}

func contactKeyboard(id string, fields ...v1.ContactField) *v1.InlineKeyboard {
	return &v1.InlineKeyboard{Rows: []*v1.InlineKeyboardRow{{Buttons: []*v1.InlineButton{
		{Id: id, Label: "Share contact", Data: "signup:42", Kind: v1.InlineButtonKind_INLINE_BUTTON_KIND_REQUEST_CONTACT, Fields: fields, Reason: "To call you back"},
		{Id: "plain", Label: "Plain"},
	}}}}
}

// botPost sends a bot message with a keyboard into room.
func (e *contactEnv) botPost(room uuid.UUID, k *v1.InlineKeyboard) *v1.Message {
	e.t.Helper()
	var got v1.CreateMessageResponse
	e.must(201, "", e.bot, true, "POST", "/api/rooms/"+room.String()+"/messages", &v1.CreateMessageRequest{Content: "Leave your contact", InlineKeyboard: k}, &got)
	return got.GetMessage()
}

func sharePath(m *v1.Message, button string) string {
	return "/api/messages/" + m.GetId() + "/buttons/" + button + "/contact"
}

func TestBotContactRequestValidationAndDMOnly(t *testing.T) {
	e := newContactEnv(t)
	room := "/api/rooms/" + e.room.String() + "/messages"
	both := []v1.ContactField{v1.ContactField_CONTACT_FIELD_PHONE, v1.ContactField_CONTACT_FIELD_EMAIL}
	// Outside a DM: 400 on send and on edit.
	e.must(400, ReasonContactDMOnly, e.bot, true, "POST", room, &v1.CreateMessageRequest{Content: "x", InlineKeyboard: contactKeyboard("share", both...)}, nil)
	var plain v1.CreateMessageResponse
	e.must(201, "", e.bot, true, "POST", room, &v1.CreateMessageRequest{Content: "x"}, &plain)
	e.must(400, ReasonContactDMOnly, e.bot, true, "PATCH", "/api/messages/"+plain.GetMessage().GetId(), &v1.UpdateMessageRequest{InlineKeyboard: contactKeyboard("share", both...), PreserveContent: true}, nil)
	// Malformed buttons: no fields, a repeated or unknown field, a long reason, fields on a callback.
	dm := "/api/rooms/" + e.olgaDM.String() + "/messages"
	bad := []*v1.InlineButton{
		{Id: "a", Label: "A", Kind: v1.InlineButtonKind_INLINE_BUTTON_KIND_REQUEST_CONTACT},
		{Id: "a", Label: "A", Kind: v1.InlineButtonKind_INLINE_BUTTON_KIND_REQUEST_CONTACT, Fields: []v1.ContactField{1, 1}},
		{Id: "a", Label: "A", Kind: v1.InlineButtonKind_INLINE_BUTTON_KIND_REQUEST_CONTACT, Fields: []v1.ContactField{0}},
		{Id: "a", Label: "A", Kind: v1.InlineButtonKind_INLINE_BUTTON_KIND_REQUEST_CONTACT, Fields: []v1.ContactField{1}, Reason: strings.Repeat("я", MaxContactReason+1)},
		{Id: "a", Label: "A", Fields: []v1.ContactField{1}},
		{Id: "a", Label: "A", Reason: "why"},
		{Id: "a", Label: "A", Kind: 7},
	}
	for i, b := range bad {
		w := e.call(e.bot, true, "POST", dm, &v1.CreateMessageRequest{Content: "x", InlineKeyboard: &v1.InlineKeyboard{Rows: []*v1.InlineKeyboardRow{{Buttons: []*v1.InlineButton{b}}}}})
		if w.Code != 422 {
			t.Fatalf("bad button %d: %d %s", i, w.Code, w.Body.String())
		}
	}
	// A DM is fine; a person cannot attach keyboards at all; the callback path refuses the button.
	m := e.botPost(e.olgaDM, contactKeyboard("share", both...))
	if b := m.GetInlineKeyboard().GetRows()[0].GetButtons()[0]; b.GetKind() != v1.InlineButtonKind_INLINE_BUTTON_KIND_REQUEST_CONTACT || len(b.GetFields()) != 2 || b.GetReason() != "To call you back" {
		t.Fatalf("saved button: %v", b)
	}
	e.must(409, "BUTTON_UNAVAILABLE", e.olga, false, "POST", "/api/messages/"+m.GetId()+"/interactions",
		&v1.CreateMessageInteractionRequest{ButtonId: "share", KeyboardRevision: m.GetKeyboardRevision(), Nonce: "n1"}, nil)
	// The callback button of the same keyboard is not a contact button.
	e.must(409, "BUTTON_UNAVAILABLE", e.olga, false, "POST", sharePath(m, "plain"), nil, nil)
	e.must(409, "BUTTON_UNAVAILABLE", e.olga, false, "POST", sharePath(m, "missing"), nil, nil)
}

func TestBotContactRequestShare(t *testing.T) {
	e := newContactEnv(t)
	ctx := context.Background()
	m := e.botPost(e.olgaDM, contactKeyboard("share", v1.ContactField_CONTACT_FIELD_PHONE, v1.ContactField_CONTACT_FIELD_EMAIL))
	e.ev.take()
	// Only the DM's person: the bot itself, an outsider of the DM.
	e.must(403, "", e.bot, true, "POST", sharePath(m, "share"), nil, nil)
	e.must(404, "", e.carl, false, "POST", sharePath(m, "share"), nil, nil)

	var resp v1.ShareContactResponse
	e.must(200, "", e.olga, false, "POST", sharePath(m, "share"), nil, &resp)
	if len(resp.GetFields()) != 2 || resp.GetMessage().GetSystem().GetContactShared() == nil {
		t.Fatalf("response: %v", &resp)
	}
	// The contact goes to that bot only; the DM gets the card (both members), without values.
	var contact *v1.ContactShared
	cards := map[uuid.UUID]bool{}
	for _, s := range e.ev.take() {
		if c := s.ev.GetContactShared(); c != nil {
			if s.user != e.bot || contact != nil {
				t.Fatalf("CONTACT_SHARED to %v", s.user)
			}
			contact = c
		}
		if msg := s.ev.GetMessageCreate().GetMessage(); msg.GetSystem().GetContactShared() != nil {
			cards[s.user] = true
			raw, _ := protojson.Marshal(msg)
			if strings.Contains(string(raw), e.olgaPhone) || strings.Contains(string(raw), e.olgaE) {
				t.Fatalf("card leaks the values: %s", raw)
			}
		}
	}
	if !cards[e.olga] || !cards[e.bot] || len(cards) != 2 {
		t.Fatalf("card recipients: %v", cards)
	}
	want := &v1.ContactShared{
		Id: resp.GetShareId(), BotUserId: e.bot.String(), UserId: e.olga.String(), DisplayName: "Olga",
		Phone: e.olgaPhone, PhoneVerified: false, Email: e.olgaE, EmailVerified: true,
		RoomId: e.olgaDM.String(), MessageId: m.GetId(), ButtonId: "share", Data: "signup:42",
		Fields: []v1.ContactField{v1.ContactField_CONTACT_FIELD_PHONE, v1.ContactField_CONTACT_FIELD_EMAIL},
	}
	if contact == nil {
		t.Fatal("no CONTACT_SHARED")
	}
	got := proto.CloneOf(contact)
	got.SharedAt = nil
	if !proto.Equal(got, want) {
		t.Fatalf("contact:\n got %v\nwant %v", got, want)
	}
	// The webhook delivery carries the same event under the share id.
	var payload []byte
	if err := e.d.Pool.QueryRow(ctx, `SELECT payload FROM bot_webhook_deliveries WHERE id = $1 AND bot_user_id = $2`, uuid.MustParse(resp.GetShareId()), e.bot).Scan(&payload); err != nil {
		t.Fatal(err)
	}
	var hook v1.BotWebhookUpdate
	if err := protojson.Unmarshal(payload, &hook); err != nil {
		t.Fatal(err)
	}
	if hook.GetId() != resp.GetShareId() || !proto.Equal(hook.GetEvent().GetContactShared(), contact) {
		t.Fatalf("webhook: %s", payload)
	}
	// One share per button per person.
	e.must(409, ReasonContactShared, e.olga, false, "POST", sharePath(m, "share"), nil, nil)

	// Only the requested fields: an email-only button never carries the phone.
	m2 := e.botPost(e.olgaDM, contactKeyboard("mail", v1.ContactField_CONTACT_FIELD_EMAIL))
	e.ev.take()
	e.must(200, "", e.olga, false, "POST", sharePath(m2, "mail"), nil, &resp)
	for _, s := range e.ev.take() {
		if c := s.ev.GetContactShared(); c != nil && (c.GetPhone() != "" || c.GetEmail() != e.olgaE || len(c.GetFields()) != 1) {
			t.Fatalf("email-only contact: %v", c)
		}
	}
	if err := e.d.Pool.QueryRow(ctx, `SELECT payload FROM bot_webhook_deliveries WHERE id = $1`, uuid.MustParse(resp.GetShareId())).Scan(&payload); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(payload), e.olgaPhone) {
		t.Fatalf("webhook leaks the phone: %s", payload)
	}

	// Carl: no phone (nothing to share), an unverified email.
	mc := e.botPost(e.carlDM, contactKeyboard("phone", v1.ContactField_CONTACT_FIELD_PHONE))
	e.must(422, ReasonContactEmpty, e.carl, false, "POST", sharePath(mc, "phone"), nil, nil)
	mc2 := e.botPost(e.carlDM, contactKeyboard("both", v1.ContactField_CONTACT_FIELD_PHONE, v1.ContactField_CONTACT_FIELD_EMAIL))
	e.ev.take()
	e.must(200, "", e.carl, false, "POST", sharePath(mc2, "both"), nil, &resp)
	for _, s := range e.ev.take() {
		if c := s.ev.GetContactShared(); c != nil && (c.GetPhone() != "" || c.GetEmail() != e.carlE || c.GetEmailVerified() || len(c.GetFields()) != 1) {
			t.Fatalf("Carl's contact: %v", c)
		}
	}

	// The journal: VIEW_JOURNALS (the owner) sees the facts without values; a member does not.
	var journal v1.ListBotContactSharesResponse
	e.must(200, "", e.olga, false, "GET", "/api/workspaces/"+e.ws.String()+"/bot-contact-shares", nil, &journal)
	if len(journal.GetEntries()) != 3 || journal.GetEntries()[0].GetUserId() != e.carl.String() || len(journal.GetEntries()[2].GetFields()) != 2 {
		t.Fatalf("journal: %v", &journal)
	}
	raw, _ := protojson.Marshal(&journal)
	if strings.Contains(string(raw), e.olgaPhone) || strings.Contains(string(raw), e.olgaE) {
		t.Fatalf("journal leaks values: %s", raw)
	}
	e.must(403, "", e.carl, false, "GET", "/api/workspaces/"+e.ws.String()+"/bot-contact-shares", nil, nil)
	e.must(403, "", e.bot, true, "GET", "/api/workspaces/"+e.ws.String()+"/bot-contact-shares", nil, nil)
}

func TestBotContactRequestHourlyLimit(t *testing.T) {
	e := newContactEnv(t)
	m := e.botPost(e.olgaDM, contactKeyboard("share", v1.ContactField_CONTACT_FIELD_EMAIL))
	for i := range ContactSharesPerHour {
		if _, err := e.d.Pool.Exec(context.Background(), `INSERT INTO bot_contact_shares (workspace_id, bot_user_id, user_id, room_id, message_id, button_id, fields)
			VALUES ($1, $2, $3, $4, gen_random_uuid(), $5, '{email}')`, e.ws, e.bot, e.olga, e.olgaDM, "b"+string(rune('a'+i))); err != nil {
			t.Fatal(err)
		}
	}
	e.must(429, ReasonContactLimit, e.olga, false, "POST", sharePath(m, "share"), nil, nil)
	if _, err := e.d.Pool.Exec(context.Background(), `UPDATE bot_contact_shares SET created_at = now() - interval '61 minutes' WHERE user_id = $1`, e.olga); err != nil {
		t.Fatal(err)
	}
	e.must(200, "", e.olga, false, "POST", sharePath(m, "share"), nil, nil)
}

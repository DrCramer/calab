//go:build integration

package canvas

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/redis/rueidis"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/dbtest"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/redisx"
	"github.com/calaba/calaba/server/internal/redisx/redistest"
	"github.com/calaba/calaba/server/internal/search"
	"github.com/calaba/calaba/server/internal/ysync"
)

func TestMain(m *testing.M) {
	redisx.SetKeyPrefix(redistest.Prefix())
	os.Exit(dbtest.Run(m))
}

// recorder keeps the published events.
type recorder struct {
	mu    sync.Mutex
	evs   []*v1.DispatchEvent
	users []userEvent // the user-channel events (mention notices)
}

type userEvent struct {
	user uuid.UUID
	ev   *v1.DispatchEvent
}

func (r *recorder) Workspace(_ context.Context, _ uuid.UUID, ev *v1.DispatchEvent) { r.add(ev) }
func (r *recorder) User(_ context.Context, u uuid.UUID, ev *v1.DispatchEvent) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.users = append(r.users, userEvent{u, ev})
}
func (r *recorder) takeUsers() []userEvent {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := r.users
	r.users = nil
	return out
}
func (r *recorder) Workspaces(_ context.Context, _ []uuid.UUID, ev *v1.DispatchEvent) {
	r.add(ev)
}
func (r *recorder) WorkspaceEvents(_ context.Context, _ uuid.UUID, evs []*v1.DispatchEvent) {
	for _, ev := range evs {
		r.add(ev)
	}
}
func (r *recorder) SessionRevoked(context.Context, uuid.UUID, string) {}
func (r *recorder) add(ev *v1.DispatchEvent) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.evs = append(r.evs, ev)
}
func (r *recorder) take() []*v1.DispatchEvent {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := r.evs
	r.evs = nil
	return out
}

// fakeAuth: the token is the user id, "bot:<id>" a bot; anything else is an invalid token.
type fakeAuth struct{}

func (fakeAuth) AuthenticateToken(_ context.Context, tok string) (auth.Identity, error) {
	bot := strings.HasPrefix(tok, "bot:")
	u, err := uuid.Parse(strings.TrimPrefix(tok, "bot:"))
	if err != nil {
		return auth.Identity{}, auth.ErrInvalidToken
	}
	return auth.Identity{UserID: u, SessionID: uuid.New(), IsBot: bot}, nil
}
func (fakeAuth) CheckSession(context.Context, uuid.UUID) error { return nil }
func (fakeAuth) CheckWorkspace(context.Context, auth.Identity, uuid.UUID, identitypolicy.Operation) error {
	return nil
}
func (fakeAuth) WithPolicy(ctx context.Context, _ auth.Identity, _ identitypolicy.Operation) context.Context {
	return ctx
}

// env is one workspace with its people and the service behind a mux (and an HTTP server for
// the sync socket).
type env struct {
	t   *testing.T
	d   *db.DB
	svc *Service
	ev  *recorder
	mux *http.ServeMux
	srv *httptest.Server
	rc  rueidis.Client
	ws  uuid.UUID
	// owner (workspace owner), admin, alice / bob (members), guest, outsider (no member)
	owner, admin, alice, bob, guest, outsider uuid.UUID
}

func newEnv(t *testing.T, cfg ysync.Config) *env {
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
	e := &env{t: t, d: d, ev: &recorder{}, mux: http.NewServeMux(), rc: rc}
	e.svc = New(d, e.ev)
	e.svc.EnableSync(rc, fakeAuth{}, nil, cfg)
	wrap := func(h http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			u, err := uuid.Parse(r.Header.Get("X-Test-User"))
			if err != nil {
				http.Error(w, "no user", http.StatusUnauthorized)
				return
			}
			c := auth.WithIdentity(r.Context(), auth.Identity{UserID: u, SessionID: uuid.New()})
			h.ServeHTTP(w, r.WithContext(perm.WithResolver(c, d.Q)))
		})
	}
	e.svc.Routes(e.mux, wrap)
	search.New(d).Routes(e.mux, wrap)
	e.srv = httptest.NewServer(e.mux)
	t.Cleanup(e.srv.Close)
	user := func(name string, guest bool) uuid.UUID {
		id := uuid.New()
		email := any(name + "-" + id.String()[:8] + "@canvas.test")
		if guest {
			email = nil
		}
		if _, err := d.Pool.Exec(ctx, `INSERT INTO users (id, email, display_name, is_guest) VALUES ($1, $2, $3, $4)`, id, email, name, guest); err != nil {
			t.Fatal(err)
		}
		return id
	}
	e.owner, e.admin, e.alice, e.bob, e.guest, e.outsider = user("Owner", false), user("Admin", false), user("Alice", false),
		user("Bob", false), user("Guest", true), user("Outsider", false)
	e.ws = uuid.New()
	if _, err := d.Pool.Exec(ctx, `INSERT INTO workspaces (id, slug, name, owner_id) VALUES ($1, $2, 'Canvas', $3)`, e.ws, "cv-"+e.ws.String()[:12], e.owner); err != nil {
		t.Fatal(err)
	}
	for u, role := range map[uuid.UUID]string{e.owner: "owner", e.admin: "admin", e.alice: "member", e.bob: "member", e.guest: "guest"} {
		if _, err := d.Q.AddMember(ctx, sqlc.AddMemberParams{WorkspaceID: e.ws, UserID: u, Role: role}); err != nil {
			t.Fatal(err)
		}
	}
	return e
}

// call makes a request as user (uuid.Nil = anonymous); body is a proto (JSON) or raw bytes.
func (e *env) call(user uuid.UUID, method, path string, body any) *httptest.ResponseRecorder {
	e.t.Helper()
	var rd io.Reader
	switch b := body.(type) {
	case nil:
	case proto.Message:
		raw, err := protojson.Marshal(b)
		if err != nil {
			e.t.Fatal(err)
		}
		rd = bytes.NewReader(raw)
	case []byte:
		rd = bytes.NewReader(b)
	}
	r := httptest.NewRequestWithContext(context.Background(), method, path, rd)
	if user != uuid.Nil {
		r.Header.Set("X-Test-User", user.String())
	}
	w := httptest.NewRecorder()
	e.mux.ServeHTTP(w, r)
	return w
}

// must asserts the status and decodes the JSON answer into out (nil = ignore).
func (e *env) must(want int, user uuid.UUID, method, path string, body any, out proto.Message) {
	e.t.Helper()
	w := e.call(user, method, path, body)
	if w.Code != want {
		e.t.Fatalf("%s %s: %d %s, want %d", method, path, w.Code, w.Body.String(), want)
	}
	if out != nil {
		if err := protojson.Unmarshal(w.Body.Bytes(), out); err != nil {
			e.t.Fatalf("%s %s: decode %v: %s", method, path, err, w.Body.String())
		}
	}
}

func item(id string) string { return "/api/canvas/items/" + id }

const (
	folder = v1.CanvasItemKind_CANVAS_ITEM_KIND_FOLDER
	board  = v1.CanvasItemKind_CANVAS_ITEM_KIND_CANVAS
)

func (e *env) createKind(user uuid.UUID, parent string, kind v1.CanvasItemKind, name string) *v1.CanvasItem {
	e.t.Helper()
	var out v1.CanvasItemResponse
	e.must(201, user, "POST", "/api/workspaces/"+e.ws.String()+"/canvas/items", &v1.CreateCanvasItemRequest{ParentId: parent, Kind: kind, Name: name}, &out)
	return out.GetItem()
}

// create makes a canvas, mkdir a folder.
func (e *env) create(user uuid.UUID, parent, name string) *v1.CanvasItem {
	e.t.Helper()
	return e.createKind(user, parent, board, name)
}

func (e *env) mkdir(user uuid.UUID, parent, name string) *v1.CanvasItem {
	e.t.Helper()
	return e.createKind(user, parent, folder, name)
}

func (e *env) names(user uuid.UUID, query string) []string {
	e.t.Helper()
	var out v1.ListCanvasItemsResponse
	e.must(200, user, "GET", "/api/workspaces/"+e.ws.String()+"/canvas/items?"+query, nil, &out)
	var t []string
	for _, p := range out.GetItems() {
		t = append(t, p.GetName())
	}
	return t
}

const (
	user = v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER
	role = v1.PermissionTargetType_PERMISSION_TARGET_TYPE_ROLE
)

// ADR-0126 §2: members see and write every item that is not restricted, guests and outsiders
// nothing; CANVAS_WRITE edits content and adds items to a folder, the structure takes the owner or
// CANVAS_MANAGE; restricted + overrides; 404 for what one does not see, 403 for what one sees but
// may not do.
func TestCanvasPermissionsMatrix(t *testing.T) {
	e := newEnv(t, ysync.Config{})
	ws := "/api/workspaces/" + e.ws.String()
	team := e.mkdir(e.alice, "", "Team")
	if team.GetMyBits() != uint64(perm.CanvasView|perm.CanvasWrite) || team.GetOwnerId() != e.alice.String() || team.GetKind() != folder {
		t.Fatalf("create answer: %v", team)
	}
	evs := e.ev.take()
	if len(evs) != 1 || evs[0].GetCanvasItemUpsert().GetItem().GetId() != team.GetId() || len(evs[0].GetCanvasItemUpsert().GetAccess()) != 1 {
		t.Fatalf("create events: %v", evs)
	}
	// Members see it; the guest and outsiders do not.
	if got := e.names(e.bob, ""); len(got) != 1 {
		t.Fatalf("bob sees %v", got)
	}
	if got := e.names(e.guest, ""); len(got) != 0 {
		t.Fatalf("the guest sees %v", got)
	}
	e.must(404, e.guest, "GET", item(team.GetId()), nil, nil)
	e.must(404, e.outsider, "GET", item(team.GetId()), nil, nil)
	e.must(404, e.outsider, "GET", ws+"/canvas/items", nil, nil)
	e.must(403, e.guest, "POST", ws+"/canvas/items", &v1.CreateCanvasItemRequest{Kind: board, Name: "x"}, nil)
	// CANVAS_WRITE: bob adds a canvas to alice's folder (he owns it) but may not change the folder.
	sub := e.create(e.bob, team.GetId(), "Bob's board")
	var full v1.CanvasItemResponse
	e.must(200, e.bob, "GET", item(team.GetId()), nil, &full)
	if !full.GetItem().GetHasChildren() {
		t.Fatal("has_children not set")
	}
	e.must(403, e.bob, "PATCH", item(team.GetId()), &v1.UpdateCanvasItemRequest{Name: proto.String("Mine")}, nil)
	e.must(403, e.bob, "POST", item(team.GetId())+"/trash", nil, nil)
	e.must(403, e.bob, "GET", item(team.GetId())+"/permissions", nil, nil)
	e.must(200, e.bob, "PATCH", item(sub.GetId()), &v1.UpdateCanvasItemRequest{Name: proto.String("Bob's")}, nil)
	e.must(200, e.admin, "PATCH", item(team.GetId()), &v1.UpdateCanvasItemRequest{Name: proto.String("Team v2")}, nil)
	e.must(422, e.alice, "PATCH", item(team.GetId()), &v1.UpdateCanvasItemRequest{Name: proto.String(strings.Repeat("я", 201))}, nil)
	// Kind and parent: a canvas holds nothing, the kind is required.
	e.must(409, e.alice, "POST", ws+"/canvas/items", &v1.CreateCanvasItemRequest{ParentId: sub.GetId(), Kind: board, Name: "inside"}, nil)
	e.must(409, e.alice, "GET", ws+"/canvas/items?parent="+sub.GetId(), nil, nil)
	e.must(422, e.alice, "POST", ws+"/canvas/items", &v1.CreateCanvasItemRequest{Name: "no kind"}, nil)
	// Restricted, shared with the guest by name: bob loses the folder and its subtree (his own
	// canvas stays his: the owner always sees his items).
	var perms v1.CanvasPermissionsResponse
	e.must(200, e.alice, "PUT", item(team.GetId())+"/permissions", &v1.UpdateCanvasPermissionsRequest{Restricted: proto.Bool(true),
		Entries: []*v1.CanvasPermissionEntry{{TargetType: user, TargetId: e.guest.String(), Allow: uint64(perm.CanvasView)}}}, &perms)
	if !perms.GetRestricted() || len(perms.GetEntries()) != 1 {
		t.Fatalf("permissions: %v", &perms)
	}
	e.must(404, e.bob, "GET", item(team.GetId()), nil, nil)
	e.must(200, e.bob, "GET", item(sub.GetId()), nil, nil)
	e.must(200, e.guest, "GET", item(team.GetId()), nil, nil)
	e.must(403, e.guest, "POST", ws+"/canvas/items", &v1.CreateCanvasItemRequest{ParentId: team.GetId(), Kind: board, Name: "g"}, nil)
	e.must(404, e.admin, "GET", item(team.GetId()), nil, nil) // addendum 2026-10-14
	// The event of the change: bob saw it before (access_before), the guest after.
	var upsert *v1.CanvasItemUpsert
	for _, ev := range e.ev.take() {
		if u := ev.GetCanvasItemUpsert(); u != nil && u.GetItem().GetId() == team.GetId() {
			upsert = u
		}
	}
	if upsert == nil || len(upsert.GetAccessBefore()) == 0 || !upsert.GetAccess()[0].GetRestricted() {
		t.Fatalf("permissions event: %v", upsert)
	}
	// A personal VIEW | WRITE gives bob the folder back with writing; a deny of WRITE takes it.
	e.must(200, e.alice, "PUT", item(team.GetId())+"/permissions", &v1.UpdateCanvasPermissionsRequest{Entries: []*v1.CanvasPermissionEntry{
		{TargetType: user, TargetId: e.bob.String(), Allow: uint64(perm.CanvasView | perm.CanvasWrite)}}}, nil)
	e.create(e.bob, team.GetId(), "Allowed")
	e.must(200, e.alice, "PUT", item(team.GetId())+"/permissions", &v1.UpdateCanvasPermissionsRequest{Entries: []*v1.CanvasPermissionEntry{
		{TargetType: user, TargetId: e.bob.String(), Allow: uint64(perm.CanvasView), Deny: uint64(perm.CanvasWrite)}}}, nil)
	e.must(403, e.bob, "POST", ws+"/canvas/items", &v1.CreateCanvasItemRequest{ParentId: team.GetId(), Kind: board, Name: "x"}, nil)
	// Validation: the guest role, foreign bits, non-members.
	var guestRole uuid.UUID
	if err := e.d.Pool.QueryRow(context.Background(), `SELECT id FROM workspace_roles WHERE workspace_id = $1 AND builtin = 'guest'`, e.ws).Scan(&guestRole); err != nil {
		t.Fatal(err)
	}
	e.must(422, e.alice, "PUT", item(team.GetId())+"/permissions", &v1.UpdateCanvasPermissionsRequest{Entries: []*v1.CanvasPermissionEntry{
		{TargetType: role, TargetId: guestRole.String(), Allow: uint64(perm.CanvasView)}}}, nil)
	e.must(422, e.alice, "PUT", item(team.GetId())+"/permissions", &v1.UpdateCanvasPermissionsRequest{Entries: []*v1.CanvasPermissionEntry{
		{TargetType: user, TargetId: e.bob.String(), Allow: uint64(perm.CanvasManage)}}}, nil)
	e.must(422, e.alice, "PUT", item(team.GetId())+"/permissions", &v1.UpdateCanvasPermissionsRequest{Entries: []*v1.CanvasPermissionEntry{
		{TargetType: user, TargetId: e.outsider.String(), Allow: uint64(perm.CanvasView)}}}, nil)
	// The journal: create, rename, share…
	var act v1.CanvasActivityPage
	e.must(200, e.alice, "GET", item(team.GetId())+"/activity", nil, &act)
	kinds := map[v1.CanvasActivityKind]int{}
	for _, a := range act.GetActivities() {
		kinds[a.GetKind()]++
	}
	if kinds[v1.CanvasActivityKind_CANVAS_ACTIVITY_KIND_CREATE] != 1 || kinds[v1.CanvasActivityKind_CANVAS_ACTIVITY_KIND_RENAME] != 1 ||
		kinds[v1.CanvasActivityKind_CANVAS_ACTIVITY_KIND_SHARE] != 3 {
		t.Fatalf("journal: %v", kinds)
	}
	e.must(403, e.bob, "GET", ws+"/canvas/activity", nil, nil)
	e.must(200, e.admin, "GET", ws+"/canvas/activity", nil, nil)
	// Settings: everyone reads, CANVAS_MANAGE writes.
	e.must(403, e.bob, "PUT", ws+"/canvas/settings", &v1.CanvasSettings{TrashDays: 30}, nil)
	e.must(422, e.admin, "PUT", ws+"/canvas/settings", &v1.CanvasSettings{TrashDays: 4000}, nil)
	e.must(200, e.admin, "PUT", ws+"/canvas/settings", &v1.CanvasSettings{TrashDays: 30}, nil)
	var set v1.CanvasSettings
	e.must(200, e.bob, "GET", ws+"/canvas/settings", nil, &set)
	if set.GetTrashDays() != 30 {
		t.Fatalf("settings: %v", &set)
	}
	// The workspace-level bits: a member's role carries VIEW | WRITE (migration 00017), a guest's
	// none.
	m, err := perm.NewResolver(e.d.Q).Member(context.Background(), e.ws, e.guest)
	if err != nil || perm.CanvasOf(m.Raw(), m.Role == perm.RoleGuest) != 0 {
		t.Fatalf("guest bits: %v %v", perm.CanvasOf(m.Raw(), true), err)
	}
}

// Moves: order among siblings, into folders only, no cycles, the path, depth 32.
func TestCanvasMoveAndOrder(t *testing.T) {
	e := newEnv(t, ysync.Config{})
	ws := "/api/workspaces/" + e.ws.String()
	a, b, c := e.mkdir(e.alice, "", "A"), e.create(e.alice, "", "B"), e.mkdir(e.alice, "", "C")
	order := func(want string, query string) {
		t.Helper()
		if got := strings.Join(e.names(e.alice, query), ","); got != want {
			t.Fatalf("order %q, want %q", got, want)
		}
	}
	order("A,B,C", "")
	e.must(200, e.alice, "PATCH", item(c.GetId()), &v1.UpdateCanvasItemRequest{Position: proto.Int32(0)}, nil)
	order("C,A,B", "")
	e.must(200, e.alice, "PATCH", item(c.GetId()), &v1.UpdateCanvasItemRequest{Position: proto.Int32(2)}, nil)
	order("A,B,C", "")
	e.must(200, e.alice, "PATCH", item(a.GetId()), &v1.UpdateCanvasItemRequest{Position: proto.Int32(1)}, nil)
	order("B,A,C", "")
	// A under C, then C under A is a cycle; a canvas takes no children.
	e.must(200, e.alice, "PATCH", item(a.GetId()), &v1.UpdateCanvasItemRequest{ParentId: proto.String(c.GetId())}, nil)
	order("B,C", "")
	order("A", "parent="+c.GetId())
	e.must(409, e.alice, "PATCH", item(c.GetId()), &v1.UpdateCanvasItemRequest{ParentId: proto.String(a.GetId())}, nil)
	e.must(409, e.alice, "PATCH", item(c.GetId()), &v1.UpdateCanvasItemRequest{ParentId: proto.String(c.GetId())}, nil)
	e.must(409, e.alice, "PATCH", item(a.GetId()), &v1.UpdateCanvasItemRequest{ParentId: proto.String(b.GetId())}, nil)
	// B under C at the front.
	e.must(200, e.alice, "PATCH", item(b.GetId()), &v1.UpdateCanvasItemRequest{ParentId: proto.String(c.GetId()), Position: proto.Int32(0)}, nil)
	order("B,A", "parent="+c.GetId())
	var path v1.CanvasPathResponse
	e.must(200, e.alice, "GET", item(a.GetId())+"/path", nil, &path)
	if len(path.GetItems()) != 2 || path.GetItems()[0].GetId() != c.GetId() {
		t.Fatalf("path: %v", &path)
	}
	// Moving someone else's item: bob may not; under a folder he cannot write: 403.
	e.must(403, e.bob, "PATCH", item(a.GetId()), &v1.UpdateCanvasItemRequest{ParentId: proto.String("")}, nil)
	mine := e.create(e.bob, "", "Bob")
	e.must(200, e.alice, "PUT", item(c.GetId())+"/permissions", &v1.UpdateCanvasPermissionsRequest{Entries: []*v1.CanvasPermissionEntry{
		{TargetType: user, TargetId: e.bob.String(), Deny: uint64(perm.CanvasWrite)}}}, nil)
	e.must(403, e.bob, "PATCH", item(mine.GetId()), &v1.UpdateCanvasItemRequest{ParentId: proto.String(c.GetId())}, nil)
	// Depth: a chain of 32 folders is the limit.
	parent := ""
	for i := 0; i < MaxDepth; i++ {
		parent = e.mkdir(e.alice, parent, "d").GetId()
	}
	e.must(409, e.alice, "POST", ws+"/canvas/items", &v1.CreateCanvasItemRequest{ParentId: parent, Kind: folder, Name: "too deep"}, nil)
	// … and a move under the deepest folder with a subtree below the item.
	e.must(409, e.alice, "PATCH", item(c.GetId()), &v1.UpdateCanvasItemRequest{ParentId: proto.String(parent)}, nil)
}

// Trash, restore and delete forever, empty trash and the sweeper (ADR-0126 §1).
func TestCanvasTrashRestoreDelete(t *testing.T) {
	e := newEnv(t, ysync.Config{})
	ctx := context.Background()
	ws := "/api/workspaces/" + e.ws.String()
	root := e.mkdir(e.alice, "", "Root")
	child := e.create(e.alice, root.GetId(), "Child")
	// Trash: the subtree goes, the trash lists the root only.
	e.must(409, e.alice, "DELETE", item(root.GetId()), nil, nil)
	e.must(200, e.alice, "POST", item(root.GetId())+"/trash", nil, nil)
	e.must(409, e.alice, "POST", item(root.GetId())+"/trash", nil, nil)
	if got := e.names(e.alice, ""); len(got) != 0 {
		t.Fatalf("live after trash: %v", got)
	}
	if got := e.names(e.alice, "trashed=1"); strings.Join(got, ",") != "Root" {
		t.Fatalf("trash: %v", got)
	}
	e.must(409, e.alice, "POST", ws+"/canvas/items", &v1.CreateCanvasItemRequest{ParentId: root.GetId(), Kind: board, Name: "x"}, nil)
	e.must(409, e.alice, "POST", item(child.GetId())+"/restore", nil, nil)
	e.must(200, e.alice, "POST", item(root.GetId())+"/restore", nil, nil)
	if got := e.names(e.alice, "parent="+root.GetId()); strings.Join(got, ",") != "Child" {
		t.Fatalf("restored subtree: %v", got)
	}
	// Delete forever: the subtree and its content go.
	cv := uuid.MustParse(child.GetId())
	if _, err := e.d.Q.AppendCanvasUpdate(ctx, sqlc.AppendCanvasUpdateParams{CanvasID: cv, Data: []byte("u")}); err != nil {
		t.Fatal(err)
	}
	e.must(200, e.alice, "POST", item(root.GetId())+"/trash", nil, nil)
	e.ev.take()
	e.must(204, e.alice, "DELETE", item(root.GetId()), nil, nil)
	var n int
	if err := e.d.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM canvas_updates WHERE canvas_id = $1) + (SELECT count(*) FROM canvas_items WHERE id = $1)`, cv).Scan(&n); err != nil || n != 0 {
		t.Fatalf("left after delete: %d %v", n, err)
	}
	evs := e.ev.take()
	if len(evs) != 1 || evs[0].GetCanvasItemRemove().GetItemId() != root.GetId() || len(evs[0].GetCanvasItemRemove().GetAccess()) == 0 {
		t.Fatalf("delete events: %v", evs)
	}
	e.must(404, e.alice, "GET", item(child.GetId()), nil, nil)
	// The journal keeps the deletion (item_id gone).
	var act v1.CanvasActivityPage
	e.must(200, e.admin, "GET", ws+"/canvas/activity", nil, &act)
	deleted := false
	for _, a := range act.GetActivities() {
		if a.GetKind() == v1.CanvasActivityKind_CANVAS_ACTIVITY_KIND_DELETE && a.GetItemName() == "Root" && a.GetItemId() == "" {
			deleted = true
		}
	}
	if !deleted {
		t.Fatalf("no delete entry: %v", &act)
	}
	// Empty trash: only what the caller may delete (bob: his own).
	mine, theirs := e.create(e.bob, "", "Mine"), e.create(e.alice, "", "Theirs")
	e.must(200, e.bob, "POST", item(mine.GetId())+"/trash", nil, nil)
	e.must(200, e.alice, "POST", item(theirs.GetId())+"/trash", nil, nil)
	var empty v1.EmptyCanvasTrashResponse
	e.must(200, e.bob, "POST", ws+"/canvas/trash/empty", nil, &empty)
	if empty.GetDeleted() != 1 {
		t.Fatalf("empty trash: %v", &empty)
	}
	// The sweeper: retention 1 day, a root trashed two days ago goes.
	e.must(200, e.admin, "PUT", ws+"/canvas/settings", &v1.CanvasSettings{TrashDays: 1}, nil)
	if _, err := e.d.Pool.Exec(ctx, `UPDATE canvas_items SET trashed_at = now() - interval '2 days' WHERE id = $1`, theirs.GetId()); err != nil {
		t.Fatal(err)
	}
	fresh := e.create(e.alice, "", "Fresh")
	e.must(200, e.alice, "POST", item(fresh.GetId())+"/trash", nil, nil)
	if got, err := e.svc.TrashSweep(ctx); err != nil || got != 1 {
		t.Fatalf("sweep: %d %v", got, err)
	}
	e.must(404, e.alice, "GET", item(theirs.GetId()), nil, nil)
	e.must(200, e.alice, "GET", item(fresh.GetId()), nil, nil)
	// A guest in a workspace suspended by a superadmin changes nothing.
	if _, err := e.d.Pool.Exec(ctx, `UPDATE workspaces SET suspended_at = now() WHERE id = $1`, e.ws); err != nil {
		t.Fatal(err)
	}
	e.must(403, e.alice, "POST", ws+"/canvas/items", &v1.CreateCanvasItemRequest{Kind: board, Name: "x"}, nil)
}

// The search section (ADR-0126 §6): name and text, folders by name, the access filter, the hit
// reference.
func TestSearchCanvasAccess(t *testing.T) {
	e := newEnv(t, ysync.Config{})
	ctx := context.Background()
	dir := e.mkdir(e.alice, "", "Planning")
	open := e.create(e.alice, dir.GetId(), "Release roadmap")
	closed := e.create(e.alice, "", "Salaries")
	if _, err := e.d.Pool.Exec(ctx, `UPDATE canvas_items SET plain_text = 'release salaries budget' WHERE id = $1`, closed.GetId()); err != nil {
		t.Fatal(err)
	}
	if _, err := e.d.Pool.Exec(ctx, `UPDATE canvas_items SET plain_text = 'Ship the release on Friday' WHERE id = $1`, open.GetId()); err != nil {
		t.Fatal(err)
	}
	e.must(200, e.alice, "PATCH", item(closed.GetId()), &v1.UpdateCanvasItemRequest{Restricted: proto.Bool(true)}, nil)
	find := func(u uuid.UUID, q string) []*v1.SearchHit {
		t.Helper()
		var out v1.SearchResponse
		e.must(200, u, "GET", "/api/search?scope="+e.ws.String()+"&type=canvas&q="+q, nil, &out)
		return out.GetSections()[0].GetItems()
	}
	if hits := find(e.alice, "release"); len(hits) != 2 {
		t.Fatalf("alice: %v", hits)
	}
	hits := find(e.bob, "release")
	if len(hits) != 1 || hits[0].GetCanvas().GetItemId() != open.GetId() || hits[0].GetTitle() != "Release roadmap" ||
		!strings.Contains(hits[0].GetSnippet(), "\u0002") || len(hits[0].GetCanvas().GetPath()) != 1 || hits[0].GetCanvas().GetPath()[0] != "Planning" {
		t.Fatalf("bob: %v", hits)
	}
	if hits := find(e.bob, "salaries"); len(hits) != 0 {
		t.Fatalf("bob found the restricted canvas: %v", hits)
	}
	for _, u := range []uuid.UUID{e.admin, e.owner} {
		if hits := find(u, "salaries"); len(hits) != 0 {
			t.Fatalf("%v found the private canvas: %v", u, hits)
		}
	}
	if hits := find(e.guest, "release"); len(hits) != 0 {
		t.Fatalf("the guest found %v", hits)
	}
	// A folder is found by its name.
	hits = find(e.bob, "planning")
	if len(hits) != 1 || !hits[0].GetCanvas().GetFolder() {
		t.Fatalf("folder: %v", hits)
	}
	// Trashed items are not found.
	e.must(200, e.alice, "POST", item(open.GetId())+"/trash", nil, nil)
	if hits := find(e.bob, "release"); len(hits) != 0 {
		t.Fatalf("trashed canvas found: %v", hits)
	}
}

// ---- sync helpers ----

type client struct {
	t  *testing.T
	ws *websocket.Conn
}

// dial opens the sync socket of a canvas as user (token = the user id).
func (e *env) dial(u uuid.UUID, id string) *client {
	e.t.Helper()
	return e.dialToken(e.srv, u.String(), id)
}

// dialToken opens the sync socket on srv and sends tok as the first (text) frame.
func (e *env) dialToken(srv *httptest.Server, tok, id string) *client {
	e.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + item(id) + "/sync"
	ws, resp, err := websocket.Dial(ctx, url, nil)
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		e.t.Fatal(err)
	}
	ws.SetReadLimit(8 << 20)
	e.t.Cleanup(func() { _ = ws.CloseNow() })
	if err := ws.Write(ctx, websocket.MessageText, []byte(tok)); err != nil {
		e.t.Fatal(err)
	}
	return &client{t: e.t, ws: ws}
}

func (c *client) send(f []byte) {
	c.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := c.ws.Write(ctx, websocket.MessageBinary, f); err != nil {
		c.t.Fatal(err)
	}
}

// read returns the next frame (nil and the close status when the socket closed).
func (c *client) read() ([]byte, websocket.StatusCode) {
	c.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, b, err := c.ws.Read(ctx)
	if err != nil {
		c.t.Logf("socket closed: %v", err)
		return nil, websocket.CloseStatus(err)
	}
	return b, -1
}

func (c *client) next(want byte) []byte {
	c.t.Helper()
	f, code := c.read()
	if f == nil {
		c.t.Fatalf("closed %d waiting for frame %d", code, want)
	}
	if f[0] != want {
		c.t.Fatalf("frame %d (%x), want %d", f[0], f[:min(len(f), 16)], want)
	}
	return f
}

// closed expects the socket to close with code (frames before it are skipped).
func (c *client) closed(code websocket.StatusCode) {
	c.t.Helper()
	for i := 0; i < 1000; i++ {
		f, got := c.read()
		if f == nil {
			if got != code {
				c.t.Fatalf("closed with %d, want %d", got, code)
			}
			return
		}
	}
	c.t.Fatal("not closed")
}

// quiet asserts nothing came before a probe: from sends an awareness frame and it must be the
// next frame c gets (a read with a short deadline would close the socket).
func (c *client) quiet(from *client) {
	c.t.Helper()
	from.send([]byte{ysync.FrameAwareness, 0xEE})
	if f := c.next(ysync.FrameAwareness); !bytes.Equal(f, []byte{ysync.FrameAwareness, 0xEE}) {
		c.t.Fatalf("unexpected awareness %x", f)
	}
}

const headerPost = 13

func post(through int64, meta snapshotMeta, state []byte) []byte {
	m, _ := json.Marshal(meta)
	out := make([]byte, headerPost+len(m)+len(state))
	out[0] = ysync.FrameSnapshotPost
	binary.BigEndian.PutUint64(out[1:9], uint64(through)) //nolint:gosec // test values
	binary.BigEndian.PutUint32(out[9:13], uint32(len(m))) //nolint:gosec // test values
	copy(out[13:], m)
	copy(out[13+len(m):], state)
	return out
}

// replica is a fake Yjs document: the snapshot's state followed by the updates in seq order. Two
// replicas that got the same frames hold the same bytes; applying out of order would differ.
type replica struct {
	doc  []byte
	last int64
}

func (r *replica) apply(t *testing.T, f []byte) {
	t.Helper()
	switch f[0] {
	case ysync.FrameSnapshot:
		r.doc, r.last = bytes.Clone(f[9:]), ysync.FrameSeq(f)
	case ysync.FrameUpdate:
		if ysync.FrameSeq(f) != r.last+1 {
			t.Fatalf("update %d after %d: a gap or a duplicate", ysync.FrameSeq(f), r.last)
		}
		r.doc, r.last = append(r.doc, f[9:]...), ysync.FrameSeq(f)
	default:
		t.Fatalf("frame %d is not document content", f[0])
	}
}

// sync reads a fresh socket's initial frames into a replica until it has seq upTo.
func (c *client) catchUp(r *replica, upTo int64) {
	c.t.Helper()
	r.apply(c.t, c.next(ysync.FrameSnapshot))
	for r.last < upTo {
		r.apply(c.t, c.next(ysync.FrameUpdate))
	}
}

var (
	frameSnapshot  = ysync.FrameSnapshot
	frameUpdate    = ysync.FrameUpdate
	frameAwareness = ysync.FrameAwareness
	frameCompact   = ysync.FrameCompact
	updateFrame    = ysync.UpdateFrame
	frameSeq       = ysync.FrameSeq
)

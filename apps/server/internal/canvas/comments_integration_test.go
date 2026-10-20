//go:build integration

package canvas

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"testing"

	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/redisx"
	"github.com/calaba/calaba/server/internal/ysync"
)

func comments(id string) string { return item(id) + "/comments" }
func comment(id string) string  { return "/api/canvas/comments/" + id }

func at(u uuid.UUID) string { return "@" + u.String() }

// post writes a comment and returns it.
func (e *env) comment(user uuid.UUID, canvas string, req *v1.CreateCanvasCommentRequest) *v1.CanvasComment {
	e.t.Helper()
	var out v1.CanvasCommentResponse
	e.must(201, user, "POST", comments(canvas), req, &out)
	return out.GetComment()
}

func (e *env) thread(user uuid.UUID, canvas, query string) *v1.ListCanvasCommentsResponse {
	e.t.Helper()
	var out v1.ListCanvasCommentsResponse
	e.must(200, user, "GET", comments(canvas)+query, nil, &out)
	return &out
}

// mentioned returns the CANVAS_COMMENT_MENTION notices sent since the last call, by recipient.
func (e *env) mentioned() map[uuid.UUID]*v1.CanvasCommentMention {
	out := map[uuid.UUID]*v1.CanvasCommentMention{}
	for _, u := range e.ev.takeUsers() {
		if n := u.ev.GetCanvasCommentMention(); n != nil {
			if out[u.user] != nil {
				e.t.Fatalf("two notices to %s", u.user)
			}
			out[u.user] = n
		}
	}
	return out
}

func (e *env) bot() uuid.UUID {
	e.t.Helper()
	ctx := context.Background()
	id := uuid.New()
	if _, err := e.d.Pool.Exec(ctx, `INSERT INTO users (id, display_name, is_bot) VALUES ($1, 'Bot', true)`, id); err != nil {
		e.t.Fatal(err)
	}
	if _, err := e.d.Q.AddMember(ctx, sqlc.AddMemberParams{WorkspaceID: e.ws, UserID: id, Role: "member"}); err != nil {
		e.t.Fatal(err)
	}
	return id
}

func ids(xs []string) []string { s := slices.Clone(xs); slices.Sort(s); return s }

// ADR-0115 wave 4: who reads, writes, edits and deletes comments; threads of one level; the
// events go with the canvas's chain.
func TestCanvasCommentsAccess(t *testing.T) {
	e := newEnv(t, ysync.Config{})
	c := e.create(e.bob, "", "Retro") // bob owns the canvas
	e.ev.take()
	// alice (a member with CANVAS_WRITE) opens a thread with a pin on an object.
	root := e.comment(e.alice, c.GetId(), &v1.CreateCanvasCommentRequest{Body: "  Look here  ", ObjectId: "note-1", X: 10, Y: -5})
	if root.GetBody() != "Look here" || root.GetObjectId() != "note-1" || root.GetX() != 10 || root.GetY() != -5 || root.GetParentId() != "" ||
		root.GetAuthorId() != e.alice.String() || root.GetResolved() {
		t.Fatalf("root: %v", root)
	}
	evs := e.ev.take()
	if len(evs) != 1 || evs[0].GetCanvasCommentUpsert().GetComment().GetId() != root.GetId() || len(evs[0].GetCanvasCommentUpsert().GetAccess()) != 1 {
		t.Fatalf("create events: %v", evs)
	}
	// Replies: a reply to a reply belongs to the root; its pin fields are ignored.
	r1 := e.comment(e.bob, c.GetId(), &v1.CreateCanvasCommentRequest{Body: "Agreed", ParentId: root.GetId(), ObjectId: "x", X: 99})
	r2 := e.comment(e.alice, c.GetId(), &v1.CreateCanvasCommentRequest{Body: "Thanks", ParentId: r1.GetId()})
	if r1.GetParentId() != root.GetId() || r2.GetParentId() != root.GetId() || r1.GetObjectId() != "" || r1.GetX() != 0 {
		t.Fatalf("replies: %v / %v", r1, r2)
	}
	e.must(404, e.alice, "POST", comments(c.GetId()), &v1.CreateCanvasCommentRequest{Body: "x", ParentId: uuid.NewString()}, nil)
	other := e.create(e.alice, "", "Other")
	e.must(404, e.alice, "POST", comments(other.GetId()), &v1.CreateCanvasCommentRequest{Body: "x", ParentId: root.GetId()}, nil)
	// Reading: members in order; the guest and outsiders get 404, for a comment id too.
	got := e.thread(e.alice, c.GetId(), "")
	var order []string
	for _, x := range got.GetComments() {
		order = append(order, x.GetId())
	}
	if !slices.Equal(order, []string{root.GetId(), r1.GetId(), r2.GetId()}) || got.GetOpenThreads() != 1 || got.GetNextCursor() != "" {
		t.Fatalf("listing: %v", got)
	}
	for _, u := range []uuid.UUID{e.guest, e.outsider} {
		e.must(404, u, "GET", comments(c.GetId()), nil, nil)
		e.must(404, u, "POST", comments(c.GetId()), &v1.CreateCanvasCommentRequest{Body: "x"}, nil)
		e.must(404, u, "PATCH", comment(root.GetId()), &v1.UpdateCanvasCommentRequest{Resolved: proto.Bool(true)}, nil)
		e.must(404, u, "DELETE", comment(root.GetId()), nil, nil)
	}
	e.must(404, e.alice, "PATCH", comment(uuid.NewString()), &v1.UpdateCanvasCommentRequest{Resolved: proto.Bool(true)}, nil)
	// A viewer (the guest let in with CANVAS_VIEW) reads but does not write or resolve.
	e.must(200, e.bob, "PUT", item(c.GetId())+"/permissions", &v1.UpdateCanvasPermissionsRequest{
		Entries: []*v1.CanvasPermissionEntry{{TargetType: user, TargetId: e.guest.String(), Allow: uint64(perm.CanvasView)}}}, nil)
	if len(e.thread(e.guest, c.GetId(), "").GetComments()) != 3 {
		t.Fatal("the viewer does not read")
	}
	e.must(403, e.guest, "POST", comments(c.GetId()), &v1.CreateCanvasCommentRequest{Body: "x"}, nil)
	e.must(403, e.guest, "PATCH", comment(root.GetId()), &v1.UpdateCanvasCommentRequest{Resolved: proto.Bool(true)}, nil)
	// Editing: the author their own, not someone else's; the owner of the canvas and
	// CANVAS_MANAGE anyone's.
	e.must(403, e.alice, "PATCH", comment(r1.GetId()), &v1.UpdateCanvasCommentRequest{Body: proto.String("hijack")}, nil)
	e.must(403, e.alice, "DELETE", comment(r1.GetId()), nil, nil)
	var upd v1.CanvasCommentResponse
	e.must(200, e.alice, "PATCH", comment(root.GetId()), &v1.UpdateCanvasCommentRequest{Body: proto.String("Look here!")}, &upd)
	if upd.GetComment().GetBody() != "Look here!" || upd.GetComment().GetEditedAt() == nil {
		t.Fatalf("edit: %v", &upd)
	}
	e.must(200, e.bob, "PATCH", comment(r2.GetId()), &v1.UpdateCanvasCommentRequest{Body: proto.String("moderated")}, nil)
	e.must(200, e.admin, "PATCH", comment(r2.GetId()), &v1.UpdateCanvasCommentRequest{Body: proto.String("moderated again")}, nil)
	// Resolving: any writer, roots only.
	e.must(422, e.alice, "PATCH", comment(r1.GetId()), &v1.UpdateCanvasCommentRequest{Resolved: proto.Bool(true)}, nil)
	e.ev.take()
	e.must(200, e.alice, "PATCH", comment(root.GetId()), &v1.UpdateCanvasCommentRequest{Resolved: proto.Bool(true)}, &upd)
	if !upd.GetComment().GetResolved() || upd.GetComment().GetResolvedBy() != e.alice.String() {
		t.Fatalf("resolve: %v", &upd)
	}
	if evs := e.ev.take(); len(evs) != 1 || !evs[0].GetCanvasCommentUpsert().GetComment().GetResolved() {
		t.Fatalf("resolve events: %v", evs)
	}
	if got := e.thread(e.alice, c.GetId(), "?open=1"); len(got.GetComments()) != 0 || got.GetOpenThreads() != 0 {
		t.Fatalf("open filter: %v", got)
	}
	e.must(200, e.bob, "PATCH", comment(root.GetId()), &v1.UpdateCanvasCommentRequest{Resolved: proto.Bool(false)}, &upd)
	if upd.GetComment().GetResolved() || upd.GetComment().GetResolvedAt() != nil {
		t.Fatalf("reopen: %v", &upd)
	}
	// Deleting: a reply alone (by the owner of the canvas), the root with its thread (the author).
	e.ev.take()
	e.must(204, e.bob, "DELETE", comment(r2.GetId()), nil, nil)
	evs = e.ev.take()
	if len(evs) != 1 || evs[0].GetCanvasCommentDelete().GetCommentId() != r2.GetId() || len(evs[0].GetCanvasCommentDelete().GetAccess()) != 1 {
		t.Fatalf("delete events: %v", evs)
	}
	e.must(204, e.alice, "DELETE", comment(root.GetId()), nil, nil)
	if got := e.thread(e.alice, c.GetId(), ""); len(got.GetComments()) != 0 {
		t.Fatalf("thread left: %v", got)
	}
	e.must(404, e.alice, "DELETE", comment(r1.GetId()), nil, nil) // went with its root
	// The journal: the facts and ids, never the text.
	var page v1.CanvasActivityPage
	e.must(200, e.alice, "GET", item(c.GetId())+"/activity", nil, &page)
	kinds := map[v1.CanvasActivityKind]int{}
	for _, a := range page.GetActivities() {
		kinds[a.GetKind()]++
		raw, _ := json.Marshal(a.GetAfter().AsMap())
		if strings.Contains(string(raw), "Look") || strings.Contains(string(raw), "Agreed") {
			t.Fatalf("comment text in the journal: %s", raw)
		}
	}
	if kinds[v1.CanvasActivityKind_CANVAS_ACTIVITY_KIND_COMMENT] != 3 || kinds[v1.CanvasActivityKind_CANVAS_ACTIVITY_KIND_RESOLVE] != 1 {
		t.Fatalf("journal kinds: %v", kinds)
	}
	// A folder has no comments.
	f := e.mkdir(e.alice, "", "Folder")
	e.must(409, e.alice, "POST", comments(f.GetId()), &v1.CreateCanvasCommentRequest{Body: "x"}, nil)
	e.must(409, e.alice, "GET", comments(f.GetId()), nil, nil)
}

// A private canvas: who is not let in gets 404 everywhere, is not mentionable, and the notice
// carries no text.
func TestCanvasCommentsPrivate(t *testing.T) {
	e := newEnv(t, ysync.Config{})
	p := e.create(e.alice, "", "Salaries")
	e.must(200, e.alice, "PUT", item(p.GetId())+"/permissions", &v1.UpdateCanvasPermissionsRequest{Restricted: proto.Bool(true),
		Entries: []*v1.CanvasPermissionEntry{{TargetType: user, TargetId: e.guest.String(), Allow: uint64(perm.CanvasView)}}}, nil)
	e.mentioned()
	root := e.comment(e.alice, p.GetId(), &v1.CreateCanvasCommentRequest{Body: "raise for " + at(e.bob) + " " + at(e.guest) + " " + at(e.admin)})
	if !slices.Equal(root.GetMentions(), []string{e.guest.String()}) {
		t.Fatalf("mentions on a private canvas: %v", root.GetMentions())
	}
	n := e.mentioned()
	if len(n) != 1 || n[e.guest] == nil || n[e.guest].GetText() != "" || n[e.guest].GetThreadId() != root.GetId() || n[e.guest].GetCanvasId() != p.GetId() {
		t.Fatalf("notices: %v", n)
	}
	for _, u := range []uuid.UUID{e.bob, e.admin, e.outsider} { // the administrator is not let in either
		e.must(404, u, "GET", comments(p.GetId()), nil, nil)
		e.must(404, u, "PATCH", comment(root.GetId()), &v1.UpdateCanvasCommentRequest{Body: proto.String("x")}, nil)
		e.must(404, u, "DELETE", comment(root.GetId()), nil, nil)
		e.must(404, u, "GET", comments(p.GetId())+"/mention-access?user_ids="+e.guest.String(), nil, nil)
	}
	var acc v1.CanvasMentionAccessResponse
	e.must(200, e.alice, "GET", comments(p.GetId())+"/mention-access?user_ids="+strings.Join([]string{e.bob.String(), e.guest.String(), e.alice.String(), e.outsider.String()}, ","), nil, &acc)
	if !slices.Equal(ids(acc.GetSeeIds()), ids([]string{e.guest.String(), e.alice.String()})) {
		t.Fatalf("mention access: %v", acc.GetSeeIds())
	}
	e.must(422, e.alice, "GET", comments(p.GetId())+"/mention-access?user_ids=nope", nil, nil)
}

// Mentions: only members who see the canvas (not bots, not outsiders) are kept and notified once
// per comment; the author never; by the workspace level; the text hidden on request.
func TestCanvasCommentMentions(t *testing.T) {
	e := newEnv(t, ysync.Config{})
	ctx := context.Background()
	bot := e.bot()
	c := e.create(e.alice, "", "Plan")
	e.mentioned()
	root := e.comment(e.alice, c.GetId(), &v1.CreateCanvasCommentRequest{
		Body: "ping " + at(e.bob) + " " + at(e.alice) + " " + at(e.guest) + " " + at(e.outsider) + " " + at(bot) + " `" + at(e.admin) + "`", X: 3, Y: 4})
	if !slices.Equal(ids(root.GetMentions()), ids([]string{e.bob.String(), e.alice.String()})) {
		t.Fatalf("mentions: %v", root.GetMentions())
	}
	n := e.mentioned()
	if len(n) != 1 || n[e.bob] == nil {
		t.Fatalf("notices: %v", n)
	}
	if b := n[e.bob]; !strings.HasPrefix(b.GetText(), "ping ") || b.GetActorId() != e.alice.String() || b.GetCanvasName() != "Plan" ||
		b.GetCommentId() != root.GetId() || b.GetX() != 3 || b.GetY() != 4 || b.GetObjectId() != "" {
		t.Fatalf("notice: %v", b)
	}
	// An edit notifies only who is new to the comment; removing and adding back does not repeat.
	e.must(200, e.alice, "PATCH", comment(root.GetId()), &v1.UpdateCanvasCommentRequest{Body: proto.String("only " + at(e.admin))}, nil)
	if n := e.mentioned(); len(n) != 1 || n[e.admin] == nil {
		t.Fatalf("edit notices: %v", n)
	}
	e.must(200, e.alice, "PATCH", comment(root.GetId()), &v1.UpdateCanvasCommentRequest{Body: proto.String("again " + at(e.bob) + " " + at(e.admin))}, nil)
	if n := e.mentioned(); len(n) != 0 {
		t.Fatalf("repeated notices: %v", n)
	}
	// A reply's notice points at its thread.
	if _, err := e.d.Pool.Exec(ctx, `UPDATE users SET hide_message_text_in_notifications = true WHERE id = $1`, e.alice); err != nil {
		t.Fatal(err)
	}
	reply := e.comment(e.bob, c.GetId(), &v1.CreateCanvasCommentRequest{Body: "re " + at(e.alice), ParentId: root.GetId()})
	n = e.mentioned()
	if len(n) != 1 || n[e.alice].GetText() != "" || n[e.alice].GetThreadId() != root.GetId() || n[e.alice].GetCommentId() != reply.GetId() || n[e.alice].GetX() != 3 {
		t.Fatalf("reply notice: %v", n)
	}
	// The workspace level: NONE or a mute silences, MENTIONS / ALL notify.
	if _, err := e.d.Pool.Exec(ctx, `INSERT INTO workspace_notification_settings (user_id, workspace_id, level) VALUES ($1, $3, 'none'),
		($2, $3, 'all')`, e.bob, e.admin, e.ws); err != nil {
		t.Fatal(err)
	}
	e.comment(e.alice, c.GetId(), &v1.CreateCanvasCommentRequest{Body: at(e.bob) + " " + at(e.admin)})
	if n := e.mentioned(); len(n) != 1 || n[e.admin] == nil {
		t.Fatalf("levels: %v", n)
	}
	// More than 10 distinct people: 422 (whoever they are).
	var many []string
	for range 11 {
		many = append(many, "@"+uuid.NewString())
	}
	e.must(422, e.alice, "POST", comments(c.GetId()), &v1.CreateCanvasCommentRequest{Body: strings.Join(many, " ")}, nil)
}

// Limits, the trash, a suspended workspace, the rate and the CASCADE of deleting forever.
func TestCanvasCommentLimits(t *testing.T) {
	e := newEnv(t, ysync.Config{})
	ctx := context.Background()
	c := e.create(e.alice, "", "Busy")
	e.must(422, e.alice, "POST", comments(c.GetId()), &v1.CreateCanvasCommentRequest{Body: "   "}, nil)
	e.must(422, e.alice, "POST", comments(c.GetId()), &v1.CreateCanvasCommentRequest{Body: strings.Repeat("я", 2001)}, nil)
	e.must(422, e.alice, "POST", comments(c.GetId()), &v1.CreateCanvasCommentRequest{Body: "bell \a"}, nil)
	e.must(422, e.alice, "POST", comments(c.GetId()), &v1.CreateCanvasCommentRequest{Body: "far", X: 2e7}, nil)
	e.must(422, e.alice, "POST", comments(c.GetId()), &v1.CreateCanvasCommentRequest{Body: "id", ObjectId: strings.Repeat("o", 65)}, nil)
	e.comment(e.alice, c.GetId(), &v1.CreateCanvasCommentRequest{Body: strings.Repeat("я", 2000) + "\n"})
	// 500 per canvas.
	if _, err := e.d.Pool.Exec(ctx, `INSERT INTO canvas_comments (canvas_id, author_id, body) SELECT $1, $2, 'filler' FROM generate_series(1, 499)`, c.GetId(), e.alice); err != nil {
		t.Fatal(err)
	}
	e.must(409, e.alice, "POST", comments(c.GetId()), &v1.CreateCanvasCommentRequest{Body: "one more"}, nil)
	// Paging: 50 roots a page by default, the cursor goes on.
	first := e.thread(e.alice, c.GetId(), "")
	if len(first.GetComments()) != 50 || first.GetNextCursor() == "" || first.GetOpenThreads() != 500 {
		t.Fatalf("page: %d %q %d", len(first.GetComments()), first.GetNextCursor(), first.GetOpenThreads())
	}
	second := e.thread(e.alice, c.GetId(), "?cursor="+first.GetNextCursor()+"&limit=100")
	if len(second.GetComments()) != 100 || second.GetComments()[0].GetId() <= first.GetComments()[49].GetId() {
		t.Fatal("cursor")
	}
	e.must(422, e.alice, "GET", comments(c.GetId())+"?limit=101", nil, nil)
	// The trash: comments are read, not written; deleting forever takes them along.
	d := e.create(e.alice, "", "Doomed")
	root := e.comment(e.alice, d.GetId(), &v1.CreateCanvasCommentRequest{Body: "bye"})
	e.must(200, e.alice, "POST", item(d.GetId())+"/trash", nil, nil)
	e.must(200, e.alice, "GET", comments(d.GetId()), nil, nil)
	e.must(409, e.alice, "POST", comments(d.GetId()), &v1.CreateCanvasCommentRequest{Body: "x"}, nil)
	e.must(409, e.alice, "PATCH", comment(root.GetId()), &v1.UpdateCanvasCommentRequest{Resolved: proto.Bool(true)}, nil)
	e.must(409, e.alice, "DELETE", comment(root.GetId()), nil, nil)
	e.must(204, e.alice, "DELETE", item(d.GetId()), nil, nil)
	var n int
	if err := e.d.Pool.QueryRow(ctx, `SELECT count(*) FROM canvas_comments WHERE canvas_id = $1`, d.GetId()).Scan(&n); err != nil || n != 0 {
		t.Fatalf("CASCADE: %d %v", n, err)
	}
	// A suspended workspace: read, no writes.
	s := e.create(e.alice, "", "Frozen")
	sr := e.comment(e.alice, s.GetId(), &v1.CreateCanvasCommentRequest{Body: "before"})
	if _, err := e.d.Pool.Exec(ctx, `UPDATE workspaces SET suspended_at = now() WHERE id = $1`, e.ws); err != nil {
		t.Fatal(err)
	}
	e.must(200, e.alice, "GET", comments(s.GetId()), nil, nil)
	e.must(403, e.alice, "POST", comments(s.GetId()), &v1.CreateCanvasCommentRequest{Body: "x"}, nil)
	e.must(403, e.alice, "PATCH", comment(sr.GetId()), &v1.UpdateCanvasCommentRequest{Body: proto.String("x")}, nil)
	e.must(403, e.alice, "DELETE", comment(sr.GetId()), nil, nil)
	if _, err := e.d.Pool.Exec(ctx, `UPDATE workspaces SET suspended_at = NULL WHERE id = $1`, e.ws); err != nil {
		t.Fatal(err)
	}
	// The per-user rate: writes past the budget get 429 (reads do not spend it).
	e.svc.CommentLimit = redisx.NewRateLimiter(e.rc, "rl:canvas-comment-test:"+uuid.NewString()+":", 2, 0.001)
	e.comment(e.bob, s.GetId(), &v1.CreateCanvasCommentRequest{Body: "1"})
	e.comment(e.bob, s.GetId(), &v1.CreateCanvasCommentRequest{Body: "2"})
	e.thread(e.bob, s.GetId(), "")
	e.must(429, e.bob, "POST", comments(s.GetId()), &v1.CreateCanvasCommentRequest{Body: "3"}, nil)
	e.comment(e.alice, s.GetId(), &v1.CreateCanvasCommentRequest{Body: "alice has her own"})
}

package canvas

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/canvasacl"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/messages"
	"github.com/calaba/calaba/server/internal/notifications"
	"github.com/calaba/calaba/server/internal/perm"
)

// Comments on a canvas (ADR-0115 wave 4): a server entity next to the Yjs document. A thread is
// a root with a pin and its replies (one level). Every route resolves the canvas first: without
// CANVAS_VIEW on it the answer is 404, for a comment too (its id says nothing). Reading takes
// CANVAS_VIEW; writing, replying and resolving CANVAS_WRITE; editing and deleting the author's
// own comment CANVAS_WRITE, anyone's the owner of the canvas or CANVAS_MANAGE
// (commentEditable). No writes on a canvas in the trash (409) or in a suspended workspace.
// Mentions are "@<user_id>" in the body; only members who see the canvas are kept
// (mentionable), the rest stay plain text, and each kept one gets CANVAS_COMMENT_MENTION once
// per comment (notified).

// Comment limits.
const (
	MaxCommentBody     = 2000 // characters (canvas_comments CHECK)
	MaxCommentMentions = 10   // distinct users per comment
	MaxCanvasComments  = 500  // comments (roots and replies) per canvas
	maxObjectID        = 64   // characters of a pin's object id
	maxPin             = 1e7  // |x|, |y| of a pin (canvas_comments CHECK)
	maxNotified        = 100  // canvas_comments.notified CHECK: later mentions are not notified
	commentPage        = 50
	maxCommentPage     = 100
	noticeText         = 200 // characters of the comment in CANVAS_COMMENT_MENTION
)

var (
	errNoComment  = httpx.NotFound("comment")
	errNotCanvas  = httpx.Conflict("only a canvas has comments")
	errNoWrite    = httpx.Forbidden("CANVAS_WRITE required")
	errNotEditor  = httpx.Forbidden("only the author, the owner of the canvas or CANVAS_MANAGE may change a comment")
	errTooMany    = httpx.Conflict("a canvas holds at most 500 comments")
	errNotARoot   = httpx.Validation("resolved", "only a thread (its first comment) is resolved")
	errPinInvalid = httpx.Validation("x", "the pin must be finite and within 10^7")
)

func commentProto(c sqlc.CanvasComment) *v1.CanvasComment {
	out := &v1.CanvasComment{
		Id: c.ID.String(), CanvasId: c.CanvasID.String(), X: c.X, Y: c.Y, AuthorId: idp(c.AuthorID),
		ParentId: idp(c.ParentID), Body: c.Body, Resolved: c.ResolvedAt != nil, ResolvedBy: idp(c.ResolvedBy),
		CreatedAt: timestamppb.New(c.CreatedAt), Mentions: make([]string, len(c.Mentions)),
	}
	if c.ObjectID != nil {
		out.ObjectId = *c.ObjectID
	}
	for i, u := range c.Mentions {
		out.Mentions[i] = u.String()
	}
	if c.EditedAt != nil {
		out.EditedAt = timestamppb.New(*c.EditedAt)
	}
	if c.ResolvedAt != nil {
		out.ResolvedAt = timestamppb.New(*c.ResolvedAt)
	}
	return out
}

// commentBody trims and checks a comment's text: 1..2000 characters, no control characters
// but line breaks and tabs.
func commentBody(s string) (string, error) {
	s = strings.TrimSpace(s)
	if n := utf8.RuneCountInString(s); n == 0 || n > MaxCommentBody {
		return "", httpx.Validation("body", "body must be 1..2000 characters")
	}
	if strings.ContainsFunc(s, func(r rune) bool { return (r < 0x20 && r != '\n' && r != '\t') || r == 0x7f }) {
		return "", httpx.Validation("body", "body must not contain control characters")
	}
	return s, nil
}

// bodyMentions are the distinct users a body @mentions (messages.ParseMentions: not in code);
// 422 above MaxCommentMentions. @everyone / @here are plain text on a canvas.
func bodyMentions(body string) ([]uuid.UUID, error) {
	ids, _ := messages.ParseMentions(body)
	if len(ids) > MaxCommentMentions {
		return nil, httpx.Validation("body", "a comment mentions at most 10 people")
	}
	return ids, nil
}

// pin checks the place of a new root.
func pin(req *v1.CreateCanvasCommentRequest) (*string, float64, float64, error) {
	x, y := req.GetX(), req.GetY()
	if !(x >= -maxPin && x <= maxPin && y >= -maxPin && y <= maxPin) { // NaN fails both
		return nil, 0, 0, errPinInvalid
	}
	o := req.GetObjectId()
	if o == "" {
		return nil, x, y, nil
	}
	if utf8.RuneCountInString(o) > maxObjectID || strings.ContainsFunc(o, func(r rune) bool { return r < 0x20 || r == 0x7f }) {
		return nil, 0, 0, httpx.Validation("objectId", "must be at most 64 characters, no control characters")
	}
	return &o, x, y, nil
}

// commentable checks that the caller may write comments on a: a canvas, live, CANVAS_WRITE, the
// workspace not suspended.
func commentable(ctx context.Context, q *sqlc.Queries, a access) error {
	if a.item.Kind != kindCanvas {
		return errNotCanvas
	}
	if err := writable(ctx, q, a.item.WorkspaceID); err != nil {
		return err
	}
	if a.item.TrashedAt != nil {
		return errTrashed
	}
	if !a.bits.Has(perm.CanvasWrite) {
		return errNoWrite
	}
	return nil
}

// changeable is commentable for a change of existing comments: the owner of the canvas or
// CANVAS_MANAGE without CANVAS_WRITE (an override to themselves) may still moderate.
func changeable(ctx context.Context, q *sqlc.Queries, a access) error {
	err := commentable(ctx, q, a)
	if errors.Is(err, errNoWrite) && a.structure() {
		return nil
	}
	return err
}

// commentEditable: the author with CANVAS_WRITE, or the owner of the canvas / CANVAS_MANAGE
// (perm.CanvasStructureAllowed).
func commentEditable(a access, c sqlc.CanvasComment) bool {
	if a.structure() {
		return true
	}
	return a.bits.Has(perm.CanvasWrite) && c.AuthorID != nil && *c.AuthorID == a.c.uid
}

// mentionable keeps the users of ids who see a canvas with this chain: members of ws (guests
// too, by the canvas's rules), not bots, not disabled. It reads through q (inside the write's
// transaction).
func mentionable(ctx context.Context, q *sqlc.Queries, ws uuid.UUID, chain []perm.TreeNode, ids []uuid.UUID) ([]uuid.UUID, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	users, err := q.ListUsersByIDs(ctx, ids)
	if err != nil {
		return nil, err
	}
	people := make(map[uuid.UUID]bool, len(users))
	for _, u := range users {
		people[u.ID] = !u.IsBot && u.DisabledAt == nil
	}
	live := make([]uuid.UUID, 0, len(ids))
	for _, u := range ids {
		if people[u] {
			live = append(live, u)
		}
	}
	// One query for all the people left (a mention-access call carries up to maxMentionAccess).
	rows, err := q.ListMembersAccess(ctx, sqlc.ListMembersAccessParams{WorkspaceID: ws, UserIds: live})
	if err != nil {
		return nil, err
	}
	members := make(map[uuid.UUID]sqlc.ListMembersAccessRow, len(rows))
	for _, row := range rows {
		members[row.UserID] = row
	}
	out := make([]uuid.UUID, 0, len(live))
	for _, u := range live {
		row, ok := members[u]
		if !ok {
			continue
		}
		m := perm.NewMember(u.String(), perm.Role(row.Role), perm.RoleList(row.RoleIds, row.RolePositions, row.RolePermissions))
		m.OwnerSeesPrivate = row.OwnerSeesPrivate
		if perm.ComputeCanvasItemIn(m, chain).Has(perm.CanvasView) {
			out = append(out, u)
		}
	}
	return out, nil
}

// notifiedAfter adds the mentions (but the author) to the comment's notified set and returns the
// set and who is new in it — the ones to notify. Past maxNotified nobody more is.
func notifiedAfter(was, mentions []uuid.UUID, author uuid.UUID) (all, fresh []uuid.UUID) {
	all = slices.Clone(was)
	for _, u := range mentions {
		if u == author || slices.Contains(all, u) || len(all) >= maxNotified {
			continue
		}
		all = append(all, u)
		fresh = append(fresh, u)
	}
	if all == nil {
		all = []uuid.UUID{}
	}
	return all, fresh
}

// takeComment spends the caller's comment budget (nil limiter = unlimited).
func (s *Service) takeComment(ctx context.Context, user uuid.UUID) error {
	if s.CommentLimit == nil {
		return nil
	}
	return s.CommentLimit.Take(ctx, user.String())
}

// listComments: GET /api/canvas/items/{id}/comments?cursor=&open=1&limit= (CANVAS_VIEW) — a page
// of threads, the oldest first, each root followed by its replies.
func (s *Service) listComments(w http.ResponseWriter, r *http.Request) error {
	a, err := s.pathItem(r)
	if err != nil {
		return err
	}
	if a.item.Kind != kindCanvas {
		return errNotCanvas
	}
	qs := r.URL.Query()
	cur, err := optUUID(qs.Get("cursor"), "cursor")
	if err != nil {
		return err
	}
	limit, err := pageLimit(r, commentPage, maxCommentPage)
	if err != nil {
		return err
	}
	open := qs.Get("open") == "1" || qs.Get("open") == "true"
	ctx, q := r.Context(), s.db.Q
	roots, err := q.ListCanvasThreads(ctx, sqlc.ListCanvasThreadsParams{CanvasID: a.item.ID, Cursor: cur, OpenOnly: open, Lim: int32(limit + 1)}) //nolint:gosec // ≤ 101
	if err != nil {
		return err
	}
	out := &v1.ListCanvasCommentsResponse{}
	if len(roots) > limit {
		roots = roots[:limit]
		out.NextCursor = roots[limit-1].ID.String()
	}
	ids := make([]uuid.UUID, len(roots))
	for i, c := range roots {
		ids[i] = c.ID
	}
	replies, err := q.ListCanvasReplies(ctx, ids)
	if err != nil {
		return err
	}
	byRoot := map[uuid.UUID][]sqlc.CanvasComment{}
	for _, c := range replies {
		byRoot[*c.ParentID] = append(byRoot[*c.ParentID], c)
	}
	out.Comments = make([]*v1.CanvasComment, 0, len(roots)+len(replies))
	for _, root := range roots {
		out.Comments = append(out.Comments, commentProto(root))
		for _, c := range byRoot[root.ID] {
			out.Comments = append(out.Comments, commentProto(c))
		}
	}
	n, err := q.CountOpenCanvasThreads(ctx, a.item.ID)
	if err != nil {
		return err
	}
	out.OpenThreads = uint32(max(n, 0)) //nolint:gosec // a count
	w.Header().Set("Cache-Control", "no-store")
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// createComment: POST /api/canvas/items/{id}/comments — a root with its pin or a reply (a reply
// to a reply goes to the root).
func (s *Service) createComment(w http.ResponseWriter, r *http.Request) error {
	id, err := httpx.PathUUID(r, "id", "item")
	if err != nil {
		return err
	}
	var req v1.CreateCanvasCommentRequest
	if err := httpx.DecodeStrict(w, r, &req); err != nil {
		return err
	}
	body, err := commentBody(req.GetBody())
	if err != nil {
		return err
	}
	wanted, err := bodyMentions(body)
	if err != nil {
		return err
	}
	parent, err := optUUID(req.GetParentId(), "parentId")
	if err != nil {
		return err
	}
	var object *string
	var x, y float64
	if parent == nil {
		if object, x, y, err = pin(&req); err != nil {
			return err
		}
	}
	ctx := r.Context()
	a, err := resolve(r, s.db.Q, id) // 404 / 403 before the budget is spent
	if err != nil {
		return err
	}
	if err := commentable(ctx, s.db.Q, a); err != nil {
		return err
	}
	if err := s.takeComment(ctx, a.c.uid); err != nil {
		return err
	}
	var c, root sqlc.CanvasComment
	var fresh []uuid.UUID
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if a, err = resolve(r, q, id); err != nil {
			return err
		}
		if err := commentable(ctx, q, a); err != nil {
			return err
		}
		if err := q.LockCanvasComments(ctx, id); err != nil {
			return err
		}
		n, err := q.CountCanvasComments(ctx, id)
		if err != nil {
			return err
		}
		if n >= MaxCanvasComments {
			return errTooMany
		}
		if parent != nil {
			p, err := q.GetCanvasComment(ctx, *parent)
			if db.IsNotFound(err) || (err == nil && p.CanvasID != id) {
				return errNoComment
			}
			if err != nil {
				return err
			}
			if p.ParentID != nil { // one level: a reply to a reply belongs to the root
				if p, err = q.GetCanvasComment(ctx, *p.ParentID); err != nil {
					return err
				}
			}
			root = p
			parent = &p.ID
		}
		mentions, err := mentionable(ctx, q, a.item.WorkspaceID, a.nodes(), wanted)
		if err != nil {
			return err
		}
		var notified []uuid.UUID
		notified, fresh = notifiedAfter(nil, mentions, a.c.uid)
		if mentions == nil {
			mentions = []uuid.UUID{}
		}
		c, err = q.InsertCanvasComment(ctx, sqlc.InsertCanvasCommentParams{CanvasID: id, ParentID: parent, ObjectID: object, X: x, Y: y,
			AuthorID: &a.c.uid, Body: body, Mentions: mentions, Notified: notified})
		if err != nil {
			return err
		}
		if parent == nil {
			root = c
		}
		return s.journal(ctx, q, a.item, &a.c.uid, "comment", nil, snap{"comment_id": c.ID.String(), "thread_id": root.ID.String()})
	})
	if err != nil {
		return err
	}
	s.publishComment(ctx, a, c)
	s.notifyMentions(ctx, a, c, root, fresh)
	httpx.Write(w, http.StatusCreated, &v1.CanvasCommentResponse{Comment: commentProto(c)})
	return nil
}

// pathComment loads {id} as a comment of a canvas the caller sees, through q: 404 for an unknown
// comment and for one on a canvas the caller does not see.
func pathComment(r *http.Request, q *sqlc.Queries, lock bool) (sqlc.CanvasComment, access, error) {
	id, err := httpx.PathUUID(r, "id", "comment")
	if err != nil {
		return sqlc.CanvasComment{}, access{}, err
	}
	get := q.GetCanvasComment
	if lock {
		get = q.GetCanvasCommentForUpdate
	}
	c, err := get(r.Context(), id)
	if db.IsNotFound(err) {
		return c, access{}, errNoComment
	}
	if err != nil {
		return c, access{}, err
	}
	a, err := resolve(r, q, c.CanvasID)
	if errors.Is(err, errNoItem) {
		return c, access{}, errNoComment
	}
	return c, a, err
}

// updateComment: PATCH /api/canvas/comments/{id} — body (the author, the owner of the canvas or
// CANVAS_MANAGE; new mentions are notified) and resolved (a root, CANVAS_WRITE).
func (s *Service) updateComment(w http.ResponseWriter, r *http.Request) error {
	var req v1.UpdateCanvasCommentRequest
	if err := httpx.DecodeStrict(w, r, &req); err != nil {
		return err
	}
	var body string
	var wanted []uuid.UUID
	if req.Body != nil {
		var err error
		if body, err = commentBody(req.GetBody()); err != nil {
			return err
		}
		if wanted, err = bodyMentions(body); err != nil {
			return err
		}
	}
	ctx := r.Context()
	c, a, err := pathComment(r, s.db.Q, false)
	if err != nil {
		return err
	}
	if err := changeable(ctx, s.db.Q, a); err != nil {
		return err
	}
	if req.Body != nil {
		if !commentEditable(a, c) {
			return errNotEditor
		}
		if err := s.takeComment(ctx, a.c.uid); err != nil {
			return err
		}
	}
	var root sqlc.CanvasComment
	var fresh []uuid.UUID
	changed, resolved := false, false
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if c, a, err = pathComment(r, q, true); err != nil {
			return err
		}
		if err := changeable(ctx, q, a); err != nil {
			return err
		}
		if req.Body != nil && body != c.Body {
			if !commentEditable(a, c) {
				return errNotEditor
			}
			mentions, err := mentionable(ctx, q, a.item.WorkspaceID, a.nodes(), wanted)
			if err != nil {
				return err
			}
			if mentions == nil {
				mentions = []uuid.UUID{}
			}
			var notified []uuid.UUID
			notified, fresh = notifiedAfter(c.Notified, mentions, a.c.uid)
			if c, err = q.UpdateCanvasCommentBody(ctx, sqlc.UpdateCanvasCommentBodyParams{ID: c.ID, Body: body, Mentions: mentions, Notified: notified}); err != nil {
				return err
			}
			changed = true
		}
		if req.Resolved != nil && req.GetResolved() != (c.ResolvedAt != nil) {
			if c.ParentID != nil {
				return errNotARoot
			}
			if !a.bits.Has(perm.CanvasWrite) && !a.structure() {
				return errNoWrite
			}
			if c, err = q.ResolveCanvasThread(ctx, sqlc.ResolveCanvasThreadParams{ID: c.ID, Resolved: req.GetResolved(), ResolvedBy: &a.c.uid}); err != nil {
				return err
			}
			changed, resolved = true, req.GetResolved()
			if resolved {
				if err := s.journal(ctx, q, a.item, &a.c.uid, "resolve", nil, snap{"thread_id": c.ID.String()}); err != nil {
					return err
				}
			}
		}
		if len(fresh) > 0 {
			root = c
			if c.ParentID != nil {
				if root, err = q.GetCanvasComment(ctx, *c.ParentID); err != nil {
					return err
				}
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	if changed {
		s.publishComment(ctx, a, c)
	}
	s.notifyMentions(ctx, a, c, root, fresh)
	httpx.Write(w, http.StatusOK, &v1.CanvasCommentResponse{Comment: commentProto(c)})
	return nil
}

// deleteComment: DELETE /api/canvas/comments/{id} — the author, the owner of the canvas or
// CANVAS_MANAGE; a root takes its thread along.
func (s *Service) deleteComment(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	var c sqlc.CanvasComment
	var a access
	err := s.db.Tx(ctx, func(q *sqlc.Queries) error {
		var err error
		if c, a, err = pathComment(r, q, true); err != nil {
			return err
		}
		if err := changeable(ctx, q, a); err != nil {
			return err
		}
		if !commentEditable(a, c) {
			return errNotEditor
		}
		n, err := q.DeleteCanvasComment(ctx, c.ID)
		if err != nil {
			return err
		}
		if n == 0 {
			return errNoComment
		}
		return nil
	})
	if err != nil {
		return err
	}
	s.publish(ctx, a.item.WorkspaceID, []*v1.DispatchEvent{{Event: &v1.DispatchEvent_CanvasCommentDelete{CanvasCommentDelete: &v1.CanvasCommentDelete{
		WorkspaceId: a.item.WorkspaceID.String(), CanvasId: a.item.ID.String(), CommentId: c.ID.String(), Access: canvasacl.Levels(a.nodes()),
	}}}})
	httpx.NoContent(w)
	return nil
}

// mentionAccess: GET /api/canvas/items/{id}/comments/mention-access?user_ids=a,b (CANVAS_VIEW) —
// which of the given members (≤ 200) see the canvas: the @ list of the comment input. The same
// rule the writes apply (mentionable).
func (s *Service) mentionAccess(w http.ResponseWriter, r *http.Request) error {
	a, err := s.pathItem(r)
	if err != nil {
		return err
	}
	var ids []uuid.UUID
	for _, p := range strings.Split(r.URL.Query().Get("user_ids"), ",") {
		if p = strings.TrimSpace(p); p == "" {
			continue
		}
		u, err := uuid.Parse(p)
		if err != nil {
			return httpx.Validation("userIds", "invalid user id")
		}
		if !slices.Contains(ids, u) {
			ids = append(ids, u)
		}
	}
	if len(ids) > maxMentionAccess {
		return httpx.Validation("userIds", "too many ids")
	}
	see, err := mentionable(r.Context(), s.db.Q, a.item.WorkspaceID, a.nodes(), ids)
	if err != nil {
		return err
	}
	out := &v1.CanvasMentionAccessResponse{SeeIds: make([]string, len(see))}
	for i, u := range see {
		out.SeeIds[i] = u.String()
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// maxMentionAccess bounds one mention-access query.
const maxMentionAccess = 200

// publishComment sends CANVAS_COMMENT_UPSERT with the canvas's chain (the gateway delivers it to
// members with CANVAS_VIEW only).
func (s *Service) publishComment(ctx context.Context, a access, c sqlc.CanvasComment) {
	s.publish(ctx, a.item.WorkspaceID, []*v1.DispatchEvent{{Event: &v1.DispatchEvent_CanvasCommentUpsert{CanvasCommentUpsert: &v1.CanvasCommentUpsert{
		WorkspaceId: a.item.WorkspaceID.String(), Comment: commentProto(c), Access: canvasacl.Levels(a.nodes()),
	}}}})
}

// notifyMentions sends CANVAS_COMMENT_MENTION to the freshly mentioned users of comment c
// (thread root) by their workspace level and mute (notifications.CanvasMentionNotifies); the
// text only where notifications.CanvasMentionText allows it. Best effort, after the commit.
func (s *Service) notifyMentions(ctx context.Context, a access, c, root sqlc.CanvasComment, users []uuid.UUID) {
	if len(users) == 0 {
		return
	}
	facts, err := s.db.Q.CanvasMentionFacts(ctx, sqlc.CanvasMentionFactsParams{UserIds: users, WorkspaceID: a.item.WorkspaceID})
	if err != nil {
		slog.WarnContext(ctx, "canvas: mention facts", "comment_id", c.ID, "err", err)
		return
	}
	private := perm.RestrictedIn(a.nodes())
	for _, f := range facts {
		cf := notifications.CanvasFacts{Level: notifications.LevelFromDB(f.Level, v1.NotificationLevel_NOTIFICATION_LEVEL_MENTIONS),
			Muted: f.Muted, HideText: f.HideMessageTextInNotifications, Private: private}
		if !notifications.CanvasMentionNotifies(cf) {
			continue
		}
		n := &v1.CanvasCommentMention{WorkspaceId: a.item.WorkspaceID.String(), CanvasId: a.item.ID.String(), CanvasName: a.item.Name,
			CommentId: c.ID.String(), ThreadId: root.ID.String(), ActorId: a.c.uid.String(), X: root.X, Y: root.Y}
		if root.ObjectID != nil {
			n.ObjectId = *root.ObjectID
		}
		if notifications.CanvasMentionText(cf) {
			n.Text = clip(c.Body, noticeText)
		}
		s.ev.User(ctx, f.UserID, &v1.DispatchEvent{Event: &v1.DispatchEvent_CanvasCommentMention{CanvasCommentMention: n}})
	}
}

package calendar

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
)

// Comments on a meeting (ADR-0104): a plain list per event (the series as a whole). Whoever
// sees the event (viewer.sees) reads and writes; the author edits; the author or an editor of
// the event (viewer.canEdit) deletes. Guests get 403 (the calendar is closed to them), bots
// like people (ADR-0109; the gateway does not send them comment events). EVENT_COMMENT_* go to the event's audience (the gateway's
// routeEventComment, as EVENT_UPDATE).

// Comment limits.
const (
	MaxCommentBody  = 4000 // characters, as a task comment (ADR-0042)
	commentPage     = 50
	maxCommentPage  = 100
	errCommentWhat  = "comment"
	errEventWhat    = "event"
	commentBodyName = "body"
)

func commentProto(c sqlc.EventComment) *v1.CalendarEventComment {
	out := &v1.CalendarEventComment{
		Id: c.ID.String(), EventId: c.EventID.String(), AuthorId: c.AuthorID.String(), Body: c.Body,
		CreatedAt: timestamppb.New(c.CreatedAt),
	}
	if c.EditedAt != nil {
		out.EditedAt = timestamppb.New(*c.EditedAt)
	}
	return out
}

// commentBody trims and checks a comment's text.
func commentBody(s string) (string, error) {
	s = strings.TrimSpace(s)
	if n := utf8.RuneCountInString(s); n == 0 || n > MaxCommentBody {
		return "", httpx.Validation(commentBodyName, "body must be 1..4000 characters")
	}
	return s, nil
}

// commentEvent resolves the event of a comment route for its viewer: 404 when hidden, 403 for
// a guest (even one who sees the meeting's room: comments are part of the calendar).
func (s *Service) commentEvent(r *http.Request) (*bundle, *viewer, error) {
	b, v, err := s.event(r, s.db.Q)
	if errors.Is(err, errGuest) {
		return nil, nil, errGuest
	}
	return b, v, err
}

// listComments: GET /api/events/{id}/comments?before=&limit= — oldest first.
func (s *Service) listComments(w http.ResponseWriter, r *http.Request) error {
	b, _, err := s.commentEvent(r)
	if err != nil {
		return err
	}
	lim := commentPage
	if l := r.URL.Query().Get("limit"); l != "" {
		n, err := strconv.Atoi(l)
		if err != nil || n < 1 || n > maxCommentPage {
			return httpx.Validation("limit", "limit must be 1..100")
		}
		lim = n
	}
	var before *uuid.UUID
	if bs := r.URL.Query().Get("before"); bs != "" {
		id, err := uuid.Parse(bs)
		if err != nil {
			return httpx.Validation("before", "before must be a comment id")
		}
		before = &id
	}
	rows, err := s.db.Q.ListEventComments(r.Context(), sqlc.ListEventCommentsParams{EventID: b.ev.ID, Before: before, Lim: int32(lim + 1)}) //nolint:gosec // ≤ 101
	if err != nil {
		return err
	}
	out := &v1.ListCalendarEventCommentsResponse{HasMore: len(rows) > lim}
	rows = rows[:min(len(rows), lim)]
	slices.Reverse(rows)
	out.Comments = make([]*v1.CalendarEventComment, len(rows))
	for i, c := range rows {
		out.Comments[i] = commentProto(c)
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// takeComment spends the caller's comment budget (nil limiter = unlimited).
func (s *Service) takeComment(ctx context.Context, user uuid.UUID) error {
	if s.CommentLimit == nil {
		return nil
	}
	return s.CommentLimit.Take(ctx, user.String())
}

// createComment: POST /api/events/{id}/comments.
func (s *Service) createComment(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	me := auth.MustFromContext(ctx).UserID
	b, _, err := s.commentEvent(r)
	if err != nil {
		return err
	}
	if b.ev.CancelledAt != nil {
		return httpx.NotFound(errEventWhat)
	}
	var req v1.CalendarEventCommentRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	body, err := commentBody(req.GetBody())
	if err != nil {
		return err
	}
	if err := s.takeComment(ctx, me); err != nil {
		return err
	}
	var c sqlc.EventComment
	var n int32
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if c, err = q.InsertEventComment(ctx, sqlc.InsertEventCommentParams{EventID: b.ev.ID, AuthorID: me, Body: body}); err != nil {
			return err
		}
		n, err = commentCount(ctx, q, b.ev.ID)
		return err
	})
	if err != nil {
		return err
	}
	s.publishComment(ctx, b, c, nil, n)
	httpx.Write(w, http.StatusCreated, &v1.CalendarEventCommentResponse{Comment: commentProto(c)})
	return nil
}

// comment loads the {comment_id} of the event.
func comment(r *http.Request, q *sqlc.Queries, b *bundle) (sqlc.EventComment, error) {
	id, err := httpx.PathUUID(r, "comment_id", errCommentWhat)
	if err != nil {
		return sqlc.EventComment{}, err
	}
	c, err := q.GetEventComment(r.Context(), sqlc.GetEventCommentParams{ID: id, EventID: b.ev.ID})
	if db.IsNotFound(err) {
		return c, httpx.NotFound(errCommentWhat)
	}
	return c, err
}

// updateComment: PATCH /api/events/{id}/comments/{comment_id} — the author only.
func (s *Service) updateComment(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	me := auth.MustFromContext(ctx).UserID
	b, _, err := s.commentEvent(r)
	if err != nil {
		return err
	}
	if b.ev.CancelledAt != nil {
		return httpx.NotFound(errEventWhat)
	}
	c, err := comment(r, s.db.Q, b)
	if err != nil {
		return err
	}
	if c.AuthorID != me {
		return httpx.Forbidden("only the author edits a comment")
	}
	var req v1.CalendarEventCommentRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	body, err := commentBody(req.GetBody())
	if err != nil {
		return err
	}
	if body == c.Body {
		httpx.Write(w, http.StatusOK, &v1.CalendarEventCommentResponse{Comment: commentProto(c)})
		return nil
	}
	if err := s.takeComment(ctx, me); err != nil {
		return err
	}
	var n int32
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if c, err = q.UpdateEventComment(ctx, sqlc.UpdateEventCommentParams{ID: c.ID, EventID: b.ev.ID, Body: body}); err != nil {
			if db.IsNotFound(err) {
				return httpx.NotFound(errCommentWhat)
			}
			return err
		}
		n, err = commentCount(ctx, q, b.ev.ID)
		return err
	})
	if err != nil {
		return err
	}
	s.publishComment(ctx, b, c, nil, n)
	httpx.Write(w, http.StatusOK, &v1.CalendarEventCommentResponse{Comment: commentProto(c)})
	return nil
}

// deleteComment: DELETE /api/events/{id}/comments/{comment_id} — the author, or whoever may
// edit the event (the organizer, MANAGE_ROOM / MANAGE_EVENTS). A cancelled event's comments
// stay deletable.
func (s *Service) deleteComment(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	me := auth.MustFromContext(ctx).UserID
	b, v, err := s.commentEvent(r)
	if err != nil {
		return err
	}
	c, err := comment(r, s.db.Q, b)
	if err != nil {
		return err
	}
	if c.AuthorID != me && !v.canEdit(b) {
		return httpx.Forbidden("only the author or the organizer deletes a comment")
	}
	var n int32
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		rows, err := q.DeleteEventComment(ctx, sqlc.DeleteEventCommentParams{ID: c.ID, EventID: b.ev.ID})
		if err != nil {
			return err
		}
		if rows == 0 {
			return httpx.NotFound(errCommentWhat)
		}
		n, err = commentCount(ctx, q, b.ev.ID)
		return err
	})
	if err != nil {
		return err
	}
	s.publishComment(ctx, b, sqlc.EventComment{}, &c.ID, n)
	httpx.NoContent(w)
	return nil
}

func commentCount(ctx context.Context, q *sqlc.Queries, event uuid.UUID) (int32, error) {
	rows, err := q.CountEventComments(ctx, []uuid.UUID{event})
	if err != nil || len(rows) == 0 {
		return 0, err
	}
	return rows[0].N, nil
}

// publishComment sends EVENT_COMMENT_UPSERT (deleted nil) or EVENT_COMMENT_DELETE with the
// routing the gateway needs to find the event's audience.
func (s *Service) publishComment(ctx context.Context, b *bundle, c sqlc.EventComment, deleted *uuid.UUID, n int32) {
	room := ""
	if b.ev.RoomID != nil {
		room = b.ev.RoomID.String()
	}
	var attendees []string
	for _, a := range b.att {
		if a.UserID != nil {
			attendees = append(attendees, a.UserID.String())
		}
	}
	ws, ev := b.ev.WorkspaceID.String(), b.ev.ID.String()
	count := uint32(max(n, 0)) //nolint:gosec // non-negative count
	if deleted != nil {
		s.ev.Workspace(ctx, b.ev.WorkspaceID, &v1.DispatchEvent{Event: &v1.DispatchEvent_EventCommentDelete{EventCommentDelete: &v1.CalendarEventCommentDelete{
			WorkspaceId: ws, EventId: ev, CommentId: deleted.String(), Comments: count,
			RoomId: room, OrganizerId: b.ev.OrganizerID.String(), AttendeeIds: attendees,
		}}})
		return
	}
	s.ev.Workspace(ctx, b.ev.WorkspaceID, &v1.DispatchEvent{Event: &v1.DispatchEvent_EventCommentUpsert{EventCommentUpsert: &v1.CalendarEventCommentUpsert{
		WorkspaceId: ws, EventId: ev, Comment: commentProto(c), Comments: count,
		RoomId: room, OrganizerId: b.ev.OrganizerID.String(), AttendeeIds: attendees,
	}}})
}

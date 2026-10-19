package calendar

import (
	"context"
	"log/slog"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/perm"
)

// A meeting's own temporary room (ADR-0112): events.temp_room asks for it; the server creates
// it TempRoomLead before the start (at once when the meeting is closer) on behalf of the
// organizer, the room ends TempRoomAfter after the meeting and follows it when it moves; a
// meeting cancelled before that gets nothing, after that its room is archived.

const (
	// TempRoomLead is how long before the start a meeting's own room is created.
	TempRoomLead = time.Hour
	// TempRoomAfter is how long the room outlives the meeting's end (as its guest links).
	TempRoomAfter = guestLinkAfter
	// tempRoomBatch bounds the rooms one sweep pass creates.
	tempRoomBatch = 50
	// tempRoomRetry is how long a request the sweep could not serve (rights, limits) waits for
	// the next try: failing requests neither cost a transaction on every pass nor fill the
	// batch ahead of the others (claims go by start).
	tempRoomRetry = 5 * time.Minute
)

// TempRooms is what a meeting's own room needs from rooms (rooms.Handlers implements it; an
// interface because rooms is imported here for its helpers, not its handlers).
type TempRooms interface {
	// CreateMeetingRoom creates the private room in q on behalf of creator (whose rights it
	// checks now) for creator and people, and returns it with what to publish after the commit.
	CreateMeetingRoom(ctx context.Context, q *sqlc.Queries, wsID, creator uuid.UUID, people []uuid.UUID, title string, end time.Time) (uuid.UUID, func(context.Context), error)
	// SyncMeetingRoom gives the people added to the meeting access to the room and takes it
	// from the people removed (nothing when it is no longer creator's live private
	// temporary room).
	SyncMeetingRoom(ctx context.Context, q *sqlc.Queries, roomID, creator uuid.UUID, add, remove []uuid.UUID) (func(context.Context), error)
	// MoveMeetingRoom moves the room's end in q (nothing when it is no longer creator's
	// live temporary room).
	MoveMeetingRoom(ctx context.Context, q *sqlc.Queries, roomID, creator uuid.UUID, end time.Time) (func(context.Context), error)
	// CloseMeetingRoom archives the room (nothing when it is no longer creator's live
	// temporary room).
	CloseMeetingRoom(ctx context.Context, roomID, creator uuid.UUID) error
}

var errTempOneOff = httpx.Validation("tempRoom", "a meeting's own temporary room is for one-off meetings only")

// checkTempRequest: who may ask for a meeting's own room — the organizer themself (the room is
// made in their name), a person (bots make no meetings with rooms of their own, ADR-0031) with
// CREATE_TEMP_ROOMS; a one-off meeting without another room.
func (s *Service) checkTempRequest(v *viewer, organizer uuid.UUID, f fields) error {
	switch {
	case s.TempRooms == nil:
		return httpx.Validation("tempRoom", "temporary rooms are not available")
	case v.bot:
		return auth.ErrBotNotAllowed
	case v.user != organizer:
		return httpx.Forbidden("only the organizer asks for the meeting's own temporary room")
	case !v.ws.Has(perm.CreateTempRooms):
		return httpx.Forbidden("CREATE_TEMP_ROOMS required")
	case f.room != nil:
		return httpx.Validation("roomId", "a meeting has either a room or its own temporary room")
	case f.rule.Repeat != v1.EventRepeat_EVENT_REPEAT_UNSPECIFIED:
		return errTempOneOff
	}
	return nil
}

// tempRoomDue: ev waits for its own room and the room is due at now.
func tempRoomDue(ev sqlc.Event, now time.Time) bool {
	return ev.TempRoom && ev.RoomID == nil && ev.CancelledAt == nil &&
		!ev.StartsAt.After(now.Add(TempRoomLead)) && ev.EndsAt.After(now)
}

// ownRoom reports whether ev's room is its own temporary room (made already).
func ownRoom(ev sqlc.Event) bool { return ev.TempRoom && ev.RoomID != nil }

// attachTempRoom creates ev's own room inside q and sets room_id (no new SEQUENCE, no mail:
// the attendees see the room in the app, outside attendees on their meeting page). onBehalf: no
// request of the organizer carries it (the sweep, another editor's change) — the workspace
// identity policy must let the organizer act now (ADR-0054; fails closed).
func (s *Service) attachTempRoom(ctx context.Context, q *sqlc.Queries, ev sqlc.Event, onBehalf bool) (sqlc.Event, func(context.Context), error) {
	if s.TempRooms == nil {
		return ev, nil, httpx.Validation("tempRoom", "temporary rooms are not available")
	}
	if onBehalf {
		ok, err := s.mayDeliver(ctx, ev.OrganizerID, ev.WorkspaceID)
		if err != nil {
			return ev, nil, err
		}
		if !ok {
			return ev, nil, httpx.Forbidden("the workspace identity policy does not let the organizer act now")
		}
	}
	// The room is private to the meeting's people (ADR-0112): the meeting is seen by nobody new.
	att, err := q.ListEventAttendees(ctx, []uuid.UUID{ev.ID})
	if err != nil {
		return ev, nil, err
	}
	var people []uuid.UUID
	for _, a := range att {
		if a.UserID != nil {
			people = append(people, *a.UserID)
		}
	}
	roomID, publish, err := s.TempRooms.CreateMeetingRoom(ctx, q, ev.WorkspaceID, ev.OrganizerID, people, ev.Title, ev.EndsAt.Add(TempRoomAfter))
	if err != nil {
		return ev, nil, err
	}
	after, err := q.SetEventTempRoom(ctx, sqlc.SetEventTempRoomParams{ID: ev.ID, RoomID: &roomID})
	if err != nil {
		return ev, nil, err
	}
	return after, publish, nil
}

// MakeTempRooms creates the meetings' own rooms due at now and returns how many. Every
// instance runs it: each meeting is claimed with FOR UPDATE SKIP LOCKED in the transaction
// that creates its room. A meeting whose room cannot be made now (the organizer lost the right,
// the limits) is retried after tempRoomRetry until the meeting ends.
func (s *Service) MakeTempRooms(ctx context.Context, now time.Time) (int, error) {
	if s.TempRooms == nil {
		return 0, nil
	}
	ctx = events.WithBudget(ctx, events.RequestBudget)
	skip := []uuid.UUID{}
	n := 0
	for range tempRoomBatch {
		var (
			claimed       *uuid.UUID
			before, after *bundle
			publish       func(context.Context)
		)
		err := s.db.Tx(ctx, func(q *sqlc.Queries) error {
			ev, err := q.ClaimEventTempRoom(ctx, sqlc.ClaimEventTempRoomParams{Due: now.Add(TempRoomLead), Now: now, Skip: skip})
			if db.IsNotFound(err) {
				return nil
			}
			if err != nil {
				return err
			}
			claimed = &ev.ID
			if before, err = loadOne(ctx, q, ev); err != nil {
				return err
			}
			made, pub, err := s.attachTempRoom(ctx, q, ev, true)
			if err != nil {
				return err
			}
			publish = pub
			if after, err = loadOne(ctx, q, made); err != nil {
				return err
			}
			if err := s.syncLinks(ctx, q, after, true, false); err != nil {
				return err
			}
			after, err = loadOne(ctx, q, made)
			return err
		})
		if claimed == nil {
			return n, err
		}
		if err != nil {
			skip = append(skip, *claimed)
			if ctx.Err() == nil {
				at := now.Add(tempRoomRetry)
				logErr(ctx, "defer the meeting's temporary room", s.db.Q.DeferEventTempRoom(ctx, sqlc.DeferEventTempRoomParams{ID: *claimed, At: &at}))
			}
			level := slog.LevelWarn
			if e := httpx.AsError(err); e != nil && e.Status < 500 {
				level = slog.LevelDebug // no right / limits: retried after tempRoomRetry
			}
			slog.Log(ctx, level, "calendar: meeting's temporary room", "event", *claimed, "err", err)
			continue
		}
		publish(ctx)
		s.ev.Workspace(ctx, after.ev.WorkspaceID, &v1.DispatchEvent{Event: &v1.DispatchEvent_EventUpdate{EventUpdate: &v1.CalendarEventUpdate{Event: after.proto(nil, nil)}}})
		s.roomSignals(ctx, before, after)
		s.changed(ctx, before, after)
		n++
	}
	return n, nil
}

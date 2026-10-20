package rooms

import (
	"context"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/moderation"
	"github.com/calaba/calaba/server/internal/perm"
)

// A meeting's own temporary room (ADR-0112): the calendar asks for it 1 h before the start —
// from the meeting sweep or a request that moved the meeting close — on behalf of the
// organizer. calendar.TempRooms; the same insertTemp as POST …/rooms/temp.

// meetingRoomName is the room's name made of the meeting title (rooms take ≤ 100 characters).
func meetingRoomName(title string) string {
	s := strings.TrimSpace(title)
	if utf8.RuneCountInString(s) > 100 {
		s = strings.TrimSpace(string([]rune(s)[:100]))
	}
	if s == "" {
		s = "Встреча"
	}
	return s
}

// meetingRoomEnd bounds the end of a meeting's room to the lifetime a temporary room may have
// from now (ADR-0044: 15 minutes .. TempLimits.MaxTTL).
func meetingRoomEnd(end, now time.Time, maxTTL time.Duration) time.Time {
	end = end.Truncate(time.Second)
	if lo := now.Add(MinTempTTL); end.Before(lo) {
		end = lo.Truncate(time.Second)
	}
	if hi := now.Add(maxTTL); end.After(hi) {
		end = hi.Truncate(time.Second)
	}
	return end
}

// CreateMeetingRoom creates the temporary room of a meeting inside the caller's transaction q,
// as POST …/rooms/temp would for creator: private, for the creator and people (the meeting's
// attendees that are members, not guests; others are left out, not refused) so the meeting is
// seen by nobody new; the link admits guests when the creator may invite them (else members
// only). The creator's rights are read
// now from the database, not taken from the time the meeting was saved: a workspace member,
// not a guest or a bot, CREATE_TEMP_ROOMS (the plan's restricted mode takes it), the workspace
// not suspended, and the temporary room limits. publish announces the room after the commit.
func (h *Handlers) CreateMeetingRoom(ctx context.Context, q *sqlc.Queries, wsID, creator uuid.UUID, people []uuid.UUID, title string, end time.Time) (uuid.UUID, func(context.Context), error) {
	m, ok, err := perm.LoadMember(ctx, q, wsID, creator)
	if err != nil {
		return uuid.Nil, nil, err
	}
	if !ok || m.Role == perm.RoleGuest {
		return uuid.Nil, nil, httpx.Forbidden("the organizer is no member of the workspace")
	}
	u, err := q.GetUser(ctx, creator)
	if err != nil {
		return uuid.Nil, nil, err
	}
	if u.IsBot {
		return uuid.Nil, nil, auth.ErrBotNotAllowed
	}
	if err := moderation.CheckSuspended(ctx, q, wsID); err != nil {
		return uuid.Nil, nil, err
	}
	bits := m.Workspace()
	lapsed, err := h.plans.Lapsed(ctx, wsID)
	if err != nil {
		return uuid.Nil, nil, err
	}
	if lapsed {
		bits = perm.PlanInactive(bits)
	}
	if !bits.Has(perm.CreateTempRooms) {
		return uuid.Nil, nil, httpx.Forbidden("CREATE_TEMP_ROOMS required")
	}
	// A guest link needs INVITE_GUESTS and a verified email (ADR-0023, ADR-0065); else the
	// link is for members only, as with guests=false.
	guests := bits.Has(perm.InviteGuests) && h.EmailGate.Allow(u) == nil
	if people, err = meetingPeople(ctx, q, wsID, creator, people); err != nil {
		return uuid.Nil, nil, err
	}
	userCap, err := h.userCap(ctx, wsID)
	if err != nil {
		return uuid.Nil, nil, err
	}
	made, err := insertTemp(ctx, q, tempSpec{
		wsID: wsID, creator: creator, name: meetingRoomName(title), expires: meetingRoomEnd(end, time.Now(), h.Temp.norm().MaxTTL), lim: h.Temp.norm(), userCap: userCap,
		private: true, people: people, guests: guests, allow: perm.ViewRoom | TempAllow&bits,
	})
	if err != nil {
		return uuid.Nil, nil, err
	}
	return made.room.ID, func(ctx context.Context) { h.publishTemp(ctx, made) }, nil
}

// meetingRoom locks roomID when it is still creator's live temporary room (ok false: archived,
// made permanent, someone else's).
func meetingRoom(ctx context.Context, q *sqlc.Queries, roomID, creator uuid.UUID) (sqlc.Room, bool, error) {
	room, err := q.GetRoomForUpdate(ctx, roomID)
	if db.IsNotFound(err) {
		return room, false, nil
	}
	if err != nil {
		return room, false, err
	}
	ok := room.ExpiresAt != nil && room.WorkspaceID != nil && room.CreatedBy != nil && *room.CreatedBy == creator
	return room, ok, nil
}

// MoveMeetingRoom follows a moved meeting inside the caller's transaction q: creator's live
// temporary room roomID now ends at end (bounded as at creation), and its own links that ended
// with it follow (as PATCH expires_at, ADR-0044). Nothing when the room is no longer the
// meeting's temporary room. publish announces ROOM_UPDATE after the commit.
func (h *Handlers) MoveMeetingRoom(ctx context.Context, q *sqlc.Queries, roomID, creator uuid.UUID, end time.Time) (func(context.Context), error) {
	cur, ok, err := meetingRoom(ctx, q, roomID, creator)
	if err != nil || !ok {
		return nil, err
	}
	end = meetingRoomEnd(end, time.Now(), h.Temp.norm().MaxTTL)
	if end.Equal(*cur.ExpiresAt) {
		return nil, nil
	}
	room, err := q.SetRoomExpiry(ctx, sqlc.SetRoomExpiryParams{ID: cur.ID, ExpiresAt: &end})
	if err != nil {
		return nil, err
	}
	if err := q.FollowRoomExpiry(ctx, sqlc.FollowRoomExpiryParams{RoomID: cur.ID, ExpiresAt: &end, OldExpiresAt: cur.ExpiresAt}); err != nil {
		return nil, err
	}
	pb, err := h.load(ctx, q, room)
	if err != nil {
		return nil, err
	}
	wsID := *room.WorkspaceID
	return func(ctx context.Context) {
		h.events.Workspace(ctx, wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_RoomUpdate{RoomUpdate: &v1.RoomUpdate{Room: pb}}})
	}, nil
}

// CloseMeetingRoom archives creator's live temporary room roomID after its meeting was
// cancelled (ADR-0112: the room was made for the meeting) — as DELETE /api/rooms/{id} by its
// creator: links revoked, the room's other meetings closed, ROOM_DELETE. Nothing when the room
// is no longer the meeting's temporary room.
func (h *Handlers) CloseMeetingRoom(ctx context.Context, roomID, creator uuid.UUID) error {
	_, ok, err := meetingRoom(ctx, h.db.Q, roomID, creator)
	if err != nil || !ok {
		return err
	}
	_, err = h.archiveTemp(ctx, roomID, false)
	return err
}

// meetingPeople keeps of ids the workspace members that are not guests, without the creator
// and duplicates (a meeting's attendees: one who left or became a guest is skipped).
func meetingPeople(ctx context.Context, q *sqlc.Queries, wsID, creator uuid.UUID, ids []uuid.UUID) ([]uuid.UUID, error) {
	seen := map[uuid.UUID]bool{creator: true}
	out := make([]uuid.UUID, 0, len(ids))
	for _, id := range ids {
		if seen[id] {
			continue
		}
		seen[id] = true
		m, err := q.GetMember(ctx, sqlc.GetMemberParams{WorkspaceID: wsID, UserID: id})
		if db.IsNotFound(err) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if m.Role != string(perm.RoleGuest) {
			out = append(out, id)
		}
	}
	return out, nil
}

// SyncMeetingRoom follows the meeting's attendee list inside the caller's transaction q: people
// added get the creator's personal allow of the room, people removed lose theirs (never the
// creator). Nothing when roomID is no longer creator's live private temporary room. publish
// announces the room's new overrides after the commit.
func (h *Handlers) SyncMeetingRoom(ctx context.Context, q *sqlc.Queries, roomID, creator uuid.UUID, add, remove []uuid.UUID) (func(context.Context), error) {
	if len(add)+len(remove) == 0 {
		return nil, nil
	}
	room, ok, err := meetingRoom(ctx, q, roomID, creator)
	if err != nil || !ok || !room.IsPrivate {
		return nil, err
	}
	wsID := *room.WorkspaceID
	ovs, err := q.ListRoomOverrides(ctx, roomID)
	if err != nil {
		return nil, err
	}
	allow := int64(perm.ViewRoom)
	for _, o := range ovs {
		if o.TargetType == "user" && o.TargetID == creator.String() {
			allow = o.Allow
		}
	}
	if add, err = meetingPeople(ctx, q, wsID, creator, add); err != nil {
		return nil, err
	}
	for _, u := range add {
		if err := q.GrantUserOverride(ctx, sqlc.GrantUserOverrideParams{RoomID: roomID, UserID: u.String(), Allow: allow}); err != nil {
			return nil, err
		}
	}
	for _, u := range remove {
		if u == creator {
			continue
		}
		if err := q.RevokeUserOverride(ctx, sqlc.RevokeUserOverrideParams{RoomID: roomID, UserID: u.String()}); err != nil {
			return nil, err
		}
	}
	pb, err := h.load(ctx, q, room)
	if err != nil {
		return nil, err
	}
	return func(ctx context.Context) {
		h.events.Workspace(ctx, wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_RoomPermissionsUpdate{
			RoomPermissionsUpdate: &v1.RoomPermissionsUpdate{WorkspaceId: wsID.String(), RoomId: roomID.String(), Permissions: pb.GetPermissionOverrides()},
		}})
	}, nil
}

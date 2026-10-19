package rooms

import (
	"net/http"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
)

// Archive actions of temporary rooms (ADR-0044 addendum 14.10): restore and make permanent.

// DefaultTempTTL is the lifetime of a restored room whose original one is not usable.
const DefaultTempTTL = 24 * time.Hour

// restoreTTL is the lifetime a restored room gets: the original one (end - creation, which
// includes extensions), within the creation limits; the default when that is out of them.
func restoreTTL(created, expires time.Time) time.Duration {
	d := expires.Sub(created)
	if d < MinTempTTL || d > MaxTempTTL {
		return DefaultTempTTL
	}
	return d
}

// archivedAccess resolves a temporary room (live or archived) for an archive action. The
// caller must see it: a private one is invisible to admins (ADR-0078) and answers 404.
func archivedAccess(r *http.Request) (uuid.UUID, perm.RoomAccess, error) {
	roomID, err := httpx.PathUUID(r, "id", "room")
	if err != nil {
		return uuid.Nil, perm.RoomAccess{}, err
	}
	acc, err := ReadAccess(r, roomID)
	if err != nil {
		return uuid.Nil, perm.RoomAccess{}, err
	}
	if !acc.Temp {
		return uuid.Nil, perm.RoomAccess{}, httpx.NotFound("room")
	}
	return roomID, acc, nil
}

// restoreTemp: POST /api/rooms/{id}/restore — an archived temporary room goes live again, with
// the links its archive revoked (ADR-0107).
func (h *Handlers) restoreTemp(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	roomID, acc, err := archivedAccess(r)
	if err != nil {
		return err
	}
	me := auth.MustFromContext(ctx).UserID
	if !MayManage(acc, me) {
		return httpx.Forbidden("MANAGE_ROOM required")
	}
	if acc.Suspended {
		return httpx.Coded(http.StatusForbidden, v1.ErrorCode_ERROR_CODE_WORKSPACE_SUSPENDED, "the workspace is suspended")
	}
	if !acc.Archived {
		return httpx.Conflict("the room is not archived")
	}
	links := h.linkPolicyOf(r, acc)
	code, err := NewLinkCode()
	if err != nil {
		return err
	}
	var (
		room sqlc.Room
		ws   sqlc.Workspace
		ovs  []sqlc.RoomPermission
	)
	err = h.db.Tx(ctx, func(q *sqlc.Queries) error {
		cur, err := q.GetArchivedTempRoomForUpdate(ctx, roomID)
		if err != nil {
			return err
		}
		if cur.WorkspaceID == nil {
			return httpx.NotFound("room")
		}
		wsID := *cur.WorkspaceID
		if err := q.LockTempRooms(ctx, wsID); err != nil {
			return err
		}
		n, err := q.CountLiveTempRooms(ctx, sqlc.CountLiveTempRoomsParams{WorkspaceID: wsID, UserID: me})
		if err != nil {
			return err
		}
		if n.Total >= MaxTempPerWorkspace {
			return errTempLimit.WithDetails("", uint64(n.Total), MaxTempPerWorkspace) //nolint:gosec // count ≥ 0
		}
		if n.Mine >= MaxTempPerUser {
			return errTempLimit.WithDetails(ReasonPerUser, uint64(n.Mine), MaxTempPerUser) //nolint:gosec // count ≥ 0
		}
		expires := time.Now().Add(restoreTTL(cur.CreatedAt, *cur.ExpiresAt)).Truncate(time.Second)
		if room, err = q.RestoreTempRoom(ctx, sqlc.RestoreTempRoomParams{ID: roomID, ExpiresAt: expires}); err != nil {
			return err
		}
		// The links the archive revoked come back (ADR-0107); none → a fresh one for the members.
		revived, err := reviveLinks(ctx, q, roomID, *cur.ExpiresAt, &expires, links)
		if err != nil {
			return err
		}
		if revived == 0 {
			allow := perm.ViewRoom | TempAllow&acc.Bits
			if _, err := q.CreateRoomInvite(ctx, sqlc.CreateRoomInviteParams{
				RoomID: roomID, Code: code, CreatedBy: me, ExpiresAt: &expires,
				MembersOnly: true, AllowBits: int64(allow), //nolint:gosec // bit mask
			}); err != nil {
				return err
			}
		}
		if ws, err = q.GetWorkspace(ctx, wsID); err != nil {
			return err
		}
		ovs, err = q.ListRoomOverrides(ctx, roomID)
		return err
	})
	if err != nil {
		return err
	}
	pb := pbconv.Room(room, pbconv.WorkspaceDefaults(ws), ovs)
	h.events.Workspace(ctx, ws.ID, &v1.DispatchEvent{Event: &v1.DispatchEvent_RoomCreate{RoomCreate: &v1.RoomCreate{Room: pb}}})
	httpx.Write(w, http.StatusOK, &v1.RestoreTempRoomResponse{Room: pb})
	return nil
}

// makePermanent: POST /api/rooms/{id}/make-permanent — a temporary room (archived or live)
// becomes a regular one; needs the right to create regular rooms (MANAGE_ROOM at workspace level).
// Its links bound to its end never expire; an archived room's links come back first (ADR-0107).
func (h *Handlers) makePermanent(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	roomID, acc, err := archivedAccess(r)
	if err != nil {
		return err
	}
	if acc.Role == perm.RoleGuest || !acc.Member.Workspace().Has(perm.ManageRoom) {
		return httpx.Forbidden("MANAGE_ROOM required to make a temporary room permanent")
	}
	links := h.linkPolicyOf(r, acc)
	var (
		room sqlc.Room
		ws   sqlc.Workspace
		ovs  []sqlc.RoomPermission
	)
	err = h.db.Tx(ctx, func(q *sqlc.Queries) error {
		cur, err := q.GetTempRoomForUpdate(ctx, roomID)
		if err != nil {
			return err
		}
		// Its links stop following an end (ADR-0107): an archived room's come back first. A
		// suspended workspace hands out no link: they stay as they are.
		switch {
		case acc.Suspended:
		case cur.ArchivedAt != nil:
			if _, err := reviveLinks(ctx, q, roomID, *cur.ExpiresAt, nil, links); err != nil {
				return err
			}
		default:
			if err := unboundLinks(ctx, q, roomID, *cur.ExpiresAt, links); err != nil {
				return err
			}
		}
		if room, err = q.MakeRoomPermanent(ctx, roomID); err != nil {
			return err
		}
		if room.WorkspaceID == nil {
			return httpx.NotFound("room")
		}
		if ws, err = q.GetWorkspace(ctx, *room.WorkspaceID); err != nil {
			return err
		}
		ovs, err = q.ListRoomOverrides(ctx, roomID)
		return err
	})
	if err != nil {
		return err
	}
	pb := pbconv.Room(room, pbconv.WorkspaceDefaults(ws), ovs)
	var ev *v1.DispatchEvent
	if acc.Archived { // it left every list when archived: it appears again
		ev = &v1.DispatchEvent{Event: &v1.DispatchEvent_RoomCreate{RoomCreate: &v1.RoomCreate{Room: pb}}}
	} else {
		ev = &v1.DispatchEvent{Event: &v1.DispatchEvent_RoomUpdate{RoomUpdate: &v1.RoomUpdate{Room: pb}}}
	}
	h.events.Workspace(ctx, ws.ID, ev)
	httpx.Write(w, http.StatusOK, &v1.MakeRoomPermanentResponse{Room: pb})
	return nil
}

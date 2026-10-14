package rooms

import (
	"net/http"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/wsaudit"
)

var errTakeOverOwnerOnly = httpx.Forbidden("only the workspace owner with «owner sees private» on").WithDetails(wsaudit.ReasonOwnerOnly, 0, 0)

// takeOver: POST /api/rooms/{id}/take-over (ADR-0078 addendum 2026-10-14, «Сделать меня
// владельцем»). The workspace owner with «Владелец видит приватное» on takes over a private
// room whose creator is no longer a member of the workspace (or unknown): created_by becomes the
// owner, who gets a personal allow of every room bit (RoomOnly), and a TAKE_OVER entry goes to the
// workspace journal. A room the caller does not see is 404; anyone else 403 OWNER_ONLY; a public
// room, a creator still in the workspace or the caller's own room 409.
func (h *Handlers) takeOver(w http.ResponseWriter, r *http.Request) error {
	roomID, err := httpx.PathUUID(r, "id", "room")
	if err != nil {
		return err
	}
	acc, err := roomAccess(r, roomID)
	if err != nil {
		return err
	}
	if !acc.Member.SeesPrivate() {
		return errTakeOverOwnerOnly
	}
	if !acc.Private {
		return httpx.Conflict("only a private room is taken over")
	}
	me := auth.MustFromContext(r.Context()).UserID
	var pb *v1.Room
	err = h.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		cur, err := q.GetRoomForUpdate(r.Context(), roomID)
		if db.IsNotFound(err) {
			return httpx.NotFound("room")
		}
		if err != nil {
			return err
		}
		if err := wsaudit.MayTakeOver(r.Context(), q, acc.WorkspaceID, acc.Member, cur.CreatedBy, errTakeOverOwnerOnly,
			httpx.Conflict("the room's creator is still a member of the workspace")); err != nil {
			return err
		}
		room, err := q.SetRoomCreator(r.Context(), sqlc.SetRoomCreatorParams{ID: roomID, CreatedBy: &me})
		if err != nil {
			return err
		}
		if err := q.GrantUserOverride(r.Context(), sqlc.GrantUserOverrideParams{RoomID: roomID, UserID: me.String(), Allow: int64(perm.RoomOnly)}); err != nil { //nolint:gosec // bit mask
			return err
		}
		if err := wsaudit.RecordTakeOver(r.Context(), q, acc.WorkspaceID, me, wsaudit.SubjectRoom, roomID, cur.CreatedBy); err != nil {
			return err
		}
		pb, err = h.load(r.Context(), q, room)
		return err
	})
	if err != nil {
		return err
	}
	perm.FromContext(r.Context()).Invalidate()
	h.events.WorkspaceEvents(r.Context(), acc.WorkspaceID, []*v1.DispatchEvent{
		{Event: &v1.DispatchEvent_RoomUpdate{RoomUpdate: &v1.RoomUpdate{Room: pb}}},
		{Event: &v1.DispatchEvent_RoomPermissionsUpdate{RoomPermissionsUpdate: &v1.RoomPermissionsUpdate{
			WorkspaceId: acc.WorkspaceID.String(), RoomId: roomID.String(), Permissions: pb.GetPermissionOverrides(),
		}}},
	})
	httpx.Write(w, http.StatusOK, &v1.UpdateRoomResponse{Room: pb})
	return nil
}

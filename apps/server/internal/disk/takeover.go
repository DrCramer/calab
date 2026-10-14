package disk

import (
	"net/http"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/diskacl"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/wsaudit"
)

var (
	errTakeOverOwnerOnly = httpx.Forbidden("only the workspace owner with «Владелец видит приватное» on takes over private items").WithDetails(wsaudit.ReasonOwnerOnly, 0, 0)
	errTakeOverMember    = httpx.Conflict("the item's owner is still a member of the workspace")
	errTakeOverPublic    = httpx.Conflict("only a private item (in a «Только выбранные» folder) can be taken over")
)

// takeOver: POST /api/disk/items/{id}/take-over — «Сделать меня владельцем» (addendum
// 2026-10-14): the workspace owner while «Владелец видит приватное» is on becomes the owner of a
// private item whose owner left the workspace (or is unknown). A workspace journal entry
// (wsaudit) records it; DISK_ITEM_UPDATE goes to whoever sees the item.
func (s *Service) takeOver(w http.ResponseWriter, r *http.Request) error {
	id, err := httpx.PathUUID(r, "id", "item")
	if err != nil {
		return err
	}
	ctx := r.Context()
	var a access
	var before, after []perm.DiskNode
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if a, err = resolve(r, q, id); err != nil {
			return err
		}
		ws := a.item.WorkspaceID
		if err := writable(ctx, q, ws); err != nil {
			return err
		}
		if err := q.LockDiskTree(ctx, ws); err != nil {
			return err
		}
		if a, err = resolve(r, q, id); err != nil { // again under the lock
			return err
		}
		if err := wsaudit.MayTakeOver(ctx, q, ws, a.c.m, a.item.OwnerID, errTakeOverOwnerOnly, errTakeOverMember); err != nil {
			return err
		}
		before = a.nodes()
		if !perm.RestrictedIn(before) {
			return errTakeOverPublic
		}
		previous := a.item.OwnerID
		it, err := q.SetDiskItemOwner(ctx, sqlc.SetDiskItemOwnerParams{ID: id, OwnerID: &a.c.uid})
		if err != nil {
			return err
		}
		if err := wsaudit.RecordTakeOver(ctx, q, ws, a.c.uid, wsaudit.SubjectDiskItem, id, previous); err != nil {
			return err
		}
		ch, err := diskacl.Load(ctx, q, []uuid.UUID{id})
		if err != nil {
			return err
		}
		after = ch.Nodes(id)
		a.item, a.chain, a.bits = it, ch, perm.ComputeDiskItemIn(a.c.m, after)
		return nil
	})
	if err != nil {
		return err
	}
	s.publish(ctx, a.item.WorkspaceID, []*v1.DispatchEvent{upsertEvent(a.item, after, before)})
	out, err := one(ctx, s.db.Q, a)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.DiskItemResponse{Item: out})
	return nil
}

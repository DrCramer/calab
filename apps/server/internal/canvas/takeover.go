package canvas

import (
	"net/http"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/wsaudit"
)

var (
	errTakeOverOwnerOnly = httpx.Forbidden("only the workspace owner with «Владелец видит приватное» on takes over private items").WithDetails(wsaudit.ReasonOwnerOnly, 0, 0)
	errTakeOverMember    = httpx.Conflict("the item's owner is still a member of the workspace")
	errTakeOverPublic    = httpx.Conflict("only a private item (under «Только выбранные») can be taken over")
)

// takeOver: POST /api/canvas/items/{id}/take-over — «Сделать меня владельцем» (addendum
// 2026-10-14): the workspace owner while «Владелец видит приватное» is on becomes the owner of a
// private item whose owner left the workspace (or is unknown). A workspace journal entry
// (wsaudit) records it; CANVAS_ITEM_UPSERT goes to whoever sees the item.
func (s *Service) takeOver(w http.ResponseWriter, r *http.Request) error {
	id, err := httpx.PathUUID(r, "id", "item")
	if err != nil {
		return err
	}
	ctx := r.Context()
	var before []perm.TreeNode
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		a, err := resolve(r, q, id)
		if err != nil {
			return err
		}
		ws := a.item.WorkspaceID
		if err := writable(ctx, q, ws); err != nil {
			return err
		}
		if err := q.LockCanvasTree(ctx, ws); err != nil {
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
		if err := q.SetCanvasItemOwner(ctx, sqlc.SetCanvasItemOwnerParams{ID: id, OwnerID: &a.c.uid}); err != nil {
			return err
		}
		return wsaudit.RecordTakeOver(ctx, q, ws, a.c.uid, wsaudit.SubjectCanvasItem, id, a.item.OwnerID)
	})
	if err != nil {
		return err
	}
	s.upserted(ctx, id, before)
	s.recheck(ctx, id)
	a, err := s.pathItem(r)
	if err != nil {
		return err
	}
	item, err := one(ctx, s.db.Q, a)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.CanvasItemResponse{Item: item})
	return nil
}

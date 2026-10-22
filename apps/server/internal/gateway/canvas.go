package gateway

import (
	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/canvasacl"
	"github.com/calaba/calaba/server/internal/perm"
)

// Canvas events (ADR-0115 §6), routed like the Wiki's (wiki.go): each CANVAS_ITEM_* event
// carries the item's access chain (server-internal, stripped here) and every recipient's bits
// come from it and their roles (perm.ComputeCanvasItemIn). Without CANVAS_VIEW on the item
// nothing is delivered; who saw the item before a change of its chain (move, restricted,
// overrides) and does not any more gets CANVAS_ITEM_REMOVE instead of the upsert. The content of
// canvases never travels here (the sync socket, internal/canvas).

// canvasBits is member uid's canvas bits on an item with this chain (mu held); 0 = not a member,
// a bot (the Canvas is for people in v1, ADR-0115) or no chain.
func (s *wsState) canvasBits(uid uuid.UUID, chain []perm.TreeNode) perm.Bits {
	m, ok := s.members[uid]
	if !ok || len(chain) == 0 || s.bots[uid] {
		return 0
	}
	return perm.ComputeCanvasItemIn(m, chain) & perm.Canvas
}

// canvasSees reports whether member uid sees an item with this chain (mu held).
func (s *wsState) canvasSees(uid uuid.UUID, chain []perm.TreeNode) bool {
	return s.canvasBits(uid, chain).Has(perm.CanvasView)
}

// canvasRemove is CANVAS_ITEM_REMOVE as clients get it.
func canvasRemove(ws, item, parent string) *v1.DispatchEvent {
	return &v1.DispatchEvent{Event: &v1.DispatchEvent_CanvasItemRemove{CanvasItemRemove: &v1.CanvasItemRemove{
		WorkspaceId: ws, ItemId: item, ParentId: parent}}}
}

// routeCanvas delivers CANVAS_ITEM_UPSERT / CANVAS_ITEM_REMOVE (st.mu held); false = not a
// canvas event.
func (h *Hub) routeCanvas(st *wsState, wid, id uuid.UUID, sessions []*Session, ev *v1.DispatchEvent) bool {
	switch e := ev.GetEvent().(type) {
	case *v1.DispatchEvent_CanvasItemUpsert:
		u := e.CanvasItemUpsert
		after := canvasacl.FromLevels(u.GetAccess())
		before := canvasacl.FromLevels(u.GetAccessBefore())
		// my_bits is the recipient's own; one encoding per distinct value (few: viewer / editor / manager).
		byBits := map[perm.Bits]*encEvent{}
		var remove *encEvent
		for _, s := range sessions {
			bits := st.canvasBits(s.user, after)
			switch {
			case bits.Has(perm.CanvasView):
				upsert := byBits[bits]
				if upsert == nil {
					it := proto.Clone(u.GetItem()).(*v1.CanvasItem)
					it.MyBits = uint64(bits)
					upsert = newScopedEnc(wid, &v1.DispatchEvent{Event: &v1.DispatchEvent_CanvasItemUpsert{CanvasItemUpsert: &v1.CanvasItemUpsert{
						WorkspaceId: u.GetWorkspaceId(), Item: it}}})
					byBits[bits] = upsert
				}
				s.dispatchEnc(id, upsert)
			case st.canvasSees(s.user, before):
				if remove == nil {
					remove = newScopedEnc(wid, canvasRemove(u.GetWorkspaceId(), u.GetItem().GetId(), u.GetItem().GetParentId()))
				}
				s.dispatchEnc(id, remove)
			}
		}
	case *v1.DispatchEvent_CanvasItemRemove:
		x := e.CanvasItemRemove
		chain := canvasacl.FromLevels(x.GetAccess())
		remove := newScopedEnc(wid, canvasRemove(x.GetWorkspaceId(), x.GetItemId(), x.GetParentId()))
		for _, s := range sessions {
			if st.canvasSees(s.user, chain) {
				s.dispatchEnc(id, remove)
			}
		}
	case *v1.DispatchEvent_CanvasCommentUpsert:
		// Comments (ADR-0116 wave 4): the whole comment to who sees the canvas, the chain stripped.
		x := e.CanvasCommentUpsert
		h.canvasToViewers(st, wid, id, sessions, canvasacl.FromLevels(x.GetAccess()), &v1.DispatchEvent{Event: &v1.DispatchEvent_CanvasCommentUpsert{
			CanvasCommentUpsert: &v1.CanvasCommentUpsert{WorkspaceId: x.GetWorkspaceId(), Comment: x.GetComment()}}})
	case *v1.DispatchEvent_CanvasCommentDelete:
		x := e.CanvasCommentDelete
		h.canvasToViewers(st, wid, id, sessions, canvasacl.FromLevels(x.GetAccess()), &v1.DispatchEvent{Event: &v1.DispatchEvent_CanvasCommentDelete{
			CanvasCommentDelete: &v1.CanvasCommentDelete{WorkspaceId: x.GetWorkspaceId(), CanvasId: x.GetCanvasId(), CommentId: x.GetCommentId()}}})
	default:
		return false
	}
	return true
}

// canvasToViewers sends out (already without its chain) to the sessions whose member sees an
// item with chain (st.mu held); an empty chain reaches nobody (fail closed).
func (h *Hub) canvasToViewers(st *wsState, wid, id uuid.UUID, sessions []*Session, chain []perm.TreeNode, out *v1.DispatchEvent) {
	var enc *encEvent
	for _, s := range sessions {
		if !st.canvasSees(s.user, chain) {
			continue
		}
		if enc == nil {
			enc = newScopedEnc(wid, out)
		}
		s.dispatchEnc(id, enc)
	}
}

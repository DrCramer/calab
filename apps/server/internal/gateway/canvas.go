package gateway

import v1 "github.com/calaba/calaba/server/gen/calaba/v1"

// Canvas events (ADR-0107 §6). Like the Wiki's, each CANVAS_ITEM_* event carries the item's
// access chain (server-internal) and must reach only the item's viewers (CANVAS_VIEW,
// perm.ComputeCanvasItemIn). Until that per-recipient routing lands (canvas v1 task H2) they are
// dropped here: fail closed, never broadcast to the whole workspace with the chain attached.

// routeCanvas swallows CANVAS_ITEM_UPSERT / CANVAS_ITEM_REMOVE; false = not a canvas event.
func routeCanvas(ev *v1.DispatchEvent) bool {
	switch ev.GetEvent().(type) {
	case *v1.DispatchEvent_CanvasItemUpsert, *v1.DispatchEvent_CanvasItemRemove:
		return true
	}
	return false
}

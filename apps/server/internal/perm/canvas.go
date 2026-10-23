package perm

// Canvas bits (ADR-0126 §2): the same rules as the wiki bits (wiki.go) — listed in the comment of
// enum Permission and docs/04, TS CANVAS_BITS; in ADMINISTRATOR (CanvasOf) but outside All;
// per-item overrides (canvas_permissions) carry CanvasView and CanvasWrite only; guests get
// nothing from their roles, only from an explicit user override on an item (or by owning it);
// bots are members like people. The item rule is the shared tree rule (tree.go) over CanvasTree.
//
// As in the Wiki, the difference from the Disk is in what the bits allow, not in how they are
// computed: CANVAS_WRITE on a canvas edits its content (the canvas is a shared document) and
// creates items in a folder; the structure of the item — rename, move, trash, restore, delete,
// access — needs its owner or CANVAS_MANAGE (CanvasStructureAllowed).
const (
	// CanvasView: see the Canvas section and every item that is not restricted. Member default.
	CanvasView Bits = 1 << 41
	// CanvasWrite: create folders and canvases; edit the content of a canvas wherever one has
	// it; the structure of one's own items. Member default.
	CanvasWrite Bits = 1 << 42
	// CanvasManage: the structure of any item, the trash retention, empty the whole trash.
	// Implies View and Write; not inside restricted items: there only what their overrides give
	// (ComputeTree).
	CanvasManage Bits = 1 << 43

	// Canvas are the three canvas bits.
	Canvas = CanvasView | CanvasWrite | CanvasManage
	// CanvasOverride are the bits a canvas_permissions row may allow or deny.
	CanvasOverride = CanvasView | CanvasWrite
)

// CanvasTree are the Canvas section's bits for the tree rule.
var CanvasTree = TreeBits{View: CanvasView, Write: CanvasWrite, Manage: CanvasManage}

// CanvasOf is the workspace-level canvas rule (TS: canvasPermissions): guests nothing;
// ADMINISTRATOR or CANVAS_MANAGE all three; anyone else (bots included) the canvas bits of their
// roles.
func CanvasOf(raw Bits, guest bool) Bits { return TreeOf(CanvasTree, raw, guest) }

// ComputeCanvasItem is the one item rule (ADR-0126 §2; TS: canvasItemPermissions): ComputeTree
// over CanvasTree. chain runs from the top-level ancestor down to the item itself (empty = the
// top level of the section: creating a top-level item needs CANVAS_WRITE there).
func ComputeCanvasItem(raw Bits, guest bool, chain []TreeLevel) Bits {
	return ComputeTree(CanvasTree, TreeInput{Raw: raw, Guest: guest, Chain: chain})
}

// ComputeCanvasItemIn computes a member's bits on the last item of chain (the top-level item
// first).
func ComputeCanvasItemIn(m Member, chain []TreeNode) Bits {
	return ComputeTreeIn(CanvasTree, m, chain)
}

// CanvasStructureAllowed is the structural rule of an item (ADR-0126 §2; TS:
// canvasStructureAllowed): renaming, moving, trashing, restoring, deleting forever and the access
// dialog need CANVAS_VIEW on the item (bits = ComputeCanvasItem) and either its ownership or
// CANVAS_MANAGE. CANVAS_WRITE alone edits the content and creates items, nothing else. Moving
// also needs CANVAS_WRITE on the destination folder.
func CanvasStructureAllowed(bits Bits, owner bool) bool {
	return bits&CanvasView != 0 && (owner || bits&CanvasManage != 0)
}

// ValidCanvasOverride reports whether an allow / deny pair may be stored in canvas_permissions:
// only CANVAS_VIEW and CANVAS_WRITE, not both ways.
func ValidCanvasOverride(allow, deny Bits) bool { return ValidTreeOverride(CanvasTree, allow, deny) }

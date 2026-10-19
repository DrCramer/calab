// Package canvasacl loads the access chains of Canvas items (ADR-0107 §2) and turns them into
// perm.TreeNode chains for perm.ComputeCanvasItemIn: the REST handlers and the sync socket
// (internal/canvas), the search section and the gateway's per-recipient routing of
// CANVAS_ITEM_* events (from the chains the events carry) share it. It is the Canvas's twin of
// internal/wikiacl and internal/diskacl.
package canvasacl

import (
	"context"
	"slices"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/perm"
)

// Chains are items with their ancestors and the overrides of every level.
type Chains struct {
	items map[uuid.UUID]sqlc.CanvasItemHead
	paths map[uuid.UUID][]uuid.UUID // leaf → ids, the top-level item first
	ovs   map[uuid.UUID][]perm.OverrideTarget
}

func empty() *Chains {
	return &Chains{items: map[uuid.UUID]sqlc.CanvasItemHead{}, paths: map[uuid.UUID][]uuid.UUID{}, ovs: map[uuid.UUID][]perm.OverrideTarget{}}
}

// Load reads the chains of ids (missing items are absent: Has reports false).
func Load(ctx context.Context, q *sqlc.Queries, ids []uuid.UUID) (*Chains, error) {
	c := empty()
	if len(ids) == 0 {
		return c, nil
	}
	rows, err := q.CanvasItemPaths(ctx, ids)
	if err != nil {
		return nil, err
	}
	for _, r := range rows {
		c.items[r.CanvasItemHead.ID] = r.CanvasItemHead
		c.paths[r.Leaf] = append(c.paths[r.Leaf], r.CanvasItemHead.ID)
	}
	c.ancestors()
	all := make([]uuid.UUID, 0, len(c.items))
	for id := range c.items {
		all = append(all, id)
	}
	if err := c.loadOverrides(ctx, q, all); err != nil {
		return nil, err
	}
	return c, nil
}

// ancestors gives every ancestor of a loaded leaf its own chain (a prefix of the leaf's), so that
// Bits and Nodes work for it too — a path (breadcrumbs, a search hit's folders) asks for each
// level's bits, and an ancestor without a chain would get the top level's bits.
func (c *Chains) ancestors() {
	leaves := make([][]uuid.UUID, 0, len(c.paths))
	for _, p := range c.paths {
		leaves = append(leaves, p)
	}
	for _, p := range leaves {
		for i, id := range p[:len(p)-1] {
			if _, ok := c.paths[id]; !ok {
				c.paths[id] = slices.Clone(p[:i+1])
			}
		}
	}
}

func (c *Chains) loadOverrides(ctx context.Context, q *sqlc.Queries, ids []uuid.UUID) error {
	if len(ids) == 0 {
		return nil
	}
	rows, err := q.ListCanvasPermissionsForItems(ctx, ids)
	if err != nil {
		return err
	}
	for _, p := range rows {
		c.ovs[p.CanvasID] = append(c.ovs[p.CanvasID], Target(p))
	}
	return nil
}

// AddChildren adds items of one parent (an id of c, or nil = the top level) with their
// overrides, so that Nodes works for them without one query per item.
func (c *Chains) AddChildren(ctx context.Context, q *sqlc.Queries, parent *uuid.UUID, children []sqlc.CanvasItemHead) error {
	base := []uuid.UUID(nil)
	if parent != nil {
		base = c.paths[*parent]
	}
	ids := make([]uuid.UUID, 0, len(children))
	for _, ch := range children {
		if _, ok := c.items[ch.ID]; ok {
			continue
		}
		c.items[ch.ID] = ch
		p := make([]uuid.UUID, len(base)+1)
		copy(p, base)
		p[len(base)] = ch.ID
		c.paths[ch.ID] = p
		ids = append(ids, ch.ID)
	}
	return c.loadOverrides(ctx, q, ids)
}

// Has reports whether the item was loaded.
func (c *Chains) Has(id uuid.UUID) bool { _, ok := c.paths[id]; return ok }

// Item returns a loaded item.
func (c *Chains) Item(id uuid.UUID) sqlc.CanvasItemHead { return c.items[id] }

// Path returns the item and its ancestors, the top-level item first.
func (c *Chains) Path(id uuid.UUID) []sqlc.CanvasItemHead {
	ids := c.paths[id]
	out := make([]sqlc.CanvasItemHead, len(ids))
	for i, x := range ids {
		out[i] = c.items[x]
	}
	return out
}

// Overrides returns the overrides of one loaded item.
func (c *Chains) Overrides(id uuid.UUID) []perm.OverrideTarget { return c.ovs[id] }

// Nodes is the chain of id as perm.ComputeCanvasItemIn reads it (nil for the top level or an
// unknown item).
func (c *Chains) Nodes(id uuid.UUID) []perm.TreeNode {
	ids := c.paths[id]
	out := make([]perm.TreeNode, len(ids))
	for i, x := range ids {
		out[i] = Node(c.items[x], c.ovs[x])
	}
	return out
}

// Bits is a member's canvas bits on id. A nil id is the top level: the
// workspace-level bits.
func (c *Chains) Bits(m perm.Member, id *uuid.UUID) perm.Bits {
	if id == nil {
		return perm.ComputeCanvasItemIn(m, nil)
	}
	return perm.ComputeCanvasItemIn(m, c.Nodes(*id))
}

// Node is one level of a chain.
func Node(p sqlc.CanvasItemHead, ovs []perm.OverrideTarget) perm.TreeNode {
	n := perm.TreeNode{Restricted: p.Restricted, Overrides: ovs}
	if p.OwnerID != nil {
		n.OwnerID = p.OwnerID.String()
	}
	return n
}

// Target converts a canvas_permissions row.
func Target(p sqlc.CanvasPermission) perm.OverrideTarget {
	return perm.OverrideTarget{TargetType: p.TargetType, TargetID: p.TargetID,
		Override: perm.Override{Allow: perm.Bits(uint64(p.Allow)), Deny: perm.Bits(uint64(p.Deny))}} //nolint:gosec // bit mask round-trip
}

// Entry converts an override to its API form.
func Entry(o perm.OverrideTarget) *v1.CanvasPermissionEntry {
	tt := v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER
	if o.TargetType == "role" {
		tt = v1.PermissionTargetType_PERMISSION_TARGET_TYPE_ROLE
	}
	return &v1.CanvasPermissionEntry{TargetType: tt, TargetId: o.TargetID, Allow: uint64(o.Allow), Deny: uint64(o.Deny)}
}

// Levels is a chain as the CANVAS_ITEM_* events carry it (server-internal routing).
func Levels(nodes []perm.TreeNode) []*v1.CanvasAccessLevel {
	out := make([]*v1.CanvasAccessLevel, len(nodes))
	for i, n := range nodes {
		l := &v1.CanvasAccessLevel{Restricted: n.Restricted, OwnerId: n.OwnerID}
		for _, o := range n.Overrides {
			l.Overrides = append(l.Overrides, Entry(o))
		}
		out[i] = l
	}
	return out
}

// FromLevels is the inverse of Levels.
func FromLevels(levels []*v1.CanvasAccessLevel) []perm.TreeNode {
	out := make([]perm.TreeNode, len(levels))
	for i, l := range levels {
		n := perm.TreeNode{Restricted: l.GetRestricted(), OwnerID: l.GetOwnerId()}
		for _, o := range l.GetOverrides() {
			tt := "user"
			if o.GetTargetType() == v1.PermissionTargetType_PERMISSION_TARGET_TYPE_ROLE {
				tt = "role"
			}
			n.Overrides = append(n.Overrides, perm.OverrideTarget{TargetType: tt, TargetID: o.GetTargetId(),
				Override: perm.Override{Allow: perm.Bits(o.GetAllow()), Deny: perm.Bits(o.GetDeny())}})
		}
		out[i] = n
	}
	return out
}

// SameChain reports whether two chains give everyone the same bits (same levels).
func SameChain(a, b []perm.TreeNode) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		x, y := a[i], b[i]
		if x.Restricted != y.Restricted || x.OwnerID != y.OwnerID || len(x.Overrides) != len(y.Overrides) {
			return false
		}
		for j := range x.Overrides {
			if x.Overrides[j] != y.Overrides[j] {
				return false
			}
		}
	}
	return true
}

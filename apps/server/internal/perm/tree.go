package perm

import "slices"

// The tree rule shared by the Disk (ADR-0094 §2) and the Wiki (ADR-0096 §2): a workspace-level
// triple of bits (VIEW / WRITE / MANAGE) on roles, then per-node overrides down a chain of
// ancestors. The two sections are two TreeBits over one algorithm (TS: treeItemPermissions).

// TreeBits names the three bits of one tree section.
type TreeBits struct {
	View, Write, Manage Bits
}

// All are the three bits.
func (b TreeBits) All() Bits { return b.View | b.Write | b.Manage }

// Override are the bits a per-node override may allow or deny: VIEW and WRITE.
func (b TreeBits) Override() Bits { return b.View | b.Write }

// TreeLevel is one node on the way from the top to the node being checked, as far as one
// member is concerned.
type TreeLevel struct {
	Restricted bool       // the node's «Только выбранные»
	Owner      bool       // the member owns this node
	RoleOvs    []Override // the node's overrides of the member's roles, lowest position first
	UserOv     *Override  // the node's override of the member; nil = none
}

// TreeInput is a member and a chain: Raw is the plain OR of the member's roles (ADMINISTRATOR
// not expanded); Chain runs from the topmost ancestor down to the node itself (empty = the root
// of the section). A bot is a member like a person (ADR-0031; ADR-0094 §2 and ADR-0096 §2,
// addendum 2026-10-14): no flag of its own.
type TreeInput struct {
	Raw   Bits
	Guest bool
	Chain []TreeLevel
}

// TreeOf is the workspace-level rule of a section (TS: treePermissions): guests nothing;
// ADMINISTRATOR or MANAGE all three; anyone else (bots included) the section's bits of their
// roles.
func TreeOf(b TreeBits, raw Bits, guest bool) Bits {
	switch {
	case guest:
		return 0
	case raw&(Administrator|b.Manage) != 0:
		return b.All()
	}
	return raw & b.All()
}

// ComputeTree is the one node rule. MANAGE or ADMINISTRATOR (TreeOf; the workspace owner is
// ADMINISTRATOR): everything on nodes outside any restricted node. Otherwise — and for them too
// once the chain has a restricted node (addendum 2026-10-14: «Только выбранные» is not bypassed
// by ADMINISTRATOR, MANAGE or the workspace owner, the ADR-0078 precedent) — the start is the
// member's VIEW | WRITE (none for guests) and at every level, top down: a restricted node drops
// what the roles and the ancestors gave; then each role's override (lowest position first: deny,
// then allow; ignored for guests — they get access only as a person), then the user's own; the
// owner of the level always has VIEW | WRITE. A child inherits its parent's result. Overrides
// touch b.Override() only. Without VIEW nothing (404). Inside a restricted subtree a MANAGE
// holder is an ordinary member (owner, 14.10): let in with «Правка» (WRITE) it gets VIEW | WRITE
// like anyone with that grant, never MANAGE; with «Просмотр», just VIEW.
func ComputeTree(b TreeBits, in TreeInput) Bits {
	ws := TreeOf(b, in.Raw, in.Guest)
	if ws&b.Manage != 0 && !Restricted(in.Chain) {
		return b.All()
	}
	ov := b.Override()
	p := ws & ov
	for i := range in.Chain {
		l := &in.Chain[i]
		if l.Restricted {
			p = 0
		}
		if !in.Guest {
			for _, o := range l.RoleOvs {
				p &^= o.Deny & ov
				p |= o.Allow & ov
			}
		}
		if l.UserOv != nil {
			p &^= l.UserOv.Deny & ov
			p |= l.UserOv.Allow & ov
		}
		if l.Owner {
			p |= ov
		}
	}
	if p&b.View == 0 {
		return 0
	}
	return p
}

// Restricted reports whether a chain runs through a restricted node: the node is private, and
// ADMINISTRATOR / MANAGE / the workspace owner get only what its overrides give them.
func Restricted(chain []TreeLevel) bool {
	for i := range chain {
		if chain[i].Restricted {
			return true
		}
	}
	return false
}

// TreeNode is one node of a chain as stored: its flag, owner and full override list.
type TreeNode struct {
	Restricted bool
	OwnerID    string // user uuid text; "" = none
	Overrides  []OverrideTarget
}

// ComputeTreeIn computes a member's bits on the last node of chain (the topmost first). Mirror
// of treeItemPermissions with override lists.
func ComputeTreeIn(b TreeBits, m Member, chain []TreeNode) Bits {
	var buf [16]TreeLevel
	levels := buf[:0]
	for _, n := range chain {
		l := TreeLevel{Restricted: n.Restricted, Owner: n.OwnerID != "" && n.OwnerID == m.UserID}
		for _, r := range m.Roles { // lowest position first
			for i := range n.Overrides {
				if o := &n.Overrides[i]; o.TargetType == "role" && o.TargetID == r.ID {
					l.RoleOvs = append(l.RoleOvs, o.Override)
					break
				}
			}
		}
		for i := range n.Overrides {
			if o := &n.Overrides[i]; o.TargetType == "user" && o.TargetID == m.UserID {
				l.UserOv = &o.Override
				break
			}
		}
		levels = append(levels, l)
	}
	return ComputeTree(b, TreeInput{Raw: m.Raw(), Guest: m.Role == RoleGuest, Chain: levels})
}

// RestrictedIn reports whether a stored chain runs through a restricted node (Restricted over
// TreeNode): its journal entries are private once it is deleted forever.
func RestrictedIn(chain []TreeNode) bool {
	for i := range chain {
		if chain[i].Restricted {
			return true
		}
	}
	return false
}

// ValidTreeOverride reports whether an allow / deny pair may be stored as a node override of
// the section: only its VIEW and WRITE (never MANAGE, other sections', billing or room bits),
// not both ways.
func ValidTreeOverride(b TreeBits, allow, deny Bits) bool {
	return (allow|deny)&^b.Override() == 0 && allow&deny == 0
}

// Detached is what a node keeps when it leaves its chain for the top of its tree (a private
// subtree detached from a parent its viewer cannot see being trashed, deleted or moved; owner,
// 14.10): its own owner, and a flag and overrides that give, at the top, the access the chain
// gave. A restricted node keeps its own (nothing above it counted). Otherwise the effective part
// of the chain — from the deepest restricted ancestor down, or all of it — is folded into the
// node per target, top down (each level: roles, then people, deny then allow, as ComputeTree
// applies it), the owners of the ancestors in that part as personal allows of b.Override() after
// their level; the node is restricted when that part is. The fold is exact for personal
// overrides and ownership; for a member with several roles whose overrides disagree at different
// levels it may differ from the chain (docs/12).
func Detached(b TreeBits, chain []TreeNode, pin []Member) TreeNode {
	if len(chain) == 0 {
		return TreeNode{}
	}
	last := chain[len(chain)-1]
	if last.Restricted {
		return last
	}
	start := 0
	for i := range chain {
		if chain[i].Restricted {
			start = i
		}
	}
	ov := b.Override()
	type key struct{ t, id string }
	var order []key
	acc := map[key]Override{}
	apply := func(k key, o Override) {
		cur, ok := acc[k]
		if !ok {
			order = append(order, k)
		}
		cur.Allow = (cur.Allow &^ (o.Deny & ov)) | (o.Allow & ov)
		cur.Deny = (cur.Deny &^ (o.Allow & ov)) | (o.Deny & ov)
		acc[k] = cur
	}
	for i := start; i < len(chain); i++ {
		n := &chain[i]
		for _, role := range []bool{true, false} {
			for _, o := range n.Overrides {
				if (o.TargetType == "role") == role {
					apply(key{o.TargetType, o.TargetID}, o.Override)
				}
			}
		}
		if i < len(chain)-1 && n.OwnerID != "" {
			apply(key{"user", n.OwnerID}, Override{Allow: ov})
		}
	}
	out := TreeNode{Restricted: chain[start].Restricted, OwnerID: last.OwnerID}
	for _, k := range order {
		if o := acc[k]; o.Allow|o.Deny != 0 {
			out.Overrides = append(out.Overrides, OverrideTarget{TargetType: k.t, TargetID: k.id, Override: o})
		}
	}
	// Pinned members (the people the chain names, the actor) get exactly what the chain gave
	// them: a personal override is the last word on a single level.
	for _, m := range pin {
		was, now := ComputeTreeIn(b, m, chain), ComputeTreeIn(b, m, []TreeNode{out})
		if was == now || m.UserID == last.OwnerID {
			continue
		}
		o := Override{Allow: was & ov, Deny: ov &^ was}
		i := slices.IndexFunc(out.Overrides, func(x OverrideTarget) bool { return x.TargetType == "user" && x.TargetID == m.UserID })
		if i < 0 {
			out.Overrides = append(out.Overrides, OverrideTarget{TargetType: "user", TargetID: m.UserID, Override: o})
		} else {
			out.Overrides[i].Override = o
		}
	}
	return out
}

// Named are the people a chain names: its owners and personal overrides (the members Detached
// should pin, with the actor).
func Named(chain []TreeNode) []string {
	var out []string
	add := func(id string) {
		if id != "" && !slices.Contains(out, id) {
			out = append(out, id)
		}
	}
	for i := range chain {
		add(chain[i].OwnerID)
		for _, o := range chain[i].Overrides {
			if o.TargetType == "user" {
				add(o.TargetID)
			}
		}
	}
	return out
}

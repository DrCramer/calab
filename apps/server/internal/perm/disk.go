package perm

// Disk bits (ADR-0094 §2). Bits from 1 << 32 on cannot be proto enum values (int32): they are
// listed in the comment of enum Permission (proto/calaba/v1/permissions.proto), docs/04 and the
// TS mirror (DISK_BITS). Workspace-level bits on roles, but unlike billing:
//   - ADMINISTRATOR includes them (DiskOf), although All stops at bit 31 (room and board rules
//     never see them);
//   - per-item overrides (disk_permissions) carry DiskView and DiskWrite (DiskOverride) and
//     nothing else; room and board overrides never carry them (RoomOnly / BoardOnly are within
//     All);
//   - guests and bots get nothing from their roles, only from an explicit user override on an
//     item (or by owning it).
const (
	// DiskView: see the Disk and every item that is not restricted. Member default.
	DiskView Bits = 1 << 35
	// DiskWrite: create folders, upload; rename, move and trash one's own items. Member default.
	DiskWrite Bits = 1 << 36
	// DiskManage: any item, the trash retention, empty the whole trash, remove anyone's public
	// link. Implies View and Write; sees restricted items too.
	DiskManage Bits = 1 << 37

	// Disk are the three disk bits.
	Disk = DiskView | DiskWrite | DiskManage
	// DiskOverride are the bits a disk_permissions row may allow or deny.
	DiskOverride = DiskView | DiskWrite
)

// DiskOf is the workspace-level disk rule (TS: diskPermissions): guests and bots nothing;
// ADMINISTRATOR (raw: the plain OR of the roles, not expanded) or DISK_MANAGE all three;
// anyone else the disk bits of their roles.
func DiskOf(raw Bits, guest, bot bool) Bits {
	switch {
	case guest || bot:
		return 0
	case raw&(Administrator|DiskManage) != 0:
		return Disk
	}
	return raw & Disk
}

// DiskLevel is one item on the way from the root to the item being checked, as far as one
// member is concerned.
type DiskLevel struct {
	Restricted bool       // disk_items.restricted: «Только выбранные»
	Owner      bool       // the member owns this item (disk_items.owner_id)
	RoleOvs    []Override // the item's overrides of the member's roles, lowest position first
	UserOv     *Override  // the item's override of the member; nil = none
}

// ComputeDiskItem is the one item rule (ADR-0094 §2; TS: diskItemPermissions). chain runs from
// the topmost ancestor down to the item itself (empty = the root). DISK_MANAGE or
// ADMINISTRATOR (DiskOf): everything, restricted items included. Otherwise the start is the
// member's DISK_VIEW | DISK_WRITE (none for guests and bots) and at every level, top down:
// a restricted item drops what the roles and the ancestors gave; then each role's override
// (lowest position first: deny, then allow; ignored for guests and bots — they get access only
// as a person), then the user's own; the owner of the level always has VIEW | WRITE. A child
// inherits its parent's result. Overrides touch DiskOverride only. Without DISK_VIEW nothing
// (404).
func ComputeDiskItem(raw Bits, guest, bot bool, chain []DiskLevel) Bits {
	ws := DiskOf(raw, guest, bot)
	if ws&DiskManage != 0 {
		return Disk
	}
	p := ws & DiskOverride
	for i := range chain {
		l := &chain[i]
		if l.Restricted {
			p = 0
		}
		if !guest && !bot {
			for _, o := range l.RoleOvs {
				p &^= o.Deny & DiskOverride
				p |= o.Allow & DiskOverride
			}
		}
		if l.UserOv != nil {
			p &^= l.UserOv.Deny & DiskOverride
			p |= l.UserOv.Allow & DiskOverride
		}
		if l.Owner {
			p |= DiskView | DiskWrite
		}
	}
	if p&DiskView == 0 {
		return 0
	}
	return p
}

// DiskNode is one item of a chain as stored: its flag, owner and full override list.
type DiskNode struct {
	Restricted bool
	OwnerID    string // user uuid text; "" = none
	Overrides  []OverrideTarget
}

// ComputeDiskItemIn computes a member's bits on the last item of chain (root's child first);
// bot: the member is a bot account. Mirror of diskItemPermissions with overrides lists.
func ComputeDiskItemIn(m Member, bot bool, chain []DiskNode) Bits {
	var buf [16]DiskLevel
	levels := buf[:0]
	for _, n := range chain {
		l := DiskLevel{Restricted: n.Restricted, Owner: n.OwnerID != "" && n.OwnerID == m.UserID}
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
	return ComputeDiskItem(m.Raw(), m.Role == RoleGuest, bot, levels)
}

// ValidDiskOverride reports whether an allow / deny pair may be stored in disk_permissions:
// only DISK_VIEW and DISK_WRITE (never DISK_MANAGE, billing or room bits), not both ways.
func ValidDiskOverride(allow, deny Bits) bool {
	return (allow|deny)&^DiskOverride == 0 && allow&deny == 0
}

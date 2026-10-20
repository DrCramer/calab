package rooms

import (
	"context"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/perm"
)

// Links of a temporary room across its archive and its conversion (ADR-0107): the archive marks
// the links it revoked (archive_revoked); restore and make permanent bring them back.

// linkPolicy is what the caller of restore / make permanent may bring back: guest-capable links
// (not members_only) only with INVITE_GUESTS at workspace level, as when creating them (not a
// bot, ADR-0031; a verified email where required, ADR-0023 / ADR-0065); no link with bits the
// caller does not hold (no escalation through links).
type linkPolicy struct {
	guests bool
	bits   perm.Bits
	admin  bool
}

// mayRevive reports whether the caller may bring this link back.
func (p linkPolicy) mayRevive(i sqlc.RoomInvite) bool {
	if !i.MembersOnly && !p.guests {
		return false
	}
	b := perm.Bits(uint64(i.AllowBits)) //nolint:gosec // bit mask
	return p.admin || b&^p.bits == 0
}

// linkPolicyOf resolves the caller's linkPolicy for a temporary room.
func (h *Handlers) linkPolicyOf(r *http.Request, acc perm.RoomAccess) linkPolicy {
	ctx := r.Context()
	p := linkPolicy{bits: acc.Bits, admin: acc.Bits.Has(perm.Administrator)}
	if acc.Role == perm.RoleGuest || auth.IsBotRequest(r) || !acc.Member.Workspace().Has(perm.InviteGuests) {
		return p
	}
	if _, err := h.EmailGate.User(ctx, h.db.Q, auth.MustFromContext(ctx).UserID); err != nil {
		return p // an unverified address hands out no guest link (the members-only ones still come back)
	}
	p.guests = true
	return p
}

// revivedExpiry is the end of a link brought back (ADR-0107): bound to the room (its end ≤ the
// room's old end) → the room's new end; its own end otherwise while still ahead, else the room's
// new end. newEnd nil = the room became permanent (never).
func revivedExpiry(link *time.Time, oldEnd time.Time, newEnd *time.Time, now time.Time) *time.Time {
	switch {
	case link == nil:
		return nil
	case !link.After(oldEnd), !link.After(now):
		return newEnd
	}
	return link
}

// reviveLinks brings back the archive-revoked links of a temporary room the caller may revive
// and settles the rest as revoked for good (the restore is where that is decided). Meeting
// links and exhausted ones never come back. Reports how many came back. Inside the transaction
// that restores / converts the room (locked).
func reviveLinks(ctx context.Context, q *sqlc.Queries, roomID uuid.UUID, oldEnd time.Time, newEnd *time.Time, p linkPolicy) (int, error) {
	links, err := q.ListArchiveRevokedInvites(ctx, roomID)
	if err != nil {
		return 0, err
	}
	now := time.Now()
	n := 0
	for _, i := range links {
		if !p.mayRevive(i) {
			continue
		}
		if err := q.ReviveRoomInvite(ctx, sqlc.ReviveRoomInviteParams{ID: i.ID, ExpiresAt: revivedExpiry(i.ExpiresAt, oldEnd, newEnd, now)}); err != nil {
			return n, err
		}
		n++
	}
	return n, q.SettleArchiveRevokedInvites(ctx, roomID)
}

// unboundLinks: a live temporary room made permanent — its links bound to its end never expire
// (guest-capable ones only when the caller may invite guests, and only links with rights the
// caller holds, as for reviving; the others keep their end).
func unboundLinks(ctx context.Context, q *sqlc.Queries, roomID uuid.UUID, oldEnd time.Time, p linkPolicy) error {
	return q.UnboundRoomInvites(ctx, sqlc.UnboundRoomInvitesParams{RoomID: roomID, OldExpiresAt: &oldEnd, GuestLinks: p.guests,
		Admin: p.admin, CallerBits: int64(p.bits)}) //nolint:gosec // bit mask
}

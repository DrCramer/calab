package rooms

import (
	"context"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/perm"
)

// tempChange is the temporary-room part of PATCH /api/rooms/{id} (ADR-0044), validated.
type tempChange struct {
	expires   *time.Time  // a new end
	permanent bool        // make_permanent
	links     *linkPolicy // make_permanent: the links bound to the end never expire (nil: they keep it)
}

func (t tempChange) any() bool { return t.expires != nil || t.permanent }

// tempPatch validates the temporary-room fields of a PATCH: temporary rooms only; a new end in
// (now, now + 7 days]; make_permanent needs the real MANAGE_ROOM (the creator's implicit right
// must not turn into a permanent room without it).
func tempPatch(req *v1.UpdateRoomRequest, acc perm.RoomAccess, now time.Time) (tempChange, error) {
	var t tempChange
	if !acc.Temp {
		switch {
		case req.ExpiresAt != nil:
			return t, httpx.Validation("expiresAt", "temporary rooms only")
		case req.GetMakePermanent():
			return t, httpx.Validation("makePermanent", "temporary rooms only")
		}
		return t, nil
	}
	if req.CategoryId != nil {
		return t, httpx.Validation("categoryId", "temporary rooms have no category")
	}
	if req.ExpiresAt != nil {
		if req.GetMakePermanent() {
			return t, httpx.Validation("expiresAt", "expiresAt and makePermanent exclude each other")
		}
		if err := req.GetExpiresAt().CheckValid(); err != nil {
			return t, httpx.Validation("expiresAt", "invalid time")
		}
		e := req.GetExpiresAt().AsTime().Truncate(time.Second)
		if !e.After(now) || e.After(now.Add(MaxTempTTL)) {
			return t, httpx.Validation("expiresAt", "the end must be in the future and at most 7 days from now")
		}
		t.expires = &e
	}
	if req.GetMakePermanent() {
		if !acc.Bits.Has(perm.ManageRoom) {
			return t, httpx.Forbidden("MANAGE_ROOM required to make a temporary room permanent")
		}
		t.permanent = true
	}
	return t, nil
}

// applyTempPatch applies a validated tempChange to cur (locked) inside the PATCH transaction.
func (h *Handlers) applyTempPatch(ctx context.Context, q *sqlc.Queries, cur sqlc.Room, t tempChange) (func(context.Context), error) {
	var publish func(context.Context)
	if !t.any() {
		return nil, nil
	}
	if cur.ExpiresAt == nil || cur.WorkspaceID == nil { // made permanent meanwhile
		return nil, httpx.Validation("expiresAt", "temporary rooms only")
	}
	if t.permanent && t.links != nil {
		if err := unboundLinks(ctx, q, cur.ID, *cur.ExpiresAt, *t.links); err != nil {
			return nil, err
		}
	}
	if t.expires != nil || t.permanent {
		if _, err := q.SetRoomExpiry(ctx, sqlc.SetRoomExpiryParams{ID: cur.ID, ExpiresAt: t.expires}); err != nil {
			return nil, err
		}
		if t.expires != nil {
			if err := q.FollowRoomExpiry(ctx, sqlc.FollowRoomExpiryParams{RoomID: cur.ID, ExpiresAt: t.expires, OldExpiresAt: cur.ExpiresAt}); err != nil {
				return nil, err
			}
			// The room's meeting that ended with it follows too (a hand-edited one stays).
			if h.Meetings != nil {
				var err error
				if publish, err = h.Meetings.FollowRoomExpiry(ctx, q, cur.ID, *cur.ExpiresAt, *t.expires); err != nil {
					return nil, err
				}
			}
		}
	}
	return publish, nil
}

// privacyPatch reads the private / public switch of a PATCH (ADR-0078 addendum 2026-10-14):
// is_private, with restricted as its alias (both given: they must agree).
func privacyPatch(req *v1.UpdateRoomRequest) (*bool, error) {
	switch {
	case req.IsPrivate != nil && req.Restricted != nil && req.GetIsPrivate() != req.GetRestricted():
		return nil, httpx.Validation("restricted", "restricted is an alias of isPrivate: they must agree")
	case req.IsPrivate != nil:
		return req.IsPrivate, nil
	}
	return req.Restricted, nil
}

// applyPrivate makes a locked live room private or public (ADR-0078 addendum 2026-10-14):
// is_private and restricted together, the member role's VIEW_ROOM deny; a room made private
// keeps the caller with the room bits they had (a personal allow of their bits within RoomOnly:
// an admin keeps managing it; the creator of a temporary room, who manages it as its creator
// without MANAGE_ROOM, gets none this way) and its creator (VIEW_ROOM). Text and voice rooms only.
func applyPrivate(ctx context.Context, q *sqlc.Queries, cur sqlc.Room, private bool, me uuid.UUID, acc perm.RoomAccess) error {
	if cur.Type != "text" && cur.Type != "voice" {
		return httpx.Validation("isPrivate", "only text and voice rooms can be private")
	}
	if cur.WorkspaceID == nil {
		return httpx.NotFound("room")
	}
	if _, err := q.SetRoomPrivate(ctx, sqlc.SetRoomPrivateParams{ID: cur.ID, IsPrivate: private}); err != nil {
		return err
	}
	if err := setPrivate(ctx, q, *cur.WorkspaceID, cur.ID, private); err != nil {
		return err
	}
	if !private {
		return nil
	}
	if !acc.Member.SeesPrivate() {
		if err := q.GrantUserOverride(ctx, sqlc.GrantUserOverrideParams{
			RoomID: cur.ID, UserID: me.String(), Allow: int64(perm.ViewRoom | acc.Bits&perm.RoomOnly), //nolint:gosec // bit mask
		}); err != nil {
			return err
		}
	}
	if cur.CreatedBy != nil && *cur.CreatedBy != me {
		return q.GrantUserOverride(ctx, sqlc.GrantUserOverrideParams{RoomID: cur.ID, UserID: cur.CreatedBy.String(), Allow: int64(perm.ViewRoom)})
	}
	return nil
}

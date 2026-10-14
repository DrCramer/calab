package rooms

import (
	"context"
	"slices"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/perm"
)

// invited are the people and roles let into a new private room (CreateRoomRequest.member_ids /
// role_ids, ADR-0078 addendum 2026-10-14).
type invited struct {
	users []uuid.UUID
	roles []uuid.UUID
}

// maxInvitees bounds member_ids + role_ids of one request.
const maxInvitees = 500

// invitees validates the invited of a new private room: members of the workspace, and roles of
// the workspace other than the built-in owner, admin and guest ones (422 otherwise).
func invitees(ctx context.Context, q *sqlc.Queries, wsID uuid.UUID, userIDs, roleIDs []string) (invited, error) {
	var out invited
	if len(userIDs)+len(roleIDs) == 0 {
		return out, nil
	}
	if len(userIDs)+len(roleIDs) > maxInvitees {
		return out, httpx.Validation("memberIds", "too many invited members and roles")
	}
	for _, s := range userIDs {
		id, err := uuid.Parse(s)
		if err != nil {
			return out, httpx.Validation("memberIds", "invalid member id")
		}
		if slices.Contains(out.users, id) {
			continue
		}
		if _, err := q.GetMember(ctx, sqlc.GetMemberParams{WorkspaceID: wsID, UserID: id}); err != nil {
			if db.IsNotFound(err) {
				return out, httpx.Validation("memberIds", "not a member of the workspace")
			}
			return out, err
		}
		out.users = append(out.users, id)
	}
	if len(roleIDs) == 0 {
		return out, nil
	}
	roles, err := q.ListWorkspaceRoles(ctx, wsID)
	if err != nil {
		return out, err
	}
	for _, s := range roleIDs {
		id, err := uuid.Parse(s)
		if err != nil {
			return out, httpx.Validation("roleIds", "invalid role id")
		}
		i := slices.IndexFunc(roles, func(r sqlc.WorkspaceRole) bool { return r.ID == id })
		if i < 0 {
			return out, httpx.Validation("roleIds", "not a role of the workspace")
		}
		if roles[i].Builtin != nil {
			// owner / admin / guest by design; member is everyone (its deny makes the room private).
			return out, httpx.Validation("roleIds", "built-in roles cannot be invited")
		}
		if !slices.Contains(out.roles, id) {
			out.roles = append(out.roles, id)
		}
	}
	return out, nil
}

// grant gives the invited VIEW_ROOM in the room: a personal allow, a role allow.
func (in invited) grant(ctx context.Context, q *sqlc.Queries, roomID uuid.UUID) error {
	for _, u := range in.users {
		if err := q.GrantUserOverride(ctx, sqlc.GrantUserOverrideParams{RoomID: roomID, UserID: u.String(), Allow: int64(perm.ViewRoom)}); err != nil {
			return err
		}
	}
	for _, r := range in.roles {
		if err := q.GrantRoleOverride(ctx, sqlc.GrantRoleOverrideParams{RoomID: roomID, RoleID: r.String(), Allow: int64(perm.ViewRoom)}); err != nil {
			return err
		}
	}
	return nil
}

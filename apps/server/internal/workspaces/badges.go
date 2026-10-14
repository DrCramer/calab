package workspaces

import (
	"context"
	"net/http"
	"strconv"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
)

// Member badges (docs/09 #82): a workspace library of small square pictures (a partner's logo
// next to a member's name) and one badge per member.
const (
	MaxBadges       = 20
	MaxBadgeBytes   = 128 << 10
	MaxBadgeSide    = 256
	maxBadgeNameLen = 32
)

func (h *Handlers) badgeRoutes(handle func(string, httpx.HandlerFunc)) {
	handle("GET /api/workspaces/{id}/badges", h.listBadges)
	handle("POST /api/workspaces/{id}/badges", h.createBadge)
	handle("PATCH /api/workspaces/{id}/badges/{badgeId}", h.updateBadge)
	handle("DELETE /api/workspaces/{id}/badges/{badgeId}", h.deleteBadge)
	handle("PUT /api/workspaces/{id}/members/{userId}/badge", h.setMemberBadge)
}

func badgeEvent(b sqlc.WorkspaceBadge, created bool) *v1.DispatchEvent {
	if created {
		return &v1.DispatchEvent{Event: &v1.DispatchEvent_BadgeCreate{BadgeCreate: &v1.BadgeCreate{Badge: pbconv.Badge(b)}}}
	}
	return &v1.DispatchEvent{Event: &v1.DispatchEvent_BadgeUpdate{BadgeUpdate: &v1.BadgeUpdate{Badge: pbconv.Badge(b)}}}
}

func memberUpdateEvent(pb *v1.WorkspaceMember) *v1.DispatchEvent {
	return &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceMemberUpdate{WorkspaceMemberUpdate: &v1.WorkspaceMemberUpdate{Member: pb}}}
}

// badgeName: 1..32 characters, no control characters (the same rule as role names).
func badgeName(s string) (string, error) {
	n, err := validateRoleName(s)
	if err != nil {
		return "", httpx.Validation("name", "name must be 1.."+strconv.Itoa(maxBadgeNameLen)+" characters without control characters")
	}
	return n, nil
}

// badgeFile checks the picture: an image the caller uploaded to this workspace (PNG / WebP /
// JPEG, ≤ 128 KB, ≤ 256×256 as measured at upload), not a sticker's file. A badge makes its file
// readable by every member (files.CanRead), so someone else's file (e.g. an attachment of a
// restricted room) must not become one; a sticker's file is deleted with its sticker.
func badgeFile(ctx context.Context, q *sqlc.Queries, wsID, caller uuid.UUID, raw string) (uuid.UUID, error) {
	bad := httpx.Validation("fileId", "a PNG, WebP or JPEG image you uploaded to this workspace, at most 128 KB and 256×256")
	id, err := uuid.Parse(raw)
	if err != nil {
		return uuid.Nil, bad
	}
	f, err := q.GetFile(ctx, id)
	if db.IsNotFound(err) {
		return uuid.Nil, bad
	}
	if err != nil {
		return uuid.Nil, err
	}
	switch {
	case f.WorkspaceID == nil || *f.WorkspaceID != wsID || (f.UploaderID == nil || *f.UploaderID != caller):
		return uuid.Nil, bad
	case f.Mime != "image/png" && f.Mime != "image/webp" && f.Mime != "image/jpeg":
		return uuid.Nil, bad
	case f.Size > MaxBadgeBytes:
		return uuid.Nil, bad
	case f.Width == nil || f.Height == nil || *f.Width < 1 || *f.Height < 1 || *f.Width > MaxBadgeSide || *f.Height > MaxBadgeSide:
		return uuid.Nil, bad
	}
	if _, err := q.GetStickerFileWorkspace(ctx, id); err == nil {
		return uuid.Nil, bad
	} else if !db.IsNotFound(err) {
		return uuid.Nil, err
	}
	return id, nil
}

func loadBadge(r *http.Request, q *sqlc.Queries, wsID uuid.UUID) (sqlc.WorkspaceBadge, error) {
	id, err := httpx.PathUUID(r, "badgeId", "badge")
	if err != nil {
		return sqlc.WorkspaceBadge{}, err
	}
	b, err := q.GetWorkspaceBadge(r.Context(), sqlc.GetWorkspaceBadgeParams{ID: id, WorkspaceID: wsID})
	if db.IsNotFound(err) {
		return b, httpx.NotFound("badge")
	}
	return b, err
}

// listBadges: GET /api/workspaces/{id}/badges (any member).
func (h *Handlers) listBadges(w http.ResponseWriter, r *http.Request) error {
	wsID, _, _, err := access(r)
	if err != nil {
		return err
	}
	rows, err := h.db.Q.ListWorkspaceBadges(r.Context(), wsID)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.ListBadgesResponse{Badges: pbconv.Badges(rows)})
	return nil
}

// createBadge: POST /api/workspaces/{id}/badges (MANAGE_MEMBERS, ADR-0048).
func (h *Handlers) createBadge(w http.ResponseWriter, r *http.Request) error {
	wsID, _, err := requireMembers(r)
	if err != nil {
		return err
	}
	var req v1.CreateBadgeRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	name, err := badgeName(req.GetName())
	if err != nil {
		return err
	}
	var created sqlc.WorkspaceBadge
	err = h.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		if err := q.LockWorkspaceBadges(r.Context(), wsID); err != nil {
			return err
		}
		n, err := q.CountWorkspaceBadges(r.Context(), wsID)
		if err != nil {
			return err
		}
		if n >= MaxBadges {
			return httpx.Conflict("a workspace has at most " + strconv.Itoa(MaxBadges) + " badges")
		}
		fileID, err := badgeFile(r.Context(), q, wsID, uid(r), req.GetFileId())
		if err != nil {
			return err
		}
		created, err = q.InsertWorkspaceBadge(r.Context(), sqlc.InsertWorkspaceBadgeParams{WorkspaceID: wsID, Name: name, FileID: fileID})
		return err
	})
	if err != nil {
		return err
	}
	h.events.Workspace(r.Context(), wsID, badgeEvent(created, true))
	httpx.Write(w, http.StatusCreated, &v1.CreateBadgeResponse{Badge: pbconv.Badge(created)})
	return nil
}

// updateBadge: PATCH /api/workspaces/{id}/badges/{badgeId} (MANAGE_MEMBERS, ADR-0048).
func (h *Handlers) updateBadge(w http.ResponseWriter, r *http.Request) error {
	wsID, _, err := requireMembers(r)
	if err != nil {
		return err
	}
	var req v1.UpdateBadgeRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	cur, err := loadBadge(r, h.db.Q, wsID)
	if err != nil {
		return err
	}
	p := sqlc.UpdateWorkspaceBadgeParams{ID: cur.ID, WorkspaceID: wsID}
	if req.Name != nil {
		n, err := badgeName(req.GetName())
		if err != nil {
			return err
		}
		p.Name = &n
	}
	if req.FileId != nil {
		id, err := badgeFile(r.Context(), h.db.Q, wsID, uid(r), req.GetFileId())
		if err != nil {
			return err
		}
		p.FileID = &id
	}
	updated, err := db.GuardValue(r.Context(), h.db, func(guarded *sqlc.Queries) (sqlc.WorkspaceBadge, error) {
		return guarded.UpdateWorkspaceBadge(r.Context(), p)
	})
	if db.IsNotFound(err) {
		return httpx.NotFound("badge")
	}
	if err != nil {
		return err
	}
	// The previous picture is now unreferenced and is removed by the orphan cleanup.
	h.events.Workspace(r.Context(), wsID, badgeEvent(updated, false))
	httpx.Write(w, http.StatusOK, &v1.UpdateBadgeResponse{Badge: pbconv.Badge(updated)})
	return nil
}

// deleteBadge: DELETE /api/workspaces/{id}/badges/{badgeId} (MANAGE_MEMBERS, ADR-0048): its members
// lose it (WORKSPACE_MEMBER_UPDATE each), then BADGE_DELETE.
func (h *Handlers) deleteBadge(w http.ResponseWriter, r *http.Request) error {
	wsID, _, err := requireMembers(r)
	if err != nil {
		return err
	}
	cur, err := loadBadge(r, h.db.Q, wsID)
	if err != nil {
		return err
	}
	var cleared []sqlc.WorkspaceMember
	err = h.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		var err error
		if cleared, err = q.ClearBadgeFromMembers(r.Context(), &cur.ID); err != nil {
			return err
		}
		n, err := q.DeleteWorkspaceBadge(r.Context(), sqlc.DeleteWorkspaceBadgeParams{ID: cur.ID, WorkspaceID: wsID})
		if err != nil {
			return err
		}
		if n == 0 {
			return httpx.NotFound("badge")
		}
		return nil
	})
	if err != nil {
		return err
	}
	evs := make([]*v1.DispatchEvent, 0, len(cleared)+1)
	for _, m := range cleared {
		pb, err := h.memberPB(r.Context(), m)
		if err != nil {
			return err
		}
		evs = append(evs, memberUpdateEvent(pb))
	}
	evs = append(evs, &v1.DispatchEvent{Event: &v1.DispatchEvent_BadgeDelete{
		BadgeDelete: &v1.BadgeDelete{WorkspaceId: wsID.String(), BadgeId: cur.ID.String()},
	}})
	h.events.WorkspaceEvents(r.Context(), wsID, evs)
	httpx.NoContent(w)
	return nil
}

// setMemberBadge: PUT /api/workspaces/{id}/members/{userId}/badge (MANAGE_NICKNAMES, like a
// nickname or birthday set by an admin; not on a member at or above the caller's highest role;
// bots have no badge).
func (h *Handlers) setMemberBadge(w http.ResponseWriter, r *http.Request) error {
	wsID, bits, _, err := access(r)
	if err != nil {
		return err
	}
	if !bits.Has(perm.ManageNicknames) {
		return httpx.Forbidden("MANAGE_NICKNAMES required")
	}
	target, err := targetUser(r)
	if err != nil {
		return err
	}
	var req v1.SetMemberBadgeRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	if _, err := h.db.Q.GetMember(r.Context(), sqlc.GetMemberParams{WorkspaceID: wsID, UserID: target}); db.IsNotFound(err) {
		return httpx.NotFound("member")
	} else if err != nil {
		return err
	}
	tu, err := h.db.Q.GetUser(r.Context(), target)
	if err != nil {
		return err
	}
	if tu.IsBot {
		return httpx.Forbidden("bots have no badge") // ADR-0031
	}
	if target != uid(r) {
		if err := outranks(r, wsID, target); err != nil {
			return err
		}
	}
	var badgeID *uuid.UUID
	if req.GetBadgeId() != "" {
		id, err := uuid.Parse(req.GetBadgeId())
		if err != nil {
			return httpx.Validation("badgeId", "unknown badge")
		}
		if _, err := h.db.Q.GetWorkspaceBadge(r.Context(), sqlc.GetWorkspaceBadgeParams{ID: id, WorkspaceID: wsID}); db.IsNotFound(err) {
			return httpx.Validation("badgeId", "unknown badge")
		} else if err != nil {
			return err
		}
		badgeID = &id
	}
	m, err := db.GuardValue(r.Context(), h.db, func(guarded *sqlc.Queries) (sqlc.WorkspaceMember, error) {
		return guarded.SetMemberBadge(r.Context(), sqlc.SetMemberBadgeParams{WorkspaceID: wsID, UserID: target, BadgeID: badgeID})
	})
	if db.IsNotFound(err) {
		return httpx.NotFound("member")
	}
	if db.IsForeignKeyViolation(err) { // deleted meanwhile
		return httpx.Validation("badgeId", "unknown badge")
	}
	if err != nil {
		return err
	}
	pb, err := MemberPB(r.Context(), h.db.Q, m, tu)
	if err != nil {
		return err
	}
	h.events.Workspace(r.Context(), wsID, memberUpdateEvent(pb))
	httpx.Write(w, http.StatusOK, &v1.SetMemberBadgeResponse{Member: pb})
	return nil
}

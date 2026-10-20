package canvas

import (
	"net/http"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/canvasacl"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
)

// MaxOverrides bounds the overrides of one item.
const MaxOverrides = 100

// getPermissions: GET /api/canvas/items/{id}/permissions (the owner or CANVAS_MANAGE).
func (s *Service) getPermissions(w http.ResponseWriter, r *http.Request) error {
	a, err := s.pathItem(r)
	if err != nil {
		return err
	}
	if !a.structure() {
		return errNotStructure
	}
	out := &v1.CanvasPermissionsResponse{Restricted: a.item.Restricted}
	for _, o := range a.chain.Overrides(a.item.ID) {
		out.Entries = append(out.Entries, canvasacl.Entry(o))
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// setPermissions: PUT /api/canvas/items/{id}/permissions — replaces the item's overrides
// (CANVAS_VIEW / CANVAS_WRITE only; roles of the workspace except the guest role, members as users —
// guests only this way) and optionally the restricted switch. The owner or CANVAS_MANAGE.
func (s *Service) setPermissions(w http.ResponseWriter, r *http.Request) error {
	id, err := httpx.PathUUID(r, "id", "item")
	if err != nil {
		return err
	}
	var req v1.UpdateCanvasPermissionsRequest
	if err := httpx.DecodeStrict(w, r, &req); err != nil {
		return err
	}
	if len(req.GetEntries()) > MaxOverrides {
		return httpx.Validation("entries", "at most 100")
	}
	type entry struct {
		tt, id      string
		allow, deny perm.Bits
	}
	entries := make([]entry, 0, len(req.GetEntries()))
	seen := map[string]bool{}
	for _, e := range req.GetEntries() {
		tt, ok := pbconv.TargetTypeToDB(e.GetTargetType())
		if !ok {
			return httpx.Validation("entries.target_type", "must be ROLE or USER")
		}
		tid, err := uuid.Parse(e.GetTargetId())
		if err != nil {
			return httpx.Validation("entries.target_id", "must be an id")
		}
		allow, deny := perm.Bits(e.GetAllow()), perm.Bits(e.GetDeny())
		if !perm.ValidCanvasOverride(allow, deny) {
			return httpx.Validation("entries.allow", "only CANVAS_VIEW and CANVAS_WRITE, not both allowed and denied")
		}
		k := tt + ":" + tid.String()
		if seen[k] {
			return httpx.Validation("entries", "one entry per target")
		}
		seen[k] = true
		if allow == 0 && deny == 0 {
			continue
		}
		entries = append(entries, entry{tt, tid.String(), allow, deny})
	}
	ctx := r.Context()
	var before []perm.TreeNode
	var out *v1.CanvasPermissionsResponse
	var a access
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if a, err = resolve(r, q, id); err != nil {
			return err
		}
		ws := a.item.WorkspaceID
		if err := writable(ctx, q, ws); err != nil {
			return err
		}
		if !a.structure() {
			return errNotStructure
		}
		if a.item.TrashedAt != nil {
			return errTrashed
		}
		// The tree lock before the row lock (like update): a public link made meanwhile below a
		// folder turned restricted here would outlive dropLinks.
		if req.Restricted != nil {
			if err := q.LockCanvasTree(ctx, ws); err != nil {
				return err
			}
		}
		if _, err := q.GetCanvasItemForUpdate(ctx, id); err != nil {
			return err
		}
		var roles map[string]sqlc.WorkspaceRole
		for _, e := range entries {
			switch e.tt {
			case "role":
				if roles == nil {
					rs, err := q.ListWorkspaceRoles(ctx, ws)
					if err != nil {
						return err
					}
					roles = map[string]sqlc.WorkspaceRole{}
					for _, r := range rs {
						roles[r.ID.String()] = r
					}
				}
				role, ok := roles[e.id]
				if !ok {
					return httpx.Validation("entries.target_id", "not a role of the workspace")
				}
				if role.Builtin != nil && *role.Builtin == string(perm.RoleGuest) {
					return httpx.Validation("entries.target_id", "guests get access only as people")
				}
			case "user":
				if _, err := q.GetMember(ctx, sqlc.GetMemberParams{WorkspaceID: ws, UserID: uuid.MustParse(e.id)}); err != nil {
					if db.IsNotFound(err) {
						return httpx.Validation("entries.target_id", "not a member of the workspace")
					}
					return err
				}
			}
		}
		before = a.nodes()
		oldOvs := a.chain.Overrides(id)
		if err := q.DeleteCanvasPermissions(ctx, id); err != nil {
			return err
		}
		for _, e := range entries {
			if err := q.InsertCanvasPermission(ctx, sqlc.InsertCanvasPermissionParams{CanvasID: id, TargetType: e.tt, TargetID: e.id,
				Allow: int64(e.allow), Deny: int64(e.deny)}); err != nil { //nolint:gosec // bit masks ≤ 1 << 43
				return err
			}
		}
		restricted := a.item.Restricted
		if req.Restricted != nil {
			restricted = req.GetRestricted()
		}
		row, err := q.UpdateCanvasItem(ctx, sqlc.UpdateCanvasItemParams{ID: id, Restricted: &restricted, UpdatedBy: &a.c.uid})
		if err != nil {
			return err
		}
		if restricted && !a.item.Restricted {
			if err := dropLinks(ctx, q, id); err != nil { // made private: its public links go (ADR-0115 wave 5)
				return err
			}
		}
		ch, err := canvasacl.Load(ctx, q, []uuid.UUID{id})
		if err != nil {
			return err
		}
		b, err := sharing(ctx, q, ws, a.item.Restricted, oldOvs)
		if err != nil {
			return err
		}
		af, err := sharing(ctx, q, ws, row.Restricted, ch.Overrides(id))
		if err != nil {
			return err
		}
		if err := s.journal(ctx, q, head(row), &a.c.uid, "share", b, af); err != nil {
			return err
		}
		out = &v1.CanvasPermissionsResponse{Restricted: row.Restricted}
		for _, o := range ch.Overrides(id) {
			out.Entries = append(out.Entries, canvasacl.Entry(o))
		}
		return nil
	})
	if err != nil {
		return err
	}
	s.upserted(ctx, id, before)
	s.recheckBelow(ctx, id)
	httpx.Write(w, http.StatusOK, out)
	return nil
}

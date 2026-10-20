package canvas

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/canvasacl"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/perm"
)

// MaxTrashDays bounds canvas_trash_days (the CHECK of migration 00103).
const MaxTrashDays = 3650

// settings: GET /api/workspaces/{id}/canvas/settings (members).
func (s *Service) settings(w http.ResponseWriter, r *http.Request) error {
	ws, _, err := pathWorkspace(r)
	if err != nil {
		return err
	}
	days, err := s.db.Q.GetCanvasTrashDays(r.Context(), ws)
	if err != nil {
		return err
	}
	out := &v1.CanvasSettings{}
	if days != nil {
		out.TrashDays = uint32(max(*days, 0)) //nolint:gosec // ≤ MaxTrashDays
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// setSettings: PUT /api/workspaces/{id}/canvas/settings (CANVAS_MANAGE) — the trash retention.
func (s *Service) setSettings(w http.ResponseWriter, r *http.Request) error {
	ws, c, err := pathWorkspace(r)
	if err != nil {
		return err
	}
	var req v1.CanvasSettings
	if err := httpx.DecodeStrict(w, r, &req); err != nil {
		return err
	}
	if req.GetTrashDays() > MaxTrashDays {
		return httpx.Validation("trash_days", "must be 0..3650")
	}
	if !c.wsBits().Has(perm.CanvasManage) {
		return httpx.Forbidden("CANVAS_MANAGE required")
	}
	ctx := r.Context()
	if err := writable(ctx, s.db.Q, ws); err != nil {
		return err
	}
	var days *int32
	if req.GetTrashDays() > 0 {
		d := int32(req.GetTrashDays()) //nolint:gosec // ≤ MaxTrashDays
		days = &d
	}
	if err := db.GuardExec(ctx, s.db, func(q *sqlc.Queries) error {
		return q.SetCanvasTrashDays(ctx, sqlc.SetCanvasTrashDaysParams{ID: ws, Days: days})
	}); err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.CanvasSettings{TrashDays: req.GetTrashDays()})
	return nil
}

// activityPage reads ?cursor= (the last entry id) and ?limit= (1..100, default 50).
func activityPage(r *http.Request) (*uuid.UUID, int, error) {
	cur, err := optUUID(r.URL.Query().Get("cursor"), "cursor")
	if err != nil {
		return nil, 0, err
	}
	limit, err := pageLimit(r, 50, 100)
	return cur, limit, err
}

func writeActivity(w http.ResponseWriter, rows []sqlc.CanvasActivity, limit int) {
	out := &v1.CanvasActivityPage{}
	if len(rows) > limit {
		rows = rows[:limit]
		out.NextCursor = rows[limit-1].ID.String()
	}
	for _, a := range rows {
		out.Activities = append(out.Activities, activityProto(a))
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.Write(w, http.StatusOK, out)
}

// itemActivity: GET /api/canvas/items/{id}/activity?cursor=&limit= — the item's history, the
// newest first (CANVAS_VIEW on the item).
func (s *Service) itemActivity(w http.ResponseWriter, r *http.Request) error {
	a, err := s.pathItem(r)
	if err != nil {
		return err
	}
	cur, limit, err := activityPage(r)
	if err != nil {
		return err
	}
	rows, err := s.db.Q.ListCanvasItemActivity(r.Context(), sqlc.ListCanvasItemActivityParams{ItemID: a.item.ID, Cursor: cur, Lim: int32(limit + 1)}) //nolint:gosec // ≤ 101
	if err != nil {
		return err
	}
	if err := hidePlaces(r.Context(), s.db.Q, a.c, rows); err != nil {
		return err
	}
	writeActivity(w, rows, limit)
	return nil
}

// workspaceActivity: GET /api/workspaces/{id}/canvas/activity?actor=&cursor=&limit= — the history
// of the whole Canvas section (CANVAS_MANAGE).
func (s *Service) workspaceActivity(w http.ResponseWriter, r *http.Request) error {
	ws, c, err := pathWorkspace(r)
	if err != nil {
		return err
	}
	if !c.wsBits().Has(perm.CanvasManage) {
		return httpx.Forbidden("CANVAS_MANAGE required")
	}
	actor, err := optUUID(r.URL.Query().Get("actor"), "actor")
	if err != nil {
		return err
	}
	cur, limit, err := activityPage(r)
	if err != nil {
		return err
	}
	ctx, q := r.Context(), s.db.Q
	// Entries of items the caller does not see (restricted ones: CANVAS_MANAGE and ADMINISTRATOR
	// do not see them, addendum 2026-10-14) are left out; a page of the journal is read again past them, a few
	// times at most, so that a long private stretch does not end the listing early.
	out := &v1.CanvasActivityPage{}
	var shown []sqlc.CanvasActivity
	for range activityRounds {
		rows, err := q.ListWorkspaceCanvasActivity(ctx, sqlc.ListWorkspaceCanvasActivityParams{WorkspaceID: ws, ActorID: actor, Cursor: cur, Lim: int32(limit + 1)}) //nolint:gosec // ≤ 101
		if err != nil {
			return err
		}
		seen, err := visibleActivity(ctx, q, c, rows)
		if err != nil {
			return err
		}
		shown = append(shown, seen...)
		if len(rows) <= limit {
			out.NextCursor = ""
			break
		}
		cur = &rows[len(rows)-1].ID
		out.NextCursor = cur.String()
		if len(shown) > limit {
			break
		}
	}
	if len(shown) > limit {
		shown = shown[:limit]
		out.NextCursor = shown[limit-1].ID.String()
	}
	if err := hidePlaces(ctx, q, c, shown); err != nil {
		return err
	}
	for _, a := range shown {
		out.Activities = append(out.Activities, activityProto(a))
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// activityRounds bounds the reads of one workspace journal page past entries the caller does
// not see.
const activityRounds = 5

// visibleActivity keeps the entries of items the caller sees (CANVAS_VIEW on the item now); an
// entry of an item deleted forever stays unless it was in a restricted subtree (private).
func visibleActivity(ctx context.Context, q *sqlc.Queries, c caller, rows []sqlc.CanvasActivity) ([]sqlc.CanvasActivity, error) {
	var ids []uuid.UUID
	for _, a := range rows {
		if a.ItemID != nil {
			ids = append(ids, *a.ItemID)
		}
	}
	ch, err := canvasacl.Load(ctx, q, ids)
	if err != nil {
		return nil, err
	}
	out := rows[:0:0]
	for _, a := range rows {
		if a.ItemID == nil {
			if !a.Private || c.m.SeesPrivate() { // the owner with «Владелец видит приватное» sees them too
				out = append(out, a)
			}
			continue
		}
		if ch.Has(*a.ItemID) && ch.Bits(c.m, a.ItemID).Has(perm.CanvasView) {
			out = append(out, a)
		}
	}
	return out, nil
}

// hidePlaces blanks the parent names (parent_name) of an item's journal entries for items the
// caller does not see (no names without CANVAS_VIEW), like the Disk's hidePlaces.
func hidePlaces(ctx context.Context, q *sqlc.Queries, c caller, rows []sqlc.CanvasActivity) error {
	parentOf := func(raw []byte) (map[string]any, *uuid.UUID) {
		if len(raw) == 0 {
			return nil, nil
		}
		var m map[string]any
		if json.Unmarshal(raw, &m) != nil {
			return nil, nil
		}
		if n, _ := m["parent_name"].(string); n == "" {
			return nil, nil
		}
		pid, _ := m["parent_id"].(string)
		id, err := uuid.Parse(pid)
		if err != nil {
			return m, nil
		}
		return m, &id
	}
	var ids []uuid.UUID
	for _, a := range rows {
		for _, side := range [][]byte{a.Before, a.After} {
			if _, id := parentOf(side); id != nil {
				ids = append(ids, *id)
			}
		}
	}
	if len(ids) == 0 {
		return nil
	}
	ch, err := canvasacl.Load(ctx, q, ids)
	if err != nil {
		return err
	}
	hide := func(raw []byte) ([]byte, error) {
		m, id := parentOf(raw)
		if m == nil || (id != nil && ch.Has(*id) && ch.Bits(c.m, id).Has(perm.CanvasView)) {
			return raw, nil
		}
		m["parent_name"] = ""
		return json.Marshal(m)
	}
	for i := range rows {
		if rows[i].Before, err = hide(rows[i].Before); err != nil {
			return err
		}
		if rows[i].After, err = hide(rows[i].After); err != nil {
			return err
		}
	}
	return nil
}

// versions: GET /api/canvas/items/{id}/versions?cursor=&limit= (CANVAS_VIEW), the newest first;
// limit 1..50, default 20.
func (s *Service) versions(w http.ResponseWriter, r *http.Request) error {
	a, err := s.pathItem(r)
	if err != nil {
		return err
	}
	cur, err := optUUID(r.URL.Query().Get("cursor"), "cursor")
	if err != nil {
		return err
	}
	limit, err := pageLimit(r, 20, 50)
	if err != nil {
		return err
	}
	rows, err := s.db.Q.ListCanvasVersions(r.Context(), sqlc.ListCanvasVersionsParams{CanvasID: a.item.ID, Cursor: cur, Lim: int32(limit + 1)}) //nolint:gosec // ≤ 51
	if err != nil {
		return err
	}
	out := &v1.CanvasVersionsResponse{}
	if len(rows) > limit {
		rows = rows[:limit]
		out.NextCursor = rows[limit-1].ID.String()
	}
	for _, v := range rows {
		out.Versions = append(out.Versions, versionProto(v))
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// version: GET /api/canvas/items/{id}/versions/{vid} — the Yjs state of a version
// (application/octet-stream; CANVAS_VIEW). The client applies its content as a new transaction to
// restore it (ADR-0096 §5).
func (s *Service) version(w http.ResponseWriter, r *http.Request) error {
	a, err := s.pathItem(r)
	if err != nil {
		return err
	}
	vid, err := httpx.PathUUID(r, "vid", "version")
	if err != nil {
		return err
	}
	v, err := s.db.Q.GetCanvasVersion(r.Context(), sqlc.GetCanvasVersionParams{ID: vid, CanvasID: a.item.ID})
	if db.IsNotFound(err) {
		return httpx.NotFound("version")
	}
	if err != nil {
		return err
	}
	h := w.Header()
	h.Set("Content-Type", "application/octet-stream")
	h.Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(v.State)
	return nil
}

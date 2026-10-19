package canvas

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"slices"
	"strconv"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/canvasacl"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/perm"
)

// PageMax bounds a listing page (canvas.proto ListCanvasItemsResponse).
const PageMax = 200

// cursor is the position after the last row of a listing page.
type cursor struct {
	Position int32     `json:"p,omitempty"`
	Trashed  time.Time `json:"t,omitzero"`
	ID       uuid.UUID `json:"i"`
}

func (c cursor) encode() string {
	b, _ := json.Marshal(c)
	return base64.RawURLEncoding.EncodeToString(b)
}

func decodeCursor(raw string) (*cursor, error) {
	if raw == "" {
		return nil, nil
	}
	b, err := base64.RawURLEncoding.DecodeString(raw)
	var c cursor
	if err != nil || json.Unmarshal(b, &c) != nil || c.ID == uuid.Nil {
		return nil, httpx.Validation("cursor", "invalid cursor")
	}
	return &c, nil
}

func pageLimit(r *http.Request, def, most int) (int, error) {
	raw := r.URL.Query().Get("limit")
	if raw == "" {
		return def, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 || n > most {
		return 0, httpx.Validation("limit", "must be 1.."+strconv.Itoa(most))
	}
	return n, nil
}

// list: GET /api/workspaces/{id}/canvas/items?parent=&trashed=&cursor=&limit= — the live children
// of a folder (or the top level) the caller sees, by position; with trashed=1 the trash roots the
// caller sees, the newest deletion first. A page of the listing may hold fewer visible items
// than the limit; next_cursor is set while there are more rows.
func (s *Service) list(w http.ResponseWriter, r *http.Request) error {
	ws, c, err := pathWorkspace(r)
	if err != nil {
		return err
	}
	qs := r.URL.Query()
	cur, err := decodeCursor(qs.Get("cursor"))
	if err != nil {
		return err
	}
	limit, err := pageLimit(r, PageMax, PageMax)
	if err != nil {
		return err
	}
	lim := int32(limit) //nolint:gosec // ≤ PageMax
	ctx, q := r.Context(), s.db.Q
	out := &v1.ListCanvasItemsResponse{}
	w.Header().Set("Cache-Control", "no-store")
	if t := qs.Get("trashed"); t == "1" || t == "true" {
		p := sqlc.ListCanvasTrashParams{WorkspaceID: ws, Lim: lim}
		if cur != nil {
			p.CursorID, p.CursorTrashed = &cur.ID, cur.Trashed
		}
		rows, err := q.ListCanvasTrash(ctx, p)
		if err != nil {
			return err
		}
		ids := make([]uuid.UUID, len(rows))
		for i, row := range rows {
			ids[i] = row.ID
		}
		ch, err := canvasacl.Load(ctx, q, ids)
		if err != nil {
			return err
		}
		var seen []sqlc.CanvasItemHead
		for _, row := range rows {
			if ch.Bits(c.m, &row.ID).Has(perm.CanvasView) {
				seen = append(seen, row)
			}
		}
		if out.Items, err = decorated(ctx, q, seen, func(p sqlc.CanvasItemHead) perm.Bits { return ch.Bits(c.m, &p.ID) }, nil); err != nil {
			return err
		}
		if len(rows) == limit {
			last := rows[len(rows)-1]
			out.NextCursor = cursor{Trashed: *last.TrashedAt, ID: last.ID}.encode()
		}
		httpx.Write(w, http.StatusOK, out)
		return nil
	}
	parent, err := optUUID(qs.Get("parent"), "parent")
	if err != nil {
		return err
	}
	if _, _, err := parentBits(r, q, ws, c, parent); err != nil {
		return err
	}
	p := sqlc.ListCanvasChildrenParams{WorkspaceID: ws, ParentID: parent, Lim: lim}
	if cur != nil {
		p.CursorID, p.CursorPosition = &cur.ID, cur.Position
	}
	rows, err := q.ListCanvasChildren(ctx, p)
	if err != nil {
		return err
	}
	var base []uuid.UUID
	if parent != nil {
		base = []uuid.UUID{*parent}
	}
	ch, err := canvasacl.Load(ctx, q, base)
	if err != nil {
		return err
	}
	items := make([]sqlc.CanvasItemHead, len(rows))
	children := make(map[uuid.UUID]bool, len(rows))
	for i, x := range rows {
		items[i] = x.CanvasItemHead
		children[x.CanvasItemHead.ID] = x.HasChildren
	}
	if err := ch.AddChildren(ctx, q, parent, items); err != nil {
		return err
	}
	var seen []sqlc.CanvasItemHead
	for _, it := range items {
		if ch.Bits(c.m, &it.ID).Has(perm.CanvasView) {
			seen = append(seen, it)
		}
	}
	if out.Items, err = decorated(ctx, q, seen, func(it sqlc.CanvasItemHead) perm.Bits { return ch.Bits(c.m, &it.ID) }, children); err != nil {
		return err
	}
	if len(rows) == limit {
		last := rows[len(rows)-1].CanvasItemHead
		out.NextCursor = cursor{Position: last.Position, ID: last.ID}.encode()
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// create: POST /api/workspaces/{id}/canvas/items (CANVAS_WRITE on the parent folder, on the
// section for the top level). The item goes last among its siblings; the caller owns it.
func (s *Service) create(w http.ResponseWriter, r *http.Request) error {
	ws, c, err := pathWorkspace(r)
	if err != nil {
		return err
	}
	var req v1.CreateCanvasItemRequest
	if err := httpx.DecodeStrict(w, r, &req); err != nil {
		return err
	}
	var kind string
	switch req.GetKind() {
	case v1.CanvasItemKind_CANVAS_ITEM_KIND_FOLDER:
		kind = kindFolder
	case v1.CanvasItemKind_CANVAS_ITEM_KIND_CANVAS:
		kind = kindCanvas
	default:
		return httpx.Validation("kind", "must be FOLDER or CANVAS")
	}
	name, err := cleanName(req.GetName())
	if err != nil {
		return err
	}
	parent, err := optUUID(req.GetParentId(), "parent_id")
	if err != nil {
		return err
	}
	ctx := r.Context()
	var it sqlc.CanvasItemHead
	var chain []perm.TreeNode
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if err := writable(ctx, q, ws); err != nil {
			return err
		}
		if err := q.LockCanvasTree(ctx, ws); err != nil {
			return err
		}
		ch, err := addable(r, q, ws, c, parent)
		if err != nil {
			return err
		}
		row, err := q.CreateCanvasItem(ctx, sqlc.CreateCanvasItemParams{WorkspaceID: ws, ParentID: parent, Kind: kind, Name: name, OwnerID: &c.uid})
		if err != nil {
			return err
		}
		it = head(row)
		if err := ch.AddChildren(ctx, q, parent, []sqlc.CanvasItemHead{it}); err != nil {
			return err
		}
		chain = ch.Nodes(it.ID)
		pl, err := place(ctx, q, parent)
		if err != nil {
			return err
		}
		pl["name"], pl["kind"] = it.Name, it.Kind
		return s.journal(ctx, q, it, &c.uid, "create", nil, pl)
	})
	if err != nil {
		return err
	}
	s.publish(ctx, ws, []*v1.DispatchEvent{s.upsertEvent(ctx, it, chain, nil)})
	httpx.Write(w, http.StatusCreated, &v1.CanvasItemResponse{Item: itemProto(it, false, false, perm.ComputeCanvasItemIn(c.m, chain))})
	return nil
}

// get: GET /api/canvas/items/{id}.
func (s *Service) get(w http.ResponseWriter, r *http.Request) error {
	a, err := s.pathItem(r)
	if err != nil {
		return err
	}
	item, err := one(r.Context(), s.db.Q, a)
	if err != nil {
		return err
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.Write(w, http.StatusOK, &v1.CanvasItemResponse{Item: item})
	return nil
}

// path: GET /api/canvas/items/{id}/path — the breadcrumbs: the ancestors the caller sees, then
// the item. Above an ancestor they do not see, nothing is shown.
func (s *Service) path(w http.ResponseWriter, r *http.Request) error {
	a, err := s.pathItem(r)
	if err != nil {
		return err
	}
	chain := a.chain.Path(a.item.ID)
	start := 0
	for i, p := range chain {
		if !a.chain.Bits(a.c.m, &p.ID).Has(perm.CanvasView) {
			start = i + 1
		}
	}
	items, err := decorated(r.Context(), s.db.Q, chain[start:], func(p sqlc.CanvasItemHead) perm.Bits { return a.chain.Bits(a.c.m, &p.ID) }, nil)
	if err != nil {
		return err
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.Write(w, http.StatusOK, &v1.CanvasPathResponse{Items: items})
	return nil
}

// update: PATCH /api/canvas/items/{id} — rename, move (parent_id set, "" = the top level:
// CANVAS_WRITE on the destination folder, no cycles, ≤ 32 deep; position = the index among the
// new siblings) and the restricted switch; the owner or CANVAS_MANAGE.
func (s *Service) update(w http.ResponseWriter, r *http.Request) error {
	id, err := httpx.PathUUID(r, "id", "item")
	if err != nil {
		return err
	}
	var req v1.UpdateCanvasItemRequest
	if err := httpx.DecodeStrict(w, r, &req); err != nil {
		return err
	}
	var newName *string
	if req.Name != nil {
		t, err := cleanName(req.GetName())
		if err != nil {
			return err
		}
		newName = &t
	}
	var target *uuid.UUID
	if req.ParentId != nil {
		if target, err = optUUID(req.GetParentId(), "parent_id"); err != nil {
			return err
		}
	}
	if req.Position != nil && req.GetPosition() < 0 {
		return httpx.Validation("position", "must not be negative")
	}
	ctx := r.Context()
	var it sqlc.CanvasItemHead
	var before []perm.TreeNode
	var a access
	var det []moved
	changed := false
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if a, err = resolve(r, q, id); err != nil {
			return err
		}
		ws := a.item.WorkspaceID
		if err := writable(ctx, q, ws); err != nil {
			return err
		}
		if err := q.LockCanvasTree(ctx, ws); err != nil {
			return err
		}
		if a, err = resolve(r, q, id); err != nil { // again under the lock
			return err
		}
		if !a.structure() {
			return errNotStructure
		}
		if a.item.TrashedAt != nil {
			return errTrashed
		}
		cur := a.item
		before = a.nodes()
		uid := &a.c.uid
		p := sqlc.UpdateCanvasItemParams{ID: id, UpdatedBy: uid}
		var journal []func(sqlc.CanvasItemHead) error
		if newName != nil && *newName != cur.Name {
			p.Name = newName
			journal = append(journal, func(it sqlc.CanvasItemHead) error {
				return s.journal(ctx, q, it, uid, "rename", snap{"name": cur.Name}, snap{"name": it.Name})
			})
		}
		if req.Restricted != nil && req.GetRestricted() != cur.Restricted {
			p.Restricted = req.Restricted
			journal = append(journal, func(it sqlc.CanvasItemHead) error {
				ovs := a.chain.Overrides(id)
				b, err := sharing(ctx, q, ws, cur.Restricted, ovs)
				if err != nil {
					return err
				}
				af, err := sharing(ctx, q, ws, it.Restricted, ovs)
				if err != nil {
					return err
				}
				return s.journal(ctx, q, it, uid, "share", b, af)
			})
		}
		it = cur
		if p.Name != nil || p.Restricted != nil {
			row, err := q.UpdateCanvasItem(ctx, p)
			if err != nil {
				return err
			}
			it, changed = head(row), true
		}
		moving := req.ParentId != nil && !sameParent(cur.ParentID, target)
		if moving || req.Position != nil {
			parent := cur.ParentID
			if moving {
				tch, err := addable(r, q, ws, a.c, target)
				if err != nil {
					return err
				}
				if target != nil && slices.ContainsFunc(tch.Path(*target), func(x sqlc.CanvasItemHead) bool { return x.ID == id }) {
					return httpx.Conflict("an item cannot be moved into itself")
				}
				below, err := q.CountCanvasSubtreeDepth(ctx, id)
				if err != nil {
					return err
				}
				if depthOf(tch, target)+1+int(below) > MaxDepth {
					return httpx.Conflict("items may be nested at most 32 deep")
				}
				parent = target
				// What the caller does not see below the item stays (addendum 2026-10-14).
				if det, err = s.detachHidden(ctx, q, cur, sees(a.c.m), &a.c.m, nil); err != nil {
					return err
				}
			}
			row, err := s.place(ctx, q, it, parent, req.Position, uid)
			if err != nil {
				return err
			}
			if moving {
				// The old siblings close the gap.
				if err := q.ReindexCanvasSiblings(ctx, sqlc.ReindexCanvasSiblingsParams{WorkspaceID: ws, ParentID: cur.ParentID}); err != nil {
					return err
				}
				journal = append(journal, func(it sqlc.CanvasItemHead) error {
					from, err := place(ctx, q, cur.ParentID)
					if err != nil {
						return err
					}
					to, err := place(ctx, q, it.ParentID)
					if err != nil {
						return err
					}
					return s.journal(ctx, q, it, uid, "move", from, to)
				})
			}
			it, changed = row, true
		}
		for _, j := range journal {
			if err := j(it); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	s.announceMoved(ctx, det)
	if changed {
		s.upserted(ctx, id, before)
		s.recheckBelow(ctx, id) // the sync sockets of the item and of the canvases below it: restricted or a move may have closed them
	}
	ch, err := canvasacl.Load(ctx, s.db.Q, []uuid.UUID{id})
	if err != nil {
		return err
	}
	a.item, a.chain = ch.Item(id), ch
	a.bits = ch.Bits(a.c.m, &id)
	if !a.bits.Has(perm.CanvasView) { // made invisible to oneself (an override): answer what is known
		httpx.Write(w, http.StatusOK, &v1.CanvasItemResponse{Item: itemProto(a.item, false, false, a.bits)})
		return nil
	}
	out, err := one(ctx, s.db.Q, a)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.CanvasItemResponse{Item: out})
	return nil
}

// place puts item it under parent (nil = the top level) at index position among the other live
// siblings (nil = last), under LockCanvasTree: the item goes last and the siblings are
// renumbered 0.., then it moves to the index, pushing the following ones down.
func (s *Service) place(ctx context.Context, q *sqlc.Queries, it sqlc.CanvasItemHead, parent *uuid.UUID, position *int32, by *uuid.UUID) (sqlc.CanvasItemHead, error) {
	const last = 1 << 30
	row, err := q.MoveCanvasItem(ctx, sqlc.MoveCanvasItemParams{ID: it.ID, ParentID: parent, Position: last, UpdatedBy: by})
	if err != nil {
		return it, err
	}
	if err := q.ReindexCanvasSiblings(ctx, sqlc.ReindexCanvasSiblingsParams{WorkspaceID: it.WorkspaceID, ParentID: parent}); err != nil {
		return it, err
	}
	if position != nil {
		if row, err = q.MoveCanvasItem(ctx, sqlc.MoveCanvasItemParams{ID: it.ID, ParentID: parent, Position: *position, UpdatedBy: by}); err != nil {
			return it, err
		}
		if err := q.ReindexCanvasSiblings(ctx, sqlc.ReindexCanvasSiblingsParams{FirstID: &it.ID, WorkspaceID: it.WorkspaceID, ParentID: parent}); err != nil {
			return it, err
		}
	}
	return q.GetCanvasItem(ctx, row.ID)
}

func sameParent(a, b *uuid.UUID) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

// trash: POST /api/canvas/items/{id}/trash — the item and its live subtree to the trash (the
// owner or CANVAS_MANAGE). The sync sockets of the trashed canvases are closed.
func (s *Service) trash(w http.ResponseWriter, r *http.Request) error {
	id, err := httpx.PathUUID(r, "id", "item")
	if err != nil {
		return err
	}
	ctx := r.Context()
	var a access
	var ids []uuid.UUID
	var det []moved
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if a, err = resolve(r, q, id); err != nil {
			return err
		}
		if err := writable(ctx, q, a.item.WorkspaceID); err != nil {
			return err
		}
		if !a.structure() {
			return errNotStructure
		}
		if a.item.TrashedAt != nil {
			return errTrashed
		}
		// Under the tree lock: a create or a move into the subtree checked its parent is live.
		if err := q.LockCanvasTree(ctx, a.item.WorkspaceID); err != nil {
			return err
		}
		// What the caller does not see below the item stays (addendum 2026-10-14).
		if det, err = s.detachHidden(ctx, q, a.item, sees(a.c.m), &a.c.m, nil); err != nil {
			return err
		}
		if ids, err = q.TrashCanvasSubtree(ctx, sqlc.TrashCanvasSubtreeParams{ID: id, TrashedAt: s.Now(), TrashedBy: &a.c.uid}); err != nil {
			return err
		}
		if !slices.Contains(ids, id) {
			return errTrashed // trashed concurrently
		}
		if a.item, err = q.GetCanvasItem(ctx, id); err != nil {
			return err
		}
		if err := q.ReindexCanvasSiblings(ctx, sqlc.ReindexCanvasSiblingsParams{WorkspaceID: a.item.WorkspaceID, ParentID: a.item.ParentID}); err != nil {
			return err
		}
		pl, err := place(ctx, q, a.item.ParentID)
		if err != nil {
			return err
		}
		pl["items"] = float64(len(ids))
		return s.journal(ctx, q, a.item, &a.c.uid, "trash", pl, nil)
	})
	if err != nil {
		return err
	}
	s.announceMoved(ctx, det)
	s.kick(ctx, ids)
	s.publish(ctx, a.item.WorkspaceID, []*v1.DispatchEvent{s.upsertEvent(ctx, a.item, a.nodes(), nil)})
	out, err := one(ctx, s.db.Q, a)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.CanvasItemResponse{Item: out})
	return nil
}

// restore: POST /api/canvas/items/{id}/restore — a trash root and what was deleted with it back
// under its parent, last among the siblings; to the top level when that parent is in the trash
// or gone (CANVAS_WRITE there then, unless CANVAS_MANAGE). The owner or CANVAS_MANAGE.
func (s *Service) restore(w http.ResponseWriter, r *http.Request) error {
	id, err := httpx.PathUUID(r, "id", "item")
	if err != nil {
		return err
	}
	ctx := r.Context()
	var before []perm.TreeNode
	var a access
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if a, err = resolve(r, q, id); err != nil {
			return err
		}
		ws := a.item.WorkspaceID
		if err := writable(ctx, q, ws); err != nil {
			return err
		}
		if err := q.LockCanvasTree(ctx, ws); err != nil {
			return err
		}
		if a, err = resolve(r, q, id); err != nil {
			return err
		}
		if !a.structure() {
			return errNotStructure
		}
		if !a.item.TrashedRoot {
			if a.item.TrashedAt == nil {
				return httpx.Conflict("the item is not in the trash")
			}
			return httpx.Conflict("restore the item it was deleted with")
		}
		before = a.nodes()
		parent := a.item.ParentID
		if parent != nil {
			p, err := q.GetCanvasItem(ctx, *parent)
			if err != nil && !db.IsNotFound(err) {
				return err
			}
			if err != nil || p.TrashedAt != nil {
				parent = nil
				if !a.manage() {
					if _, err := addable(r, q, ws, a.c, nil); err != nil {
						return httpx.Conflict("restore the folder it was in first")
					}
				}
			}
		}
		ids, err := q.RestoreCanvasSubtree(ctx, sqlc.RestoreCanvasSubtreeParams{ID: id, ParentID: parent})
		if err != nil {
			return err
		}
		if !slices.Contains(ids, id) {
			return httpx.Conflict("the item is not in the trash")
		}
		if a.item, err = q.GetCanvasItem(ctx, id); err != nil {
			return err
		}
		pl, err := place(ctx, q, a.item.ParentID)
		if err != nil {
			return err
		}
		pl["items"] = float64(len(ids))
		return s.journal(ctx, q, a.item, &a.c.uid, "restore", nil, pl)
	})
	if err != nil {
		return err
	}
	s.upserted(ctx, id, before)
	ch, err := canvasacl.Load(ctx, s.db.Q, []uuid.UUID{id})
	if err != nil {
		return err
	}
	a.item, a.chain, a.bits = ch.Item(id), ch, ch.Bits(a.c.m, &id)
	out, err := one(ctx, s.db.Q, a)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.CanvasItemResponse{Item: out})
	return nil
}

// deleted is what deleting one subtree forever did, for after the commit.
type deleted struct {
	item  sqlc.CanvasItemHead
	chain []perm.TreeNode
	moved []moved // detached from the subtree first
}

// deleteTree deletes item p and its subtree forever in q's transaction, in the Disk's order
// (ADR-0094 §4): the journal entry, then the items (CASCADE: updates, snapshots, versions,
// overrides). A canvas holds no files, so there is nothing else to release. The caller holds
// LockCanvasTree.
//
// What v does not see below the item is detached first (addendum 2026-10-14): by actor's
// operation (m: the actor as a member), or by the sweeper (v: what the trash root's deleter saw;
// retrash: the detached trash gets a time of its own).
func (s *Service) deleteTree(ctx context.Context, q *sqlc.Queries, p sqlc.CanvasItemHead, chain []perm.TreeNode, actor *uuid.UUID, v viewer, m *perm.Member, retrash *time.Time) (deleted, error) {
	d := deleted{item: p, chain: chain}
	var err error
	if d.moved, err = s.detachHidden(ctx, q, p, v, m, retrash); err != nil {
		return d, err
	}
	// The journal of a restricted subtree stays out of the workspace journal once its chains are
	// gone (addendum 2026-10-14 of ADR-0096 §2).
	private := perm.RestrictedIn(chain)
	if err := q.MarkCanvasSubtreeActivityPrivate(ctx, sqlc.MarkCanvasSubtreeActivityPrivateParams{ID: p.ID, Restricted: private}); err != nil {
		return d, err
	}
	if _, err := q.DeleteCanvasItem(ctx, p.ID); err != nil {
		return d, err
	}
	before := snap{"name": p.Name, "kind": p.Kind}
	if err := s.journalEntry(ctx, q, p, actor, "delete", before, nil, private); err != nil {
		return d, err
	}
	return d, nil
}

// finish announces committed deletions.
func (s *Service) finish(ctx context.Context, ds []deleted) {
	if len(ds) == 0 {
		return
	}
	evs := make([]*v1.DispatchEvent, 0, len(ds))
	for _, d := range ds {
		s.announceMoved(ctx, d.moved)
		evs = append(evs, removeEvent(d.item, d.chain))
	}
	s.publish(ctx, ds[0].item.WorkspaceID, evs)
}

// deleteForever: DELETE /api/canvas/items/{id} — an item in the trash (a root or a part of
// one), with its subtree; the owner or CANVAS_MANAGE.
func (s *Service) deleteForever(w http.ResponseWriter, r *http.Request) error {
	id, err := httpx.PathUUID(r, "id", "item")
	if err != nil {
		return err
	}
	ctx := r.Context()
	var d deleted
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		a, err := resolve(r, q, id)
		if err != nil {
			return err
		}
		if err := writable(ctx, q, a.item.WorkspaceID); err != nil {
			return err
		}
		if !a.structure() {
			return errNotStructure
		}
		if a.item.TrashedAt == nil {
			return httpx.Conflict("move the item to the trash first")
		}
		if err := q.LockCanvasTree(ctx, a.item.WorkspaceID); err != nil {
			return err
		}
		// Re-read under the row lock: a concurrent restore must not be undone by this deletion.
		cur, err := q.GetCanvasItemForUpdate(ctx, id)
		if db.IsNotFound(err) {
			return errNoItem
		}
		if err != nil {
			return err
		}
		if cur.TrashedAt == nil {
			return httpx.Conflict("move the item to the trash first")
		}
		d, err = s.deleteTree(ctx, q, cur, a.nodes(), &a.c.uid, sees(a.c.m), &a.c.m, nil)
		return err
	})
	if err != nil {
		return err
	}
	s.finish(ctx, []deleted{d})
	w.WriteHeader(http.StatusNoContent)
	return nil
}

var errSkip = httpx.Conflict("skipped")

// emptyTrash: POST /api/workspaces/{id}/canvas/trash/empty — deletes forever every trash root
// the caller may delete (their own; all with CANVAS_MANAGE), one transaction per root.
func (s *Service) emptyTrash(w http.ResponseWriter, r *http.Request) error {
	ws, c, err := pathWorkspace(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	if err := writable(ctx, s.db.Q, ws); err != nil {
		return err
	}
	roots, err := s.db.Q.ListCanvasTrashRootsAll(ctx, ws)
	if err != nil {
		return err
	}
	ids := make([]uuid.UUID, len(roots))
	for i, p := range roots {
		ids[i] = p.ID
	}
	ch, err := canvasacl.Load(ctx, s.db.Q, ids)
	if err != nil {
		return err
	}
	out := &v1.EmptyCanvasTrashResponse{}
	var done []deleted
	for _, p := range roots {
		if !perm.CanvasStructureAllowed(ch.Bits(c.m, &p.ID), c.owns(p)) {
			continue
		}
		var d deleted
		err := s.db.Tx(ctx, func(q *sqlc.Queries) error {
			a, err := resolve(r, q, p.ID)
			if err != nil || !a.item.TrashedRoot || !a.structure() {
				return errSkip
			}
			if err := q.LockCanvasTree(ctx, ws); err != nil {
				return err
			}
			cur, err := q.GetCanvasItemForUpdate(ctx, p.ID)
			if err != nil || !cur.TrashedRoot { // gone or restored meanwhile
				return errSkip
			}
			d, err = s.deleteTree(ctx, q, cur, a.nodes(), &c.uid, sees(c.m), &c.m, nil)
			return err
		})
		if err == errSkip { //nolint:errorlint // sentinel returned as is
			continue
		}
		if err != nil {
			s.finish(ctx, done)
			return err
		}
		done = append(done, d)
		out.Deleted++
	}
	s.finish(ctx, done)
	httpx.Write(w, http.StatusOK, out)
	return nil
}

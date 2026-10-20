package canvas

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/canvasacl"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/perm"
)

// CoalesceWindow is how recent a person's rename of an item must be for their next rename of it
// to merge into that entry (ADR-0081, like the Disk and the Wiki).
const CoalesceWindow = 5 * time.Minute

// snap is one side of a journal entry.
type snap map[string]any

func encode(m snap) ([]byte, error) {
	if m == nil {
		return nil, nil
	}
	return json.Marshal(m)
}

// journal writes one entry about item p (its name as now); actor nil = the sweeper. Kinds:
// ADR-0113 §1 (create, rename, move, share, trash, restore, delete, version).
func (s *Service) journal(ctx context.Context, q *sqlc.Queries, p sqlc.CanvasItemHead, actor *uuid.UUID, kind string, before, after snap) error {
	return s.journalEntry(ctx, q, p, actor, kind, before, after, false)
}

// journalEntry is journal with the private flag of a "delete" entry (the item's chain ran
// through a restricted item: the workspace journal leaves it out, addendum 2026-10-14).
func (s *Service) journalEntry(ctx context.Context, q *sqlc.Queries, p sqlc.CanvasItemHead, actor *uuid.UUID, kind string, before, after snap, private bool) error {
	b, err := encode(before)
	if err != nil {
		return err
	}
	a, err := encode(after)
	if err != nil {
		return err
	}
	if kind == "rename" && actor != nil {
		last, err := q.LastCanvasActivity(ctx, &p.ID)
		switch {
		case err == nil && last.Kind == "rename" && last.ActorID != nil && *last.ActorID == *actor &&
			s.Now().Sub(last.CreatedAt) < CoalesceWindow:
			var was snap
			_ = json.Unmarshal(last.Before, &was)
			if was["name"] == after["name"] {
				return q.DeleteCanvasActivity(ctx, last.ID) // renamed back: nothing happened
			}
			return q.UpdateCanvasActivityAfter(ctx, sqlc.UpdateCanvasActivityAfterParams{ID: last.ID, After: a, ItemName: p.Name})
		case err != nil && !db.IsNotFound(err):
			return err
		}
	}
	var item *uuid.UUID
	if kind != "delete" {
		item = &p.ID
	}
	_, err = q.InsertCanvasActivity(ctx, sqlc.InsertCanvasActivityParams{WorkspaceID: p.WorkspaceID, ItemID: item, ItemName: p.Name,
		ActorID: actor, Kind: kind, Before: b, After: a, Private: private})
	return err
}

// place is where an item is, for the journal: its parent's id and name ("" = the top level).
func place(ctx context.Context, q *sqlc.Queries, parent *uuid.UUID) (snap, error) {
	if parent == nil {
		return snap{"parent_id": "", "parent_name": ""}, nil
	}
	p, err := q.GetCanvasItem(ctx, *parent)
	if err != nil {
		if db.IsNotFound(err) {
			return snap{"parent_id": parent.String(), "parent_name": ""}, nil
		}
		return nil, err
	}
	return snap{"parent_id": p.ID.String(), "parent_name": p.Name}, nil
}

// sharing is the access settings of an item for the journal: restricted and the overrides with
// the names of their targets.
func sharing(ctx context.Context, q *sqlc.Queries, ws uuid.UUID, restricted bool, ovs []perm.OverrideTarget) (snap, error) {
	var users []uuid.UUID
	for _, o := range ovs {
		if o.TargetType == "user" {
			if id, err := uuid.Parse(o.TargetID); err == nil {
				users = append(users, id)
			}
		}
	}
	names := map[string]string{}
	if len(users) > 0 {
		us, err := q.ListUsersByIDs(ctx, users)
		if err != nil {
			return nil, err
		}
		for _, u := range us {
			names[u.ID.String()] = u.DisplayName
		}
	}
	roles := map[string]string{}
	for _, o := range ovs {
		if o.TargetType == "role" {
			rs, err := q.ListWorkspaceRoles(ctx, ws)
			if err != nil {
				return nil, err
			}
			for _, r := range rs {
				roles[r.ID.String()] = r.Name
			}
			break
		}
	}
	entries := make([]any, 0, len(ovs))
	for _, o := range ovs {
		name := names[o.TargetID]
		if o.TargetType == "role" {
			name = roles[o.TargetID]
		}
		entries = append(entries, map[string]any{"target_type": o.TargetType, "target_id": o.TargetID, "name": name,
			"allow": float64(uint64(o.Allow)), "deny": float64(uint64(o.Deny))})
	}
	return snap{"restricted": restricted, "entries": entries}, nil
}

// ---- events ----

// eventItem is an item as the CANVAS_ITEM_UPSERT event carries it: no per-recipient bits (those
// come with a refetch), with has_children.
func (s *Service) eventItem(ctx context.Context, p sqlc.CanvasItemHead) *v1.CanvasItem {
	children := false
	if with, err := s.db.Q.ListCanvasItemsWithChildren(ctx, []uuid.UUID{p.ID}); err == nil {
		children = len(with) > 0
	}
	return itemProto(p, false, children, 0)
}

// upsertEvent is CANVAS_ITEM_UPSERT of p: after is its access chain now, before the one it had
// when that changed (nil = unchanged, or nobody saw it: a new item).
func (s *Service) upsertEvent(ctx context.Context, p sqlc.CanvasItemHead, after, before []perm.TreeNode) *v1.DispatchEvent {
	return &v1.DispatchEvent{Event: &v1.DispatchEvent_CanvasItemUpsert{CanvasItemUpsert: &v1.CanvasItemUpsert{
		WorkspaceId: p.WorkspaceID.String(), Item: s.eventItem(ctx, p),
		Access: canvasacl.Levels(after), AccessBefore: canvasacl.Levels(before),
	}}}
}

// removeEvent is CANVAS_ITEM_REMOVE of p, to who saw it through chain.
func removeEvent(p sqlc.CanvasItemHead, chain []perm.TreeNode) *v1.DispatchEvent {
	return &v1.DispatchEvent{Event: &v1.DispatchEvent_CanvasItemRemove{CanvasItemRemove: &v1.CanvasItemRemove{
		WorkspaceId: p.WorkspaceID.String(), ItemId: p.ID.String(), ParentId: idp(p.ParentID), Access: canvasacl.Levels(chain),
	}}}
}

// publish sends the events of a committed change.
func (s *Service) publish(ctx context.Context, ws uuid.UUID, evs []*v1.DispatchEvent) {
	if len(evs) > 0 {
		s.ev.WorkspaceEvents(ctx, ws, evs)
	}
}

// upserted announces a committed change of item id: its chain is read again (after the change)
// and before, when it differs, goes along (who saw it then and does not now gets a removal).
func (s *Service) upserted(ctx context.Context, id uuid.UUID, before []perm.TreeNode) {
	ch, err := canvasacl.Load(ctx, s.db.Q, []uuid.UUID{id})
	if err != nil || !ch.Has(id) {
		if err != nil {
			slog.WarnContext(ctx, "canvas: event chain", "item_id", id, "err", err)
		}
		return
	}
	after := ch.Nodes(id)
	var was []perm.TreeNode
	if before != nil && !canvasacl.SameChain(before, after) {
		was = before
	}
	p := ch.Item(id)
	s.publish(ctx, p.WorkspaceID, []*v1.DispatchEvent{s.upsertEvent(ctx, p, after, was)})
}

// kick makes every socket of the items (on every instance) check its access now: after a trash,
// a change of overrides or of restricted.
func (s *Service) kick(ctx context.Context, items []uuid.UUID) {
	if s.sync == nil {
		return
	}
	s.sync.Kick(ctx, items)
}

// maxKicked bounds the canvases one structural change makes recheck at once (one Redis pipeline);
// the rest is caught by the periodic recheck of every socket.
const maxKicked = 2000

// recheckBelow makes the sockets of item and of every live canvas below it check access now: the access of a canvas is the
// chain of its folders, so a change of restricted, of the overrides or a move of a folder
// changes it for the sockets of the canvases inside, which are keyed by the canvas (a folder has
// none).
func (s *Service) recheckBelow(ctx context.Context, item uuid.UUID) {
	if s.sync == nil {
		return
	}
	ids := []uuid.UUID{item}
	rows, err := s.db.Q.ListCanvasSubtree(ctx, item)
	if err != nil {
		slog.WarnContext(ctx, "canvas: recheck subtree", "item_id", item, "err", err)
	}
	for _, r := range rows {
		if r.CanvasItemHead.Kind == kindCanvas && r.CanvasItemHead.TrashedAt == nil && len(ids) < maxKicked {
			ids = append(ids, r.CanvasItemHead.ID)
		}
	}
	s.kick(ctx, ids)
}

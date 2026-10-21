package canvas

import (
	"context"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/canvasacl"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/perm"
)

// Detaching (addendum 2026-10-14 of ADR-0096 §2, ADR-0114 §2; as on the Disk and in the Wiki): a
// private item is seen only by its owner and those let in, and nobody else's operation may
// destroy or carry it away. Before an item is trashed, deleted forever or moved, every item of
// its subtree the actor does not see (the topmost of each hidden branch, with what is below it)
// leaves for the top level: its owner, content, versions and history stay, its flag and
// overrides become ones that keep its access there (perm.Detached), a live one goes last among
// the top-level items, a trashed one becomes a trash root of its own. The actor's operation then
// applies to the part it sees; its answer says nothing of what was detached (no names, no
// counts).

// viewer decides what an operation's actor sees: chain is an item's whole chain.
type viewer func(chain []perm.TreeNode) bool

// sees is the viewer of a member.
func sees(m perm.Member) viewer {
	return func(chain []perm.TreeNode) bool {
		return perm.ComputeTreeIn(perm.CanvasTree, m, chain).Has(perm.CanvasView)
	}
}

// moved is one detached item, for the event after the commit.
type moved struct {
	item          sqlc.CanvasItemHead
	before, after []perm.TreeNode
}

// announceMoved publishes the detached items and makes their sync sockets check access again.
func (s *Service) announceMoved(ctx context.Context, ds []moved) {
	if len(ds) == 0 {
		return
	}
	evs := make([]*v1.DispatchEvent, len(ds))
	ids := make([]uuid.UUID, len(ds))
	for i, d := range ds {
		evs[i] = s.upsertEvent(ctx, d.item, d.after, d.before)
		ids[i] = d.item.ID
	}
	s.publish(ctx, ds[0].item.WorkspaceID, evs)
	s.kick(ctx, ids)
}

// detachHidden detaches the items below root that v does not see, under LockCanvasTree. actor
// (nil for the sweeper) is pinned with the people the chains name, so the new overrides give
// nobody more than they had. retrash (the sweeper) restarts the trash time of what is detached
// from the trash.
func (s *Service) detachHidden(ctx context.Context, q *sqlc.Queries, root sqlc.CanvasItemHead, v viewer, actor *perm.Member, retrash *time.Time) ([]moved, error) {
	rows, err := q.ListCanvasSubtree(ctx, root.ID)
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	ids := make([]uuid.UUID, len(rows))
	for i, r := range rows {
		ids[i] = r.CanvasItemHead.ID
	}
	ch, err := canvasacl.Load(ctx, q, ids)
	if err != nil {
		return nil, err
	}
	hidden := map[uuid.UUID]bool{}
	members := map[string]*perm.Member{}
	var out []moved
	for _, r := range rows {
		p := r.CanvasItemHead
		if p.ParentID != nil && hidden[*p.ParentID] {
			hidden[p.ID] = true // goes with its detached ancestor
			continue
		}
		chain := ch.Nodes(p.ID)
		if v(chain) {
			continue
		}
		hidden[p.ID] = true
		var pin []perm.Member
		if actor != nil {
			pin = append(pin, *actor)
		}
		for _, uid := range perm.Named(chain) {
			m, ok := members[uid]
			if !ok {
				if id, err := uuid.Parse(uid); err == nil {
					mm, found, err := perm.LoadMember(ctx, q, p.WorkspaceID, id)
					if err != nil {
						return nil, err
					}
					if found {
						m = &mm
					}
				}
				members[uid] = m
			}
			if m != nil {
				pin = append(pin, *m)
			}
		}
		n := perm.Detached(perm.CanvasTree, chain, pin)
		pos, err := slot(ctx, q, p.WorkspaceID, nil, p.ID, nil)
		if err != nil {
			return nil, err
		}
		if _, err := q.DetachCanvasItem(ctx, sqlc.DetachCanvasItemParams{ID: p.ID, Restricted: n.Restricted, Position: pos}); err != nil {
			return nil, err
		}
		if !p.Restricted { // a restricted item keeps its own overrides (perm.Detached)
			if err := q.DeleteCanvasPermissions(ctx, p.ID); err != nil {
				return nil, err
			}
			for _, o := range n.Overrides {
				if err := q.InsertCanvasPermission(ctx, sqlc.InsertCanvasPermissionParams{CanvasID: p.ID, TargetType: o.TargetType, TargetID: o.TargetID,
					Allow: int64(o.Allow), Deny: int64(o.Deny)}); err != nil { //nolint:gosec // bit mask round-trip
					return nil, err
				}
			}
		}
		if retrash != nil && p.TrashedAt != nil {
			if err := q.RetimeCanvasTrash(ctx, sqlc.RetimeCanvasTrashParams{ID: p.ID, TrashedAt: *retrash}); err != nil {
				return nil, err
			}
		}
		cur, err := q.GetCanvasItem(ctx, p.ID)
		if err != nil {
			return nil, err
		}
		from, err := place(ctx, q, p.ParentID)
		if err != nil {
			return nil, err
		}
		to, _ := place(ctx, q, nil)
		if err := s.journal(ctx, q, cur, nil, "move", from, to); err != nil {
			return nil, err
		}
		out = append(out, moved{item: cur, before: chain, after: []perm.TreeNode{canvasacl.Node(cur, n.Overrides)}})
	}
	return out, nil
}

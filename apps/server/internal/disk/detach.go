package disk

import (
	"context"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/diskacl"
	"github.com/calaba/calaba/server/internal/perm"
)

// Detaching (addendum 2026-10-14 of ADR-0094 §2, owner 14.10): a private folder is seen only by
// its owner and those let in, and nobody else's operation may destroy or carry it away. Before an
// item is trashed, deleted forever or moved, every item of its subtree the actor does not see
// (the topmost of each hidden branch, with what is below it) leaves for the root of the Disk:
// its owner, history and files stay, its flag and overrides become ones that keep its access at
// the root (perm.Detached), a live one takes a free name, a trashed one becomes a trash root of
// its own. The actor's operation then applies to the part it sees; its answer says nothing of
// what was detached (no names, no counts).

// viewer decides what an operation's actor sees: chain is an item's whole chain.
type viewer func(chain []perm.DiskNode) bool

// sees is the viewer of a member.
func sees(m perm.Member) viewer {
	return func(chain []perm.DiskNode) bool { return perm.ComputeDiskItemIn(m, chain).Has(perm.DiskView) }
}

// moved is one detached item, for the event after the commit.
type moved struct {
	item          sqlc.DiskItem
	before, after []perm.DiskNode
}

func (d moved) event() *v1.DispatchEvent { return upsertEvent(d.item, d.after, d.before) }

func movedEvents(ds []moved) []*v1.DispatchEvent {
	evs := make([]*v1.DispatchEvent, len(ds))
	for i, d := range ds {
		evs[i] = d.event()
	}
	return evs
}

// detachHidden detaches the items below root that v does not see, under LockDiskTree. actor
// (nil for the sweeper) is pinned with the people the chains name, so the new overrides give
// nobody more than they had. retrash (the sweeper) restarts the trash time of what is detached
// from the trash.
func (s *Service) detachHidden(ctx context.Context, q *sqlc.Queries, root sqlc.DiskItem, v viewer, actor *perm.Member, retrash *time.Time) ([]moved, error) {
	rows, err := q.ListDiskSubtree(ctx, root.ID)
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	ids := make([]uuid.UUID, len(rows))
	for i, r := range rows {
		ids[i] = r.DiskItem.ID
	}
	ch, err := diskacl.Load(ctx, q, ids)
	if err != nil {
		return nil, err
	}
	hidden := map[uuid.UUID]bool{}
	members := map[string]*perm.Member{}
	var out []moved
	for _, r := range rows {
		it := r.DiskItem
		if it.ParentID != nil && hidden[*it.ParentID] {
			hidden[it.ID] = true // goes with its detached ancestor
			continue
		}
		chain := ch.Nodes(it.ID)
		if v(chain) {
			continue
		}
		hidden[it.ID] = true
		var pin []perm.Member
		if actor != nil {
			pin = append(pin, *actor)
		}
		for _, uid := range perm.Named(chain) {
			m, ok := members[uid]
			if !ok {
				if id, err := uuid.Parse(uid); err == nil {
					mm, found, err := perm.LoadMember(ctx, q, it.WorkspaceID, id)
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
		n := perm.Detached(perm.DiskTree, chain, pin)
		name := it.Name
		if it.TrashedAt == nil {
			if name, err = freeName(ctx, q, it.WorkspaceID, nil, it.Name, it.Kind, &it.ID); err != nil {
				return nil, err
			}
		}
		cur, err := q.DetachDiskItem(ctx, sqlc.DetachDiskItemParams{ID: it.ID, Name: name, Restricted: n.Restricted})
		if err != nil {
			return nil, err
		}
		if !it.Restricted { // a restricted item keeps its own overrides (perm.Detached)
			if err := q.DeleteDiskPermissions(ctx, it.ID); err != nil {
				return nil, err
			}
			for _, o := range n.Overrides {
				if err := q.InsertDiskPermission(ctx, sqlc.InsertDiskPermissionParams{ItemID: it.ID, TargetType: o.TargetType, TargetID: o.TargetID,
					Allow: int64(o.Allow), Deny: int64(o.Deny)}); err != nil { //nolint:gosec // bit mask round-trip
					return nil, err
				}
			}
		}
		if retrash != nil && cur.TrashedAt != nil {
			if err := q.RetimeDiskTrash(ctx, sqlc.RetimeDiskTrashParams{ID: it.ID, TrashedAt: *retrash}); err != nil {
				return nil, err
			}
			t := *retrash
			cur.TrashedAt = &t
		}
		from, err := place(ctx, q, it.ParentID)
		if err != nil {
			return nil, err
		}
		to, _ := place(ctx, q, nil)
		if err := s.journal(ctx, q, cur, nil, "move", from, to); err != nil {
			return nil, err
		}
		out = append(out, moved{item: cur, before: chain, after: []perm.DiskNode{diskacl.Node(cur, n.Overrides)}})
	}
	return out, nil
}

package canvas

import (
	"context"
	"math"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// Sibling order is (position, id), ascending, with gaps: a create, restore or detach takes the
// slot step after the last sibling, a move to an index takes the midpoint between its new
// neighbours, and a trash or a move out leaves its gap. Each of those writes the one row; only
// when two neighbours have no free position between them is the level spread out again
// (SpreadCanvasSiblings), which takes about log2(step) moves into the same gap.
const step = 1024

// lastPos is the highest position among the live children of parent (nil = the top level) other
// than self, -1 when there are none.
func lastPos(ctx context.Context, q *sqlc.Queries, ws uuid.UUID, parent *uuid.UUID, self uuid.UUID) (int32, error) {
	if parent == nil {
		return q.LastCanvasRootPosition(ctx, sqlc.LastCanvasRootPositionParams{WorkspaceID: ws, ExcludeID: self})
	}
	return q.LastCanvasFolderPosition(ctx, sqlc.LastCanvasFolderPositionParams{WorkspaceID: ws, ParentID: *parent, ExcludeID: self})
}

// siblingsAt is the positions of the live children of parent other than self from index off on,
// at most lim of them.
func siblingsAt(ctx context.Context, q *sqlc.Queries, ws uuid.UUID, parent *uuid.UUID, self uuid.UUID, off, lim int32) ([]int32, error) {
	if parent == nil {
		return q.CanvasRootSiblingPositions(ctx, sqlc.CanvasRootSiblingPositionsParams{WorkspaceID: ws, ExcludeID: self, Off: off, Lim: lim})
	}
	return q.CanvasFolderSiblingPositions(ctx, sqlc.CanvasFolderSiblingPositionsParams{WorkspaceID: ws, ParentID: *parent, ExcludeID: self,
		Off: off, Lim: lim})
}

// slot is the position for self going under parent at index at among the other live siblings
// (nil or past the end = last), under LockCanvasTree. self may be uuid.Nil (a new item).
func slot(ctx context.Context, q *sqlc.Queries, ws uuid.UUID, parent *uuid.UUID, self uuid.UUID, at *int32) (int32, error) {
	spread := func(hole int32) error {
		return q.SpreadCanvasSiblings(ctx, sqlc.SpreadCanvasSiblingsParams{WorkspaceID: ws, ParentID: parent, ExcludeID: self, Hole: hole, Step: step})
	}
	appendLast := func() (int32, error) {
		last, err := lastPos(ctx, q, ws, parent, self)
		if err != nil || last < 0 {
			return 0, err
		}
		if last <= math.MaxInt32-step {
			return last + step, nil
		}
		if err := spread(-1); err != nil {
			return 0, err
		}
		if last, err = lastPos(ctx, q, ws, parent, self); err != nil {
			return 0, err
		}
		return last + step, nil
	}
	if at == nil {
		return appendLast()
	}
	k := *at
	if k == 0 {
		next, err := siblingsAt(ctx, q, ws, parent, self, 0, 1)
		if err != nil || len(next) == 0 {
			return 0, err
		}
		if next[0] >= 1 {
			return next[0] / 2, nil
		}
	} else {
		nb, err := siblingsAt(ctx, q, ws, parent, self, k-1, 2)
		if err != nil {
			return 0, err
		}
		if len(nb) < 2 { // at or past the end
			return appendLast()
		}
		if nb[1]-nb[0] >= 2 {
			return nb[0] + (nb[1]-nb[0])/2, nil
		}
	}
	if err := spread(k); err != nil {
		return 0, err
	}
	return k * step, nil
}

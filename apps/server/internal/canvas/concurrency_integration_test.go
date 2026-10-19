//go:build integration

package canvas

import (
	"context"
	"fmt"
	"math/rand/v2"
	"sync"
	"sync/atomic"
	"testing"

	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/ysync"
)

// Several people move, trash, restore, create and delete forever at once over the same few
// folders: no answer is a 5xx and the tree stays a tree — no cycle, nothing deeper than 32, no
// live item under a trashed folder, the live siblings of a parent numbered 0.. without a gap or
// a duplicate (LockCanvasTree).
func TestCanvasConcurrentStructureStaysConsistent(t *testing.T) {
	e := newEnv(t, ysync.Config{})
	ws := "/api/workspaces/" + e.ws.String()
	var ids []string
	for i := 0; i < 6; i++ {
		ids = append(ids, e.mkdir(e.alice, "", fmt.Sprint("F", i)).GetId())
	}
	var wg sync.WaitGroup
	var bad sync.Map
	var moved, trashed atomic.Int32
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func(seed uint64) {
			defer wg.Done()
			rng := rand.New(rand.NewPCG(seed, seed+1))
			pick := func() string { return ids[rng.IntN(len(ids))] }
			for i := 0; i < 40; i++ {
				who := e.alice
				if rng.IntN(3) == 0 {
					who = e.admin // CANVAS_MANAGE: any item's structure
				}
				a, b := pick(), pick()
				var code int
				var what string
				switch n := rng.IntN(12); {
				case n < 5:
					what = "move"
					code = e.call(who, "PATCH", item(a), &v1.UpdateCanvasItemRequest{ParentId: proto.String(b)}).Code
				case n < 7:
					what = "to top"
					code = e.call(who, "PATCH", item(a), &v1.UpdateCanvasItemRequest{ParentId: proto.String(""), Position: proto.Int32(int32(rng.IntN(4)))}).Code //nolint:gosec // small
				case n < 8:
					what = "trash"
					code = e.call(who, "POST", item(a)+"/trash", nil).Code
				case n < 10:
					what = "restore"
					code = e.call(who, "POST", item(a)+"/restore", nil).Code
				case n < 11:
					what = "create"
					code = e.call(who, "POST", ws+"/canvas/items", &v1.CreateCanvasItemRequest{ParentId: a, Kind: board, Name: "c"}).Code
				default:
					what = "delete"
					code = e.call(who, "DELETE", item(a), nil).Code
				}
				if code == 200 && what == "move" {
					moved.Add(1)
				}
				if code == 200 && what == "trash" {
					trashed.Add(1)
				}
				if code >= 500 {
					bad.Store(fmt.Sprintf("%s %s", what, a), code)
				}
			}
		}(uint64(g) + 1)
	}
	wg.Wait()
	if moved.Load() < 2 || trashed.Load() < 2 {
		t.Errorf("the run exercised too little: %d moves, %d trashes", moved.Load(), trashed.Load())
	}
	bad.Range(func(k, v any) bool {
		t.Errorf("%v answered %v", k, v)
		return true
	})
	ctx := context.Background()
	var n int
	// A cycle never reaches the top: walk up at most 40 levels.
	if err := e.d.Pool.QueryRow(ctx, `
		WITH RECURSIVE up (id, parent_id, depth) AS (
			SELECT id, parent_id, 1 FROM canvas_items WHERE workspace_id = $1
			UNION ALL
			SELECT up.id, p.parent_id, up.depth + 1 FROM up JOIN canvas_items p ON p.id = up.parent_id WHERE up.depth < 40)
		SELECT count(*) FROM up WHERE depth >= 33`, e.ws).Scan(&n); err != nil || n != 0 {
		t.Fatalf("items deeper than 32 or in a cycle: %d %v", n, err)
	}
	if err := e.d.Pool.QueryRow(ctx, `
		SELECT count(*) FROM canvas_items c JOIN canvas_items p ON p.id = c.parent_id
		WHERE c.workspace_id = $1 AND c.trashed_at IS NULL AND p.trashed_at IS NOT NULL`, e.ws).Scan(&n); err != nil || n != 0 {
		t.Fatalf("live items under a trashed folder: %d %v", n, err)
	}
	if err := e.d.Pool.QueryRow(ctx, `
		SELECT count(*) FROM (
			SELECT parent_id, count(*) AS n, max(position) AS top, count(DISTINCT position) AS d FROM canvas_items
			WHERE workspace_id = $1 AND trashed_at IS NULL GROUP BY parent_id) s
		WHERE s.top <> s.n - 1 OR s.d <> s.n`, e.ws).Scan(&n); err != nil || n != 0 {
		t.Fatalf("sibling positions with a gap or a duplicate: %d %v", n, err)
	}
}

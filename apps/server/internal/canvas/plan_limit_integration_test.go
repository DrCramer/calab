//go:build integration

package canvas

import (
	"context"
	"fmt"
	"strings"
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/plans"
	"github.com/calaba/calaba/server/internal/ysync"
)

// overLimit asserts a 409 PLAN_LIMIT naming the canvas limit.
func (e *env) overLimit(method, path string, body any, limit int) {
	e.t.Helper()
	w := e.call(e.owner, method, path, body)
	want := fmt.Sprintf("allows %d canvases", limit)
	if w.Code != 409 || !strings.Contains(w.Body.String(), want) || !strings.Contains(w.Body.String(), "PLAN_LIMIT") {
		e.t.Fatalf("%s %s: %d %s, want 409 PLAN_LIMIT %q", method, path, w.Code, w.Body.String(), want)
	}
}

func (e *env) withPlans(plan string) {
	e.t.Helper()
	e.svc.Plans = plans.New(e.d, e.rc, plans.DefaultFree, plans.DefaultTeam, plans.DefaultBusiness)
	if plan != "" {
		if _, err := e.d.Pool.Exec(context.Background(), `INSERT INTO workspace_plans (workspace_id, plan) VALUES ($1, $2)`, e.ws, plan); err != nil {
			e.t.Fatal(err)
		}
	}
}

// TestCanvasLimitByPlan: the live canvases of a workspace are capped by the plan (owner, 23.10:
// Free 3, Team 30, Business 100); folders do not count. The canvas past the cap is a 409
// PLAN_LIMIT with the limit; the trash frees a seat.
func TestCanvasLimitByPlan(t *testing.T) {
	for _, tc := range []struct {
		plan  string // workspace_plans.plan; "" = no row (Free)
		limit int
	}{{"", 3}, {"team", 30}, {"enterprise", 100}} {
		t.Run(fmt.Sprintf("%s_%d", tc.plan, tc.limit), func(t *testing.T) {
			e := newEnv(t, ysync.Config{})
			e.withPlans(tc.plan)
			path := "/api/workspaces/" + e.ws.String() + "/canvas/items"
			dir := e.mkdir(e.owner, "", "dir")
			last := e.create(e.owner, "", "c0")
			for i := 1; i < tc.limit; i++ {
				last = e.create(e.owner, dir.GetId(), fmt.Sprintf("c%d", i))
			}
			// Exactly limit canvases exist: one more is refused, at the top level and in a folder.
			for _, parent := range []string{"", dir.GetId()} {
				e.overLimit("POST", path, &v1.CreateCanvasItemRequest{ParentId: parent, Kind: board, Name: "over"}, tc.limit)
			}
			// Folders are free.
			e.mkdir(e.owner, dir.GetId(), "sub")
			// A trashed canvas does not count: one seat is free again, then full again.
			e.must(200, e.owner, "POST", item(last.GetId())+"/trash", nil, nil)
			e.create(e.owner, "", "again")
			e.overLimit("POST", path, &v1.CreateCanvasItemRequest{Kind: board, Name: "over"}, tc.limit)
		})
	}
}

// TestCanvasRestoreLimit: a restore bringing canvases back takes seats like a create (the whole
// subtree counts); a restore without canvases and a workspace already over the limit keep working.
func TestCanvasRestoreLimit(t *testing.T) {
	e := newEnv(t, ysync.Config{})
	e.withPlans("") // Free: 3
	dir := e.mkdir(e.owner, "", "dir")
	e.create(e.owner, dir.GetId(), "a")
	e.create(e.owner, dir.GetId(), "b")
	e.create(e.owner, "", "c")
	// The folder with two canvases goes to the trash: 1 live, 2 coming back would make 3 — allowed.
	e.must(200, e.owner, "POST", item(dir.GetId())+"/trash", nil, nil)
	e.must(200, e.owner, "POST", item(dir.GetId())+"/restore", nil, nil)
	// Again, but a new canvas takes a seat meanwhile: 2 live + 2 back > 3.
	e.must(200, e.owner, "POST", item(dir.GetId())+"/trash", nil, nil)
	e.create(e.owner, "", "d")
	e.overLimit("POST", item(dir.GetId())+"/restore", nil, 3)
	if got := e.names(e.owner, "trashed=1"); len(got) != 1 || got[0] != "dir" {
		t.Fatalf("trash after a refused restore: %v, want [dir]", got)
	}
	// One canvas back on its own fits.
	one := e.create(e.owner, "", "e") // 3 live: full
	e.must(200, e.owner, "POST", item(one.GetId())+"/trash", nil, nil)
	e.must(200, e.owner, "POST", item(one.GetId())+"/restore", nil, nil)

	// A workspace over the limit (rows from before the limit) keeps everything: folders restore
	// and are created, canvases are not.
	for i := range 3 {
		if _, err := e.d.Pool.Exec(context.Background(),
			`INSERT INTO canvas_items (workspace_id, kind, name, owner_id, updated_by, position) VALUES ($1, 'canvas', $2, $3, $3, $4)`,
			e.ws, fmt.Sprintf("old%d", i), e.owner, 100+i); err != nil {
			t.Fatal(err)
		}
	}
	empty := e.mkdir(e.owner, "", "empty")
	e.must(200, e.owner, "POST", item(empty.GetId())+"/trash", nil, nil)
	e.must(200, e.owner, "POST", item(empty.GetId())+"/restore", nil, nil)
	e.overLimit("POST", item(dir.GetId())+"/restore", nil, 3)
	e.overLimit("POST", "/api/workspaces/"+e.ws.String()+"/canvas/items", &v1.CreateCanvasItemRequest{Kind: board, Name: "over"}, 3)
	// Without a plan service (on-prem without limits) nothing is capped.
	e.svc.Plans = nil
	e.must(200, e.owner, "POST", item(dir.GetId())+"/restore", nil, nil)
}

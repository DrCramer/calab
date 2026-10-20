//go:build integration

package wiki

import (
	"context"
	"fmt"
	"strings"
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/plans"
)

// TestWikiPageLimitByPlan: the live pages of a workspace are capped by the plan (owner, CBF-43:
// Free 10, Team 50, Business 500). The page past the cap is a 409 PLAN_LIMIT with the limit; the
// trash frees a seat, a restore does not need one.
func TestWikiPageLimitByPlan(t *testing.T) {
	for _, tc := range []struct {
		plan  string // workspace_plans.plan; "" = no row (Free)
		limit int
	}{{"", 10}, {"team", 50}, {"enterprise", 500}} {
		t.Run(fmt.Sprintf("%s_%d", tc.plan, tc.limit), func(t *testing.T) {
			e := newEnv(t, SyncConfig{})
			e.svc.plans = plans.New(e.d, e.rc, plans.DefaultFree, plans.DefaultTeam, plans.DefaultBusiness)
			if tc.plan != "" {
				if _, err := e.d.Pool.Exec(context.Background(), `INSERT INTO workspace_plans (workspace_id, plan) VALUES ($1, $2)`, e.ws, tc.plan); err != nil {
					t.Fatal(err)
				}
			}
			path := "/api/workspaces/" + e.ws.String() + "/wiki/pages"
			first := e.create(e.owner, "", "p0")
			last := first
			for i := 1; i < tc.limit; i++ {
				last = e.create(e.owner, first.GetId(), fmt.Sprintf("p%d", i))
			}
			// Exactly limit pages exist: one more is refused, at the top level and under a page.
			want := fmt.Sprintf("allows %d wiki pages", tc.limit)
			for _, parent := range []string{"", first.GetId()} {
				w := e.call(e.owner, "POST", path, &v1.CreateWikiPageRequest{ParentId: parent, Title: "over"}, nil)
				if w.Code != 409 || !strings.Contains(w.Body.String(), want) || !strings.Contains(w.Body.String(), "PLAN_LIMIT") {
					t.Fatalf("page %d: %d %s, want 409 PLAN_LIMIT %q", tc.limit+1, w.Code, w.Body.String(), want)
				}
			}
			// A trashed page does not count: one seat is free again, then full again.
			e.must(200, e.owner, "POST", page(last.GetId())+"/trash", nil, nil)
			e.create(e.owner, first.GetId(), "again")
			e.must(409, e.owner, "POST", path, &v1.CreateWikiPageRequest{Title: "over"}, nil)
		})
	}
}

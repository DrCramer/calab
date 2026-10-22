package plans

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// CBF-69: AI is Business only (owner, 22.10): a positive flag, so Free, Team, an older custom
// row without the key and an expired plan have none; an override of Team / Business cannot move it.
func TestAIPlanFlag(t *testing.T) {
	if DefaultFree.AI || DefaultTeam.AI || !DefaultBusiness.AI || CustomBase.AI || (Limits{}).AI {
		t.Fatalf("built-in AI flags: free %v team %v business %v custom %v", DefaultFree.AI, DefaultTeam.AI, DefaultBusiness.AI, CustomBase.AI)
	}
	// The operator's own tariffs (PLAN_*_LIMITS) may grant it.
	if free, _, _, err := Defaults(`{"ai":true}`, "", ""); err != nil || !free.AI {
		t.Fatalf("env ai: %v %v", free.AI, err)
	}

	ctx := context.Background()
	now := time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC)
	past := now.Add(-time.Hour)
	f := &fakeRows{rows: map[uuid.UUID]*sqlc.WorkspacePlan{}}
	s := testService(f, &now)
	for _, c := range []struct {
		name string
		row  *sqlc.WorkspacePlan
		want bool
	}{
		{"no row (free)", nil, false},
		{"free", &sqlc.WorkspacePlan{Plan: "free"}, false},
		{"team", &sqlc.WorkspacePlan{Plan: "team"}, false},
		{"business", &sqlc.WorkspacePlan{Plan: "enterprise"}, true},
		{"expired business", &sqlc.WorkspacePlan{Plan: "enterprise", ValidUntil: &past}, false},
		{"older custom row", &sqlc.WorkspacePlan{Plan: "custom", Limits: []byte(`{"members":7}`)}, false},
		{"custom with ai", &sqlc.WorkspacePlan{Plan: "custom", Limits: []byte(`{"members":7,"ai":true}`)}, true},
		{"team with a stored ai key", &sqlc.WorkspacePlan{Plan: "team", Limits: []byte(`{"ai":true,"members":7}`)}, false},
		{"business with a stored ai key", &sqlc.WorkspacePlan{Plan: "enterprise", Limits: []byte(`{"ai":false}`)}, true},
	} {
		id := uuid.New()
		if c.row != nil {
			c.row.WorkspaceID = id
			f.rows[id] = c.row
		}
		ok, err := s.AllowsAI(ctx, id)
		if err != nil || ok != c.want {
			t.Errorf("%s: AllowsAI %v %v, want %v", c.name, ok, err, c.want)
		}
		if l, _ := s.Effective(ctx, id); l.Proto().GetAi() != c.want {
			t.Errorf("%s: PlanLimits.ai %v, want %v", c.name, l.Proto().GetAi(), c.want)
		}
	}
	if ok, err := (*Service)(nil).AllowsAI(ctx, uuid.New()); err != nil || !ok {
		t.Fatalf("nil service: %v %v", ok, err)
	}

	// The admin form: Team / Business overrides cannot change ai; the plan's own value and a
	// custom plan's choice pass.
	a := &Admin{plans: s}
	for _, c := range []struct {
		plan v1.Plan
		ai   bool
		ok   bool
	}{
		{v1.Plan_PLAN_TEAM, true, false},
		{v1.Plan_PLAN_TEAM, false, true},
		{v1.Plan_PLAN_ENTERPRISE, false, false},
		{v1.Plan_PLAN_ENTERPRISE, true, true},
		{v1.Plan_PLAN_CUSTOM, true, true},
		{v1.Plan_PLAN_CUSTOM, false, true},
	} {
		l := s.PlanLimits(c.plan).Proto()
		l.Ai = c.ai
		_, target, stored, _, err := a.validatePlan(&v1.AdminSetPlanRequest{Plan: c.plan, Limits: l}, now)
		if (err == nil) != c.ok {
			t.Errorf("%v ai=%v: err %v, want ok %v", c.plan, c.ai, err, c.ok)
			continue
		}
		if err == nil && (target.AI != c.ai || (c.plan != v1.Plan_PLAN_CUSTOM && stored != nil)) {
			t.Errorf("%v ai=%v: target %v stored %s", c.plan, c.ai, target.AI, stored)
		}
	}
}

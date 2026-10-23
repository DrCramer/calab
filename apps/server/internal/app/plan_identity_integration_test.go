//go:build integration

package app_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/identitypolicy"
)

// CBF-44: the OAuth provider (and SSO, directory sync) followed plan = enterprise alone, in Go and
// in the identity gate's SQL, so a custom plan never had it whatever the superadmin did, and
// switching back to the custom plan revoked it again. ADR-0113: a stored corporate_identity flag
// decides (custom plans, overrides of Team / Business); Team / Business overrides store only what
// differs from the plan's defaults.
func TestAdminPlanIdentityAndOverrides(t *testing.T) {
	ctx := context.Background()
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	wid := uuid.MustParse(ws.GetId())
	admin := superadminUser(t)
	loader := identitypolicy.NewSQLLoader(testDB.Q, testCfg.IdentityEntitlements())
	put := func(req *v1.AdminSetPlanRequest) *v1.WorkspacePlan {
		t.Helper()
		var out v1.AdminSetPlanResponse
		admin.must(200, "PUT", "/api/admin/workspaces/"+ws.GetId()+"/plan", req, &out)
		return out.GetWorkspace().GetWorkspace().GetPlan()
	}
	// Both paths of the gate: the single-grant read (OAuth client management) and the
	// one-statement identity state (business_eligible in SQL).
	oauth := func(step string, want bool) {
		t.Helper()
		now := time.Now()
		g, err := loader.LoadGrant(ctx, now, wid, identitypolicy.OAuthProvider)
		if err != nil {
			t.Fatal(err)
		}
		state, err := loader.LoadIdentityState(ctx, uuid.MustParse(o.session), uuid.MustParse(o.id), wid)
		if err != nil {
			t.Fatal(err)
		}
		one := identitypolicy.RequireEntitlement(now, wid, g, identitypolicy.OAuthProvider).Allowed
		gate := identitypolicy.RequireEntitlement(now, wid, state.Grants[identitypolicy.OAuthProvider], identitypolicy.OAuthProvider).Allowed
		if one != want || gate != want {
			t.Fatalf("%s: OAuth provider grant %v / gate %v, want %v", step, one, gate, want)
		}
	}
	// The stored overrides as compact JSON with sorted keys (NULL = "").
	stored := func() string {
		t.Helper()
		var raw []byte
		if err := testDB.Pool.QueryRow(ctx, `SELECT limits FROM workspace_plans WHERE workspace_id = $1`, wid).Scan(&raw); err != nil {
			t.Fatal(err)
		}
		if raw == nil {
			return ""
		}
		var m map[string]any
		if err := json.Unmarshal(raw, &m); err != nil {
			t.Fatal(err)
		}
		out, _ := json.Marshal(m)
		return string(out)
	}

	// An admin client that does not know the flag sends no key: no identity (no permissive zero).
	put(&v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_CUSTOM, Limits: &v1.PlanLimits{RoomMembers: 9}})
	oauth("custom without identity", false)
	// The bug: a custom plan with the switch on got no grant at all.
	if p := put(&v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_CUSTOM, Limits: &v1.PlanLimits{RoomMembers: 9, CorporateIdentity: true}}); !p.GetLimits().GetCorporateIdentity() {
		t.Fatalf("custom limits: %v", p.GetLimits())
	}
	oauth("custom with identity", true)
	// An older custom row without the key: off (CustomBase), in Go and in SQL.
	if _, err := testDB.Pool.Exec(ctx, `UPDATE workspace_plans SET limits = limits - 'corporate_identity' WHERE workspace_id = $1`, wid); err != nil {
		t.Fatal(err)
	}
	oauth("older custom row", false)

	// Team: the defaults, no grant, nothing stored.
	team := put(&v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_TEAM})
	if team.GetLimits().GetCorporateIdentity() || stored() != "" {
		t.Fatalf("team defaults: %v, stored %s", team.GetLimits(), stored())
	}
	oauth("team", false)
	// Team with overrides: only the changed keys are stored; the plan stays Team.
	l := proto.Clone(team.GetLimits()).(*v1.PlanLimits)
	l.RoomMembers, l.CorporateIdentity = 40, true
	p := put(&v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_TEAM, Limits: l})
	if p.GetPlan() != v1.Plan_PLAN_TEAM || p.GetLimits().GetRoomMembers() != 40 || p.GetLimits().GetMembers() != team.GetLimits().GetMembers() ||
		stored() != `{"corporate_identity":true,"room_members":40}` {
		t.Fatalf("team overrides: %v, stored %s", p, stored())
	}
	oauth("team with identity", true)
	// Saved again unchanged (what the admin form sends): the overrides stay.
	put(&v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_TEAM, Limits: p.GetLimits()})
	if stored() != `{"corporate_identity":true,"room_members":40}` {
		t.Fatalf("resaved overrides: %s", stored())
	}
	// Without limits: back to the defaults.
	if p := put(&v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_TEAM}); p.GetLimits().GetRoomMembers() != team.GetLimits().GetRoomMembers() || stored() != "" {
		t.Fatalf("team reset: %v, stored %s", p.GetLimits(), stored())
	}
	oauth("team reset", false)

	// Business: on by default, an override turns it off.
	biz := put(&v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_ENTERPRISE})
	oauth("business", true)
	l = proto.Clone(biz.GetLimits()).(*v1.PlanLimits)
	l.CorporateIdentity = false
	put(&v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_ENTERPRISE, Limits: l})
	oauth("business without identity", false)

	// Free takes no limits.
	if st := admin.do("PUT", "/api/admin/workspaces/"+ws.GetId()+"/plan", &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_FREE, Limits: &v1.PlanLimits{}}, nil); st != 422 {
		t.Fatalf("free with limits: %d", st)
	}
}

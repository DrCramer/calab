//go:build integration

package app_test

import (
	"testing"

	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// TestAIPlanGate (CBF-69): the AI features are Business only. On Free and Team every AI route —
// settings, check, status, smart tasks — answers 409 AI_PLAN_REQUIRED without calling the
// provider; rights still come first (403 / 404); the boards' AI instruction stays writable on any
// plan; a Team / Business override cannot grant or remove AI; the stored settings survive a
// downgrade and work again on Business.
func TestAIPlanGate(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	base := "/api/workspaces/" + wid + "/ai"
	smart := "/api/workspaces/" + wid + "/smart-tasks"
	key := func(s string) *string { return &s }
	gpt := v1.AiProvider_AI_PROVIDER_GPTUNNEL
	board := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Разработка", Key: "DEV"}, 201)

	refused := func(step string) {
		t.Helper()
		calls := aiFakeCalls.Load()
		for _, c := range []struct {
			u      *user
			method string
			path   string
			in     proto.Message
		}{
			{o, "GET", base, nil},
			{o, "PUT", base, &v1.PutAiSettingsRequest{Provider: gpt, Model: "gpt-6-astra", ApiKey: key(aiFakeKey)}},
			{o, "POST", base + "/check", &v1.CheckAiRequest{Provider: gpt, Model: "gpt-6-astra", ApiKey: key(aiFakeKey)}},
			{o, "GET", base + "/status", nil},
			{bob, "GET", base + "/status", nil},
			{bob, "POST", smart, &v1.CreateSmartTaskRequest{Text: "ROUTE=DEV x"}},
		} {
			if st, e := c.u.apiErrBody(c.method, c.path, c.in); st != 409 || e.GetReason() != "AI_PLAN_REQUIRED" {
				t.Fatalf("%s: %s %s: %d %v, want 409 AI_PLAN_REQUIRED", step, c.method, c.path, st, e)
			}
		}
		// Rights first: a member without MANAGE_INTEGRATIONS still gets 403.
		bob.must(403, "PUT", base, &v1.PutAiSettingsRequest{Provider: gpt, Model: "m", ApiKey: key(aiFakeKey)}, nil)
		if n := aiFakeCalls.Load(); n != calls {
			t.Fatalf("%s: the provider was called %d times", step, n-calls)
		}
	}

	// Free (no plan row) and Team.
	refused("free")
	instr := "Ставь метку bug"
	o.must(200, "PATCH", "/api/boards/"+board.GetId(), &v1.UpdateBoardRequest{AiInstruction: &instr}, nil) // any plan
	setPlan(t, wid, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_TEAM})
	refused("team")

	// An override of Team cannot grant AI (422), nor one of Business remove it.
	admin := superadminUser(t)
	var cur v1.GetWorkspaceResponse
	o.must(200, "GET", "/api/workspaces/"+wid, nil, &cur)
	l := proto.Clone(cur.GetWorkspace().GetPlan().GetLimits()).(*v1.PlanLimits)
	if l.GetAi() {
		t.Fatal("team limits carry ai")
	}
	l.Ai = true
	if st := admin.do("PUT", "/api/admin/workspaces/"+wid+"/plan", &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_TEAM, Limits: l}, nil); st != 422 {
		t.Fatalf("team override with ai: %d", st)
	}
	refused("team after a refused override")

	// Business: on; settings saved and checked; the members see it in the plan.
	setPlan(t, wid, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_ENTERPRISE})
	o.must(200, "GET", "/api/workspaces/"+wid, nil, &cur)
	if !cur.GetWorkspace().GetPlan().GetLimits().GetAi() {
		t.Fatal("business limits without ai")
	}
	l = proto.Clone(cur.GetWorkspace().GetPlan().GetLimits()).(*v1.PlanLimits)
	l.Ai = false
	if st := admin.do("PUT", "/api/admin/workspaces/"+wid+"/plan", &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_ENTERPRISE, Limits: l}, nil); st != 422 {
		t.Fatalf("business override without ai: %d", st)
	}
	o.must(200, "PUT", base, &v1.PutAiSettingsRequest{Provider: gpt, Model: "gpt-6-astra", ApiKey: key(aiFakeKey)}, nil)
	var c v1.CheckAiResponse
	o.must(200, "POST", base+"/check", &v1.CheckAiRequest{Provider: gpt, Model: "gpt-6-astra"}, &c)
	if !c.GetOk() || c.GetState() != v1.AiState_AI_STATE_READY {
		t.Fatalf("business check: %v", &c)
	}

	// Back to Team: refused again, the settings stay; on Business they are READY again.
	setPlan(t, wid, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_TEAM})
	refused("team after business")
	setPlan(t, wid, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_ENTERPRISE})
	var st v1.GetAiStatusResponse
	bob.must(200, "GET", base+"/status", nil, &st)
	if st.GetState() != v1.AiState_AI_STATE_READY {
		t.Fatalf("business again: %v", st.GetState())
	}
}

package app

import (
	"strings"
	"testing"
)

// TestBotRouteGroups (ADR-0109 §3): every section of the bot table says why, a people-only
// section names its reason, on-behalf tags sit only on botAllow sections, and the routes ADR-0109
// opened stay closed on behalf of the owner (ADR-0106 §3 is not widened).
func TestBotRouteGroups(t *testing.T) {
	n := 0
	for i, g := range botRouteGroups {
		if len(g.routes) == 0 {
			t.Errorf("group %d (%q) has no routes", i, g.why)
		}
		if strings.TrimSpace(g.why) == "" {
			t.Errorf("group %d (%v) has no reason", i, g.routes)
		}
		if g.access != botAllow && g.access != botDeny && g.access != botPublic {
			t.Errorf("group %d: unknown access %d", i, g.access)
		}
		if g.onBehalf != 0 && g.access != botAllow {
			t.Errorf("group %d: an on-behalf tag on a section that is not botAllow", i)
		}
		if strings.HasPrefix(g.why, "ADR-0109") && (g.access != botAllow || g.onBehalf != onBehalfClosed) {
			t.Errorf("group %d: ADR-0109 opens routes to bots and keeps them closed on behalf", i)
		}
		n += len(g.routes)
	}
	if n != len(botRoutes) {
		t.Errorf("%d routes in the groups, %d in the index", n, len(botRoutes))
	}
	// The cases the owner asked for (CBF-11): a bot with the bits manages automations and Git.
	for _, p := range []string{"POST /api/boards/{id}/rules", "PATCH /api/rules/{id}", "DELETE /api/rules/{id}",
		"POST /api/rules/{id}/test", "GET /api/boards/{id}/git", "PUT /api/boards/{id}/git", "DELETE /api/boards/{id}/git"} {
		if botRoutes[p] != botAllow || onBehalfAllowed(p) {
			t.Errorf("%q: want botAllow and closed on behalf", p)
		}
	}
	// ADR-0119: the bot asks for its own consent, never on behalf; the consent itself, a decline
	// and a cancellation stay a person's.
	if p := "POST /api/workspaces/{id}/bots/{botId}/delegation-invites"; botRoutes[p] != botAllow || onBehalfAllowed(p) {
		t.Errorf("%q: want botAllow and closed on behalf", p)
	}
	for _, p := range []string{"PUT /api/workspaces/{id}/bots/{botId}/delegations/{userId}", "DELETE /api/workspaces/{id}/bots/{botId}/delegations/{userId}",
		"DELETE /api/workspaces/{id}/bots/{botId}/delegation-invites/{userId}", "POST /api/messages/{id}/interactions"} {
		if botRoutes[p] != botDeny {
			t.Errorf("%q: want botDeny", p)
		}
	}
	// Kept people only whatever the roles (ADR-0109 §2).
	for _, p := range []string{"POST /api/tasks/{id}/approval", "POST /api/workspaces/{id}/bots/{botId}/token",
		"PATCH /api/workspaces/{id}/bots/{botId}", "DELETE /api/workspaces/{id}", "GET /api/workspaces/{id}/billing",
		"PATCH /api/me/password", "GET /api/me/sessions", "PUT /api/workspaces/{workspace_id}/identity/policy",
		"POST /api/rooms/{id}/invites", "POST /api/dms/{id}/call", "GET /api/notes", "POST /api/workspaces/{id}/members"} {
		if botRoutes[p] != botDeny {
			t.Errorf("%q: want botDeny", p)
		}
	}
}

func TestIndexBotRoutesRejectsDuplicates(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Error("a route listed twice must panic")
		}
	}()
	indexBotRoutes([]botRouteGroup{{access: botAllow, why: "a", routes: []string{"GET /x"}}, {access: botDeny, why: "b", routes: []string{"GET /x"}}})
}

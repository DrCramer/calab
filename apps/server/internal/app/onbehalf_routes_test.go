package app

import (
	"regexp"
	"slices"
	"testing"
)

// TestOnBehalfRouteTable (ADR-0106 §3): the on-behalf tag only adjusts the bot table — an open
// route was botDeny, a closed one botAllow — and no route of the person's account, bot
// management, billing, superadmin, workspace deletion or voice is ever open on behalf of the
// owner. The integration test of the same name checks the server enforces it.
func TestOnBehalfRouteTable(t *testing.T) {
	var open []string
	for p, a := range onBehalfRoutes {
		switch a {
		case onBehalfOpen:
			if botRoutes[p] != botDeny {
				t.Errorf("%q is opened on behalf but is not botDeny (%v)", p, botRoutes[p])
			}
			open = append(open, p)
		case onBehalfClosed:
			if botRoutes[p] != botAllow {
				t.Errorf("%q is closed on behalf but is not botAllow: drop the line", p)
			}
		default:
			t.Errorf("%q: unknown on-behalf access %d", p, a)
		}
	}
	slices.Sort(open)
	if want := []string{"POST /api/tasks/{id}/approval"}; !slices.Equal(open, want) {
		t.Errorf("opened on behalf: %v, want %v (a new one needs ADR-0106 §3 updated)", open, want)
	}

	never := regexp.MustCompile(`^PATCH /api/me$|^POST /api/me/avatar$|/api/me/(password|email|sessions|push|oauth|caldav|status|external-events|blocked-bots)` +
		`|/api/auth/|/oidc/|/oauth/|/identity|/bots|/billing|^[A-Z]+ /api/admin/|^DELETE /api/workspaces/\{id\}$|/take-over` +
		`|/join$|/voice|/camera/|/stream/|/sounds/play|/calls|/recording/|/mailbox/|^POST /api/workspaces$|/invites/lookup` +
		`|^POST /api/workspaces/\{id\}/members$|/sip|/apps|/webhook|/notes`)
	for p := range botRoutes {
		if never.MatchString(p) && onBehalfAllowed(p) {
			t.Errorf("%q must not be open on behalf of the owner", p)
		}
	}
	// Spot checks of the decision itself.
	for p, want := range map[string]bool{
		"POST /api/tasks/{id}/approval":                  true,
		"POST /api/rooms/{id}/messages":                  true,
		"PATCH /api/tasks/{id}":                          true,
		"GET /api/me":                                    true,
		"PATCH /api/me":                                  false,
		"PATCH /api/workspaces/{id}/bots/{botId}":        false,
		"POST /api/workspaces/{id}/bots/{botId}/token":   false,
		"DELETE /api/workspaces/{id}":                    false,
		"GET /api/me/sessions":                           false,
		"POST /api/rooms/{id}/join":                      false,
		"PUT /api/events/{id}/rsvp":                      false,
		"POST /api/messages/{id}/interactions":           false,
		"GET /api/workspaces/{id}/billing":               false,
		"unlisted":                                       false,
		"POST /api/workspaces/{id}/bots/{botId}/avatar":  false,
		"DELETE /api/workspaces/{id}/bots/{botId}/token": false,
	} {
		if got := onBehalfAllowed(p); got != want {
			t.Errorf("onBehalfAllowed(%q) = %v, want %v", p, got, want)
		}
	}
}

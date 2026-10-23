package identitypolicy

import (
	"testing"
	"time"
)

// CBF-44: corporate identity used to follow plan = enterprise alone, so a custom plan (or Team)
// could never have the OAuth provider whatever the superadmin set. A stored boolean
// corporate_identity decides now (ADR-0113); without it only Business does; expiry always denies.
func TestPlanGrantsIdentity(t *testing.T) {
	past, future := testNow.Add(-time.Hour), testNow.Add(time.Hour)
	for name, c := range map[string]struct {
		plan   string
		limits string
		until  *time.Time
		want   bool
	}{
		"business":                 {"enterprise", "", nil, true},
		"business until later":     {"enterprise", "", &future, true},
		"business expired":         {"enterprise", "", &past, false},
		"business override off":    {"enterprise", `{"corporate_identity":false}`, nil, false},
		"team":                     {"team", "", nil, false},
		"team override on":         {"team", `{"room_members":40,"corporate_identity":true}`, nil, true},
		"free":                     {"free", "", nil, false},
		"custom without the key":   {"custom", `{"room_members":5}`, nil, false},
		"custom on":                {"custom", `{"corporate_identity":true}`, nil, true},
		"custom on expired":        {"custom", `{"corporate_identity":true}`, &past, false},
		"custom off":               {"custom", `{"corporate_identity":false}`, nil, false},
		"custom non-boolean":       {"custom", `{"corporate_identity":"true"}`, nil, false},
		"custom null":              {"custom", `{"corporate_identity":null}`, nil, false},
		"custom corrupt":           {"custom", `not json`, nil, false},
		"business non-boolean key": {"enterprise", `{"corporate_identity":0}`, nil, true},
	} {
		var limits []byte
		if c.limits != "" {
			limits = []byte(c.limits)
		}
		if got := PlanGrantsIdentity(c.plan, limits, c.until, testNow); got != c.want {
			t.Errorf("%s: %v, want %v", name, got, c.want)
		}
	}
}

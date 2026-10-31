//go:build integration

package app_test

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// metrikaFakeMS is the Measurement Protocol token of the run (any non-empty value enables it).
const metrikaFakeMS = "it-metrika"

// metrikaFake is the Measurement Protocol collector of the whole run (config MetrikaMPURL).
var metrikaFake = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
	_, _ = w.Write([]byte("<!-- OK -->"))
}))

// ADR-0135: a sign-up stores its first-touch attribution and, with a Metrika ClientID, one
// signup conversion; without attribution nothing is stored.
func TestSignupAttribution(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	code := invite(t, o, ws.GetId())
	signup := func(a *v1.SignupAttribution) string {
		seq++
		c := &client{t: t, ip: fmt.Sprintf("10.9.%d.%d", seq/250, seq%250+1)}
		var resp v1.RegisterResponse
		c.must(201, "POST", "/api/auth/register", &v1.RegisterRequest{Email: uniq("attr") + "@example.com", Password: "password123",
			DisplayName: "Attr", InviteCode: code, Attribution: a}, &resp)
		return resp.GetMe().GetUser().GetId()
	}
	count := func(q, id string) int {
		var n int
		if err := testDB.Pool.QueryRow(context.Background(), q, id).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	const attrQ = `SELECT count(*) FROM user_attribution WHERE user_id = $1`
	const convQ = `SELECT count(*) FROM metrika_conversions WHERE dedupe_key = 'signup:' || $1 AND goal = 'signup'`

	id := signup(&v1.SignupAttribution{UtmSource: "yandex", UtmMedium: "cpc", UtmCampaign: "brand", Yclid: "991", YmClientId: "1710232430899999999"})
	var src, cid string
	if err := testDB.Pool.QueryRow(context.Background(), `SELECT utm_source, ym_client_id FROM user_attribution WHERE user_id = $1`, id).Scan(&src, &cid); err != nil {
		t.Fatal(err)
	}
	if src != "yandex" || cid != "1710232430899999999" || count(convQ, id) != 1 {
		t.Fatalf("attribution %q %q, conversions %d", src, cid, count(convQ, id))
	}
	// UTM only (no consent on the landing → no ClientID): stored, nothing for Metrika.
	id = signup(&v1.SignupAttribution{UtmSource: "telegram", YmClientId: "not-a-number"})
	if count(attrQ, id) != 1 || count(convQ, id) != 0 {
		t.Fatalf("utm-only sign-up: attribution %d, conversions %d", count(attrQ, id), count(convQ, id))
	}
	id = signup(nil)
	if count(attrQ, id) != 0 || count(convQ, id) != 0 {
		t.Fatal("a sign-up without attribution stored something")
	}
}

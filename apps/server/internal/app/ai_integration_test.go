//go:build integration

package app_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// aiFakeKey is the only key the fake provider accepts (a fixture, not a real key).
const aiFakeKey = "it-ai-key-0123456789abcd" //nolint:gosec // G101: a test fixture

// aiFake is a fake OpenAI-compatible provider: GPTUNNEL_AI_URL of the test server is its /v1,
// and the OpenAI-compatible tests point base_url at it too (loopback is allowed in tests).
var aiFake = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || r.URL.Path != "/v1/chat/completions" {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if r.Header.Get("Authorization") != "Bearer "+aiFakeKey {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = io.WriteString(w, `{"error":{"message":"Unauthorized","type":"unauthorized_request_error"}}`)
		return
	}
	var req struct {
		Model    string `json:"model"`
		Messages []struct {
			Role    string `json:"role"`
			Content string `json:"content"`
		} `json:"messages"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	if len(req.Messages) == 2 && req.Messages[0].Role == "system" { // smart tasks (smart_integration_test)
		smartFakeAnswer(w, req.Messages[0].Content, req.Messages[1].Content)
		return
	}
	if req.Model == "missing" {
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, `{"error":{"message":"The model 'missing' does not exist","code":"model_not_found"}}`)
		return
	}
	_, _ = io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":"Hello!"}}]}`)
}))

func TestAIIntegration(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	base := "/api/workspaces/" + wid + "/ai"
	key := func(s string) *string { return &s }
	gpt := v1.AiProvider_AI_PROVIDER_GPTUNNEL
	oai := v1.AiProvider_AI_PROVIDER_OPENAI_COMPATIBLE

	// Defaults; MANAGE_INTEGRATIONS only (members, guests 403; strangers 404).
	var g v1.GetAiSettingsResponse
	o.must(200, "GET", base, nil, &g)
	if s := g.GetSettings(); s.GetProvider() != v1.AiProvider_AI_PROVIDER_UNSPECIFIED || s.GetModel() != "gpt-6-astra" || s.GetHasKey() || s.GetUpdatedAt() != nil {
		t.Fatalf("defaults: %v", s)
	}
	bob.must(403, "GET", base, nil, nil)
	bob.must(403, "PUT", base, &v1.PutAiSettingsRequest{Provider: gpt, Model: "m", ApiKey: key(aiFakeKey)}, nil)
	bob.must(403, "POST", base+"/check", &v1.CheckAiRequest{Provider: gpt, Model: "m", ApiKey: key(aiFakeKey)}, nil)
	gus := register(t, invite(t, o, wid))
	guest := v1.WorkspaceRole_WORKSPACE_ROLE_GUEST
	o.must(200, "PATCH", "/api/workspaces/"+wid+"/members/"+gus.id, &v1.UpdateMemberRequest{Role: &guest}, nil)
	gus.must(403, "GET", base, nil, nil)
	other := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	stranger := register(t, invite(t, o, other.GetId()))
	stranger.must(404, "GET", base, nil, nil)

	// Validation.
	for field, req := range map[string]*v1.PutAiSettingsRequest{
		"provider": {Model: "m"},
		"model":    {Provider: gpt, Model: "  "},
		"baseUrl":  {Provider: oai, Model: "m", BaseUrl: "not a url"},
		"apiKey":   {Provider: gpt, Model: "m", ApiKey: key("with space")},
	} {
		if st, e := o.apiErrBody("PUT", base, req); st != 422 || e.GetField() != field {
			t.Fatalf("%s: %d %v", field, st, e)
		}
	}
	if st, e := o.apiErrBody("POST", base+"/check", &v1.CheckAiRequest{Provider: gpt, Model: "m"}); st != 422 || e.GetField() != "apiKey" {
		t.Fatalf("check without a key: %d %v", st, e)
	}

	// Save GPTunneL: the key is sealed and comes back only as a mask.
	var put v1.PutAiSettingsResponse
	o.must(200, "PUT", base, &v1.PutAiSettingsRequest{Provider: gpt, Model: " gpt-6-astra ", ApiKey: key(aiFakeKey)}, &put)
	if s := put.GetSettings(); s.GetProvider() != gpt || s.GetModel() != "gpt-6-astra" || !s.GetHasKey() || s.GetKeyMask() != "••••abcd" || s.GetUpdatedBy() != o.id || s.GetBaseUrl() != "" {
		t.Fatalf("saved: %v", s)
	}
	if strings.Contains(string(o.lastBody), aiFakeKey) {
		t.Fatal("PUT echoes the key")
	}
	row, err := testDB.Q.GetWorkspaceAi(context.Background(), uuid.MustParse(wid))
	if err != nil || len(row.KeyEnc) == 0 || strings.Contains(string(row.KeyEnc), aiFakeKey) {
		t.Fatalf("stored: %v", err)
	}
	o.must(200, "GET", base, nil, &g)
	if strings.Contains(string(o.lastBody), aiFakeKey) || !g.GetSettings().GetHasKey() {
		t.Fatalf("GET: %s", o.lastBody)
	}

	// Check: the stored key, a wrong key, a missing model.
	var c v1.CheckAiResponse
	o.must(200, "POST", base+"/check", &v1.CheckAiRequest{Provider: gpt, Model: "gpt-6-astra"}, &c)
	if !c.GetOk() || c.GetReply() != "Hello!" || c.GetHttpStatus() != 200 {
		t.Fatalf("check ok: %v", &c)
	}
	o.must(200, "POST", base+"/check", &v1.CheckAiRequest{Provider: gpt, Model: "gpt-6-astra", ApiKey: key("wrong-key-000000000000")}, &c)
	if c.GetOk() || c.GetError() != "unauthorized" || c.GetHttpStatus() != 401 {
		t.Fatalf("check wrong key: %v", &c)
	}
	o.must(200, "POST", base+"/check", &v1.CheckAiRequest{Provider: gpt, Model: "missing"}, &c)
	if c.GetOk() || c.GetError() != "model_not_found" {
		t.Fatalf("check missing model: %v", &c)
	}

	// The stored key never goes to another provider or base URL without being entered again.
	compat := aiFake.URL + "/v1/"
	if st, e := o.apiErrBody("PUT", base, &v1.PutAiSettingsRequest{Provider: oai, Model: "m", BaseUrl: compat}); st != 422 || e.GetField() != "apiKey" {
		t.Fatalf("switch without a key: %d %v", st, e)
	}
	if st, e := o.apiErrBody("POST", base+"/check", &v1.CheckAiRequest{Provider: oai, Model: "m", BaseUrl: compat}); st != 422 || e.GetField() != "apiKey" {
		t.Fatalf("check another host with the stored key: %d %v", st, e)
	}
	o.must(200, "PUT", base, &v1.PutAiSettingsRequest{Provider: oai, Model: "m", BaseUrl: compat, ApiKey: key(aiFakeKey)}, &put)
	if s := put.GetSettings(); s.GetProvider() != oai || s.GetBaseUrl() != aiFake.URL+"/v1" || !s.GetHasKey() {
		t.Fatalf("saved compatible: %v", s)
	}
	o.must(200, "POST", base+"/check", &v1.CheckAiRequest{Provider: oai, Model: "m", BaseUrl: aiFake.URL + "/v1"}, &c)
	if !c.GetOk() {
		t.Fatalf("check compatible: %v", &c)
	}
	// Same target, no key field: the key is kept; "" removes it.
	o.must(200, "PUT", base, &v1.PutAiSettingsRequest{Provider: oai, Model: "m2", BaseUrl: aiFake.URL + "/v1"}, &put)
	if !put.GetSettings().GetHasKey() || put.GetSettings().GetModel() != "m2" {
		t.Fatalf("kept: %v", put.GetSettings())
	}
	o.must(200, "PUT", base, &v1.PutAiSettingsRequest{Provider: oai, Model: "m2", BaseUrl: aiFake.URL + "/v1", ApiKey: key("")}, &put)
	if put.GetSettings().GetHasKey() || put.GetSettings().GetKeyMask() != "" {
		t.Fatalf("removed: %v", put.GetSettings())
	}
}

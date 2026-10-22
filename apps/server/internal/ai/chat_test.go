package ai

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"strings"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/unfurl"
)

const fakeKey = "sk-test-0123456789abcdef"

func loopback(netip.Addr) bool { return true }

// provider is a mock Chat Completions API: it checks the request and answers status + body.
func provider(t *testing.T, status int, body string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/chat/completions" {
			http.NotFound(w, r)
			return
		}
		if got := r.Header.Get("Authorization"); got != "Bearer "+fakeKey {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = io.WriteString(w, `{"error":{"message":"Unauthorized","type":"unauthorized_request_error","code":null}}`)
			return
		}
		var req chatRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Model == "" || len(req.Messages) != 1 || req.Messages[0].Content != "hi" {
			t.Errorf("bad request: %+v %v", req, err)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestHelloOK(t *testing.T) {
	srv := provider(t, 200, `{"id":"x","choices":[{"message":{"role":"assistant","content":" Hello! How can I help? "}}]}`)
	res := NewChat(loopback).Hello(context.Background(), srv.URL+"/v1/", fakeKey, "gpt-6-astra")
	if !res.OK || res.Reply != "Hello! How can I help?" || res.Status != 200 || res.Error != "" {
		t.Fatalf("got %+v", res)
	}
}

func TestHelloContentParts(t *testing.T) {
	srv := provider(t, 200, `{"choices":[{"message":{"content":[{"type":"text","text":"Hi"},{"type":"text","text":"!"}]}}]}`)
	if res := NewChat(loopback).Hello(context.Background(), srv.URL+"/v1", fakeKey, "m"); !res.OK || res.Reply != "Hi!" {
		t.Fatalf("got %+v", res)
	}
}

func TestHelloErrors(t *testing.T) {
	cases := []struct {
		name, key, body string
		status          int
		want            string
	}{
		{"wrong key", "sk-wrong-key-000000000", "", 200, ErrUnauthorized},
		{"model", fakeKey, `{"error":{"message":"The model 'nope' does not exist","code":"model_not_found"}}`, 404, ErrModelNotFound},
		{"model in 400", fakeKey, `{"error":{"message":"Unknown model: nope"}}`, 400, ErrModelNotFound},
		{"balance", fakeKey, `{"error":{"message":"Insufficient balance"}}`, 402, ErrInsufficientBalance},
		{"rate", fakeKey, `{"error":"slow down"}`, 429, ErrRateLimited},
		{"5xx", fakeKey, `<html>bad gateway</html>`, 502, ErrProvider},
		{"other 4xx", fakeKey, `{"error":{"message":"messages: required"}}`, 422, ErrBadRequest},
		{"not json", fakeKey, `hello`, 200, ErrBadResponse},
		{"no choices", fakeKey, `{"choices":[]}`, 200, ErrBadResponse},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			srv := provider(t, c.status, c.body)
			res := NewChat(loopback).Hello(context.Background(), srv.URL+"/v1", c.key, "m")
			if res.OK || res.Error != c.want {
				t.Fatalf("got %+v, want %s", res, c.want)
			}
			if strings.Contains(res.Message, c.key) {
				t.Fatal("key in the message")
			}
		})
	}
}

func TestHelloWrongPathAndBlocked(t *testing.T) {
	srv := provider(t, 200, `{}`)
	if res := NewChat(loopback).Hello(context.Background(), srv.URL+"/nope", fakeKey, "m"); res.Error != ErrNotFound {
		t.Fatalf("wrong path: %+v", res)
	}
	// The production policy refuses loopback: the key never reaches a private address.
	if res := NewChat(func(netip.Addr) bool { return false }).Hello(context.Background(), srv.URL+"/v1", fakeKey, "m"); res.Error != ErrBlockedAddress {
		t.Fatalf("blocked: %+v", res)
	}
	if res := NewChat(loopback).Hello(context.Background(), "http://127.0.0.1:1/v1", fakeKey, "m"); res.Error != ErrNetwork {
		t.Fatalf("network: %+v", res)
	}
}

func TestHelloNoRedirect(t *testing.T) {
	hit := false
	other := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hit = true }))
	defer other.Close()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL+"/v1/chat/completions", http.StatusTemporaryRedirect)
	}))
	defer srv.Close()
	if res := NewChat(loopback).Hello(context.Background(), srv.URL+"/v1", fakeKey, "m"); res.OK || hit {
		t.Fatalf("redirect followed: %+v hit=%v", res, hit)
	}
}

func TestValidate(t *testing.T) {
	key := func(s string) *string { return &s }
	ok := []struct {
		req  *v1.PutAiSettingsRequest
		base string
	}{
		{&v1.PutAiSettingsRequest{Provider: v1.AiProvider_AI_PROVIDER_GPTUNNEL, Model: " gpt-6-astra ", BaseUrl: "ignored"}, ""},
		{&v1.PutAiSettingsRequest{Provider: v1.AiProvider_AI_PROVIDER_OPENAI_COMPATIBLE, Model: "m", BaseUrl: "https://api.example.com/v1/"}, "https://api.example.com/v1"},
		{&v1.PutAiSettingsRequest{Provider: v1.AiProvider_AI_PROVIDER_OPENAI_COMPATIBLE, Model: "m", BaseUrl: "https://api.example.com/v1/chat/completions"}, "https://api.example.com/v1"},
	}
	for _, c := range ok {
		in, err := validate(c.req, nil)
		if err != nil || in.baseURL != c.base || in.model != strings.TrimSpace(c.req.Model) {
			t.Fatalf("%v: %+v %v", c.req, in, err)
		}
	}
	bad := []struct {
		req   *v1.PutAiSettingsRequest
		key   *string
		field string
	}{
		{&v1.PutAiSettingsRequest{Model: "m"}, nil, "provider"},
		{&v1.PutAiSettingsRequest{Provider: v1.AiProvider_AI_PROVIDER_GPTUNNEL, Model: "  "}, nil, "model"},
		{&v1.PutAiSettingsRequest{Provider: v1.AiProvider_AI_PROVIDER_OPENAI_COMPATIBLE, Model: "m"}, nil, "baseUrl"},
		{&v1.PutAiSettingsRequest{Provider: v1.AiProvider_AI_PROVIDER_OPENAI_COMPATIBLE, Model: "m", BaseUrl: "api.example.com"}, nil, "baseUrl"},
		{&v1.PutAiSettingsRequest{Provider: v1.AiProvider_AI_PROVIDER_OPENAI_COMPATIBLE, Model: "m", BaseUrl: "ftp://api.example.com"}, nil, "baseUrl"},
		{&v1.PutAiSettingsRequest{Provider: v1.AiProvider_AI_PROVIDER_OPENAI_COMPATIBLE, Model: "m", BaseUrl: "https://u:p@api.example.com"}, nil, "baseUrl"}, //nolint:gosec // G101: credentials in a URL are what is refused
		{&v1.PutAiSettingsRequest{Provider: v1.AiProvider_AI_PROVIDER_GPTUNNEL, Model: "m"}, key("has space"), "apiKey"},
	}
	for _, c := range bad {
		_, err := validate(c.req, c.key)
		if err == nil {
			t.Fatalf("%v: accepted", c.req)
		}
		if f := fieldOf(err); f != c.field {
			t.Fatalf("%v: field %q, want %q", c.req, f, c.field)
		}
	}
	in, err := validate(&v1.PutAiSettingsRequest{Provider: v1.AiProvider_AI_PROVIDER_GPTUNNEL, Model: "m"}, key(" Bearer abc "))
	if err != nil || *in.key != "abc" {
		t.Fatalf("bearer prefix: %+v %v", in, err)
	}
}

func fieldOf(err error) string {
	if e := httpx.AsError(err); e != nil {
		return e.Field
	}
	return ""
}

func TestKeyHint(t *testing.T) {
	if keyHint("short") != "" || keyHint(fakeKey) != "cdef" {
		t.Fatal("hint")
	}
}

// TestHelloLive calls the real provider when CALAB_GPTUNNEL_TEST_KEY and GPTUNNEL_AI_URL are set
// (never in CI). It logs only the outcome, never the key or the reply.
func TestHelloLive(t *testing.T) {
	key, base := os.Getenv("CALAB_GPTUNNEL_TEST_KEY"), os.Getenv("GPTUNNEL_AI_URL")
	if key == "" || base == "" {
		t.Skip("CALAB_GPTUNNEL_TEST_KEY / GPTUNNEL_AI_URL not set")
	}
	model := os.Getenv("CALAB_GPTUNNEL_TEST_MODEL")
	if model == "" {
		model = DefaultModel
	}
	res := NewChat(unfurl.PublicAddr).Hello(context.Background(), base, key, model)
	t.Logf("live check: ok=%v error=%q http=%d latency=%s reply_chars=%d", res.OK, res.Error, res.Status, res.Latency.Round(time.Millisecond), len([]rune(res.Reply)))
	if !res.OK {
		t.Fatalf("no answer: %s %d", res.Error, res.Status)
	}
}

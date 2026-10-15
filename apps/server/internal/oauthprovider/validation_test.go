package oauthprovider

import (
	"encoding/base64"
	"errors"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
)

func TestRedirectExactness(t *testing.T) {
	for _, tc := range []struct {
		raw, registered, kind string
		want                  bool
	}{
		{"https://rp.example/callback", "https://rp.example/callback", "confidential_web", true},
		{"https://rp.example/callback/child", "https://rp.example/callback", "confidential_web", false},
		{"https://rp.example/callback?x=1", "https://rp.example/callback", "public_spa", false},
		{"https://rp.example/callback#secret", "https://rp.example/callback", "public_spa", false},
		{"https://rp.example.evil/callback", "https://rp.example/callback", "confidential_web", false},
		{"https://user@rp.example/callback", "https://rp.example/callback", "confidential_web", false},
		{"http://127.0.0.1:49152/callback?x=1", "http://127.0.0.1/callback?x=1", "public_native", true},
		{"http://[::1]:49152/callback", "http://[::1]/callback", "public_native", true},
		{"http://localhost:49152/callback", "http://127.0.0.1/callback", "public_native", false},
		{"http://127.0.0.2:49152/callback", "http://127.0.0.1/callback", "public_native", false},
		{"http://127.0.0.1:49152/other", "http://127.0.0.1/callback", "public_native", false},
		{"http://127.0.0.1:49152/callback", "http://127.0.0.1/callback", "public_spa", false},
		{"com.example.app:/callback", "com.example.app:/callback", "public_native", true},
		{"com.example.app:/callback", "com.example.app:/callback", "confidential_web", false},
		{"https://rp.example/%63allback", "https://rp.example/callback", "confidential_web", false},
		// Loopback for every client type (ADR-0102): exact for web/SPA and for localhost.
		{"http://localhost:3000/callback", "http://localhost:3000/callback", "confidential_web", true},
		{"http://localhost:3000/callback", "http://localhost:3000/callback", "public_spa", true},
		{"http://127.0.0.1:8080/cb", "http://127.0.0.1:8080/cb", "confidential_web", true},
		{"http://[::1]:8080/cb", "http://[::1]:8080/cb", "public_spa", true},
		{"http://localhost:3001/callback", "http://localhost:3000/callback", "confidential_web", false},
		{"http://127.0.0.1:8081/cb", "http://127.0.0.1:8080/cb", "confidential_web", false},
		{"http://localhost:49152/callback", "http://localhost/callback", "public_native", false},
		{"http://localhost/callback", "http://localhost/callback", "public_native", true},
		{"http://localhost.evil.example/callback", "http://localhost.evil.example/callback", "confidential_web", false},
		{"http://rp.example/callback", "http://rp.example/callback", "confidential_web", false},
		{"http://127.0.0.2/callback", "http://127.0.0.2/callback", "public_native", false},
	} {
		t.Run(tc.raw+"/"+tc.kind, func(t *testing.T) {
			if got := redirectMatches(tc.raw, tc.registered, tc.kind); got != tc.want {
				t.Fatalf("got %v want %v", got, tc.want)
			}
		})
	}
}

func TestValidateClientFields(t *testing.T) {
	ok := []string{"https://rp.example/callback"}
	scopes := []string{"openid", "profile"}
	many := func(prefix string) []string {
		out := make([]string, 11)
		for i := range out {
			out[i] = prefix + strconv.Itoa(i)
		}
		return out
	}
	for _, tc := range []struct {
		name                     string
		client, kind             string
		redirects, origins, scop []string
		field, message           string
	}{
		{"valid web", "RP", "confidential_web", ok, nil, scopes, "", ""},
		{"web localhost", "RP", "confidential_web", []string{"http://localhost:3000/callback"}, nil, scopes, "", ""},
		{"spa loopback and origin", "RP", "public_spa", []string{"http://127.0.0.1:5173/cb"}, []string{"https://rp.example"}, scopes, "", ""},
		{"native scheme", "RP", "public_native", []string{"com.example.app:/cb"}, nil, scopes, "", ""},
		{"blank name", "  ", "confidential_web", ok, nil, scopes, "name", "name must be 1 to 100 characters"},
		{"long name", strings.Repeat("я", 101), "confidential_web", ok, nil, scopes, "name", "name must be 1 to 100 characters"},
		{"no type", "RP", "", ok, nil, scopes, "type", "unknown client type"},
		{"no redirect", "RP", "confidential_web", nil, nil, scopes, "redirectUris", "at least one redirect URI is required"},
		{"11 redirects", "RP", "confidential_web", many("https://rp.example/cb/"), nil, scopes, "redirectUris", "at most 10 redirect URIs"},
		{"plain http", "RP", "confidential_web", []string{"http://rp.example/cb"}, nil, scopes, "redirectUris", redirectScheme},
		{"fragment", "RP", "confidential_web", []string{"https://rp.example/cb#x"}, nil, scopes, "redirectUris", redirectChars},
		{"wildcard", "RP", "confidential_web", []string{"https://*.rp.example/cb"}, nil, scopes, "redirectUris", redirectChars},
		{"space", "RP", "confidential_web", []string{"https://rp.example/c b"}, nil, scopes, "redirectUris", redirectChars},
		{"userinfo", "RP", "confidential_web", []string{"https://u@rp.example/cb"}, nil, scopes, "redirectUris", redirectInvalid},
		{"relative", "RP", "confidential_web", []string{"/callback"}, nil, scopes, "redirectUris", redirectInvalid},
		{"web custom scheme", "RP", "confidential_web", []string{"com.example.app:/cb"}, nil, scopes, "redirectUris", redirectNative},
		{"duplicate redirect", "RP", "confidential_web", []string{"https://rp.example/cb", "https://rp.example/cb"}, nil, scopes, "redirectUris", "duplicate redirect URI"},
		{"origins on web", "RP", "confidential_web", ok, []string{"https://rp.example"}, scopes, "allowedOrigins", "allowed origins are only for SPA clients"},
		{"11 origins", "RP", "public_spa", ok, many("https://rp.example:"), scopes, "allowedOrigins", "at most 10 allowed origins"},
		{"origin with path", "RP", "public_spa", ok, []string{"https://rp.example/app"}, scopes, "allowedOrigins", "origin must be https://host[:port] without a path"},
		{"http origin", "RP", "public_spa", ok, []string{"http://rp.example"}, scopes, "allowedOrigins", "origin must be https://host[:port] without a path"},
		{"duplicate origin", "RP", "public_spa", ok, []string{"https://rp.example", "https://rp.example"}, scopes, "allowedOrigins", "duplicate origin"},
		{"no openid", "RP", "confidential_web", ok, nil, []string{"profile"}, "scopes", "scopes must include openid and only openid, profile, email"},
		{"duplicate scope", "RP", "confidential_web", ok, nil, []string{"openid", "openid"}, "scopes", "scopes must include openid and only openid, profile, email"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := validateClient(tc.client, tc.kind, tc.redirects, tc.origins, tc.scop)
			if tc.field == "" {
				if err != nil {
					t.Fatalf("rejected: %v", err)
				}
				return
			}
			var api *httpx.Error
			if !errors.As(err, &api) || api.Status != 422 || api.Code != v1.ErrorCode_ERROR_CODE_VALIDATION || api.Field != tc.field || api.Message != tc.message {
				t.Fatalf("got %#v, want %s %q", err, tc.field, tc.message)
			}
		})
	}
}

func TestAuthorizeValidation(t *testing.T) {
	c := sqlc.OauthClient{Scopes: []string{"openid", "profile", "email"}}
	base := url.Values{"response_type": {"code"}, "redirect_uri": {"https://rp.example/callback"}, "scope": {"openid profile"}, "state": {"state"}, "nonce": {"nonce"}, "code_challenge_method": {"S256"}, "code_challenge": {base64.RawURLEncoding.EncodeToString(hash("verifier"))}}
	for _, tc := range []struct{ key, value, code string }{
		{"response_type", "token", "unsupported_response_type"}, {"code_challenge_method", "plain", "invalid_request"}, {"code_challenge", "abc", "invalid_request"}, {"state", "", "invalid_request"}, {"nonce", "", "invalid_request"}, {"scope", "openid offline_access", "invalid_scope"}, {"scope", "openid profile profile", "invalid_scope"}, {"prompt", "none login", "invalid_request"}, {"prompt", "none consent", "invalid_request"}, {"prompt", "select_account", "invalid_request"}, {"max_age", "-1", "invalid_request"}, {"max_age", "2147483648", "invalid_request"}, {"request_uri", "https://evil.example/jar", "invalid_request"}, {"claims", "{}", "invalid_request"}, {"id_token_hint", "not-a-jwt", "invalid_request"},
	} {
		t.Run(tc.key+tc.value, func(t *testing.T) {
			f := url.Values{}
			for k, v := range base {
				f[k] = v
			}
			f.Set(tc.key, tc.value)
			_, err := parseAuthorize(f, c)
			if err == nil || err.Error() != "oauthprovider: "+tc.code {
				t.Fatalf("got %v", err)
			}
		})
	}
	for _, prompt := range []string{"none", " none ", "\tnone\n"} {
		f := url.Values{}
		for k, v := range base {
			f[k] = v
		}
		f.Set("prompt", prompt)
		req, err := parseAuthorize(f, c)
		if err != nil || req.Prompt != "none" {
			t.Fatalf("prompt %q: %q %v", prompt, req.Prompt, err)
		}
	}
	f := url.Values{}
	for k, v := range base {
		f[k] = v
	}
	f["state"] = []string{"one", "two"}
	if _, err := parseAuthorize(f, c); err == nil {
		t.Fatal("duplicate state accepted")
	}
	f.Set("state", "state")
	f.Set("acr_values", "unsupported-mfa-preference another-preference")
	if req, err := parseAuthorize(f, c); err != nil || req.State != "state" || req.PkceChallenge != base.Get("code_challenge") {
		t.Fatalf("optional acr preference changed authorization: %+v %v", req, err)
	}
	f["acr_values"] = []string{"one", "two"}
	if _, err := parseAuthorize(f, c); err == nil {
		t.Fatal("duplicate acr_values accepted")
	}
}

func TestAuthenticationFreshness(t *testing.T) {
	now := time.Now()
	zero := int32(0)
	age := int32(60)
	if freshAuthentication(now, now.Add(-time.Minute), now.Add(-2*time.Minute), "login", nil) {
		t.Fatal("old login accepted")
	}
	if freshAuthentication(now, now.Add(-time.Minute), now.Add(-2*time.Minute), "", &zero) {
		t.Fatal("max_age=0 accepted stale auth")
	}
	if freshAuthentication(now, now.Add(-time.Minute), now.Add(-2*time.Minute), "", &age) {
		t.Fatal("max_age accepted stale auth")
	}
	if !freshAuthentication(now, now.Add(-time.Minute), now.Add(-time.Second), "login consent", &zero) {
		t.Fatal("new authentication rejected")
	}
	if freshAuthentication(now, now, time.Time{}, "", nil) {
		t.Fatal("migration without auth time accepted")
	}
}

func TestOpaqueSeparation(t *testing.T) {
	for _, prefix := range []string{"calab_oa_", "calab_or_", "calab_oc_", "calab_os_"} {
		raw := opaque(prefix)
		if !tokenShape(raw, prefix) {
			t.Fatal("generated token invalid")
		}
		for _, other := range []string{"calab_oa_", "calab_or_", "calab_oc_", "calab_os_"} {
			if other != prefix && tokenShape(raw, other) {
				t.Fatal("cross token type accepted")
			}
		}
	}
}

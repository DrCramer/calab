//go:build integration

package oauthprovider

import (
	"net/url"
	"strings"
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"google.golang.org/protobuf/encoding/protojson"
)

// ADR-0102: an admin with an ordinary bearer session creates a client although the
// last local password entry is far older than the 5-minute management window.
func TestProviderCreateClientWithoutRecentPassword(t *testing.T) {
	f := fixture(t)
	f.sql("UPDATE sessions SET local_authenticated_at=clock_timestamp()-interval '3 days' WHERE id=$1", f.session)
	f.sql("UPDATE workspace_members SET role='admin' WHERE workspace_id=$1 AND user_id=$2", f.ws, f.user)
	c := f.client(v1.OAuthClientType_OAUTH_CLIENT_TYPE_CONFIDENTIAL_WEB, false)
	if c.SecretOnce == "" {
		t.Fatal("confidential client without a secret")
	}
	path := "/api/workspaces/" + f.ws.String() + "/oauth/clients/" + c.Client.ClientId
	if st, _, b := f.proto("POST", path+"/rotate-secret", &v1.RotateOAuthClientSecretRequest{}); st != 200 {
		t.Fatalf("rotate with a stale password: %d %s", st, b)
	}
	if st, _, b := f.proto("DELETE", path, nil); st != 204 && st != 200 {
		t.Fatalf("delete with a stale password: %d %s", st, b)
	}
	var audits int
	if err := f.d.Pool.QueryRow(t.Context(), "SELECT count(*) FROM workspace_identity_audit WHERE workspace_id=$1", f.ws).Scan(&audits); err != nil || audits < 3 {
		t.Fatalf("mutations not audited: %d %v", audits, err)
	}
	// A guest never manages clients, whatever the session age.
	f.sql("UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2", f.ws, f.user)
	if st, _, _ := f.proto("GET", "/api/workspaces/"+f.ws.String()+"/oauth/clients", nil); st != 403 {
		t.Fatal("member managed clients")
	}
}

// ADR-0102: a confidential web client registers an http://localhost redirect for
// development and completes the code flow on it, matched exactly.
func TestProviderConfidentialWebLoopbackRedirect(t *testing.T) {
	f := fixture(t)
	in := &v1.CreateOAuthClientRequest{Name: "Local dev", Type: v1.OAuthClientType_OAUTH_CLIENT_TYPE_CONFIDENTIAL_WEB, RedirectUris: []string{"http://localhost:3000/auth/callback"}, Scopes: []string{"openid", "profile", "email"}}
	st, _, body := f.proto("POST", "/api/workspaces/"+f.ws.String()+"/oauth/clients", in)
	if st != 201 {
		t.Fatalf("create loopback web client: %d %s", st, body)
	}
	c := &v1.OAuthClientSecretResponse{}
	if err := protojson.Unmarshal(body, c); err != nil {
		t.Fatal(err)
	}
	req, code := f.code(c.Client, false)
	if code == "" || req.redirect != "http://localhost:3000/auth/callback" {
		t.Fatalf("no code on the loopback redirect: %q %q", req.redirect, code)
	}
	if st, _, b := f.exchange(c, req, code); st != 200 {
		t.Fatalf("exchange on the loopback redirect: %d %s", st, b)
	}
	// Web loopback stays exact: another port is not the registered URI.
	q := url.Values{"response_type": {"code"}, "client_id": {c.Client.ClientId}, "redirect_uri": {"http://localhost:3001/auth/callback"}, "scope": {"openid"}, "state": {"s"}, "nonce": {"n"}, "code_challenge_method": {"S256"}, "code_challenge": {opaque("")}}
	st, h, _ := f.wire("GET", "/oidc/workspaces/"+f.ws.String()+"/authorize?"+q.Encode(), "", nil, "", "")
	if st == 303 && strings.HasPrefix(h.Get("Location"), "http://localhost:3001") {
		t.Fatal("redirected to an unregistered loopback port")
	}
}

// Field-level validation reaches the client with the offending field (ADR-0102).
func TestProviderCreateClientFieldErrors(t *testing.T) {
	f := fixture(t)
	for _, tc := range []struct {
		in    *v1.CreateOAuthClientRequest
		field string
	}{
		{&v1.CreateOAuthClientRequest{Name: "RP", Type: v1.OAuthClientType_OAUTH_CLIENT_TYPE_CONFIDENTIAL_WEB, RedirectUris: []string{"http://rp.example.test/cb"}, Scopes: []string{"openid"}}, "redirectUris"},
		{&v1.CreateOAuthClientRequest{Name: "RP", Type: v1.OAuthClientType_OAUTH_CLIENT_TYPE_CONFIDENTIAL_WEB, RedirectUris: []string{"https://rp.example.test/cb"}, AllowedOrigins: []string{"https://rp.example.test"}, Scopes: []string{"openid"}}, "allowedOrigins"},
		{&v1.CreateOAuthClientRequest{Name: " ", Type: v1.OAuthClientType_OAUTH_CLIENT_TYPE_CONFIDENTIAL_WEB, RedirectUris: []string{"https://rp.example.test/cb"}, Scopes: []string{"openid"}}, "name"},
	} {
		st, _, body := f.proto("POST", "/api/workspaces/"+f.ws.String()+"/oauth/clients", tc.in)
		out := &v1.ApiError{}
		if err := protojson.Unmarshal(body, out); err != nil || st != 422 || out.Code != v1.ErrorCode_ERROR_CODE_VALIDATION || out.Field != tc.field {
			t.Fatalf("%s: %d %s", tc.field, st, body)
		}
	}
}

// Bearer management routes accept the configured app origins and name a foreign one
// with 403 FORBIDDEN instead of a bare validation error (ADR-0102).
func TestProviderManagementOrigins(t *testing.T) {
	f := fixture(t)
	f.s.appOrigins = append(f.s.appOrigins, "https://alias.example.test")
	in := &v1.CreateOAuthClientRequest{Name: "RP", Type: v1.OAuthClientType_OAUTH_CLIENT_TYPE_CONFIDENTIAL_WEB, RedirectUris: []string{"https://rp.example.test/cb"}, Scopes: []string{"openid"}}
	body, err := protojson.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	path := "/api/workspaces/" + f.ws.String() + "/oauth/clients"
	auth := "Bearer first_party_" + f.session.String()
	if st, _, b := f.wire("POST", path, "application/json", body, auth, "https://alias.example.test"); st != 201 {
		t.Fatalf("alias origin rejected: %d %s", st, b)
	}
	st, _, b := f.wire("POST", path, "application/json", body, auth, "https://evil.example.test")
	assertAPIError(t, st, b, 403, v1.ErrorCode_ERROR_CODE_FORBIDDEN)
	// The cookie-bound consent routes keep the exact configured origin.
	c := f.client(v1.OAuthClientType_OAUTH_CLIENT_TYPE_PUBLIC_NATIVE, false)
	req := f.begin(c.Client, nil)
	bind, err := protojson.Marshal(&v1.BindOAuthRequest{CsrfToken: req.handle})
	if err != nil {
		t.Fatal(err)
	}
	if st, _, _ := f.wire("POST", "/api/oauth/requests/"+req.handle+"/bind", "application/json", bind, auth, "https://alias.example.test"); st == 200 {
		t.Fatal("consent bind accepted an alias origin")
	}
}

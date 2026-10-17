package oauthprovider

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"google.golang.org/protobuf/encoding/protojson"
)

func TestFirstPartyIdentityErrorCodes(t *testing.T) {
	cases := []struct {
		reason   identitypolicy.Reason
		recovery bool
		code     v1.ErrorCode
	}{
		{identitypolicy.SSORequired, false, v1.ErrorCode_ERROR_CODE_SSO_REQUIRED},
		{identitypolicy.RecentAuthRequired, false, v1.ErrorCode_ERROR_CODE_RECENT_AUTH_REQUIRED},
		{identitypolicy.DirectoryStale, false, v1.ErrorCode_ERROR_CODE_DIRECTORY_ACCESS_DENIED},
		{identitypolicy.MembershipSuspended, false, v1.ErrorCode_ERROR_CODE_DIRECTORY_ACCESS_DENIED},
		{identitypolicy.ScopeDenied, false, v1.ErrorCode_ERROR_CODE_IDENTITY_SCOPE_DENIED},
		{identitypolicy.ScopeDenied, true, v1.ErrorCode_ERROR_CODE_RECOVERY_ONLY},
	}
	for _, tc := range cases {
		t.Run(tc.code.String()+string(tc.reason), func(t *testing.T) {
			st := identitypolicy.State{}
			if tc.recovery {
				st.Principal.Authority = identitypolicy.Recovery
			}
			w := httptest.NewRecorder()
			writeAPIError(w, apiIdentityError(st, identitypolicy.Decision{Reason: tc.reason}, identitypolicy.ErrDenied))
			got := &v1.ApiError{}
			if err := protojson.Unmarshal(w.Body.Bytes(), got); err != nil {
				t.Fatal(err)
			}
			if w.Code != http.StatusForbidden || got.Code != tc.code {
				t.Fatalf("%d %s", w.Code, w.Body.String())
			}
		})
	}
	w := httptest.NewRecorder()
	writeError(w, errors.New("internal database error"))
	if w.Code != 503 || w.Body.String() != "{\"error\":\"server_error\"}\n" {
		t.Fatalf("external error format changed: %d %s", w.Code, w.Body.String())
	}
}

func TestManagementAppOrigin(t *testing.T) {
	s := &Service{c: Config{PublicOrigin: "https://app.calab.io"}, appOrigins: []string{"https://app.calab.io", "https://app.calab.ru"}}
	for _, tc := range []struct {
		origin, site string
		want         bool
	}{
		{"https://app.calab.io", "", true},
		{"https://app.calab.ru", "", true},
		{"https://APP.calab.ru", "same-origin", true},
		{"https://app.calab.ru", "cross-site", false},
		{"https://evil.example", "", false},
		{"null", "", false},
		{"", "same-origin", true},
		{"", "", false},
		{"", "cross-site", false},
	} {
		r := httptest.NewRequestWithContext(t.Context(), "POST", "https://app.calab.io/api/workspaces/x/oauth/clients", nil)
		if tc.origin != "" {
			r.Header.Set("Origin", tc.origin)
		}
		if tc.site != "" {
			r.Header.Set("Sec-Fetch-Site", tc.site)
		}
		if got := s.appOrigin(r); got != tc.want {
			t.Errorf("%q %q: got %v", tc.origin, tc.site, got)
		}
		// The cookie-bound consent routes keep the exact configured origin.
		if s.sameOrigin(r) && tc.origin != "https://app.calab.io" {
			t.Errorf("consent check widened for %q", tc.origin)
		}
	}
}

func TestWriteAPIErrorKeepsValidationField(t *testing.T) {
	w := httptest.NewRecorder()
	writeAPIError(w, validateClient("RP", "confidential_web", []string{"http://rp.example/cb"}, nil, []string{"openid"}))
	got := &v1.ApiError{}
	if err := protojson.Unmarshal(w.Body.Bytes(), got); err != nil {
		t.Fatal(err)
	}
	if w.Code != 422 || got.Code != v1.ErrorCode_ERROR_CODE_VALIDATION || got.Field != "redirectUris" || got.Message != redirectScheme {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
}

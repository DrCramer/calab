package buildinfo

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

func TestVersionEndpoint(t *testing.T) {
	Version, Commit = "1.2.3", "abc1234"
	defer func() { Version, Commit = "dev", "" }()
	mux := http.NewServeMux()
	Routes(mux, "mailto:support@calab.io")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest("GET", "/api/version", nil)) //nolint:noctx // test
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}
	var got v1.GetVersionResponse
	if err := protojson.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.GetVersion() != "1.2.3" || got.GetCommit() != "abc1234" || got.GetLicense() != "BUSL-1.1" ||
		got.GetAttribution() != "Powered by GPTunneL" || got.GetProduct() != "Calab" || got.GetCommercialLicense() == "" || got.GetUrl() == "" ||
		got.GetPlanContact() != "mailto:support@calab.io" {
		t.Fatalf("%v", &got)
	}
}

func TestCommitFallback(t *testing.T) {
	if c := commit(); c == "" {
		t.Fatal("empty commit")
	}
}

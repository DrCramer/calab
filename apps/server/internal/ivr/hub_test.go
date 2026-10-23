package ivr

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/ivrwire"
)

type nopFile struct{ *strings.Reader }

func (nopFile) Close() error { return nil }

// The worker's endpoints answer only its token: anything else is a plain 404 (no hint that
// the endpoint exists), and without IVR_AGENT_TOKEN nothing is open at all.
func TestHubAuth(t *testing.T) {
	prompt := uuid.New()
	h := New(nil, "s3cret-token")
	h.Prompt = func(_ context.Context, id uuid.UUID) (io.ReadSeekCloser, time.Time, bool, error) {
		if id != prompt {
			return nil, time.Time{}, false, nil
		}
		return nopFile{strings.NewReader("OggS…")}, time.Now(), true, nil
	}
	mux := http.NewServeMux()
	h.Routes(mux)
	get := func(path, auth string) int {
		r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, path, nil)
		if auth != "" {
			r.Header.Set("Authorization", auth)
		}
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w.Code
	}
	file := ivrwire.FilesPath + prompt.String()
	for _, auth := range []string{"", "Bearer wrong", "s3cret-token", "Basic s3cret-token"} {
		if c := get(file, auth); c != http.StatusNotFound {
			t.Fatalf("file with %q: %d", auth, c)
		}
		if c := get(ivrwire.AgentPath, auth); c != http.StatusNotFound {
			t.Fatalf("agent with %q: %d", auth, c)
		}
	}
	if c := get(file, "Bearer s3cret-token"); c != http.StatusOK {
		t.Fatalf("prompt: %d", c)
	}
	if c := get(ivrwire.FilesPath+uuid.NewString(), "Bearer s3cret-token"); c != http.StatusNotFound {
		t.Fatalf("not a prompt: %d", c)
	}
	off := New(nil, "")
	if off.Configured() || off.Available(context.Background()) || off.authorized(httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/", nil)) {
		t.Fatal("a hub without a token is open")
	}
}

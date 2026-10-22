package sipreg

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/sipregwire"
)

type fakeSource struct {
	mu   sync.Mutex
	accs map[uuid.UUID]sipregwire.Account
}

func (f *fakeSource) RegAccounts(context.Context) ([]sipregwire.Account, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := []sipregwire.Account{}
	for _, a := range f.accs {
		out = append(out, a)
	}
	return out, nil
}

func (f *fakeSource) RegAccount(_ context.Context, ws uuid.UUID) (sipregwire.Account, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	a, ok := f.accs[ws]
	return a, ok, nil
}

// The agent's endpoint answers only its own token (a plain 404 otherwise, nothing without
// SIPREG_AGENT_TOKEN).
func TestHubAuth(t *testing.T) {
	h := New(nil, "s3cret-token")
	h.Source = &fakeSource{}
	mux := http.NewServeMux()
	h.Routes(mux)
	for _, auth := range []string{"", "Bearer wrong", "s3cret-token", "Basic s3cret-token", "Bearer it-ivr-token"} {
		r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, sipregwire.AgentPath, nil)
		if auth != "" {
			r.Header.Set("Authorization", auth)
		}
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		if w.Code != http.StatusNotFound {
			t.Fatalf("agent with %q: %d", auth, w.Code)
		}
	}
	off := New(nil, "")
	if off.Configured() || off.Available(context.Background()) || off.Changed(context.Background(), uuid.New()) == nil {
		t.Fatal("a hub without a token is open")
	}
}

// hello → snapshot; a change → account_set / account_del of that workspace; the agent's events
// reach OnEvent.
func TestHubSession(t *testing.T) {
	ws1, ws2 := uuid.New(), uuid.New()
	src := &fakeSource{accs: map[uuid.UUID]sipregwire.Account{ws1: {WS: ws1.String(), Username: "u1", Password: "p1"}}}
	h := New(nil, "tok")
	h.Source = src
	got := make(chan sipregwire.Event, 4)
	h.OnEvent = func(_ context.Context, ev sipregwire.Event) { got <- ev }
	mux := http.NewServeMux()
	h.Routes(mux)
	srv := httptest.NewServer(mux)
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, resp, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+sipregwire.AgentPath, &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": []string{"Bearer tok"}},
	})
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c.CloseNow() }()
	write := func(ev sipregwire.Event) {
		b, _ := json.Marshal(ev)
		if err := c.Write(ctx, websocket.MessageText, b); err != nil {
			t.Fatal(err)
		}
	}
	read := func() sipregwire.Command {
		_, b, err := c.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var cmd sipregwire.Command
		if err := json.Unmarshal(b, &cmd); err != nil {
			t.Fatal(err)
		}
		return cmd
	}
	write(sipregwire.Event{Op: sipregwire.OpHello})
	if cmd := read(); cmd.Op != sipregwire.OpSnapshot || len(cmd.Accounts) != 1 || cmd.Accounts[0].Password != "p1" {
		t.Fatalf("snapshot: %+v", cmd)
	}
	src.mu.Lock()
	src.accs[ws2] = sipregwire.Account{WS: ws2.String(), Username: "u2"}
	src.mu.Unlock()
	h.deliver(ctx, ws2)
	if cmd := read(); cmd.Op != sipregwire.OpAccountSet || cmd.Account == nil || cmd.Account.WS != ws2.String() {
		t.Fatalf("set: %+v", cmd)
	}
	src.mu.Lock()
	delete(src.accs, ws1)
	src.mu.Unlock()
	h.deliver(ctx, ws1)
	if cmd := read(); cmd.Op != sipregwire.OpAccountDel || cmd.WS != ws1.String() {
		t.Fatalf("del: %+v", cmd)
	}
	write(sipregwire.Event{Op: sipregwire.OpRegistration, WS: ws2.String(), Status: sipregwire.StatusRegistered})
	select {
	case ev := <-got:
		if ev.Op != sipregwire.OpRegistration || ev.WS != ws2.String() {
			t.Fatalf("event: %+v", ev)
		}
	case <-ctx.Done():
		t.Fatal("no event")
	}
}

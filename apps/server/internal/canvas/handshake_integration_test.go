//go:build integration

package canvas

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/ysync"
)

// The first frame: a text frame with the token within AuthTimeout, a binary one is refused; the
// Origin of the upgrade is checked; a read-only workspace (suspended) leaves the socket read-only.
func TestCanvasSyncHandshake(t *testing.T) {
	e := newEnv(t, ysync.Config{AuthTimeout: 300 * time.Millisecond})
	p := e.create(e.alice, "", "Hello")
	url := "ws" + strings.TrimPrefix(e.srv.URL, "http") + item(p.GetId()) + "/sync"
	dial := func() *websocket.Conn {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		ws, resp, err := websocket.Dial(ctx, url, nil)
		if resp != nil && resp.Body != nil {
			_ = resp.Body.Close()
		}
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = ws.CloseNow() })
		return ws
	}
	closeCode := func(ws *websocket.Conn) websocket.StatusCode {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, _, err := ws.Read(ctx)
		return websocket.CloseStatus(err)
	}
	// Silence: no token within AuthTimeout drops the socket (the timed-out read ends the connection
	// without a close frame).
	start := time.Now()
	if got := closeCode(dial()); got != -1 || time.Since(start) > 3*time.Second {
		t.Fatalf("no token: closed with %d after %v", got, time.Since(start))
	}
	// A binary first frame is not a token.
	ws := dial()
	if err := ws.Write(context.Background(), websocket.MessageBinary, []byte(e.alice.String())); err != nil {
		t.Fatal(err)
	}
	if got := closeCode(ws); got != ysync.CloseAuth {
		t.Fatalf("binary token: closed with %d", got)
	}
	// A huge first frame hits the read limit (64 KiB) before anything is parsed.
	ws = dial()
	_ = ws.Write(context.Background(), websocket.MessageText, []byte(strings.Repeat("x", 1<<20)))
	if got := closeCode(ws); got != websocket.StatusMessageTooBig {
		t.Fatalf("big token frame: closed with %d", got)
	}
}

func TestCanvasSyncOriginAndSuspended(t *testing.T) {
	e := newEnv(t, ysync.Config{})
	// A second service whose upgrade only accepts one Origin (gateway.OriginAllowed in production).
	other := New(e.d, e.ev)
	other.EnableSync(e.rc, fakeAuth{}, func(origin string, _ bool) bool { return origin == "https://app.example" }, ysync.Config{})
	mux := http.NewServeMux()
	other.Routes(mux, func(h http.Handler) http.Handler { return h })
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	p := e.create(e.alice, "", "Guarded")
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + item(p.GetId()) + "/sync"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, resp, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {"https://evil.example"}}})
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if err == nil || resp == nil || resp.StatusCode != http.StatusForbidden {
		t.Fatalf("a foreign Origin was upgraded: %v %v", resp, err)
	}
	ws, resp, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {"https://app.example"}}})
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		t.Fatal(err)
	}
	_ = ws.CloseNow()

	// A suspended workspace: reading goes on, writing closes the socket.
	a := e.dial(e.alice, p.GetId())
	a.next(frameSnapshot)
	if _, err := e.d.Pool.Exec(context.Background(), `UPDATE workspaces SET suspended_at = now() WHERE id = $1`, e.ws); err != nil {
		t.Fatal(err)
	}
	r := e.dial(e.bob, p.GetId())
	r.next(frameSnapshot)
	r.send(updateFrame(0, []byte("x")))
	r.closed(ysync.CloseForbidden)
	var n int
	if err := e.d.Pool.QueryRow(context.Background(), `SELECT count(*) FROM canvas_updates WHERE canvas_id = $1`, p.GetId()).Scan(&n); err != nil || n != 0 {
		t.Fatalf("a write into a suspended workspace: %d %v", n, err)
	}
	e.must(403, e.alice, "POST", "/api/workspaces/"+e.ws.String()+"/canvas/items", &v1.CreateCanvasItemRequest{Kind: board, Name: "x"}, nil)
}

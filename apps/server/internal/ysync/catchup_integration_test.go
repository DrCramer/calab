//go:build integration

package ysync

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// gatedBackend is memBackend whose snapshot reads wait for open and count how many run at once.
type gatedBackend struct {
	*memBackend
	open      chan struct{}
	now, peak atomic.Int32
}

func (b *gatedBackend) GetSnapshot(ctx context.Context, q *sqlc.Queries, id uuid.UUID) (int64, []byte, error) {
	n := b.now.Add(1)
	defer b.now.Add(-1)
	for {
		p := b.peak.Load()
		if n <= p || b.peak.CompareAndSwap(p, n) {
			break
		}
	}
	select {
	case <-b.open:
	case <-ctx.Done():
		return 0, nil, ctx.Err()
	}
	return b.memBackend.GetSnapshot(ctx, q, id)
}

// A crowd of anonymous viewers of one public document builds its catch-ups (snapshot + updates in
// memory) at most ViewerCatchUpsPerDoc at a time and within ViewerCatchUps across documents; a
// member's catch-up is not queued behind them; every socket gets its snapshot once slots free up.
func TestCatchUpSlots(t *testing.T) {
	e := newProfEnv(t, fullProfile, Config{})
	gb := &gatedBackend{memBackend: e.b, open: make(chan struct{})}
	h := NewHub(gb, Options{DB: e.h.db, Redis: e.rc, Auth: memAuth{},
		Config: Config{CatchUps: 4, ViewerCatchUps: 3, ViewerCatchUpsPerDoc: 2}})
	mux := http.NewServeMux()
	mux.HandleFunc("GET /sync/{id}", h.Serve)
	mux.HandleFunc("GET /view/{id}", func(w http.ResponseWriter, r *http.Request) {
		doc := uuid.MustParse(r.PathValue("id"))
		h.ServeViewer(w, r, Viewer{Doc: doc,
			Check: func(context.Context) (time.Time, int, string) { return time.Time{}, 0, "" },
			Slots: []Slot{{Key: "t:" + doc.String(), Max: 100}}})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	base := "ws" + strings.TrimPrefix(srv.URL, "http")
	dial := func(path string, token bool) *profClient {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		ws, resp, err := websocket.Dial(ctx, base+path, nil)
		if resp != nil && resp.Body != nil {
			_ = resp.Body.Close()
		}
		if err != nil {
			t.Fatal(err)
		}
		ws.SetReadLimit(8 << 20)
		t.Cleanup(func() { _ = ws.CloseNow() })
		if token {
			if err := ws.Write(ctx, websocket.MessageText, []byte(uuid.NewString())); err != nil {
				t.Fatal(err)
			}
		}
		return &profClient{t: t, ws: ws}
	}
	waitPeak := func(want int32) {
		t.Helper()
		deadline := time.Now().Add(3 * time.Second)
		for gb.now.Load() < want && time.Now().Before(deadline) {
			time.Sleep(10 * time.Millisecond)
		}
		time.Sleep(200 * time.Millisecond) // anything over the limit would have started by now
		if n := gb.now.Load(); n != want {
			t.Fatalf("%d catch-ups at once, want %d", n, want)
		}
	}

	docA, docB := e.doc, uuid.New()
	var viewers []*profClient
	for i := 0; i < 6; i++ {
		viewers = append(viewers, dial("/view/"+docA.String(), false))
	}
	waitPeak(2) // one document's viewers: ViewerCatchUpsPerDoc
	for i := 0; i < 3; i++ {
		viewers = append(viewers, dial("/view/"+docB.String(), false))
	}
	waitPeak(3) // all viewers: ViewerCatchUps
	member := dial("/sync/"+docA.String(), true)
	waitPeak(4) // a member takes a free slot of all sockets (CatchUps)

	close(gb.open)
	member.next(FrameSnapshot)
	for _, v := range viewers {
		v.next(FrameSnapshot)
	}
	if p := gb.peak.Load(); p > 4 {
		t.Fatalf("peak %d catch-ups at once, over CatchUps", p)
	}
}

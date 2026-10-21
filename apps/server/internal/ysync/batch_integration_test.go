//go:build integration

package ysync

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/db/dbtest"
)

var batchProfile = Profile{
	Ceiling:           true,
	ByteBudget:        true,
	CoalesceAwareness: true,
	RecheckJitter:     true,
	PublishBackoff:    true,
	BatchAwareness:    true,
}

func makeAwarenessFrame(clientID uint64, clock uint64, state string) []byte {
	return encodeAwarenessUpdate([]awarenessEntry{
		{clientID: clientID, clock: clock, state: []byte(state)},
	})
}

func decodeAwarenessFrame(t *testing.T, f []byte) []awarenessEntry {
	t.Helper()
	if len(f) == 0 || f[0] != FrameAwareness {
		t.Fatalf("expected FrameAwareness (%d), got %x", FrameAwareness, f)
	}
	entries, err := parseAwarenessUpdate(f[1:])
	if err != nil {
		t.Fatalf("parseAwarenessUpdate failed: %v", err)
	}
	return entries
}

// (a) 3 sockets: two send 20 frames per window; receiver sees <= 2 batched frames with latest states.
func TestBatchAwarenessCoalescing(t *testing.T) {
	e := newProfEnv(t, batchProfile, Config{AwarenessWindow: 100 * time.Millisecond})
	a, b, c := e.dial(), e.dial(), e.dial()

	framesCh := make(chan []byte, 100)
	go func() {
		for {
			_, msg, err := c.ws.Read(context.Background())
			if err != nil {
				return
			}
			framesCh <- msg
		}
	}()

	// Burst 20 frames each with increasing clocks within ~20ms
	for i := 1; i <= 20; i++ {
		a.send(makeAwarenessFrame(100, uint64(i), `{"x":20}`))
		b.send(makeAwarenessFrame(200, uint64(i), `{"y":20}`))
	}

	// Collect frames for 250ms
	var frames [][]awarenessEntry
	timeout := time.After(250 * time.Millisecond)
collect:
	for {
		select {
		case f := <-framesCh:
			if f[0] == FrameAwareness {
				frames = append(frames, decodeAwarenessFrame(t, f))
			}
		case <-timeout:
			break collect
		}
	}

	if len(frames) == 0 {
		t.Fatal("expected at least 1 batched awareness frame, got 0")
	}
	if len(frames) > 2 {
		t.Fatalf("expected at most 2 batched awareness frames, got %d", len(frames))
	}

	// Find the latest entry for each client in the frames
	var lastA, lastB *awarenessEntry
	for _, batch := range frames {
		for i := range batch {
			entry := batch[i]
			if entry.clientID == 100 && (lastA == nil || entry.clock > lastA.clock) {
				lastA = &entry
			}
			if entry.clientID == 200 && (lastB == nil || entry.clock > lastB.clock) {
				lastB = &entry
			}
		}
	}

	if lastA == nil || lastA.clock != 20 || string(lastA.state) != `{"x":20}` {
		t.Fatalf("expected client 100 latest clock 20, got %+v", lastA)
	}
	if lastB == nil || lastB.clock != 20 || string(lastB.state) != `{"y":20}` {
		t.Fatalf("expected client 200 latest clock 20, got %+v", lastB)
	}
}

// (b) Farewell frame (null) is delivered immediately, without waiting for the window ticker.
func TestBatchAwarenessFarewellImmediate(t *testing.T) {
	// 500ms window: if it waited for the window, delivery would take >= 500ms.
	e := newProfEnv(t, batchProfile, Config{AwarenessWindow: 500 * time.Millisecond})
	a, b := e.dial(), e.dial()

	// Initial frame to establish presence
	a.send(makeAwarenessFrame(1001, 1, `{"user":"alice"}`))
	b.next(FrameAwareness)

	// Send farewell frame (state "null")
	start := time.Now()
	a.send(makeAwarenessFrame(1001, 2, "null"))

	// b should receive it immediately
	f := b.next(FrameAwareness)
	elapsed := time.Since(start)

	if elapsed > 200*time.Millisecond {
		t.Fatalf("farewell frame took %v to deliver, expected < 200ms (window is 500ms)", elapsed)
	}

	entries := decodeAwarenessFrame(t, f)
	if len(entries) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(entries))
	}
	if entries[0].clientID != 1001 || entries[0].clock != 2 || string(entries[0].state) != "null" {
		t.Fatalf("expected farewell entry {1001, 2, null}, got %+v", entries[0])
	}
}

// (c) Recipient does not receive entries with its own clientID.
func TestBatchAwarenessSenderFiltering(t *testing.T) {
	e := newProfEnv(t, batchProfile, Config{AwarenessWindow: 80 * time.Millisecond})
	a, b, c := e.dial(), e.dial(), e.dial()

	// Alice (111) and Bob (222) send awareness updates in the same window
	a.send(makeAwarenessFrame(111, 1, `{"name":"alice"}`))
	b.send(makeAwarenessFrame(222, 1, `{"name":"bob"}`))

	// Wait for window flush
	time.Sleep(150 * time.Millisecond)

	fa := decodeAwarenessFrame(t, a.next(FrameAwareness))
	fb := decodeAwarenessFrame(t, b.next(FrameAwareness))
	fc := decodeAwarenessFrame(t, c.next(FrameAwareness))

	// Alice must not see herself (111)
	for _, entry := range fa {
		if entry.clientID == 111 {
			t.Fatalf("Alice received her own clientID 111: %+v", entry)
		}
		if entry.clientID != 222 {
			t.Fatalf("Alice received unexpected clientID %d", entry.clientID)
		}
	}

	// Bob must not see himself (222)
	for _, entry := range fb {
		if entry.clientID == 222 {
			t.Fatalf("Bob received his own clientID 222: %+v", entry)
		}
		if entry.clientID != 111 {
			t.Fatalf("Bob received unexpected clientID %d", entry.clientID)
		}
	}

	// Charlie (pure reader, never sent anything) must see BOTH Alice (111) and Bob (222)
	has111, has222 := false, false
	for _, entry := range fc {
		if entry.clientID == 111 {
			has111 = true
		}
		if entry.clientID == 222 {
			has222 = true
		}
	}
	if !has111 || !has222 {
		t.Fatalf("Charlie expected both 111 and 222, got %+v", fc)
	}
}

// (d) Multi-instance Valkey relay delivers and decodes valid y-protocols awareness.
func TestBatchAwarenessMultiInstanceRelay(t *testing.T) {
	cfg := Config{AwarenessWindow: 50 * time.Millisecond}
	e := newProfEnv(t, batchProfile, cfg)

	// Create second hub/server on the same redis and backend
	h2 := NewHub(e.b, Options{DB: dbtest.Connect(t), Redis: e.rc, Auth: memAuth{}, Config: cfg})
	mux2 := http.NewServeMux()
	mux2.HandleFunc("GET /sync/{id}", h2.Serve)
	srv2 := httptest.NewServer(mux2)
	t.Cleanup(srv2.Close)

	// Sockets: a on instance 1, b on instance 2
	a := e.dial()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws2, resp, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv2.URL, "http")+"/sync/"+e.doc.String(), nil)
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ws2.CloseNow() })
	if err := ws2.Write(ctx, websocket.MessageText, []byte(uuid.NewString())); err != nil {
		t.Fatal(err)
	}
	b := &profClient{t: t, ws: ws2}
	b.next(FrameSnapshot)

	// a sends 5 awareness updates on instance 1
	for i := 1; i <= 5; i++ {
		a.send(makeAwarenessFrame(555, uint64(i), `{"room":"inst1"}`))
	}

	// b on instance 2 receives batched frame relayed via Valkey
	f := b.next(FrameAwareness)
	entries := decodeAwarenessFrame(t, f)
	if len(entries) != 1 {
		t.Fatalf("expected 1 entry on instance 2, got %d", len(entries))
	}
	if entries[0].clientID != 555 || entries[0].clock != 5 || string(entries[0].state) != `{"room":"inst1"}` {
		t.Fatalf("relayed frame invalid: %+v", entries[0])
	}
}

// (e) Wiki profile delivers 1-by-1 without timer, Wiki tests pass.
func TestBatchAwarenessWikiProfileUntouched(t *testing.T) {
	// Zero profile = Wiki: BatchAwareness is false
	e := newProfEnv(t, Profile{}, Config{})
	a, b := e.dial(), e.dial()

	// Send 3 distinct frames
	for i := byte(1); i <= 3; i++ {
		a.send([]byte{FrameAwareness, i, i + 10})
	}

	// All 3 frames should arrive 1-by-1 immediately with exact bytes
	for i := byte(1); i <= 3; i++ {
		f := b.next(FrameAwareness)
		expected := []byte{FrameAwareness, i, i + 10}
		if !bytes.Equal(f, expected) {
			t.Fatalf("frame %d: expected %x, got %x", i, expected, f)
		}
	}
}

// (f) Slow receiver does not get markStale from awareness, UPDATEs arrive cleanly.
func TestBatchAwarenessSlowReceiverDoesNotStale(t *testing.T) {
	e := newProfEnv(t, batchProfile, Config{AwarenessWindow: 50 * time.Millisecond})
	a, b := e.dial(), e.dial()

	// Initial awareness to register
	a.send(makeAwarenessFrame(777, 1, `{"pos":0}`))
	b.next(FrameAwareness)

	// Send an UPDATE frame first
	a.send(UpdateFrame(0, []byte("essential-edit")))
	a.next(FrameUpdate)

	// Send 30 awareness frames rapidly
	for i := 2; i <= 31; i++ {
		a.send(makeAwarenessFrame(777, uint64(i), `{"pos":1}`))
	}

	// b reads: UPDATE must arrive first without markStale / catch-up
	f := b.next(FrameUpdate)
	if FrameSeq(f) != 1 || string(f[headerSeq:]) != "essential-edit" {
		t.Fatalf("unexpected update frame %x", f)
	}

	// Awareness slot was overwritten, next awareness frame should have latest clock 31
	f = b.next(FrameAwareness)
	entries := decodeAwarenessFrame(t, f)
	if len(entries) != 1 || entries[0].clock != 31 {
		t.Fatalf("expected awareness with clock 31, got %+v", entries)
	}
}

//go:build integration

package ysync

import (
	"bytes"
	"context"
	"fmt"
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

	// Give time for awTimer to flush awPending (clock 31)
	time.Sleep(150 * time.Millisecond)
	var gotClock31 bool
	for {
		f = b.next(FrameAwareness)
		entries := decodeAwarenessFrame(t, f)
		for _, entry := range entries {
			if entry.clientID == 777 && entry.clock == 31 {
				gotClock31 = true
				break
			}
		}
		if gotClock31 {
			break
		}
	}
}

func (e *profEnv) findConn(clientID uint64) *conn {
	e.t.Helper()
	e.h.mu.Lock()
	defer e.h.mu.Unlock()
	r := e.h.rooms[e.doc]
	if r == nil {
		return nil
	}
	for c := range r.conns {
		if c.clientID.Load() == clientID {
			return c
		}
	}
	return nil
}

// Problem 1 tests:
// (a) Writer blocked: socket receives entry A in window 1, then entry B in window 2; after unblocking receives BOTH.
func TestBatchAwarenessAccumulatorBothEntriesDelivered(t *testing.T) {
	e := newProfEnv(t, batchProfile, Config{AwarenessWindow: 30 * time.Millisecond})
	a, b, c := e.dial(), e.dial(), e.dial()

	// c announces clientID 999 (sender does not receive its own update, buffer stays clean)
	c.send(makeAwarenessFrame(999, 1, `{"val":"initC"}`))
	time.Sleep(50 * time.Millisecond)

	cConn := e.findConn(999)
	if cConn == nil {
		t.Fatal("cConn not found")
	}

	// Pause awareness delivery on c
	cConn.testPauseAwareness.Store(true)

	// Send record A from socket a (window 1)
	a.send(makeAwarenessFrame(10, 2, `{"val":"stateA"}`))
	time.Sleep(50 * time.Millisecond) // window 1 flushes, merges into cConn.awAccum

	// Send record B from socket b (window 2)
	b.send(makeAwarenessFrame(20, 2, `{"val":"stateB"}`))
	time.Sleep(50 * time.Millisecond) // window 2 flushes, merges into cConn.awAccum

	// Verify cConn.awAccum has both entries before unblocking
	cConn.awAccumMu.Lock()
	has10 := cConn.awAccum[10].clock == 2
	has20 := cConn.awAccum[20].clock == 2
	cConn.awAccumMu.Unlock()
	if !has10 || !has20 {
		t.Fatalf("expected both 10 and 20 in accumulator, got has10=%v has20=%v", has10, has20)
	}

	// Unpause writer and kick it
	cConn.testPauseAwareness.Store(false)
	select {
	case cConn.kick <- struct{}{}:
	default:
	}

	// c receives one combined awareness frame with BOTH records
	f := c.next(FrameAwareness)
	entries := decodeAwarenessFrame(t, f)
	var gotA, gotB bool
	for _, entry := range entries {
		if entry.clientID == 10 && entry.clock == 2 && string(entry.state) == `{"val":"stateA"}` {
			gotA = true
		}
		if entry.clientID == 20 && entry.clock == 2 && string(entry.state) == `{"val":"stateB"}` {
			gotB = true
		}
	}
	if !gotA || !gotB {
		t.Fatalf("expected both A and B after unblock, got entries: %+v", entries)
	}
}

// (b) Farewell record A (null) followed by record B reaches slow receiver.
func TestBatchAwarenessAccumulatorFarewellPreserved(t *testing.T) {
	e := newProfEnv(t, batchProfile, Config{AwarenessWindow: 30 * time.Millisecond})
	a, b, c := e.dial(), e.dial(), e.dial()

	// c announces clientID 999
	c.send(makeAwarenessFrame(999, 1, `{"val":"initC"}`))
	time.Sleep(50 * time.Millisecond)

	cConn := e.findConn(999)
	if cConn == nil {
		t.Fatal("cConn not found")
	}

	// Pause awareness delivery on c
	cConn.testPauseAwareness.Store(true)

	// Send farewell record A (null)
	a.send(makeAwarenessFrame(10, 2, "null"))
	time.Sleep(40 * time.Millisecond)

	// Send record B
	b.send(makeAwarenessFrame(20, 2, `{"val":"stateB"}`))
	time.Sleep(50 * time.Millisecond)

	// Verify cConn.awAccum has both entries before unpausing
	cConn.awAccumMu.Lock()
	has10Null := cConn.awAccum[10].clock == 2 && string(cConn.awAccum[10].state) == "null"
	has20 := cConn.awAccum[20].clock == 2
	cConn.awAccumMu.Unlock()
	if !has10Null || !has20 {
		t.Fatalf("expected farewell A and 20 in accumulator, got has10Null=%v has20=%v", has10Null, has20)
	}

	// Unpause writer and kick it
	cConn.testPauseAwareness.Store(false)
	select {
	case cConn.kick <- struct{}{}:
	default:
	}

	// c receives frame with both A (null) and B
	f := c.next(FrameAwareness)
	entries := decodeAwarenessFrame(t, f)
	var gotANull, gotB bool
	for _, entry := range entries {
		if entry.clientID == 10 && entry.clock == 2 && string(entry.state) == "null" {
			gotANull = true
		}
		if entry.clientID == 20 && entry.clock == 2 && string(entry.state) == `{"val":"stateB"}` {
			gotB = true
		}
	}
	if !gotANull || !gotB {
		t.Fatalf("expected farewell A(null) and state B, got: %+v", entries)
	}
}

// (c) Record with smaller clock does not overwrite a larger one.
func TestBatchAwarenessAccumulatorLowerClockDoesNotOverwrite(t *testing.T) {
	c := &conn{
		h:       &Hub{m: newMetrics("test")},
		awAccum: make(map[uint64]awarenessEntry),
	}

	// Deliver entry with clock 10
	c.deliverAwarenessEntries([]awarenessEntry{
		{clientID: 42, clock: 10, state: []byte(`{"v":10}`)},
	})

	// Deliver entry with clock 5 (stale)
	c.deliverAwarenessEntries([]awarenessEntry{
		{clientID: 42, clock: 5, state: []byte(`{"v":5}`)},
	})

	c.awAccumMu.Lock()
	entry := c.awAccum[42]
	c.awAccumMu.Unlock()
	if entry.clock != 10 || string(entry.state) != `{"v":10}` {
		t.Fatalf("expected clock 10 to be preserved, got %+v", entry)
	}

	// Deliver entry with clock 15 (newer)
	c.deliverAwarenessEntries([]awarenessEntry{
		{clientID: 42, clock: 15, state: []byte(`{"v":15}`)},
	})

	c.awAccumMu.Lock()
	entry = c.awAccum[42]
	c.awAccumMu.Unlock()
	if entry.clock != 15 || string(entry.state) != `{"v":15}` {
		t.Fatalf("expected clock 15 to win, got %+v", entry)
	}
}

// Problem 2: One socket sends 5000 awareness frames in a second; parsed frames <= profile budget + margin, final state arrives.
func TestBatchAwarenessIngressBudget(t *testing.T) {
	e := newProfEnv(t, batchProfile, Config{
		AwarenessPerSecond: 10,
		AwarenessWindow:    25 * time.Millisecond,
	})
	sender, receiver := e.dial(), e.dial()

	// Initial ping
	sender.send(makeAwarenessFrame(777, 1, `{"v":1}`))
	time.Sleep(50 * time.Millisecond)
	receiver.next(FrameAwareness)

	// Find sender conn
	e.h.mu.Lock()
	r := e.h.rooms[e.doc]
	var senderConn *conn
	for c := range r.conns {
		if c.clientID.Load() == 777 {
			senderConn = c
			break
		}
	}
	e.h.mu.Unlock()
	if senderConn == nil {
		t.Fatal("senderConn not found")
	}

	senderConn.parsedAwareness.Store(0)

	// Send 5000 frames
	const totalFrames = 5000
	start := time.Now()
	for i := 2; i <= totalFrames+1; i++ {
		sender.send(makeAwarenessFrame(777, uint64(i), fmt.Sprintf(`{"v":%d}`, i)))
		if i%500 == 0 {
			time.Sleep(80 * time.Millisecond)
		}
	}
	elapsed := time.Since(start)

	// Wait for any trailing timer flush
	time.Sleep(200 * time.Millisecond)

	parsed := senderConn.parsedAwareness.Load()
	t.Logf("Sent %d frames over %v: parsed %d frames", totalFrames, elapsed, parsed)

	// In ~0.8-1.5s at 10/s, budget allows ~15-25 frames.
	// We check parsed <= 35, which proves 5000 frames were NOT parsed.
	maxAllowed := uint64(float64(e.h.cfg.AwarenessPerSecond)*elapsed.Seconds()*2.0) + 15
	if parsed > maxAllowed {
		t.Fatalf("parsed %d frames, exceeded budget limit of %d (budget=%d/s, elapsed=%v)",
			parsed, maxAllowed, e.h.cfg.AwarenessPerSecond, elapsed)
	}

	// Drain frames on receiver until final state v=5001 is found
	deadline := time.Now().Add(3 * time.Second)
	var gotFinal bool
	for time.Now().Before(deadline) {
		f := receiver.next(FrameAwareness)
		entries := decodeAwarenessFrame(t, f)
		for _, entry := range entries {
			if entry.clientID == 777 && string(entry.state) == fmt.Sprintf(`{"v":%d}`, totalFrames+1) {
				gotFinal = true
				break
			}
		}
		if gotFinal {
			break
		}
	}
	if !gotFinal {
		t.Fatalf("expected final state v=%d to arrive at receiver", totalFrames+1)
	}
}

// Problem 3: 1000 rooms connected in idle state; no per-room awareness ticker goroutines, no armed timers;
// sending 1 entry delivers after window, and timer is disarmed again.
func TestBatchAwarenessRoomTimerOnDemand(t *testing.T) {
	cfg := Config{AwarenessWindow: 30 * time.Millisecond}
	e := newProfEnv(t, batchProfile, cfg)

	const numRooms = 1000
	docs := make([]uuid.UUID, numRooms)
	conns := make([]*conn, numRooms)

	for i := 0; i < numRooms; i++ {
		docs[i] = uuid.New()
		conns[i] = &conn{
			h:       e.h,
			doc:     docs[i],
			key:     uuid.NewString(),
			ctx:     context.Background(),
			out:     make(chan []byte, 16),
			kick:    make(chan struct{}, 1),
			awAccum: make(map[uint64]awarenessEntry),
		}
		conns[i].write.Store(true)
		e.h.join(conns[i])
	}

	t.Cleanup(func() {
		for i := 0; i < numRooms; i++ {
			e.h.leave(conns[i])
		}
	})

	// Verify all 1000 rooms in idle: no timers armed
	e.h.mu.Lock()
	if len(e.h.rooms) < numRooms {
		e.h.mu.Unlock()
		t.Fatalf("expected at least %d rooms, got %d", numRooms, len(e.h.rooms))
	}
	for _, doc := range docs {
		r := e.h.rooms[doc]
		if r == nil {
			e.h.mu.Unlock()
			t.Fatalf("room %v not found", doc)
		}
		r.awMu.Lock()
		if r.awTimer != nil {
			r.awMu.Unlock()
			e.h.mu.Unlock()
			t.Fatalf("expected idle room %v to have no armed timer", doc)
		}
		if len(r.awBatch) != 0 {
			r.awMu.Unlock()
			e.h.mu.Unlock()
			t.Fatalf("expected idle room %v to have empty batch", doc)
		}
		r.awMu.Unlock()
	}
	e.h.mu.Unlock()

	// Send one record to room 0
	doc0 := docs[0]
	e.h.mu.Lock()
	r0 := e.h.rooms[doc0]
	e.h.mu.Unlock()

	entry := awarenessEntry{clientID: 101, clock: 1, state: []byte(`{"cursor":"active"}`)}
	e.h.enqueueAwareness(doc0, []awarenessEntry{entry})

	// Verify timer is armed immediately after enqueuing into empty batch
	r0.awMu.Lock()
	if r0.awTimer == nil {
		r0.awMu.Unlock()
		t.Fatal("expected awTimer to be armed after enqueue")
	}
	r0.awMu.Unlock()

	// Wait for window to expire and flush
	time.Sleep(cfg.AwarenessWindow + 30*time.Millisecond)

	// Verify timer is cleared and batch is empty again
	r0.awMu.Lock()
	if r0.awTimer != nil {
		r0.awMu.Unlock()
		t.Fatal("expected awTimer to be disarmed after window flush")
	}
	if len(r0.awBatch) != 0 {
		r0.awMu.Unlock()
		t.Fatal("expected awBatch to be empty after window flush")
	}
	r0.awMu.Unlock()

	// Verify connection 0 received the awareness frame in its accumulator
	conns[0].awAccumMu.Lock()
	rec := conns[0].awAccum[101]
	conns[0].awAccumMu.Unlock()
	if rec.clientID != 101 || rec.clock != 1 || string(rec.state) != `{"cursor":"active"}` {
		t.Fatalf("expected entry delivered to accumulator, got: %+v", rec)
	}
}

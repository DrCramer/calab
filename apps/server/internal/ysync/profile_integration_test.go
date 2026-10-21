//go:build integration

package ysync

import (
	"bytes"
	"context"
	"encoding/binary"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/redis/rueidis"

	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db/dbtest"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/calaba/calaba/server/internal/redisx"
)

// The profiles side by side: the zero Profile (the Wiki) must be the relay of origin/main, the full
// one (the Canvas) everything built since. The documents live in memory (memBackend); Postgres is
// only the catch-up's transaction, Valkey the real relay.

func TestMain(m *testing.M) { os.Exit(dbtest.Run(m)) }

var fullProfile = Profile{Ceiling: true, ByteBudget: true, CoalesceAwareness: true, RecheckJitter: true, PublishBackoff: true}

// memBackend keeps one document per id in memory; every socket may write.
type memBackend struct {
	prof Profile
	mu   sync.Mutex
	docs map[uuid.UUID]*memDoc
}

type memDoc struct {
	through int64
	state   []byte
	updates []Update
	next    int64 // the next seq
}

func (b *memBackend) doc(id uuid.UUID) *memDoc {
	d := b.docs[id]
	if d == nil {
		d = &memDoc{next: 1}
		b.docs[id] = d
	}
	return d
}

func (*memBackend) Name() string       { return "yprof" }
func (*memBackend) LogKey() string     { return "doc_id" }
func (*memBackend) Noun() string       { return "document" }
func (*memBackend) MaxState() int      { return 1 << 20 }
func (b *memBackend) Profile() Profile { return b.prof }

func (b *memBackend) GetSnapshot(_ context.Context, _ *sqlc.Queries, id uuid.UUID) (int64, []byte, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	d := b.doc(id)
	if d.state == nil {
		return 0, EmptyState, nil
	}
	return d.through, d.state, nil
}

func (b *memBackend) GetSnapshotSeq(_ context.Context, _ *sqlc.Queries, id uuid.UUID) (int64, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.doc(id).through, nil
}

func (b *memBackend) ListUpdates(_ context.Context, _ *sqlc.Queries, id uuid.UUID, after int64, lim int32) ([]Update, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	var out []Update
	for _, u := range b.doc(id).updates {
		if u.Seq > after && len(out) < int(lim) {
			out = append(out, u)
		}
	}
	return out, nil
}

func (b *memBackend) AppendUpdate(_ context.Context, _ *sqlc.Queries, id uuid.UUID, data []byte, _ *uuid.UUID) (int64, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	d := b.doc(id)
	seq := d.next
	d.next++
	d.updates = append(d.updates, Update{Seq: seq, Data: data})
	return seq, nil
}

func (b *memBackend) UpdatesSince(_ context.Context, _ *sqlc.Queries, id uuid.UUID, after int64) (Stats, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	var st Stats
	for _, u := range b.doc(id).updates {
		if u.Seq > after {
			st.Updates++
			st.Bytes += int64(len(u.Data))
		}
	}
	return st, nil
}

func (b *memBackend) UpsertSnapshot(_ context.Context, _ *sqlc.Queries, id uuid.UUID, state []byte, through int64, _ *uuid.UUID) (int64, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	d := b.doc(id)
	if through < d.through {
		return 0, nil
	}
	d.through, d.state = through, state
	return 1, nil
}

func (b *memBackend) DeleteUpdatesThrough(_ context.Context, _ *sqlc.Queries, id uuid.UUID, through int64) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	d := b.doc(id)
	kept := d.updates[:0]
	for _, u := range d.updates {
		if u.Seq > through {
			kept = append(kept, u)
		}
	}
	d.updates = kept
	return nil
}

func (b *memBackend) nextSeq(id uuid.UUID) int64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.doc(id).next
}

func (b *memBackend) stored(id uuid.UUID) int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.doc(id).updates)
}

func (*memBackend) Authorize(context.Context, auth.Identity, uuid.UUID) (bool, int, string) {
	return true, 0, ""
}

func (*memBackend) DecodeMeta([]byte) (any, bool, error) { return nil, false, nil }

func (b *memBackend) PostSnapshot(ctx context.Context, p Post) (Result, error) {
	ok, through, _, err := StoreSnapshot(ctx, b, nil, p, b.nextSeq(p.Doc))
	return Result{Stored: ok, Through: through}, err
}

// memAuth: the token is the user id.
type memAuth struct{}

func (memAuth) AuthenticateToken(_ context.Context, tok string) (auth.Identity, error) {
	u, err := uuid.Parse(tok)
	if err != nil {
		return auth.Identity{}, auth.ErrInvalidToken
	}
	return auth.Identity{UserID: u, SessionID: uuid.New()}, nil
}
func (memAuth) CheckSession(context.Context, uuid.UUID) error { return nil }
func (memAuth) CheckWorkspace(context.Context, auth.Identity, uuid.UUID, identitypolicy.Operation) error {
	return nil
}
func (memAuth) WithPolicy(ctx context.Context, _ auth.Identity, _ identitypolicy.Operation) context.Context {
	return ctx
}

type profEnv struct {
	t   *testing.T
	b   *memBackend
	srv *httptest.Server
	rc  rueidis.Client
	h   *Hub
	doc uuid.UUID
}

func newProfEnv(t *testing.T, prof Profile, cfg Config) *profEnv {
	t.Helper()
	url := os.Getenv("TEST_REDIS_URL")
	if url == "" {
		t.Fatal("TEST_REDIS_URL required")
	}
	rc, err := redisx.Connect(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(rc.Close)
	b := &memBackend{prof: prof, docs: map[uuid.UUID]*memDoc{}}
	h := NewHub(b, Options{DB: dbtest.Connect(t), Redis: rc, Auth: memAuth{}, Config: cfg})
	mux := http.NewServeMux()
	mux.HandleFunc("GET /sync/{id}", h.Serve)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return &profEnv{t: t, b: b, srv: srv, rc: rc, h: h, doc: uuid.New()}
}

type profClient struct {
	t  *testing.T
	ws *websocket.Conn
}

func (e *profEnv) dial() *profClient {
	e.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, resp, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(e.srv.URL, "http")+"/sync/"+e.doc.String(), nil)
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		e.t.Fatal(err)
	}
	ws.SetReadLimit(8 << 20)
	e.t.Cleanup(func() { _ = ws.CloseNow() })
	if err := ws.Write(ctx, websocket.MessageText, []byte(uuid.NewString())); err != nil {
		e.t.Fatal(err)
	}
	c := &profClient{t: e.t, ws: ws}
	c.next(FrameSnapshot)
	for i := e.b.stored(e.doc); i > 0; i-- { // the catch-up of the backlog
		c.next(FrameUpdate)
	}
	return c
}

func (c *profClient) send(f []byte) {
	c.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := c.ws.Write(ctx, websocket.MessageBinary, f); err != nil {
		c.t.Fatal(err)
	}
}

// read is the next frame within d (nil and the close code, or -1 on the timeout).
func (c *profClient) read(d time.Duration) ([]byte, websocket.StatusCode) {
	ctx, cancel := context.WithTimeout(context.Background(), d)
	defer cancel()
	_, b, err := c.ws.Read(ctx)
	if err != nil {
		return nil, websocket.CloseStatus(err)
	}
	return b, -1
}

func (c *profClient) next(want byte) []byte {
	c.t.Helper()
	f, code := c.read(5 * time.Second)
	if f == nil {
		c.t.Fatalf("closed %d waiting for frame %d", code, want)
	}
	if f[0] != want {
		c.t.Fatalf("frame %d (%x), want %d", f[0], f[:min(len(f), 16)], want)
	}
	return f
}

// probe: an awareness frame from `from` arrives at c, nothing else before it.
func (c *profClient) probe(from *profClient) {
	c.t.Helper()
	from.send([]byte{FrameAwareness, 0xEE})
	if f := c.next(FrameAwareness); !bytes.Equal(f, []byte{FrameAwareness, 0xEE}) {
		c.t.Fatalf("frame before the probe: %x", f[:min(len(f), 16)])
	}
}

// seed stores n updates of size bytes each, as a long backlog after no snapshot.
func (e *profEnv) seed(n, size int) {
	d := e.b.doc(e.doc)
	for i := 0; i < n; i++ {
		d.updates = append(d.updates, Update{Seq: d.next, Data: make([]byte, size)})
		d.next++
	}
}

func postFrame(through int64, state []byte) []byte {
	meta := []byte("{}")
	out := make([]byte, headerPost+len(meta)+len(state))
	out[0] = FrameSnapshotPost
	binary.BigEndian.PutUint64(out[1:9], uint64(through))    //nolint:gosec // test values
	binary.BigEndian.PutUint32(out[9:13], uint32(len(meta))) //nolint:gosec // 2 bytes
	copy(out[headerPost:], meta)
	copy(out[headerPost+len(meta):], state)
	return out
}

// The Wiki's profile has no ceiling: a document far past 10 000 updates and 16 MiB after its
// snapshot still stores and relays every UPDATE; the sender alone gets the ordinary COMPACT_REQUEST
// (500 updates / 1 MiB, once per cooldown), the peer none, nobody is closed 4012 / 4014, and a stored
// snapshot puts no control message on the channel. The Canvas's profile refuses the same UPDATE.
func TestProfileCeiling(t *testing.T) {
	for _, tc := range []struct {
		name string
		prof Profile
	}{{"wiki", Profile{}}, {"canvas", fullProfile}} {
		t.Run(tc.name, func(t *testing.T) {
			e := newProfEnv(t, tc.prof, Config{})
			e.seed(12_000, 1500) // 12 000 updates, 18 MB
			a, b := e.dial(), e.dial()
			// Everything published on the document's channel.
			var mu sync.Mutex
			var relayed [][]byte
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			subscribed := make(chan struct{})
			var once sync.Once
			go func() {
				sctx := rueidis.WithOnSubscriptionHook(ctx, func(rueidis.PubSubSubscription) { once.Do(func() { close(subscribed) }) })
				_ = e.rc.Receive(sctx, e.rc.B().Subscribe().Channel(redisx.Channel("yprof:"+e.doc.String())).Build(), func(m rueidis.PubSubMessage) {
					mu.Lock()
					relayed = append(relayed, []byte(m.Message)[16:])
					mu.Unlock()
				})
			}()
			<-subscribed
			if tc.name == "canvas" {
				a.send(UpdateFrame(0, []byte("over")))
				a.next(FrameCompact)
				b.next(FrameCompact)
				if n := e.b.stored(e.doc); n != 12_000 {
					t.Fatalf("stored %d at the ceiling", n)
				}
				return
			}
			compacts := 0
			for i := 0; i < 15; i++ {
				a.send(UpdateFrame(0, []byte{'u', byte(i)}))
				for {
					f, code := a.read(5 * time.Second)
					if f == nil {
						t.Fatalf("closed %d", code)
					}
					if f[0] == FrameCompact {
						compacts++
						continue
					}
					if f[0] != FrameUpdate || FrameSeq(f) != int64(12_001+i) {
						t.Fatalf("echo %x", f[:min(len(f), 16)])
					}
					break
				}
				if f := b.next(FrameUpdate); FrameSeq(f) != int64(12_001+i) {
					t.Fatalf("relayed %x", f[:min(len(f), 16)])
				}
			}
			if compacts != 1 {
				t.Fatalf("%d COMPACT_REQUESTs to the sender, want 1", compacts)
			}
			b.probe(a) // the peer got no COMPACT_REQUEST
			if n := e.b.stored(e.doc); n != 12_015 {
				t.Fatalf("stored %d", n)
			}
			// A snapshot through everything: stored under its own through, no extra update, no
			// control message, nobody closed.
			a.send(postFrame(12_015, []byte("state")))
			b.probe(a)
			a.probe(b)
			if d := e.b.doc(e.doc); d.through != 12_015 || d.next != 12_016 || len(d.updates) != 0 {
				t.Fatalf("after the snapshot: through %d next %d updates %d", d.through, d.next, len(d.updates))
			}
			time.Sleep(100 * time.Millisecond)
			mu.Lock()
			defer mu.Unlock()
			for _, f := range relayed {
				if f[0] >= 0xF0 {
					t.Fatalf("control message %x on the channel", f[0])
				}
			}
		})
	}
}

// The Wiki's profile drops awareness over the budget (10 at once): of 15 frames sent together the
// peer gets the first 10 and never the rest. The Canvas's profile delivers the newest one late.
func TestProfileAwareness(t *testing.T) {
	for _, tc := range []struct {
		name string
		prof Profile
		want int
	}{{"wiki", Profile{}, 10}, {"canvas", fullProfile, 11}} {
		t.Run(tc.name, func(t *testing.T) {
			e := newProfEnv(t, tc.prof, Config{AwarenessPerSecond: 10})
			a, b := e.dial(), e.dial()
			for i := 0; i < 15; i++ {
				a.send([]byte{FrameAwareness, byte(i)})
			}
			var got []byte
			for {
				f, _ := b.read(500 * time.Millisecond)
				if f == nil {
					break
				}
				if f[0] != FrameAwareness {
					t.Fatalf("frame %d", f[0])
				}
				got = append(got, f[1])
			}
			if len(got) != tc.want {
				t.Fatalf("peer got %v, want %d frames", got, tc.want)
			}
			if tc.name == "canvas" && got[10] != 14 {
				t.Fatalf("the late frame is %d, want the newest (14)", got[10])
			}
		})
	}
}

// The Wiki's UPDATE budget is one bucket of 20 frames at once, whatever their size: 20 frames of
// 60 KiB (1.2 MB, over the Canvas's byte burst of MaxState) are all stored, and of 21 tiny ones the
// 21st closes 4008, as on origin/main. The Canvas's byte bucket closes the 18th frame of 60 KiB.
func TestProfileUpdateBudget(t *testing.T) {
	for _, tc := range []struct {
		name       string
		prof       Profile
		size, sent int
		pass       int // stored before the close (sent = pass: no close)
	}{
		{"wiki-bytes", Profile{}, 60 << 10, 20, 20},
		{"wiki-frames", Profile{}, 1, 21, 20},
		{"canvas-bytes", fullProfile, 60 << 10, 18, 17},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := newProfEnv(t, tc.prof, Config{CompactBytes: 1 << 30})
			a := e.dial()
			frames := make([][]byte, tc.sent)
			for i := range frames {
				frames[i] = UpdateFrame(0, bytes.Repeat([]byte{byte(i)}, tc.size))
			}
			for _, f := range frames {
				a.send(f)
			}
			for i := 0; i < tc.pass; i++ {
				a.next(FrameUpdate)
			}
			f, code := a.read(500 * time.Millisecond)
			switch {
			case f != nil:
				t.Fatalf("a frame %d after %d updates", f[0], tc.pass)
			case tc.sent > tc.pass && code != CloseRate:
				t.Fatalf("closed %d, want %d", code, CloseRate)
			case tc.sent == tc.pass && code != -1:
				t.Fatalf("closed %d, want open", code)
			}
			if n := e.b.stored(e.doc); n != tc.pass {
				t.Fatalf("stored %d, want %d", n, tc.pass)
			}
		})
	}
}

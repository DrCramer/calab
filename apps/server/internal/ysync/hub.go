package ysync

import (
	"bytes"
	"context"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/redis/rueidis"

	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/redisx"
)

// Options are what a Hub needs besides its Backend.
type Options struct {
	DB *db.DB
	// Redis relays the frames between instances (channel <name>:<docId>).
	Redis rueidis.Client
	// Auth authenticates the socket's first frame like the gateway's IDENTIFY.
	Auth Authenticator
	// Origin decides the WebSocket upgrade (gateway.OriginAllowed with the web client's origins);
	// nil = any.
	Origin func(origin string, hasCookie bool) bool
	Config Config
}

// Hub serves the sync sockets of one section: the rooms of its documents on this instance.
type Hub struct {
	b        Backend
	db       *db.DB
	rc       rueidis.Client
	auth     Authenticator
	origin   func(origin string, hasCookie bool) bool
	cfg      Config
	prof     Profile // the Backend's, read once
	instance [16]byte
	m        metrics
	// Warn lines of a failing Valkey and of failed socket writes, one per logEvery each.
	subLog, pubLog, writeLog logLimit
	// pubDown is when a publish last failed (UnixNano; 0 = it works): awareness is not published
	// for pubBackoff after it.
	pubDown atomic.Int64

	mu    sync.Mutex
	rooms map[uuid.UUID]*room
}

// room is the sockets of one document on this instance and its Redis subscription.
type room struct {
	id        uuid.UUID
	conns     map[*conn]struct{}
	stop      chan struct{}
	lastCheck time.Time // the COMPACT_REQUEST threshold query (hub.mu)
	// The updates after the snapshot as this instance knows them (hub.mu): read from the database
	// at statsAt, then counted up by the updates stored here; other instances' updates are seen at
	// the next refresh.
	updates, bytes int64
	statsAt        time.Time
	// ready closes when the first SUBSCRIBE of <name>:<doc> is confirmed: a socket reads its
	// snapshot only after it, so that nothing published between that read and the subscription
	// is lost (a frame after the read arrives through Redis; one before it is in the database).
	ready      chan struct{}
	subscribed bool // hub.mu

	// Awareness batching (Canvas profile)
	awMu      sync.Mutex
	awBatch   map[uint64]awarenessEntry
	awInCount int
	awTimer   *time.Timer
}

// NewHub creates the hub of a section.
func NewHub(b Backend, o Options) *Hub {
	cfg := o.Config.WithDefaults()
	if cfg.UpdateBytesBurst == 0 {
		cfg.UpdateBytesBurst = int64(b.MaxState())
	}
	if cfg.UpdateBytesPerSecond == 0 {
		cfg.UpdateBytesPerSecond = int64(b.MaxState()) / 20
	}
	h := &Hub{b: b, db: o.DB, rc: o.Redis, auth: o.Auth, origin: o.Origin, cfg: cfg, prof: b.Profile(), rooms: map[uuid.UUID]*room{},
		m: newMetrics(b.Name())}
	h.instance = uuid.New()
	return h
}

func (h *Hub) channel(doc uuid.UUID) string { return redisx.Channel(h.b.Name() + ":" + doc.String()) }

// join adds c to its document's room, subscribing the instance to the document's channel on the
// first socket.
func (h *Hub) join(c *conn) *room {
	h.mu.Lock()
	defer h.mu.Unlock()
	r := h.rooms[c.doc]
	if r == nil {
		r = &room{
			id:      c.doc,
			conns:   map[*conn]struct{}{},
			stop:    make(chan struct{}),
			ready:   make(chan struct{}),
			awBatch: make(map[uint64]awarenessEntry),
		}
		h.rooms[c.doc] = r
		h.m.rooms.Inc()
		go h.listen(r)
	}
	r.conns[c] = struct{}{}
	h.m.sockets.Inc()
	return r
}

// leave removes c; the last socket of a document ends the subscription.
func (h *Hub) leave(c *conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	r := h.rooms[c.doc]
	if r == nil {
		return
	}
	delete(r.conns, c)
	h.m.sockets.Dec()
	if len(r.conns) == 0 {
		delete(h.rooms, c.doc)
		h.m.rooms.Dec()
		close(r.stop)
		r.awMu.Lock()
		if r.awTimer != nil {
			r.awTimer.Stop()
			r.awTimer = nil
		}
		r.awBatch = nil
		r.awInCount = 0
		r.awMu.Unlock()
	}
}

// listen keeps the room subscribed to <name>:<doc> until it is stopped. A subscription lost
// (a reconnect, a concurrent UNSUBSCRIBE of a previous room of the document) is made again; once
// it is confirmed, every socket of the room catches up from the database (frames published
// meanwhile never reached it).
func (h *Hub) listen(r *room) {
	ctx, cancel := context.WithCancel(context.Background())
	go func() { <-r.stop; cancel() }()
	ch := h.channel(r.id)
	ctx = rueidis.WithOnSubscriptionHook(ctx, func(s rueidis.PubSubSubscription) {
		if s.Kind == "subscribe" && s.Channel == ch {
			h.onSubscribed(r)
		}
	})
	for ctx.Err() == nil {
		err := h.rc.Receive(ctx, h.rc.B().Subscribe().Channel(ch).Build(), func(m rueidis.PubSubMessage) {
			h.onRelay(r, []byte(m.Message))
		})
		if ctx.Err() != nil {
			break
		}
		if err != nil {
			h.subLog.warn(h.b.Name()+" sync: subscription lost", h.b.LogKey(), r.id, "err", err)
		}
		select {
		case <-ctx.Done():
		case <-time.After(200 * time.Millisecond):
		}
	}
	// Receive does not unsubscribe when its context ends.
	uctx, ucancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer ucancel()
	_ = h.rc.Do(uctx, h.rc.B().Unsubscribe().Channel(ch).Build()).Error()
}

// onSubscribed: the first confirmation opens the room (ready); a later one (a re-subscription)
// makes every socket of the room catch up from the database.
func (h *Hub) onSubscribed(r *room) {
	h.mu.Lock()
	first := !r.subscribed
	r.subscribed = true
	conns := make([]*conn, 0, len(r.conns))
	if !first {
		for c := range r.conns {
			conns = append(conns, c)
		}
	}
	h.mu.Unlock()
	if first {
		close(r.ready)
		return
	}
	for _, c := range conns {
		c.markStale()
	}
}

// onRelay delivers a frame published by another instance to this instance's sockets of the
// document.
func (h *Hub) onRelay(r *room, msg []byte) {
	if len(msg) < 17 || bytes.Equal(msg[:16], h.instance[:]) {
		return
	}
	frame := msg[16:]
	h.mu.Lock()
	if frame[0] == ctlCompacted {
		r.statsAt = time.Time{} // another instance stored a snapshot: the count is read again
	}
	conns := make([]*conn, 0, len(r.conns))
	for c := range r.conns {
		conns = append(conns, c)
	}
	h.mu.Unlock()
	for _, c := range conns {
		c.deliverFrame(frame)
	}
}

// deliverFrame hands a relayed frame to c: a recheck control to its checker, a stored snapshot
// (ctlCompacted) closes a socket with refused updates (it reconnects and resends them), a
// COMPACT_REQUEST only to a socket that may write (a read-only client has nothing to post),
// AWARENESS never to a viewer (an anonymous link does not see who is on the document), the rest
// queued.
func (c *conn) deliverFrame(frame []byte) {
	switch {
	case frame[0] == ctlRecheck:
		c.recheckSoon()
	case frame[0] == ctlCompacted:
		if c.refused.Load() {
			c.close(CloseResend, "the update ceiling is lifted: resend")
		}
	case frame[0] == FrameCompact && !c.write.Load():
	case frame[0] == FrameAwareness:
		if c.viewer != nil {
			return
		}
		if c.h.prof.BatchAwareness {
			c.deliverAwareness(frame)
			return
		}
		c.enqueue(frame)
	default:
		c.enqueue(frame)
	}
}

// deliver hands frame to the sockets of the document on this instance, except from.
func (h *Hub) deliver(doc uuid.UUID, from *conn, frame []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if r := h.rooms[doc]; r != nil {
		for c := range r.conns {
			if c != from {
				c.deliverFrame(frame)
			}
		}
	}
}

// relayCmd is the Redis command that carries frame to the other instances.
func (h *Hub) relayCmd(doc uuid.UUID, frame []byte) rueidis.Completed {
	msg := make([]byte, 16+len(frame))
	copy(msg, h.instance[:])
	copy(msg[16:], frame)
	return h.rc.B().Publish().Channel(h.channel(doc)).Message(rueidis.BinaryString(msg)).Build()
}

// pubBackoff: after a failed publish, awareness is not published for this long.
const pubBackoff = time.Second

// broadcast sends frame to the other sockets of the document here and, through Redis, on the
// other instances (after the commit of what it carries). A failed awareness publish is never
// logged; with Profile.PublishBackoff, while publishing fails, awareness goes to this instance's
// sockets only: it is not worth the reader's wait of up to 3 s per frame.
func (h *Hub) broadcast(ctx context.Context, doc uuid.UUID, from *conn, frame []byte) {
	h.deliver(doc, from, frame)
	aw := frame[0] == FrameAwareness
	// Without the profile's backoff every awareness frame is published, as the Wiki's relay did.
	if down := h.pubDown.Load(); aw && h.prof.PublishBackoff && down != 0 && time.Since(time.Unix(0, down)) < pubBackoff {
		h.m.dropPub.Inc()
		return
	}
	pctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
	defer cancel()
	if err := h.rc.Do(pctx, h.relayCmd(doc, frame)).Error(); err != nil {
		h.pubDown.Store(time.Now().UnixNano())
		h.m.dropPub.Inc()
		if !aw {
			h.pubLog.warn(h.b.Name()+" sync: publish", h.b.LogKey(), doc, "err", err)
		}
		return
	}
	if h.pubDown.Load() != 0 {
		h.pubDown.Store(0)
	}
}

// Kick makes every socket of the documents (on every instance) check its access now: after a
// trash, a change of overrides or of restricted. The Redis messages of many documents go in one
// pipeline.
func (h *Hub) Kick(ctx context.Context, docs []uuid.UUID) {
	if len(docs) == 0 {
		return
	}
	cmds := make(rueidis.Commands, len(docs))
	for i, d := range docs {
		h.deliver(d, nil, []byte{ctlRecheck})
		cmds[i] = h.relayCmd(d, []byte{ctlRecheck})
	}
	pctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
	defer cancel()
	for i, r := range h.rc.DoMulti(pctx, cmds...) {
		if err := r.Error(); err != nil {
			h.pubLog.warn(h.b.Name()+" sync: publish", h.b.LogKey(), docs[i], "err", err)
			return
		}
	}
}

// enqueueAwareness adds entries to the room's current window batch.
func (h *Hub) enqueueAwareness(doc uuid.UUID, entries []awarenessEntry) {
	if len(entries) == 0 {
		return
	}
	h.mu.Lock()
	r := h.rooms[doc]
	h.mu.Unlock()
	if r == nil {
		return
	}
	r.awMu.Lock()
	defer r.awMu.Unlock()
	if r.awBatch == nil {
		return
	}
	arm := len(r.awBatch) == 0
	for _, e := range entries {
		r.awInCount++
		existing, ok := r.awBatch[e.clientID]
		if !ok {
			r.awBatch[e.clientID] = e
		} else {
			if e.clock > existing.clock || (e.clock == existing.clock && bytes.Equal(e.state, []byte("null"))) {
				r.awBatch[e.clientID] = e
			}
		}
	}
	if arm {
		if r.awTimer != nil {
			r.awTimer.Stop()
		}
		r.awTimer = time.AfterFunc(h.cfg.AwarenessWindow, func() {
			h.flushRoomAwareness(r)
		})
	}
}

// flushRoomAwareness coalesces and sends the room's batched awareness frames.
func (h *Hub) flushRoomAwareness(r *room) {
	r.awMu.Lock()
	if r.awTimer != nil {
		r.awTimer.Stop()
		r.awTimer = nil
	}
	if len(r.awBatch) == 0 {
		r.awMu.Unlock()
		return
	}
	batch := r.awBatch
	inCount := r.awInCount
	r.awBatch = make(map[uint64]awarenessEntry)
	r.awInCount = 0
	r.awMu.Unlock()

	coalesced := inCount - len(batch)
	if coalesced > 0 {
		h.m.coalescedEntries.Add(float64(coalesced))
	}

	merged := make([]awarenessEntry, 0, len(batch))
	senders := make(map[uint64]struct{}, len(batch))
	for _, e := range batch {
		merged = append(merged, e)
		senders[e.clientID] = struct{}{}
	}

	fullFrame := encodeAwarenessUpdate(merged)
	h.m.batchedFrames.Inc()

	// Snapshot sockets under h.mu
	h.mu.Lock()
	roomConns := make([]*conn, 0, len(r.conns))
	for c := range r.conns {
		roomConns = append(roomConns, c)
	}
	h.mu.Unlock()

	// Deliver to local sockets outside h.mu
	for _, c := range roomConns {
		if c.viewer != nil {
			continue
		}
		cid := c.clientID.Load()
		if cid != 0 {
			if _, sent := senders[cid]; sent {
				// Filter out recipient's own clientID
				filtered := make([]awarenessEntry, 0, len(merged)-1)
				for _, e := range merged {
					if e.clientID != cid {
						filtered = append(filtered, e)
					}
				}
				if len(filtered) > 0 {
					c.deliverAwarenessEntries(filtered)
				}
				continue
			}
		}
		c.deliverAwarenessEntries(merged)
	}

	// Publish fullFrame to Valkey outside h.mu
	if h.rc == nil {
		return
	}
	if down := h.pubDown.Load(); h.prof.PublishBackoff && down != 0 && time.Since(time.Unix(0, down)) < pubBackoff {
		h.m.dropPub.Inc()
		return
	}
	pctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := h.rc.Do(pctx, h.relayCmd(r.id, fullFrame)).Error(); err != nil {
		h.pubDown.Store(time.Now().UnixNano())
		h.m.dropPub.Inc()
	} else if h.pubDown.Load() != 0 {
		h.pubDown.Store(0)
	}
}

// broadcastAwarenessImmediate sends a farewell awareness frame immediately without batching.
func (h *Hub) broadcastAwarenessImmediate(ctx context.Context, doc uuid.UUID, from *conn, frame []byte) {
	h.mu.Lock()
	r := h.rooms[doc]
	var roomConns []*conn
	if r != nil {
		roomConns = make([]*conn, 0, len(r.conns))
		for c := range r.conns {
			roomConns = append(roomConns, c)
		}
	}
	h.mu.Unlock()

	if r != nil {
		if from != nil {
			if cid := from.clientID.Load(); cid != 0 {
				r.awMu.Lock()
				delete(r.awBatch, cid)
				r.awMu.Unlock()
			}
		}

		for _, c := range roomConns {
			if c == from || c.viewer != nil {
				continue
			}
			c.deliverAwareness(frame)
		}
	}

	// Publish immediately to Valkey
	if h.rc == nil {
		return
	}
	if down := h.pubDown.Load(); h.prof.PublishBackoff && down != 0 && time.Since(time.Unix(0, down)) < pubBackoff {
		h.m.dropPub.Inc()
		return
	}
	pctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
	defer cancel()
	if err := h.rc.Do(pctx, h.relayCmd(doc, frame)).Error(); err != nil {
		h.pubDown.Store(time.Now().UnixNano())
		h.m.dropPub.Inc()
	} else if h.pubDown.Load() != 0 {
		h.pubDown.Store(0)
	}
}

// shouldCheckCompact throttles the threshold query per document on this instance.
func (h *Hub) shouldCheckCompact(doc uuid.UUID) bool {
	if h.cfg.CompactCheckEvery < 0 {
		return true
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	r := h.rooms[doc]
	if r == nil {
		return false
	}
	now := time.Now()
	if now.Sub(r.lastCheck) < h.cfg.CompactCheckEvery {
		return false
	}
	r.lastCheck = now
	return true
}

// docStats is the room's count of the updates after the snapshot: the cached estimate while it is
// younger than CompactCheckEvery, else read from the database (always, when that is < 0).
func (h *Hub) docStats(ctx context.Context, doc uuid.UUID) (updates, size int64, err error) {
	ttl := max(h.cfg.CompactCheckEvery, 0)
	if ttl > 0 {
		h.mu.Lock()
		if r := h.rooms[doc]; r != nil && time.Since(r.statsAt) < ttl {
			updates, size = r.updates, r.bytes
			h.mu.Unlock()
			return updates, size, nil
		}
		h.mu.Unlock()
	}
	seq, err := SnapshotSeq(ctx, h.b, h.db.Q, doc)
	if err != nil {
		return 0, 0, err
	}
	st, err := h.b.UpdatesSince(ctx, h.db.Q, doc, seq)
	if err != nil {
		return 0, 0, err
	}
	h.mu.Lock()
	if r := h.rooms[doc]; r != nil {
		r.updates, r.bytes, r.statsAt = int64(st.Updates), st.Bytes, time.Now()
	}
	h.mu.Unlock()
	return int64(st.Updates), st.Bytes, nil
}

// noteStored counts an update stored here; noteCompacted forgets the estimate after a snapshot
// (the next UPDATE reads the database).
func (h *Hub) noteStored(doc uuid.UUID, n int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if r := h.rooms[doc]; r != nil {
		r.updates++
		r.bytes += int64(n)
	}
}

func (h *Hub) noteCompacted(doc uuid.UUID) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if r := h.rooms[doc]; r != nil {
		r.statsAt = time.Time{}
	}
}

// ---- per-person socket limit (Redis, across instances) ----

func (h *Hub) connsKey(doc, user uuid.UUID) string {
	return redisx.Key(h.b.Name() + ":conns:" + doc.String() + ":" + user.String())
}

func (h *Hub) connTTL() time.Duration { return h.cfg.IdleTimeout + h.cfg.PingInterval }

// claim registers socket c in each of its socket sets (c.slots: the person's on the document, or
// a viewer's per link and per IP); false over any set's Max, and then it is in none.
func (h *Hub) claim(ctx context.Context, c *conn) (bool, error) {
	now := time.Now()
	exp := float64(now.Add(h.connTTL()).UnixMilli())
	cmds := make(rueidis.Commands, 0, 4*len(c.slots))
	for _, s := range c.slots {
		cmds = append(cmds,
			h.rc.B().Zremrangebyscore().Key(s.Key).Min("-inf").Max(formatMs(now)).Build(),
			h.rc.B().Zadd().Key(s.Key).ScoreMember().ScoreMember(exp, c.key).Build(),
			h.rc.B().Zcard().Key(s.Key).Build(),
			h.rc.B().Pexpire().Key(s.Key).Milliseconds(h.connTTL().Milliseconds()).Build())
	}
	res := h.rc.DoMulti(ctx, cmds...)
	for _, r := range res {
		if err := r.Error(); err != nil {
			h.release(c)
			return false, err
		}
	}
	for i, s := range c.slots {
		n, err := res[4*i+2].AsInt64()
		if err != nil {
			h.release(c)
			return false, err
		}
		if n > int64(s.Max) {
			h.release(c)
			return false, nil
		}
	}
	return true, nil
}

// touch keeps the socket's registrations alive (on every ping).
func (h *Hub) touch(ctx context.Context, c *conn) {
	exp := float64(time.Now().Add(h.connTTL()).UnixMilli())
	cmds := make(rueidis.Commands, 0, 2*len(c.slots))
	for _, s := range c.slots {
		cmds = append(cmds,
			h.rc.B().Zadd().Key(s.Key).ScoreMember().ScoreMember(exp, c.key).Build(),
			h.rc.B().Pexpire().Key(s.Key).Milliseconds(h.connTTL().Milliseconds()).Build())
	}
	h.rc.DoMulti(ctx, cmds...)
}

func (h *Hub) release(c *conn) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	cmds := make(rueidis.Commands, 0, len(c.slots))
	for _, s := range c.slots {
		cmds = append(cmds, h.rc.B().Zrem().Key(s.Key).Member(c.key).Build())
	}
	h.rc.DoMulti(ctx, cmds...)
}

func formatMs(t time.Time) string { return strconv.FormatInt(t.UnixMilli(), 10) }

// bucket is a token bucket.
type bucket struct {
	tokens, burst, rate float64
	last                time.Time
}

func newBucket(burst, perSecond float64) bucket {
	return bucket{tokens: burst, burst: burst, rate: perSecond, last: time.Now()}
}

func (b *bucket) take() bool { return b.takeN(1) }

// wait is how long until a token is there (0: now).
func (b *bucket) wait() time.Duration {
	t := min(b.burst, b.tokens+time.Since(b.last).Seconds()*b.rate)
	if t >= 1 {
		return 0
	}
	return time.Duration((1 - t) / b.rate * float64(time.Second))
}

// takeN spends n tokens, or none when fewer are left.
func (b *bucket) takeN(n float64) bool {
	now := time.Now()
	b.tokens = min(b.burst, b.tokens+now.Sub(b.last).Seconds()*b.rate)
	b.last = now
	if b.tokens < n {
		return false
	}
	b.tokens -= n
	return true
}

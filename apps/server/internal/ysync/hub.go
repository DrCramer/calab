package ysync

import (
	"bytes"
	"context"
	"log/slog"
	"strconv"
	"sync"
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
	instance [16]byte

	mu    sync.Mutex
	rooms map[uuid.UUID]*room
}

// room is the sockets of one document on this instance and its Redis subscription.
type room struct {
	id        uuid.UUID
	conns     map[*conn]struct{}
	stop      chan struct{}
	lastCheck time.Time // the COMPACT_REQUEST threshold query (hub.mu)
	// ready closes when the first SUBSCRIBE of <name>:<doc> is confirmed: a socket reads its
	// snapshot only after it, so that nothing published between that read and the subscription
	// is lost (a frame after the read arrives through Redis; one before it is in the database).
	ready      chan struct{}
	subscribed bool // hub.mu
}

// NewHub creates the hub of a section.
func NewHub(b Backend, o Options) *Hub {
	h := &Hub{b: b, db: o.DB, rc: o.Redis, auth: o.Auth, origin: o.Origin, cfg: o.Config.WithDefaults(), rooms: map[uuid.UUID]*room{}}
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
		r = &room{id: c.doc, conns: map[*conn]struct{}{}, stop: make(chan struct{}), ready: make(chan struct{})}
		h.rooms[c.doc] = r
		go h.listen(r)
	}
	r.conns[c] = struct{}{}
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
	if len(r.conns) == 0 {
		delete(h.rooms, c.doc)
		close(r.stop)
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
			slog.Warn(h.b.Name()+" sync: subscription lost", "doc_id", r.id, "err", err)
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
	conns := make([]*conn, 0, len(r.conns))
	for c := range r.conns {
		conns = append(conns, c)
	}
	h.mu.Unlock()
	for _, c := range conns {
		if frame[0] == ctlRecheck {
			c.recheckSoon()
		} else {
			c.enqueue(frame)
		}
	}
}

// broadcast sends frame to the other sockets of the document here and, through Redis, on the
// other instances (after the commit of what it carries).
func (h *Hub) broadcast(ctx context.Context, doc uuid.UUID, from *conn, frame []byte) {
	h.mu.Lock()
	if r := h.rooms[doc]; r != nil {
		for c := range r.conns {
			if c != from {
				if frame[0] == ctlRecheck {
					c.recheckSoon()
				} else {
					c.enqueue(frame)
				}
			}
		}
	}
	h.mu.Unlock()
	msg := make([]byte, 16+len(frame))
	copy(msg, h.instance[:])
	copy(msg[16:], frame)
	pctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
	defer cancel()
	if err := h.rc.Do(pctx, h.rc.B().Publish().Channel(h.channel(doc)).Message(rueidis.BinaryString(msg)).Build()).Error(); err != nil {
		slog.Warn(h.b.Name()+" sync: publish", "doc_id", doc, "err", err)
	}
}

// Kick makes every socket of the documents (on every instance) check its access now: after a
// trash, a change of overrides or of restricted.
func (h *Hub) Kick(ctx context.Context, docs []uuid.UUID) {
	for _, d := range docs {
		h.broadcast(ctx, d, nil, []byte{ctlRecheck})
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

// ---- per-person socket limit (Redis, across instances) ----

func (h *Hub) connsKey(doc, user uuid.UUID) string {
	return redisx.Key(h.b.Name() + ":conns:" + doc.String() + ":" + user.String())
}

func (h *Hub) connTTL() time.Duration { return h.cfg.IdleTimeout + h.cfg.PingInterval }

// claim registers socket c of its person on the document; false over MaxConnsPerUser.
func (h *Hub) claim(ctx context.Context, c *conn) (bool, error) {
	key, now := h.connsKey(c.doc, c.id.UserID), time.Now()
	exp := float64(now.Add(h.connTTL()).UnixMilli())
	res := h.rc.DoMulti(ctx,
		h.rc.B().Zremrangebyscore().Key(key).Min("-inf").Max(formatMs(now)).Build(),
		h.rc.B().Zadd().Key(key).ScoreMember().ScoreMember(exp, c.key).Build(),
		h.rc.B().Zcard().Key(key).Build(),
		h.rc.B().Pexpire().Key(key).Milliseconds(h.connTTL().Milliseconds()).Build())
	for _, r := range res {
		if err := r.Error(); err != nil {
			return false, err
		}
	}
	n, err := res[2].AsInt64()
	if err != nil {
		return false, err
	}
	if n > int64(h.cfg.MaxConnsPerUser) {
		h.release(c)
		return false, nil
	}
	return true, nil
}

// touch keeps the socket's registration alive (on every ping).
func (h *Hub) touch(ctx context.Context, c *conn) {
	key := h.connsKey(c.doc, c.id.UserID)
	exp := float64(time.Now().Add(h.connTTL()).UnixMilli())
	h.rc.DoMulti(ctx,
		h.rc.B().Zadd().Key(key).ScoreMember().ScoreMember(exp, c.key).Build(),
		h.rc.B().Pexpire().Key(key).Milliseconds(h.connTTL().Milliseconds()).Build())
}

func (h *Hub) release(c *conn) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = h.rc.Do(ctx, h.rc.B().Zrem().Key(h.connsKey(c.doc, c.id.UserID)).Member(c.key).Build()).Error()
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

func (b *bucket) take() bool {
	now := time.Now()
	b.tokens = min(b.burst, b.tokens+now.Sub(b.last).Seconds()*b.rate)
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

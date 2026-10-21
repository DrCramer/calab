package ysync

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/redis/rueidis"

	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/redisx"
)

// conn is one client socket on one document.
type conn struct {
	h      *Hub
	ws     *websocket.Conn
	doc    uuid.UUID
	id     auth.Identity
	botTok string // a bot's token: rechecked by authenticating it again (no session row)
	key    string // the socket's member in its socket sets (slots)
	ctx    context.Context
	cancel context.CancelFunc

	// viewer: an anonymous receive-only socket (ServeViewer); nil for a person's or a bot's.
	viewer *Viewer
	// until is when the viewer's access ends by itself (UnixNano; 0 = never), from its last check.
	until atomic.Int64
	// slots are the socket sets the socket counts in: the person's on the document, or the
	// viewer's (link, IP).
	slots []Slot

	write   atomic.Bool   // the section's WRITE bit and the policy allow writing
	out     chan []byte   // frames for the writer
	stale   atomic.Bool   // an update or snapshot was dropped (queue full): catch up from the DB
	kick    chan struct{} // wakes the writer after stale is set
	recheck chan struct{} // an access recheck was asked for (ctlRecheck)
	closed  sync.Once

	// Awareness batching (Canvas profile)
	clientID           atomic.Uint64
	awAccumMu          sync.Mutex
	awAccum            map[uint64]awarenessEntry
	testPauseAwareness atomic.Bool
	parsedAwareness    atomic.Uint64
	farewells          bucket // own farewell frames relayed at once (reader goroutine only)

	// The writer's position: the highest seq the client has (snapshot or update); -1 = nothing
	// sent yet. Writer goroutine only.
	lastSent int64

	// Inbound budgets (reader goroutine only).
	updates, updateBytes, snapshots bucket
	// The awareness budget and the newest frame over it, waiting for a token (awTimer sends it);
	// awMu guards the three (the reader and the timer).
	awMu      sync.Mutex
	awareness bucket
	awPending []byte
	awPendEnt []awarenessEntry // awPending parsed (Canvas profile; nil = not parsed yet)
	awTimer   *time.Timer
	// refused: an UPDATE of this socket was refused at the ceiling and no stored snapshot of this
	// socket carried it yet (the package doc: it is delivered by such a snapshot or by a reconnect).
	// Set by the reader, read by the relay (ctlCompacted).
	refused atomic.Bool
	// overSince is the first refused UPDATE of the current run of refusals, lastOver the latest one
	// (zero: none). Reader goroutine only.
	overSince, lastOver time.Time
}

// enqueue hands a frame to the writer without blocking. A full queue drops it: an awareness
// frame is just lost, a lost update or snapshot makes the writer catch up from the database.
func (c *conn) enqueue(frame []byte) {
	select {
	case c.out <- frame:
	default:
		c.h.m.dropQueue.Inc()
		if t := frame[0]; t == FrameUpdate || t == FrameSnapshot {
			c.markStale()
		}
	}
}

// deliverAwareness parses frame and merges its awareness entries into the socket's accumulator map (Canvas profile).
// If the frame cannot be parsed, it is preserved by putting it into the standard out queue.
func (c *conn) deliverAwareness(frame []byte) {
	if len(frame) < 2 {
		c.enqueue(frame)
		return
	}
	entries, err := parseAwarenessUpdate(frame[1:])
	if err != nil {
		c.enqueue(frame)
		return
	}
	c.deliverAwarenessEntries(entries)
}

// deliverAwarenessEntries merges awareness entries into the socket's accumulator map.
func (c *conn) deliverAwarenessEntries(entries []awarenessEntry) {
	if len(entries) == 0 {
		return
	}
	c.awAccumMu.Lock()
	if c.awAccum == nil {
		c.awAccum = make(map[uint64]awarenessEntry)
	}
	for _, e := range entries {
		existing, ok := c.awAccum[e.clientID]
		if !ok {
			c.awAccum[e.clientID] = e
		} else {
			c.h.m.overwrittenSlots.Inc()
			eNull := bytes.Equal(e.state, []byte("null"))
			existingNull := bytes.Equal(existing.state, []byte("null"))
			if e.clock > existing.clock || (e.clock == existing.clock && eNull && !existingNull) {
				c.awAccum[e.clientID] = e
			}
		}
	}
	c.awAccumMu.Unlock()

	select {
	case c.kick <- struct{}{}:
	default:
	}
}

// popAwareness drains all accumulated awareness entries and encodes them into a single frame.
func (c *conn) popAwareness() []byte {
	c.awAccumMu.Lock()
	if len(c.awAccum) == 0 {
		c.awAccumMu.Unlock()
		return nil
	}
	entries := make([]awarenessEntry, 0, len(c.awAccum))
	for _, e := range c.awAccum {
		entries = append(entries, e)
	}
	c.awAccum = make(map[uint64]awarenessEntry)
	c.awAccumMu.Unlock()
	return encodeAwarenessUpdate(entries)
}

// markStale makes the writer catch up from the database.
func (c *conn) markStale() {
	c.stale.Store(true)
	select {
	case c.kick <- struct{}{}:
	default:
	}
}

func (c *conn) recheckSoon() {
	select {
	case c.recheck <- struct{}{}:
	default:
	}
}

// close ends the socket once with a close code.
func (c *conn) close(code int, reason string) {
	c.closed.Do(func() {
		c.h.m.closed(code)
		// The close handshake first: cancelling the context of a pending Read or Write drops the
		// connection without a close frame.
		go func() {
			_ = c.ws.Close(websocket.StatusCode(code), reason) //nolint:gosec // close codes
			c.cancel()
		}()
	})
}

// OriginAllowed is the WebSocket upgrade rule of the hub's sockets (Options.Origin); a section
// checks it before it spends anything on a viewer's credential.
func (h *Hub) OriginAllowed(r *http.Request) bool {
	return h.origin == nil || h.origin(r.Header.Get("Origin"), r.Header.Get("Cookie") != "")
}

// accept upgrades the request to the socket of doc.
func (h *Hub) accept(w http.ResponseWriter, r *http.Request, doc uuid.UUID) (*conn, bool) {
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// Origin is checked before (gateway.OriginAllowed): Electron's file:// / "null" origins.
		InsecureSkipVerify: true,
		CompressionMode:    websocket.CompressionDisabled,
	})
	if err != nil {
		return nil, false
	}
	ws.SetReadLimit(readLimitRO)
	ctx, cancel := context.WithCancel(context.WithoutCancel(r.Context()))
	// Without the byte budget the frame bucket bursts its rate, as the Wiki's relay did.
	burst := h.cfg.UpdatesPerSecond
	if h.prof.ByteBudget {
		burst = h.cfg.UpdateBurst
	}
	return &conn{h: h, ws: ws, doc: doc, key: uuid.NewString(), ctx: ctx, cancel: cancel, lastSent: -1,
		out: make(chan []byte, 256), kick: make(chan struct{}, 1), recheck: make(chan struct{}, 1),
		updates:     newBucket(float64(burst), float64(h.cfg.UpdatesPerSecond)),
		updateBytes: newBucket(float64(h.cfg.UpdateBytesBurst), float64(h.cfg.UpdateBytesPerSecond)),
		awareness:   newBucket(float64(h.cfg.AwarenessPerSecond), float64(h.cfg.AwarenessPerSecond)),
		farewells:   newBucket(float64(h.cfg.FarewellBurst), float64(h.cfg.FarewellBurst)/h.cfg.FarewellWindow.Seconds()),
		snapshots:   newBucket(2, 1/h.cfg.SnapshotEvery.Seconds())}, true
}

// ServeViewer is the anonymous receive-only socket of v.Doc (see the package doc): no token
// frame, v.Check is the access rule, v.Slots the socket limits. The caller has checked the
// credential, OriginAllowed and its connect rate before.
func (h *Hub) ServeViewer(w http.ResponseWriter, r *http.Request, v Viewer) {
	if !h.OriginAllowed(r) {
		http.Error(w, "origin not allowed", http.StatusForbidden)
		return
	}
	c, ok := h.accept(w, r, v.Doc)
	if !ok {
		return
	}
	defer c.close(1000, "")
	c.viewer = &v
	for _, s := range v.Slots {
		c.slots = append(c.slots, Slot{Key: redisx.Key(h.b.Name() + ":viewers:" + s.Key), Max: s.Max})
	}
	if code, reason := c.authorize(); code != 0 {
		c.close(code, reason)
		return
	}
	h.run(c)
}

// Serve is the sync socket handler: the document is the path value {id}.
func (h *Hub) Serve(w http.ResponseWriter, r *http.Request) {
	if !h.OriginAllowed(r) {
		http.Error(w, "origin not allowed", http.StatusForbidden)
		return
	}
	doc, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		httpx.WriteError(w, r, httpx.NotFound(h.b.Noun()))
		return
	}
	c, ok := h.accept(w, r, doc)
	if !ok {
		return
	}
	defer c.close(1000, "")
	ctx, ws := c.ctx, c.ws

	// In-band auth: the first message is a text frame with the access token.
	actx, acancel := context.WithTimeout(ctx, h.cfg.AuthTimeout)
	typ, tok, err := ws.Read(actx)
	acancel()
	if err != nil {
		c.close(CloseTryAgain, "no token")
		return
	}
	if typ != websocket.MessageText {
		c.close(CloseAuth, "token expected")
		return
	}
	token := strings.TrimSpace(string(tok))
	id, err := h.auth.AuthenticateToken(ctx, token)
	switch {
	case errors.Is(err, auth.ErrInvalidToken):
		c.close(CloseAuth, "authentication failed")
		return
	case errors.Is(err, auth.ErrSessionRevoked):
		c.close(CloseRevoked, "session revoked")
		return
	case err != nil:
		c.close(CloseTryAgain, "try again")
		return
	}
	c.id = id
	if id.IsBot {
		c.botTok = token
	}
	if code, reason := c.authorize(); code != 0 {
		c.close(code, reason)
		return
	}
	c.slots = []Slot{{Key: h.connsKey(doc, id.UserID), Max: h.cfg.MaxConnsPerUser}}
	h.run(c)
}

// run is the socket after its access is resolved: the socket limits, the room, the first
// catch-up, then the writer, the pinger and the reader until the socket ends.
func (h *Hub) run(c *conn) {
	ctx := c.ctx
	if c.write.Load() {
		c.ws.SetReadLimit(h.readLimitRW())
	}
	ok, err := h.claim(ctx, c)
	if err != nil {
		c.close(CloseTryAgain, "try again")
		return
	}
	if !ok {
		c.close(CloseRate, "too many connections to the "+h.b.Noun())
		return
	}
	defer h.release(c)
	rm := h.join(c)
	defer h.leave(c)
	// Subscribed first, then the snapshot read (catch-up), duplicates dropped by seq.
	wait := time.NewTimer(h.cfg.SubscribeTimeout)
	select {
	case <-rm.ready:
		wait.Stop()
	case <-wait.C:
		c.close(CloseTryAgain, "try again")
		return
	case <-ctx.Done():
		wait.Stop()
		return
	}
	c.markStale() // the first catch-up: SNAPSHOT + UPDATEs (lastSent -1)
	go c.writeLoop()
	go c.pingLoop()
	c.readLoop()
}

func (h *Hub) readLimitRW() int64 { return int64(headerPost + MaxMeta + h.b.MaxState()) }

// authorize resolves the caller's access to the document (as at connect, and on every recheck):
// 0 = allowed (write set), else the close code.
func (c *conn) authorize() (int, string) {
	ctx, cancel := context.WithTimeout(c.ctx, 10*time.Second)
	defer cancel()
	if c.viewer != nil { // never writes: write stays false
		until, code, reason := c.viewer.Check(ctx)
		if code != 0 {
			return code, reason
		}
		var u int64
		if !until.IsZero() {
			u = until.UnixNano()
		}
		c.until.Store(u)
		return 0, ""
	}
	write, code, reason := c.h.b.Authorize(ctx, c.id, c.doc)
	if code != 0 {
		return code, reason
	}
	c.write.Store(write)
	return 0, ""
}

// pingLoop pings the client (idle close), keeps the per-person registration alive and rechecks
// the session and the access every RecheckInterval (± 20 % with Profile.RecheckJitter,
// Hub.nextRecheck) or when asked.
func (c *conn) pingLoop() {
	h := c.h
	ping := time.NewTicker(h.cfg.PingInterval)
	defer ping.Stop()
	recheck := time.NewTicker(h.nextRecheck())
	defer recheck.Stop()
	// A viewer: the end of its access by itself (an expiry) and of its life.
	var expiry, life <-chan time.Time
	var expT *time.Timer
	arm := func() {
		if expT != nil {
			expT.Stop()
		}
		expT, expiry = nil, nil
		if u := c.until.Load(); u != 0 {
			// At least a second: the database's clock decides, a check a little early re-arms.
			expT = time.NewTimer(max(time.Until(time.Unix(0, u)), time.Second))
			expiry = expT.C
		}
	}
	if c.viewer != nil {
		arm()
		lt := time.NewTimer(h.cfg.ViewerMaxLife)
		defer lt.Stop()
		life = lt.C
		defer func() {
			if expT != nil {
				expT.Stop()
			}
		}()
	}
	check := func() bool {
		if c.viewer != nil { // no session: the access rule alone
			code, reason := c.authorize()
			if code != 0 && code != CloseTryAgain {
				c.close(code, reason)
				return false
			}
			arm()
			return true
		}
		sctx, cancel := context.WithTimeout(c.ctx, 5*time.Second)
		var err error
		if c.botTok != "" {
			// A bot token has no session row: a replaced or revoked token fails again here.
			_, err = h.auth.AuthenticateToken(sctx, c.botTok)
			if errors.Is(err, auth.ErrInvalidToken) {
				err = auth.ErrSessionRevoked
			}
		} else {
			err = h.auth.CheckSession(sctx, c.id.SessionID)
		}
		cancel()
		if errors.Is(err, auth.ErrSessionRevoked) {
			c.close(CloseRevoked, "session revoked")
			return false
		}
		if code, reason := c.authorize(); code != 0 && code != CloseTryAgain {
			c.close(code, reason)
			return false
		}
		return true
	}
	for {
		select {
		case <-c.ctx.Done():
			return
		case <-ping.C:
			pctx, cancel := context.WithTimeout(c.ctx, max(h.cfg.IdleTimeout-h.cfg.PingInterval, time.Second))
			err := c.ws.Ping(pctx)
			cancel()
			if err != nil {
				c.close(CloseIdle, "idle")
				return
			}
			h.touch(c.ctx, c)
		case <-recheck.C:
			if !check() {
				return
			}
			// Without the jitter the ticker keeps its period, as the Wiki's relay did.
			if h.prof.RecheckJitter {
				recheck.Reset(h.nextRecheck())
			}
		case <-c.recheck:
			if !check() {
				return
			}
		case <-expiry:
			if !check() {
				return
			}
		case <-life:
			c.close(CloseTryAgain, "reconnect")
			return
		}
	}
}

// nextRecheck is the time to a socket's next access recheck: RecheckInterval, jittered with
// Profile.RecheckJitter.
func (h *Hub) nextRecheck() time.Duration {
	if !h.prof.RecheckJitter {
		return h.cfg.RecheckInterval
	}
	return recheckDelay(h.cfg.RecheckInterval, rand.Float64()) //nolint:gosec // jitter
}

// recheckDelay is the time to a socket's next access recheck: every ± 20 % around (r in [0, 1)),
// so that the sockets reconnected together after a restart (≈ 6 queries each) spread out.
func recheckDelay(every time.Duration, r float64) time.Duration {
	return time.Duration(float64(every) * (0.8 + 0.4*r))
}

// writeLoop sends the queued frames in order. Updates carry contiguous seqs per document: one at
// or below what the client has is skipped, a gap (a frame lost in Redis, or published before this
// socket subscribed) is filled from the database first.
func (c *conn) writeLoop() {
	if !c.h.prof.BatchAwareness {
		for {
			select {
			case <-c.ctx.Done():
				return
			case f := <-c.out:
				if !c.handle(f) {
					return
				}
			case <-c.kick:
			}
			if c.stale.Swap(false) && !c.catchUp() {
				return
			}
		}
	}

	for {
		// Priority: drain all document updates / control frames from c.out first
		drained := false
		for !drained {
			select {
			case <-c.ctx.Done():
				return
			case f := <-c.out:
				if !c.handle(f) {
					return
				}
				if c.stale.Swap(false) && !c.catchUp() {
					return
				}
			default:
				drained = true
			}
		}

		if c.stale.Swap(false) && !c.catchUp() {
			return
		}

		// When c.out is empty, collect and send all accumulated awareness entries
		if !c.testPauseAwareness.Load() {
			if frame := c.popAwareness(); len(frame) > 0 {
				if !c.send(frame) {
					return
				}
				continue
			}
		}

		// When both are empty, wait for incoming frames or wakeups
		select {
		case <-c.ctx.Done():
			return
		case f := <-c.out:
			if !c.handle(f) {
				return
			}
		case <-c.kick:
		}
		if c.stale.Swap(false) && !c.catchUp() {
			return
		}
	}
}

func (c *conn) handle(f []byte) bool {
	switch f[0] {
	case FrameUpdate:
		seq := FrameSeq(f)
		if seq <= c.lastSent {
			return true
		}
		if seq > c.lastSent+1 {
			if !c.catchUp() {
				return false
			}
			if seq <= c.lastSent {
				return true
			}
		}
		c.lastSent = seq
	case FrameSnapshot:
		c.lastSent = max(c.lastSent, FrameSeq(f))
	}
	return c.send(f)
}

// catchUp sends what the client lacks: the snapshot when it is newer than what was sent (or on
// the first call), then the stored updates after it, read in one repeatable-read transaction so
// that a compaction in between loses nothing.
func (c *conn) catchUp() bool {
	c.h.m.catchUps.Inc()
	var frames [][]byte
	last := c.lastSent
	st := c.h.b
	err := c.h.db.ReadTx(c.ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(c.ctx, "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"); err != nil {
			return err
		}
		q := c.h.db.Q.WithTx(tx)
		seq, err := SnapshotSeq(c.ctx, st, q, c.doc)
		if err != nil {
			return err
		}
		if last < 0 || seq > last {
			through, state, err := LoadSnapshot(c.ctx, st, q, c.doc)
			if err != nil {
				return err
			}
			frames = append(frames, SnapshotFrame(through, state))
			last = through
		}
		return EachUpdate(c.ctx, st, q, c.doc, last, func(seq int64, data []byte) error {
			frames = append(frames, UpdateFrame(seq, data))
			last = seq
			return nil
		})
	})
	if err != nil {
		if c.ctx.Err() == nil {
			slog.Warn(st.Name()+" sync: catch-up", st.LogKey(), c.doc, "err", err)
			c.close(CloseTryAgain, "try again")
		}
		return false
	}
	for _, f := range frames {
		if !c.send(f) {
			return false
		}
	}
	c.lastSent = last
	return true
}

func (c *conn) send(f []byte) bool {
	ctx, cancel := context.WithTimeout(c.ctx, c.h.cfg.WriteTimeout)
	defer cancel()
	if err := c.ws.Write(ctx, websocket.MessageBinary, f); err != nil {
		if c.ctx.Err() == nil {
			slog.Warn("sync: write failed", "doc", c.doc, "err", err)
		}
		c.close(CloseTryAgain, "write failed")
		return false
	}
	return true
}

// readLoop handles the client's frames until the socket ends. A viewer sends none: its first
// data frame (text or binary, any type, before anything of it is looked at) closes it 4013; the
// reads only serve the control frames (pong, close).
func (c *conn) readLoop() {
	if c.viewer != nil {
		if _, _, err := c.ws.Read(c.ctx); err == nil {
			c.close(CloseReceiveOnly, "receive only")
		}
		return
	}
	defer c.endAwareness()
	for {
		typ, b, err := c.ws.Read(c.ctx)
		if err != nil {
			return
		}
		if typ != websocket.MessageBinary || len(b) == 0 {
			c.close(CloseBadFrame, "binary frames expected")
			return
		}
		var ok bool
		switch b[0] {
		case FrameUpdate:
			ok = c.onUpdate(b)
		case FrameAwareness:
			ok = c.onAwareness(b)
		case FrameSnapshotPost:
			ok = c.onSnapshot(b)
		default:
			c.close(CloseBadFrame, "unexpected frame")
			return
		}
		if !ok {
			return
		}
	}
}

// onUpdate stores one Yjs update under the document's next seq, echoes it to the sender with
// that seq and relays it to every other socket of the document.
func (c *conn) onUpdate(b []byte) bool {
	if !c.write.Load() {
		c.close(CloseForbidden, "read only")
		return false
	}
	if len(b) <= headerSeq || len(b)-headerSeq > MaxUpdate {
		c.close(CloseBadFrame, "bad update")
		return false
	}
	// Without the byte budget only the frame bucket counts, as the Wiki's relay did.
	if !c.updates.take() || (c.h.prof.ByteBudget && !c.updateBytes.takeN(float64(len(b)-headerSeq))) {
		c.close(CloseRate, "rate limited")
		return false
	}
	// Without the ceiling every update is stored, as the Wiki's relay did.
	if c.h.prof.Ceiling {
		switch c.admitUpdate(len(b) - headerSeq) {
		case admitDrop:
			return true
		case admitClose:
			return false
		}
	}
	data := bytes.Clone(b[headerSeq:])
	seq, err := db.GuardValue(c.ctx, c.h.db, func(q *sqlc.Queries) (int64, error) {
		return c.h.b.AppendUpdate(c.ctx, q, c.doc, data, &c.id.UserID)
	})
	if db.IsNotFound(err) {
		c.close(CloseNotFound, "the "+c.h.b.Noun()+" is gone or in the trash")
		return false
	}
	if err != nil {
		if c.ctx.Err() == nil {
			slog.Warn(c.h.b.Name()+" sync: append", c.h.b.LogKey(), c.doc, "err", err)
			c.close(CloseTryAgain, "try again")
		}
		return false
	}
	if c.h.prof.Ceiling { // the ceiling's count of the backlog
		c.h.noteStored(c.doc, len(data))
	}
	f := UpdateFrame(seq, data)
	c.enqueue(f)
	c.h.broadcast(c.ctx, c.doc, c, f)
	c.maybeCompact()
	return true
}

type admission int

const (
	admitStore admission = iota // below the ceiling: store it
	admitDrop                   // at the ceiling: refused, the socket stays
	admitClose                  // at the ceiling for CeilingGrace: the socket is closed 4012
)

// admitUpdate is the hard ceiling of the updates after the snapshot (Config.CeilingUpdates /
// CeilingBytes). At it an UPDATE is neither stored nor relayed (the client still holds it; the
// package doc says how it is delivered), every socket with WRITE is asked to compact
// (COMPACT_REQUEST, at most once per CompactCooldown per document across instances) and a socket
// still sending CeilingGrace after the first refusal of a run is closed 4012 (a run ends after
// 2 × CeilingGrace without a refusal: a socket refused long ago gets the whole grace again). The
// ceiling lifts by itself when a snapshot removes enough updates (seen by the next database read
// of the room's count).
func (c *conn) admitUpdate(size int) admission {
	h := c.h
	updates, total, err := h.docStats(c.ctx, c.doc)
	if err != nil || (updates < int64(h.cfg.CeilingUpdates) && total+int64(size) <= h.cfg.CeilingBytes) {
		// A failing count is not a reason to refuse: the append reports a database failure itself.
		if c.refused.Load() {
			// This update may build on the refused ones, which the others never got: storing it
			// would leave it pending on every replica. The reconnect's replay resends them all.
			c.close(CloseResend, "the update ceiling is lifted: resend")
			return admitClose
		}
		return admitStore
	}
	now := time.Now()
	if c.overSince.IsZero() || now.Sub(c.lastOver) > 2*h.cfg.CeilingGrace {
		c.overSince = now
	}
	c.lastOver = now
	if now.Sub(c.overSince) >= h.cfg.CeilingGrace {
		c.close(CloseCeiling, "the document is over its update ceiling: compact it")
		return admitClose
	}
	c.refused.Store(true)
	h.m.dropCeiling.Inc()
	set, err := h.rc.Do(c.ctx, h.rc.B().Set().Key(redisx.Key(h.b.Name()+":ceiling:"+c.doc.String())).Value("1").Nx().
		Px(h.cfg.CompactCooldown).Build()).AsBool()
	if (err == nil || rueidis.IsRedisNil(err)) && set {
		h.m.ceilingHits.Inc()
		//nolint:gosec // G706: the section name, ids and counts only (a viewer's slots carry its client IP, never logged)
		slog.Warn(h.b.Name()+" sync: update ceiling reached", h.b.LogKey(), c.doc, "updates", updates, "bytes", total, "user_id", c.id.UserID)
		h.broadcast(c.ctx, c.doc, nil, []byte{FrameCompact})
	}
	return admitDrop
}

// maybeCompact asks the sender for a snapshot when the updates after the stored one exceed the
// thresholds, at most once per CompactCooldown per document across instances.
func (c *conn) maybeCompact() {
	h := c.h
	if !h.shouldCheckCompact(c.doc) {
		return
	}
	q := h.db.Q
	seq, err := SnapshotSeq(c.ctx, h.b, q, c.doc)
	if err != nil {
		return
	}
	st, err := h.b.UpdatesSince(c.ctx, q, c.doc, seq)
	if err != nil || (st.Updates <= int32(h.cfg.CompactUpdates) && st.Bytes <= h.cfg.CompactBytes) { //nolint:gosec // small config
		return
	}
	set, err := h.rc.Do(c.ctx, h.rc.B().Set().Key(redisx.Key(h.b.Name()+":compact:"+c.doc.String())).Value("1").Nx().
		Px(h.cfg.CompactCooldown).Build()).AsBool()
	if err != nil && !rueidis.IsRedisNil(err) {
		return
	}
	if set {
		c.enqueue([]byte{FrameCompact})
	}
}

// onAwareness relays a cursor / presence update to the other sockets of the document (never
// stored); a read-only socket's is dropped. Over the budget the frame is dropped, or with
// Profile.CoalesceAwareness the newest frame waits for the next token and replaces any older one
// waiting (a client sends its whole state each time), so the last state — the final view, the new
// selection — always arrives, and a flood still relays no more than the budget. b is the reader's
// own (ws.Read allocates every message).
func (c *conn) onAwareness(b []byte) bool {
	if !c.write.Load() || len(b) > 1+MaxUpdate {
		return true
	}

	var entries []awarenessEntry
	// Farewell frames (state null) bypass the budget so peers immediately learn the client left.
	if bytes.Contains(b[1:], []byte("null")) {
		if !c.h.prof.BatchAwareness {
			if es, err := parseAwarenessUpdate(b[1:]); err == nil && isFarewell(es) {
				c.parsedAwareness.Add(1)
				if c.clientID.Load() == 0 && len(es) > 0 {
					c.clientID.Store(es[0].clientID)
				}
				c.h.broadcast(c.ctx, c.doc, c, b)
				return true
			}
		} else if es, ok := c.parseAwareness(b); ok {
			// Canvas: only the socket's own farewell, and only a few per FarewellWindow, goes at once;
			// anything else takes the ordinary way below, with the entries already parsed.
			entries = es
			if isFarewell(es) && c.ownOnly(es) && c.farewells.take() {
				c.h.broadcastAwarenessImmediate(c.ctx, c.doc, c, b)
				return true
			}
		}
	}

	c.awMu.Lock()
	switch {
	case c.awPending != nil:
		c.h.m.dropAwareness.Inc()
		c.awPending, c.awPendEnt = b, entries
		c.awMu.Unlock()
	case c.awareness.take():
		c.awMu.Unlock()
		c.forwardAwareness(b, entries, false)
	case !c.h.prof.CoalesceAwareness: // over the budget: dropped, as the Wiki's relay did
		c.h.m.dropAwareness.Inc()
		c.awMu.Unlock()
	default:
		c.awPending, c.awPendEnt = b, entries
		c.awTimer = time.AfterFunc(c.awareness.wait(), c.flushAwareness)
		c.awMu.Unlock()
	}
	return true
}

// parseAwareness parses a frame once (Canvas profile) and remembers the socket's clientID from
// its first frame; ok is false for a malformed or empty one.
func (c *conn) parseAwareness(b []byte) ([]awarenessEntry, bool) {
	entries, err := parseAwarenessUpdate(b[1:])
	if err != nil || len(entries) == 0 {
		return nil, false
	}
	c.parsedAwareness.Add(1)
	if c.clientID.Load() == 0 {
		c.clientID.Store(entries[0].clientID)
	}
	return entries, true
}

// ownOnly reports whether every entry belongs to the socket's own clientID.
func (c *conn) ownOnly(entries []awarenessEntry) bool {
	cid := c.clientID.Load()
	for _, e := range entries {
		if e.clientID != cid {
			return false
		}
	}
	return cid != 0
}

// forwardAwareness relays a frame that passed the budget; entries are its parsed form (nil: not
// parsed yet). With Profile.BatchAwareness it joins the window batch; only final (the closing
// socket's last frame, endAwareness) sends a farewell at once.
func (c *conn) forwardAwareness(b []byte, entries []awarenessEntry, final bool) {
	if !c.h.prof.BatchAwareness {
		c.h.broadcast(c.ctx, c.doc, c, b)
		return
	}
	if entries == nil {
		var ok bool
		if entries, ok = c.parseAwareness(b); !ok {
			c.h.broadcast(c.ctx, c.doc, c, b)
			return
		}
	}
	if final && isFarewell(entries) {
		c.h.broadcastAwarenessImmediate(c.ctx, c.doc, c, b)
		return
	}
	c.h.enqueueAwareness(c.doc, entries)
}

// flushAwareness sends the waiting awareness frame when its token is there (awTimer).
func (c *conn) flushAwareness() {
	c.awMu.Lock()
	if c.awPending == nil || c.ctx.Err() != nil {
		c.awMu.Unlock()
		return // nothing, or the socket is ending: endAwareness sends it
	}
	if !c.write.Load() { // read-only since
		c.awPending, c.awPendEnt = nil, nil
		c.awMu.Unlock()
		return
	}
	if !c.awareness.take() { // early by a rounding: wait again
		c.awTimer = time.AfterFunc(c.awareness.wait(), c.flushAwareness)
		c.awMu.Unlock()
		return
	}
	f, ent := c.awPending, c.awPendEnt
	c.awPending, c.awPendEnt = nil, nil
	c.awMu.Unlock()
	c.forwardAwareness(f, ent, false)
}

// endAwareness sends the waiting awareness frame of a socket that is ending, over the budget: it
// is often the farewell (the client's own state removed before it closes), and peers would show a
// ghost cursor until their timeout without it.
func (c *conn) endAwareness() {
	c.awMu.Lock()
	if c.awTimer != nil {
		c.awTimer.Stop()
	}
	f, ent := c.awPending, c.awPendEnt
	c.awPending, c.awPendEnt = nil, nil
	c.awMu.Unlock()
	if f != nil && c.write.Load() {
		c.forwardAwareness(f, ent, true)
	}
}

// onSnapshot handles a SNAPSHOT_POST (ADR-0096 §4): the Backend stores it in one transaction.
// Nothing is sent back. With meta.broadcast (changes no update carried: a transaction too big
// for one frame) the other sockets of the document get the state as a SNAPSHOT; a stale one
// (through below the stored snapshot, or past the counter) is not stored but still relayed, with
// through 0 so that no socket's position moves, and the poster is asked for a fresh snapshot.
// The post of a socket with refused updates (conn.refused) is relayed the same way, and when stored
// (under a seq of its own, StoreSnapshot) the poster gets that seq as an empty UPDATE. With
// Profile.Ceiling a stored snapshot tells every instance (ctlCompacted).
func (c *conn) onSnapshot(b []byte) bool {
	if !c.write.Load() {
		c.close(CloseForbidden, "read only")
		return false
	}
	if !c.snapshots.take() {
		c.close(CloseRate, "rate limited")
		return false
	}
	if len(b) < headerPost {
		c.close(CloseBadFrame, "bad snapshot")
		return false
	}
	through := FrameSeq(b)
	mlen := int(binary.BigEndian.Uint32(b[9:13]))
	if mlen > MaxMeta || headerPost+mlen > len(b) {
		c.close(CloseBadFrame, "bad snapshot")
		return false
	}
	meta, broadcast, err := c.h.b.DecodeMeta(b[headerPost : headerPost+mlen])
	if err != nil {
		c.close(CloseBadFrame, "bad snapshot meta")
		return false
	}
	state := bytes.Clone(b[headerPost+mlen:])
	if len(state) == 0 || len(state) > c.h.b.MaxState() {
		return true // the client warns about a document over the limit; nothing is stored
	}
	refused := c.refused.Load()
	res, err := c.h.b.PostSnapshot(c.ctx, Post{Doc: c.doc, Through: through, Meta: meta, State: state, By: c.id.UserID,
		VersionEvery: c.h.cfg.VersionEvery, Refused: refused})
	if err != nil {
		switch {
		case errors.Is(err, ErrGone):
			c.close(CloseNotFound, "the "+c.h.b.Noun()+" is gone or in the trash")
		case errors.Is(err, ErrBadMeta):
			c.close(CloseBadFrame, "bad snapshot meta")
		case c.ctx.Err() == nil:
			//nolint:gosec // G706: the section name, the document id and a database error only
			slog.Warn(c.h.b.Name()+" sync: snapshot", c.h.b.LogKey(), c.doc, "err", err)
			c.close(CloseTryAgain, "try again")
		}
		return false
	}
	if res.Stored {
		c.h.noteCompacted(c.doc)
		if refused {
			c.refused.Store(false)
			c.overSince, c.lastOver = time.Time{}, time.Time{}
		}
	}
	switch {
	case res.Stored && refused:
		c.h.broadcast(c.ctx, c.doc, c, SnapshotFrame(res.Through, state))
		c.enqueue(UpdateFrame(res.Through, EmptyState)) // the poster's position, not its own state back
	case res.Stored && broadcast:
		c.h.broadcast(c.ctx, c.doc, c, SnapshotFrame(res.Through, state))
	case !res.Stored && (broadcast || refused):
		c.h.broadcast(c.ctx, c.doc, c, SnapshotFrame(0, state))
		c.enqueue([]byte{FrameCompact})
	}
	// Without the ceiling nothing listens for it: no control message beyond the Wiki relay's own.
	if res.Stored && c.h.prof.Ceiling {
		c.h.broadcast(c.ctx, c.doc, c, []byte{ctlCompacted})
	}
	if res.After != nil {
		res.After()
	}
	return true
}

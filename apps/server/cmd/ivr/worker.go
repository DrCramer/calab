package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/pion/webrtc/v4"

	"github.com/calaba/calaba/server/internal/ivrwire"
)

// worker holds the API connection and the calls it is in.
type worker struct {
	cfg      config
	cache    *cache
	ringback *clip // nil: the ringback plays as silence

	mu    sync.Mutex
	calls map[string]*call
	out   chan ivrwire.Event // the current API session's outbox; nil while disconnected
}

func newWorker(cfg config) *worker {
	w := &worker{cfg: cfg, cache: newCache(cfg.cacheDir, cfg.apiURL, cfg.token), calls: map[string]*call{}}
	if b, err := os.ReadFile(cfg.ringbackPath); err != nil {
		slog.Warn("ivr: no ringback tone, the caller hears silence while it rings", "path", cfg.ringbackPath, "err", err)
	} else if c, err := decodeOgg(b); err != nil {
		slog.Warn("ivr: bad ringback tone", "path", cfg.ringbackPath, "err", err)
	} else {
		w.ringback = c
	}
	return w
}

// emit sends an event to the API (dropped while disconnected: the API's deadlines cover it).
func (w *worker) emit(ev ivrwire.Event) {
	w.mu.Lock()
	out := w.out
	w.mu.Unlock()
	if out == nil {
		return
	}
	select {
	case out <- ev:
	default:
		slog.Warn("ivr: event queue full, dropped", "op", ev.Op, "call", ev.Call)
	}
}

// run keeps a session to the API until ctx ends, reconnecting with backoff.
func (w *worker) run(ctx context.Context) {
	backoff := time.Second
	for ctx.Err() == nil {
		start := time.Now()
		err := w.session(ctx)
		if ctx.Err() != nil {
			return
		}
		if time.Since(start) > time.Minute {
			backoff = time.Second
		}
		slog.Warn("ivr: API connection lost, reconnecting", "err", err, "in", backoff)
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, 30*time.Second)
	}
}

func agentURL(api string) string {
	if rest, ok := strings.CutPrefix(api, "https://"); ok {
		return "wss://" + rest + ivrwire.AgentPath
	}
	return "ws://" + strings.TrimPrefix(api, "http://") + ivrwire.AgentPath
}

func (w *worker) session(ctx context.Context) error {
	dctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	ws, resp, err := websocket.Dial(dctx, agentURL(w.cfg.apiURL), &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": []string{"Bearer " + w.cfg.token}},
	})
	cancel()
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		return err
	}
	defer func() { _ = ws.CloseNow() }()
	ws.SetReadLimit(ivrwire.MaxFrame)
	sctx, stop := context.WithCancel(ctx)
	defer stop()
	out := make(chan ivrwire.Event, 256)
	w.mu.Lock()
	w.out = out
	held := make([]string, 0, len(w.calls))
	for id := range w.calls {
		held = append(held, id)
	}
	w.mu.Unlock()
	defer func() {
		w.mu.Lock()
		if w.out == out {
			w.out = nil
		}
		w.mu.Unlock()
	}()
	slog.Info("ivr: connected to the API", "calls", len(held))
	go func() {
		for {
			select {
			case <-sctx.Done():
				return
			case ev := <-out:
				b, _ := json.Marshal(ev)
				wctx, cancel := context.WithTimeout(sctx, 5*time.Second)
				err := ws.Write(wctx, websocket.MessageText, b)
				cancel()
				if err != nil {
					stop()
					return
				}
			}
		}
	}()
	w.emit(ivrwire.Event{Op: ivrwire.OpHello, Calls: held})
	for {
		typ, b, err := ws.Read(sctx)
		if err != nil {
			return err
		}
		if typ != websocket.MessageText {
			continue
		}
		var c ivrwire.Command
		if err := json.Unmarshal(b, &c); err != nil || c.Call == "" {
			slog.Warn("ivr: bad command frame", "err", err)
			continue
		}
		w.dispatch(c)
	}
}

// dispatch hands a command to its call's queue (one goroutine per call keeps their order; a
// slow join of one call never holds up another).
func (w *worker) dispatch(c ivrwire.Command) {
	w.mu.Lock()
	cl, ok := w.calls[c.Call]
	if !ok {
		if c.Op != ivrwire.OpJoin {
			w.mu.Unlock()
			if c.Op != ivrwire.OpLeave {
				w.emit(ivrwire.Event{Op: ivrwire.OpError, Call: c.Call, Error: "not in this call"})
			}
			return
		}
		cl = &call{id: c.Call, w: w, cmds: make(chan ivrwire.Command, 32), p: &player{}}
		w.calls[c.Call] = cl
		go cl.loop()
	}
	w.mu.Unlock()
	select {
	case cl.cmds <- c:
	default:
		slog.Warn("ivr: call command queue full", "call", c.Call, "op", c.Op)
	}
}

func (w *worker) forget(cl *call) {
	w.mu.Lock()
	if w.calls[cl.id] == cl {
		delete(w.calls, cl.id)
	}
	w.mu.Unlock()
}

func (w *worker) closeAll() {
	w.mu.Lock()
	all := make([]*call, 0, len(w.calls))
	for _, c := range w.calls {
		all = append(all, c)
	}
	w.mu.Unlock()
	for _, c := range all {
		c.disconnect()
	}
}

// call is the worker in one call's room.
type call struct {
	id   string
	w    *worker
	cmds chan ivrwire.Command
	p    *player

	mu   sync.Mutex
	room *lksdk.Room
	gone bool
}

func (c *call) loop() {
	for cmd := range c.cmds {
		switch cmd.Op {
		case ivrwire.OpJoin:
			if err := c.join(cmd.Room, cmd.Token); err != nil {
				slog.Warn("ivr: join", "call", c.id, "err", err)
				c.w.emit(ivrwire.Event{Op: ivrwire.OpError, Call: c.id, Error: "join: " + err.Error()})
				c.w.forget(c)
				return
			}
			c.w.emit(ivrwire.Event{Op: ivrwire.OpJoined, Call: c.id})
		case ivrwire.OpPlay:
			if err := c.play(cmd.Play); err != nil {
				slog.Warn("ivr: play", "call", c.id, "err", err)
				c.w.emit(ivrwire.Event{Op: ivrwire.OpError, Call: c.id, Error: "play: " + err.Error()})
			}
		case ivrwire.OpStop:
			c.p.stop()
		case ivrwire.OpLeave:
			c.disconnect()
			c.w.forget(c)
			c.w.emit(ivrwire.Event{Op: ivrwire.OpLeft, Call: c.id})
			return
		}
	}
}

func (c *call) join(room, token string) error {
	cb := lksdk.NewRoomCallback()
	cb.OnDataPacket = func(data lksdk.DataPacket, _ lksdk.DataReceiveParams) {
		if d, ok := data.(*livekit.SipDTMF); ok && d.GetDigit() != "" {
			c.w.emit(ivrwire.Event{Op: ivrwire.OpDTMF, Call: c.id, Digit: d.GetDigit()})
		}
	}
	cb.OnDisconnected = func() {
		c.mu.Lock()
		gone := c.gone
		c.gone = true
		c.mu.Unlock()
		if !gone { // the room closed or the connection broke (not our leave)
			c.w.forget(c)
			c.w.emit(ivrwire.Event{Op: ivrwire.OpLeft, Call: c.id})
		}
	}
	// Listening to nothing: the worker never decodes audio, it only plays and reads data.
	r, err := lksdk.ConnectToRoomWithToken(c.w.cfg.livekitURL, token, cb, lksdk.WithAutoSubscribe(false))
	if err != nil {
		return err
	}
	track, err := lksdk.NewLocalSampleTrack(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2,
		SDPFmtpLine: "minptime=10;useinbandfec=1"})
	if err != nil {
		r.Disconnect()
		return err
	}
	track.OnBind(func() {
		if err := track.StartWrite(c.p, nil); err != nil {
			slog.Warn("ivr: start audio", "call", c.id, "err", err)
		}
	})
	if _, err := r.LocalParticipant.PublishTrack(track, &lksdk.TrackPublicationOptions{Name: "ivr", Source: livekit.TrackSource_MICROPHONE}); err != nil {
		r.Disconnect()
		return err
	}
	c.mu.Lock()
	c.room = r
	c.mu.Unlock()
	slog.Info("ivr: joined", "call", c.id, "room", room)
	return nil
}

func (c *call) play(p *ivrwire.Play) error {
	if p == nil {
		c.p.stop()
		return nil
	}
	var cl *clip
	switch {
	case p.Builtin == ivrwire.BuiltinRingback:
		if c.w.ringback == nil {
			c.p.stop()
			return nil
		}
		cl = c.w.ringback
	case p.FileID != "":
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		b, err := c.w.cache.get(ctx, p.FileID)
		cancel()
		if err != nil {
			return err
		}
		if cl, err = decodeOgg(b); err != nil {
			return err
		}
	default:
		c.p.stop()
		return nil
	}
	var done func()
	if !p.Loop {
		done = func() { c.w.emit(ivrwire.Event{Op: ivrwire.OpPlayed, Call: c.id}) }
	}
	c.p.play(cl, p.Loop, done)
	return nil
}

func (c *call) disconnect() {
	c.p.stop()
	c.mu.Lock()
	r := c.room
	c.room, c.gone = nil, true
	c.mu.Unlock()
	if r != nil {
		r.Disconnect()
	}
}

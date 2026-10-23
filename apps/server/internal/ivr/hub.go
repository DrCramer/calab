// Package ivr is the API's end of the IVR worker (ADR-0117 §2, cmd/ivr): the worker's outgoing
// WebSocket GET /api/internal/ivr-agent and its prompt downloads, both authenticated with the
// shared IVR_AGENT_TOKEN. It implements rtc.IVRAgent for the telephony service and hands the
// worker's events back to it; it knows nothing of routes.
//
// Several API replicas: the replica holding the socket keeps the Valkey key ivr:agent alive
// (Available) and every replica subscribes to the channel ivr:cmd; a command is always
// published there, and the holder writes it to the socket. One worker at a time: a new
// connection to a replica replaces its older one.
package ivr

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/redis/rueidis"

	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/ivrwire"
	"github.com/calaba/calaba/server/internal/redisx"
	"github.com/calaba/calaba/server/internal/rtc"
)

const (
	presenceTTL   = 15 * time.Second
	heartbeat     = 5 * time.Second
	writeTimeout  = 5 * time.Second
	commandBuffer = 64
)

func agentKey() string   { return redisx.Key("ivr:agent") }
func cmdChannel() string { return redisx.Channel("ivr:cmd") }

// ErrUnavailable means no worker is connected.
var ErrUnavailable = errors.New("ivr: no worker connected")

// PromptFile opens a voice menu prompt by id (Ogg/Opus); ok=false: no such prompt.
type PromptFile func(ctx context.Context, id uuid.UUID) (rc io.ReadSeekCloser, modTime time.Time, ok bool, err error)

// Hub is the worker's endpoint on one API replica.
type Hub struct {
	redis    rueidis.Client
	token    string
	instance string
	// OnEvent receives the worker's events (the telephony service); set before Run.
	OnEvent func(ctx context.Context, ev ivrwire.Event)
	// Prompt serves prompt downloads; set before Routes are used.
	Prompt PromptFile

	mu   sync.Mutex
	conn *agentConn
}

type agentConn struct {
	ws  *websocket.Conn
	out chan []byte
}

// New creates the hub; token "" = the worker endpoints answer 404 and nothing is available.
func New(r rueidis.Client, token string) *Hub {
	return &Hub{redis: r, token: token, instance: uuid.NewString()}
}

var _ rtc.IVRAgent = (*Hub)(nil)

// Configured reports whether the server has a worker token.
func (h *Hub) Configured() bool { return h.token != "" }

// Routes registers the worker's endpoints (no user authentication: the worker's token).
func (h *Hub) Routes(mux httpx.Router) {
	mux.Handle("GET "+ivrwire.AgentPath, http.HandlerFunc(h.serveAgent))
	mux.Handle("GET "+ivrwire.FilesPath+"{id}", httpx.HandlerFunc(h.serveFile))
}

// authorized checks the bearer token in constant time.
func (h *Hub) authorized(r *http.Request) bool {
	if h.token == "" {
		return false
	}
	got, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	return ok && subtle.ConstantTimeCompare([]byte(got), []byte(h.token)) == 1
}

func (h *Hub) serveFile(w http.ResponseWriter, r *http.Request) error {
	if !h.authorized(r) || h.Prompt == nil {
		return httpx.NotFound("file")
	}
	id, err := httpx.PathUUID(r, "id", "file")
	if err != nil {
		return err
	}
	rc, mod, ok, err := h.Prompt(r.Context(), id)
	if err != nil {
		return err
	}
	if !ok {
		return httpx.NotFound("file")
	}
	defer func() { _ = rc.Close() }()
	w.Header().Set("Content-Type", "audio/ogg")
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	http.ServeContent(w, r, "", mod, rc)
	return nil
}

func (h *Hub) serveAgent(w http.ResponseWriter, r *http.Request) {
	if !h.authorized(r) {
		http.NotFound(w, r)
		return
	}
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true, // not a browser: the bearer token authenticates
		CompressionMode:    websocket.CompressionDisabled,
	})
	if err != nil {
		return
	}
	ws.SetReadLimit(ivrwire.MaxFrame)
	c := &agentConn{ws: ws, out: make(chan []byte, commandBuffer)}
	h.mu.Lock()
	old := h.conn
	h.conn = c
	h.mu.Unlock()
	if old != nil {
		_ = old.ws.Close(websocket.StatusPolicyViolation, "replaced by a newer worker connection")
	}
	slog.InfoContext(r.Context(), "ivr: worker connected", "remote", r.RemoteAddr)
	ctx, cancel := context.WithCancel(context.WithoutCancel(r.Context()))
	defer cancel()
	go h.keepAlive(ctx, c)
	go h.writeLoop(ctx, c)
	h.readLoop(ctx, c)
	cancel()
	h.mu.Lock()
	if h.conn == c {
		h.conn = nil
		h.mu.Unlock()
		h.dropPresence(context.WithoutCancel(r.Context()))
	} else {
		h.mu.Unlock()
	}
	_ = ws.CloseNow()
	slog.InfoContext(r.Context(), "ivr: worker disconnected")
}

func (h *Hub) readLoop(ctx context.Context, c *agentConn) {
	for {
		typ, b, err := c.ws.Read(ctx)
		if err != nil {
			return
		}
		if typ != websocket.MessageText {
			continue
		}
		var ev ivrwire.Event
		if err := json.Unmarshal(b, &ev); err != nil {
			slog.WarnContext(ctx, "ivr: bad event frame", "err", err)
			continue
		}
		if h.OnEvent != nil {
			h.OnEvent(events.WithBudget(ctx, events.RequestBudget), ev)
		}
	}
}

func (h *Hub) writeLoop(ctx context.Context, c *agentConn) {
	for {
		select {
		case <-ctx.Done():
			return
		case b := <-c.out:
			wctx, cancel := context.WithTimeout(ctx, writeTimeout)
			err := c.ws.Write(wctx, websocket.MessageText, b)
			cancel()
			if err != nil {
				_ = c.ws.CloseNow()
				return
			}
		}
	}
}

// keepAlive renews ivr:agent while the socket lives and pings the worker.
func (h *Hub) keepAlive(ctx context.Context, c *agentConn) {
	t := time.NewTicker(heartbeat)
	defer t.Stop()
	for {
		if err := h.redis.Do(ctx, h.redis.B().Set().Key(agentKey()).Value(h.instance).Ex(presenceTTL).Build()).Error(); err != nil && ctx.Err() == nil {
			slog.WarnContext(ctx, "ivr: renew presence", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		pctx, cancel := context.WithTimeout(ctx, writeTimeout)
		err := c.ws.Ping(pctx)
		cancel()
		if err != nil && ctx.Err() == nil {
			_ = c.ws.CloseNow()
			return
		}
	}
}

var dropScript = rueidis.NewLuaScript(`if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`)

func (h *Hub) dropPresence(ctx context.Context) {
	ctx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	if err := dropScript.Exec(ctx, h.redis, []string{agentKey()}, []string{h.instance}).Error(); err != nil {
		slog.WarnContext(ctx, "ivr: drop presence", "err", err)
	}
}

// Run delivers published commands to this replica's worker socket until ctx ends.
func (h *Hub) Run(ctx context.Context) {
	if h.token == "" {
		return
	}
	for ctx.Err() == nil {
		err := h.redis.Receive(ctx, h.redis.B().Subscribe().Channel(cmdChannel()).Build(), func(m rueidis.PubSubMessage) {
			h.mu.Lock()
			c := h.conn
			h.mu.Unlock()
			if c == nil {
				return
			}
			select {
			case c.out <- []byte(m.Message):
			default:
				slog.WarnContext(ctx, "ivr: worker command queue full, dropped")
			}
		})
		if ctx.Err() != nil {
			return
		}
		slog.WarnContext(ctx, "ivr: command subscription lost, retrying", "err", err)
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Second):
		}
	}
}

// Available implements rtc.IVRAgent.
func (h *Hub) Available(ctx context.Context) bool {
	if h.token == "" {
		return false
	}
	n, err := h.redis.Do(ctx, h.redis.B().Exists().Key(agentKey()).Build()).AsInt64()
	return err == nil && n > 0
}

func (h *Hub) send(ctx context.Context, c ivrwire.Command) error {
	if h.token == "" {
		return ErrUnavailable
	}
	b, err := json.Marshal(c)
	if err != nil {
		return err
	}
	ctx, done := events.Detached(ctx, writeTimeout)
	defer done()
	return h.redis.Do(ctx, h.redis.B().Publish().Channel(cmdChannel()).Message(string(b)).Build()).Error()
}

// Join implements rtc.IVRAgent.
func (h *Hub) Join(ctx context.Context, call uuid.UUID, room, token string) error {
	return h.send(ctx, ivrwire.Command{Op: ivrwire.OpJoin, Call: call.String(), Room: room, Token: token})
}

// Play implements rtc.IVRAgent.
func (h *Hub) Play(ctx context.Context, call uuid.UUID, p rtc.IVRPlay) error {
	return h.send(ctx, ivrwire.Command{Op: ivrwire.OpPlay, Call: call.String(), Play: &p})
}

// Stop implements rtc.IVRAgent.
func (h *Hub) Stop(ctx context.Context, call uuid.UUID) error {
	return h.send(ctx, ivrwire.Command{Op: ivrwire.OpStop, Call: call.String()})
}

// Leave implements rtc.IVRAgent.
func (h *Hub) Leave(ctx context.Context, call uuid.UUID) error {
	return h.send(ctx, ivrwire.Command{Op: ivrwire.OpLeave, Call: call.String()})
}

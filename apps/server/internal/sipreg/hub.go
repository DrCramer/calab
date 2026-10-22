// Package sipreg is the API's end of the SIP registration agent (ADR-0121, cmd/sipreg): the
// agent's outgoing WebSocket GET /api/internal/sipreg-agent, authenticated with its own
// SIPREG_AGENT_TOKEN (not the IVR worker's: this agent gets the providers' passwords). On the
// agent's hello the hub sends the snapshot of every account to register; later changes of one
// workspace go out as account_set / account_del. The agent's events go to the telephony
// service. The hub knows nothing of rights or routes.
//
// Several API replicas: the replica holding the socket keeps the Valkey key sipreg:agent alive
// (Available). A change on any replica is published to the channel sipreg:cmd as the workspace
// id alone; the holder re-reads that account and writes it to the socket — the passwords are
// decrypted only by the replica that writes them and never pass through Valkey.
package sipreg

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
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
	"github.com/calaba/calaba/server/internal/redisx"
	"github.com/calaba/calaba/server/internal/sipregwire"
)

const (
	presenceTTL   = 15 * time.Second
	heartbeat     = 5 * time.Second
	writeTimeout  = 5 * time.Second
	commandBuffer = 64
)

func agentKey() string   { return redisx.Key("sipreg:agent") }
func cmdChannel() string { return redisx.Channel("sipreg:cmd") }

// Source is what the hub sends the agent: the telephony service.
type Source interface {
	// RegAccounts: every account in REGISTER mode with live inbound calls.
	RegAccounts(ctx context.Context) ([]sipregwire.Account, error)
	// RegAccount: the workspace's account; ok = false: nothing to register (unregister it).
	RegAccount(ctx context.Context, ws uuid.UUID) (a sipregwire.Account, ok bool, err error)
}

// Hub is the agent's endpoint on one API replica.
type Hub struct {
	redis    rueidis.Client
	token    string
	instance string
	// Source and OnEvent: the telephony service; set before Routes / Run are used.
	Source  Source
	OnEvent func(ctx context.Context, ev sipregwire.Event)

	mu   sync.Mutex
	conn *agentConn
}

type agentConn struct {
	ws  *websocket.Conn
	out chan []byte
}

// New creates the hub; token "" = the endpoint answers 404 and the agent is never available.
func New(r rueidis.Client, token string) *Hub {
	return &Hub{redis: r, token: token, instance: uuid.NewString()}
}

// Configured reports whether the server has an agent token.
func (h *Hub) Configured() bool { return h.token != "" }

// Routes registers the agent's endpoint (no user authentication: the agent's token).
func (h *Hub) Routes(mux httpx.Router) {
	mux.Handle("GET "+sipregwire.AgentPath, http.HandlerFunc(h.serveAgent))
}

func (h *Hub) authorized(r *http.Request) bool {
	if h.token == "" {
		return false
	}
	got, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	return ok && subtle.ConstantTimeCompare([]byte(got), []byte(h.token)) == 1
}

func (h *Hub) serveAgent(w http.ResponseWriter, r *http.Request) {
	if !h.authorized(r) || h.Source == nil {
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
	ws.SetReadLimit(sipregwire.MaxFrame)
	c := &agentConn{ws: ws, out: make(chan []byte, commandBuffer)}
	h.mu.Lock()
	old := h.conn
	h.conn = c
	h.mu.Unlock()
	if old != nil {
		_ = old.ws.Close(websocket.StatusPolicyViolation, "replaced by a newer agent connection")
	}
	slog.InfoContext(r.Context(), "sipreg: agent connected", "remote", r.RemoteAddr)
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
	slog.InfoContext(r.Context(), "sipreg: agent disconnected")
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
		var ev sipregwire.Event
		if err := json.Unmarshal(b, &ev); err != nil {
			slog.WarnContext(ctx, "sipreg: bad event frame", "err", err)
			continue
		}
		if ev.Op == sipregwire.OpHello {
			h.sendSnapshot(ctx, c)
			continue
		}
		if h.OnEvent != nil {
			h.OnEvent(events.WithBudget(ctx, events.RequestBudget), ev)
		}
	}
}

// sendSnapshot answers the agent's hello with every account (on this replica only).
func (h *Hub) sendSnapshot(ctx context.Context, c *agentConn) {
	accs, err := h.Source.RegAccounts(ctx)
	if err != nil {
		slog.WarnContext(ctx, "sipreg: snapshot", "err", err)
		_ = c.ws.Close(websocket.StatusTryAgainLater, "snapshot failed")
		return
	}
	if accs == nil {
		accs = []sipregwire.Account{}
	}
	h.enqueue(ctx, c, sipregwire.Command{Op: sipregwire.OpSnapshot, Accounts: accs})
	slog.InfoContext(ctx, "sipreg: snapshot sent", "accounts", len(accs))
}

func (h *Hub) enqueue(ctx context.Context, c *agentConn, cmd sipregwire.Command) {
	b, err := json.Marshal(cmd)
	if err != nil {
		return
	}
	select {
	case c.out <- b:
	default:
		// A lost delta would leave a stale registration: reconnecting makes a fresh snapshot.
		slog.WarnContext(ctx, "sipreg: agent queue full, reconnecting it")
		_ = c.ws.Close(websocket.StatusTryAgainLater, "queue full")
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

// keepAlive renews sipreg:agent while the socket lives and pings the agent.
func (h *Hub) keepAlive(ctx context.Context, c *agentConn) {
	t := time.NewTicker(heartbeat)
	defer t.Stop()
	for {
		if h.redis != nil {
			if err := h.redis.Do(ctx, h.redis.B().Set().Key(agentKey()).Value(h.instance).Ex(presenceTTL).Build()).Error(); err != nil && ctx.Err() == nil {
				slog.WarnContext(ctx, "sipreg: renew presence", "err", err)
			}
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
	if h.redis == nil {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	if err := dropScript.Exec(ctx, h.redis, []string{agentKey()}, []string{h.instance}).Error(); err != nil {
		slog.WarnContext(ctx, "sipreg: drop presence", "err", err)
	}
}

// Run delivers published changes to this replica's agent socket until ctx ends.
func (h *Hub) Run(ctx context.Context) {
	if h.token == "" || h.redis == nil {
		return
	}
	for ctx.Err() == nil {
		err := h.redis.Receive(ctx, h.redis.B().Subscribe().Channel(cmdChannel()).Build(), func(m rueidis.PubSubMessage) {
			ws, err := uuid.Parse(m.Message)
			if err != nil {
				return
			}
			h.deliver(ctx, ws)
		})
		if ctx.Err() != nil {
			return
		}
		slog.WarnContext(ctx, "sipreg: change subscription lost, retrying", "err", err)
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Second):
		}
	}
}

// deliver writes the current state of one workspace's account to this replica's agent socket.
func (h *Hub) deliver(ctx context.Context, ws uuid.UUID) {
	h.mu.Lock()
	c := h.conn
	h.mu.Unlock()
	if c == nil || h.Source == nil {
		return
	}
	a, ok, err := h.Source.RegAccount(ctx, ws)
	if err != nil {
		slog.WarnContext(ctx, "sipreg: account", "workspace", ws, "err", err)
		return
	}
	if ok {
		h.enqueue(ctx, c, sipregwire.Command{Op: sipregwire.OpAccountSet, Account: &a})
	} else {
		h.enqueue(ctx, c, sipregwire.Command{Op: sipregwire.OpAccountDel, WS: ws.String()})
	}
}

// ErrUnavailable means no agent token is configured.
var ErrUnavailable = errors.New("sipreg: no registration agent configured")

// Available reports whether an agent is connected to some replica.
func (h *Hub) Available(ctx context.Context) bool {
	if h.token == "" || h.redis == nil {
		return false
	}
	n, err := h.redis.Do(ctx, h.redis.B().Exists().Key(agentKey()).Build()).AsInt64()
	return err == nil && n > 0
}

// Changed tells the agent (through whichever replica holds it) that the workspace's account
// changed: it is re-read there and sent as account_set / account_del.
func (h *Hub) Changed(ctx context.Context, ws uuid.UUID) error {
	if h.token == "" || h.redis == nil {
		return ErrUnavailable
	}
	ctx, done := events.Detached(ctx, writeTimeout)
	defer done()
	return h.redis.Do(ctx, h.redis.B().Publish().Channel(cmdChannel()).Message(ws.String()).Build()).Error()
}

package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/calaba/calaba/server/internal/sipregwire"
)

// wire holds the session to the API: commands in, events out, reconnecting with backoff. While
// it is down the agent keeps registering with the last accounts it got (calls go on); events
// are dropped then (the next registration report and the snapshot on reconnect cover them).
type wire struct {
	apiURL, token string
	agent         *agent

	mu  sync.Mutex
	out chan sipregwire.Event // nil while disconnected
}

func (w *wire) emit(ev sipregwire.Event) {
	w.mu.Lock()
	out := w.out
	w.mu.Unlock()
	if out == nil {
		return
	}
	select {
	case out <- ev:
	default:
		slog.Warn("sipreg: event queue full, dropped", "op", ev.Op)
	}
}

func (w *wire) run(ctx context.Context) {
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
		slog.Warn("sipreg: API connection lost, reconnecting", "err", err, "in", backoff)
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
		return "wss://" + rest + sipregwire.AgentPath
	}
	return "ws://" + strings.TrimPrefix(api, "http://") + sipregwire.AgentPath
}

func (w *wire) session(ctx context.Context) error {
	dctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	ws, resp, err := websocket.Dial(dctx, agentURL(w.apiURL), &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": []string{"Bearer " + w.token}},
	})
	cancel()
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		return err
	}
	defer func() { _ = ws.CloseNow() }()
	ws.SetReadLimit(sipregwire.MaxFrame)
	sctx, stop := context.WithCancel(ctx)
	defer stop()
	out := make(chan sipregwire.Event, 256)
	w.mu.Lock()
	w.out = out
	w.mu.Unlock()
	defer func() {
		w.mu.Lock()
		if w.out == out {
			w.out = nil
		}
		w.mu.Unlock()
	}()
	slog.Info("sipreg: connected to the API")
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
	w.emit(sipregwire.Event{Op: sipregwire.OpHello})
	for {
		typ, b, err := ws.Read(sctx)
		if err != nil {
			return err
		}
		if typ != websocket.MessageText {
			continue
		}
		var cmd sipregwire.Command
		if err := json.Unmarshal(b, &cmd); err != nil {
			slog.Warn("sipreg: bad command frame", "err", err)
			continue
		}
		w.agent.apply(ctx, cmd)
		// The snapshot is in: report the current state of every registration once more (the API
		// may have marked them unavailable while the agent was away).
		if cmd.Op == sipregwire.OpSnapshot {
			w.agent.reportAll()
		}
	}
}

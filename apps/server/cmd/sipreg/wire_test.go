package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/sipreg"
	"github.com/calaba/calaba/server/internal/sipregwire"
)

type oneAccount struct{ acc sipregwire.Account }

func (o oneAccount) RegAccounts(context.Context) ([]sipregwire.Account, error) {
	return []sipregwire.Account{o.acc}, nil
}

func (o oneAccount) RegAccount(context.Context, uuid.UUID) (sipregwire.Account, bool, error) {
	return o.acc, true, nil
}

// The whole channel: the agent dials the API's hub with its token, says hello, gets the
// snapshot, registers at the provider and reports «registered» back to the API.
func TestWireToHub(t *testing.T) {
	p, lk := newProvider(t), newLiveKit(t)
	ag := newTestAgent(t, lk)
	hub := sipreg.New(nil, "agent-token")
	hub.Source = oneAccount{acc: testAccount(p)}
	got := make(chan sipregwire.Event, 16)
	hub.OnEvent = func(_ context.Context, ev sipregwire.Event) { got <- ev }
	mux := http.NewServeMux()
	hub.Routes(mux)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	w := &wire{apiURL: srv.URL, token: "agent-token", agent: ag.agent}
	ag.emit = w.emit
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	go w.run(ctx)
	for {
		select {
		case ev := <-got:
			if ev.Op == sipregwire.OpRegistration && ev.Status == sipregwire.StatusRegistered {
				if ev.WS != testAccount(p).WS {
					t.Fatalf("event %+v", ev)
				}
				return
			}
		case <-ctx.Done():
			t.Fatal("no registration report reached the API")
		}
	}
}

// A wrong token gets nothing (the hub answers 404 and the agent keeps retrying).
func TestWireWrongToken(t *testing.T) {
	hub := sipreg.New(nil, "agent-token")
	hub.Source = oneAccount{}
	mux := http.NewServeMux()
	hub.Routes(mux)
	srv := httptest.NewServer(mux)
	defer srv.Close()
	w := &wire{apiURL: srv.URL, token: "it-ivr-token"}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := w.session(ctx); err == nil {
		t.Fatal("connected with another token")
	}
}

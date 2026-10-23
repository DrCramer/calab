//go:build integration

package ysync

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db/dbtest"
	"github.com/calaba/calaba/server/internal/identitypolicy"
)

// revokingAuth is memAuth whose sessions and bot tokens can be revoked while a socket is open:
// "bot:<id>" is a bot token, anything else a person's.
type revokingAuth struct{ revoked *atomic.Bool }

func (a revokingAuth) AuthenticateToken(_ context.Context, tok string) (auth.Identity, error) {
	if a.revoked.Load() {
		return auth.Identity{}, auth.ErrInvalidToken
	}
	bot := strings.HasPrefix(tok, "bot:")
	u, err := uuid.Parse(strings.TrimPrefix(tok, "bot:"))
	if err != nil {
		return auth.Identity{}, auth.ErrInvalidToken
	}
	return auth.Identity{UserID: u, SessionID: uuid.New(), IsBot: bot}, nil
}

func (a revokingAuth) CheckSession(context.Context, uuid.UUID) error {
	if a.revoked.Load() {
		return auth.ErrSessionRevoked
	}
	return nil
}

func (revokingAuth) CheckWorkspace(context.Context, auth.Identity, uuid.UUID, identitypolicy.Operation) error {
	return nil
}

func (revokingAuth) WithPolicy(ctx context.Context, _ auth.Identity, _ identitypolicy.Operation) context.Context {
	return ctx
}

// The in-band authentication of the shared socket, for the Wiki's profile (the zero one) and
// the Canvas's: no token within AuthTimeout, a binary first frame and a bad token close the socket
// before anything of the document is sent; a session revoked while the socket is open (a person's
// session row, a bot's replaced token) closes it 4010 at the next recheck.
func TestSocketAuthAndSessionRevocation(t *testing.T) {
	for name, prof := range map[string]Profile{
		"wiki":   {},
		"canvas": {Ceiling: true, ByteBudget: true, CoalesceAwareness: true, RecheckJitter: true, PublishBackoff: true, RetryPublish: true, BatchAwareness: true},
	} {
		t.Run(name, func(t *testing.T) {
			e := newProfEnv(t, prof, Config{})
			revoked := &atomic.Bool{}
			h := NewHub(e.b, Options{DB: dbtest.Connect(t), Redis: e.rc, Auth: revokingAuth{revoked: revoked},
				Config: Config{AuthTimeout: 300 * time.Millisecond, RecheckInterval: 200 * time.Millisecond}})
			mux := http.NewServeMux()
			mux.HandleFunc("GET /sync/{id}", h.Serve)
			srv := httptest.NewServer(mux)
			t.Cleanup(srv.Close)
			dial := func(first []byte, typ websocket.MessageType) *profClient {
				t.Helper()
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				ws, resp, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+"/sync/"+e.doc.String(), nil)
				if resp != nil && resp.Body != nil {
					_ = resp.Body.Close()
				}
				if err != nil {
					t.Fatal(err)
				}
				ws.SetReadLimit(8 << 20)
				t.Cleanup(func() { _ = ws.CloseNow() })
				if first != nil {
					if err := ws.Write(ctx, typ, first); err != nil {
						t.Fatal(err)
					}
				}
				return &profClient{t: t, ws: ws}
			}
			closed := func(c *profClient, want websocket.StatusCode) {
				t.Helper()
				for i := 0; i < 100; i++ {
					f, code := c.read(3 * time.Second)
					if f == nil {
						if code != want {
							t.Fatalf("closed %d, want %d", code, want)
						}
						return
					}
					if f[0] == FrameSnapshot && want != CloseRevoked {
						t.Fatalf("a snapshot before the authentication")
					}
				}
				t.Fatal("not closed")
			}
			// No token in time: the read's deadline ends the connection (coder/websocket drops it
			// without a close frame), well before the client's own deadline.
			start := time.Now()
			if f, _ := dial(nil, 0).read(3 * time.Second); f != nil || time.Since(start) > 2*time.Second {
				t.Fatalf("no token: frame %x after %v", f, time.Since(start))
			}
			closed(dial([]byte(uuid.NewString()), websocket.MessageBinary), CloseAuth) // a binary first frame
			closed(dial([]byte("not a token"), websocket.MessageText), CloseAuth)
			// A person's session and a bot's token, revoked while the socket is open.
			for _, tok := range []string{uuid.NewString(), "bot:" + uuid.NewString()} {
				revoked.Store(false)
				c := dial([]byte(tok), websocket.MessageText)
				c.next(FrameSnapshot)
				revoked.Store(true)
				closed(c, CloseRevoked)
			}
		})
	}
}

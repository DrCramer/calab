//go:build integration

package ysync

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"

	"github.com/calaba/calaba/server/internal/redisx"
)

// stubBackend is a Backend for the hub alone (nothing of the Store is called).
type stubBackend struct{ Backend }

func (stubBackend) Name() string     { return "ytest" }
func (stubBackend) LogKey() string   { return "doc_id" }
func (stubBackend) Noun() string     { return "document" }
func (stubBackend) MaxState() int    { return 1 << 20 }
func (stubBackend) Profile() Profile { return Profile{PublishBackoff: true} }

// A failing Valkey (here a closed client): every frame not published is counted, an UPDATE's
// failure is logged once per logEvery, awareness never, and after a failure awareness is not
// even tried for pubBackoff (the reader would wait up to 3 s per frame).
func TestBroadcastWhileValkeyFails(t *testing.T) {
	url := os.Getenv("TEST_REDIS_URL")
	if url == "" {
		t.Fatal("TEST_REDIS_URL required")
	}
	rc, err := redisx.Connect(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	rc.Close()
	buf := captureLog(t)
	h := NewHub(stubBackend{}, Options{Redis: rc})
	ctx, doc := context.Background(), uuid.New()
	before := dropped(t, "publish")
	for i := 0; i < 20; i++ {
		h.broadcast(ctx, doc, nil, []byte{FrameAwareness, byte(i)})
	}
	if h.pubDown.Load() == 0 {
		t.Fatal("a failed publish is not remembered")
	}
	for i := 0; i < 20; i++ {
		h.broadcast(ctx, doc, nil, UpdateFrame(int64(i+1), []byte{byte(i)}))
	}
	if n := dropped(t, "publish") - before; n != 40 {
		t.Fatalf("dropped %v frames, want 40", n)
	}
	if n := strings.Count(buf.String(), "ytest sync: publish"); n != 1 {
		t.Fatalf("%d publish lines, want 1:\n%s", n, buf)
	}
}

// dropped is calaba_ysync_dropped_frames_total of the stub section for a reason.
func dropped(t *testing.T, reason string) float64 {
	t.Helper()
	mfs, err := prometheus.DefaultGatherer.Gather()
	if err != nil {
		t.Fatal(err)
	}
	for _, mf := range mfs {
		if mf.GetName() != "calaba_ysync_dropped_frames_total" {
			continue
		}
		for _, m := range mf.GetMetric() {
			n := 0
			for _, l := range m.GetLabel() {
				if (l.GetName() == "section" && l.GetValue() == "ytest") || (l.GetName() == "reason" && l.GetValue() == reason) {
					n++
				}
			}
			if n == 2 {
				return m.GetCounter().GetValue()
			}
		}
	}
	return 0
}

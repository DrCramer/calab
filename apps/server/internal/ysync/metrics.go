package ysync

import (
	"log/slog"
	"strconv"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// The sync sockets' metrics (GET /metrics), per section (the Backend's Name).
var (
	roomsGauge = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Namespace: "calaba", Subsystem: "ysync", Name: "rooms", Help: "Documents with a sync socket on this instance."}, []string{"section"})
	socketsGauge = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Namespace: "calaba", Subsystem: "ysync", Name: "sockets", Help: "Open sync sockets on this instance."}, []string{"section"})
	droppedFrames = promauto.NewCounterVec(prometheus.CounterOpts{
		Namespace: "calaba", Subsystem: "ysync", Name: "dropped_frames_total",
		Help: "Frames not delivered: queue (a socket's queue full; an update or snapshot is caught up from the database), " +
			"awareness (over the budget: dropped, or replaced by a newer one), ceiling (an UPDATE refused at the update ceiling), " +
			"publish (not published to the other instances)."}, []string{"section", "reason"})
	catchUps = promauto.NewCounterVec(prometheus.CounterOpts{
		Namespace: "calaba", Subsystem: "ysync", Name: "catchups_total", Help: "Catch-ups of a socket from the database (its first frames included)."}, []string{"section"})
	ceilingHits = promauto.NewCounterVec(prometheus.CounterOpts{
		Namespace: "calaba", Subsystem: "ysync", Name: "ceiling_hits_total",
		Help: "Documents found at their update ceiling (at most once per CompactCooldown each)."}, []string{"section"})
	closes = promauto.NewCounterVec(prometheus.CounterOpts{
		Namespace: "calaba", Subsystem: "ysync", Name: "closes_total", Help: "Server-initiated socket closes by code (4000 and up)."}, []string{"section", "code"})
	batchedFrames = promauto.NewCounterVec(prometheus.CounterOpts{
		Namespace: "calaba", Subsystem: "ysync", Name: "batched_frames_total",
		Help: "Batched awareness frames sent per window."}, []string{"section"})
	coalescedEntries = promauto.NewCounterVec(prometheus.CounterOpts{
		Namespace: "calaba", Subsystem: "ysync", Name: "coalesced_entries_total",
		Help: "Awareness entries coalesced within batching windows."}, []string{"section"})
	overwrittenSlots = promauto.NewCounterVec(prometheus.CounterOpts{
		Namespace: "calaba", Subsystem: "ysync", Name: "overwritten_slots_total",
		Help: "Awareness slots overwritten on a socket before delivery."}, []string{"section"})
)

// metrics are a hub's series, resolved once (the frame paths only add).
type metrics struct {
	section                                           string
	rooms, sockets                                    prometheus.Gauge
	dropQueue, dropAwareness, dropCeiling, dropPub    prometheus.Counter
	catchUps, ceilingHits                             prometheus.Counter
	batchedFrames, coalescedEntries, overwrittenSlots prometheus.Counter
}

func newMetrics(section string) metrics {
	drop := func(reason string) prometheus.Counter { return droppedFrames.WithLabelValues(section, reason) }
	return metrics{
		section:          section,
		rooms:            roomsGauge.WithLabelValues(section),
		sockets:          socketsGauge.WithLabelValues(section),
		dropQueue:        drop("queue"),
		dropAwareness:    drop("awareness"),
		dropCeiling:      drop("ceiling"),
		dropPub:          drop("publish"),
		catchUps:         catchUps.WithLabelValues(section),
		ceilingHits:      ceilingHits.WithLabelValues(section),
		batchedFrames:    batchedFrames.WithLabelValues(section),
		coalescedEntries: coalescedEntries.WithLabelValues(section),
		overwrittenSlots: overwrittenSlots.WithLabelValues(section),
	}
}

func (m *metrics) closed(code int) {
	if code >= 4000 {
		closes.WithLabelValues(m.section, strconv.Itoa(code)).Inc()
	}
}

// logEvery: one line of a kind per section this often while a dependency fails (a Valkey outage
// would otherwise log every 200 ms per room and on every frame).
const logEvery = 10 * time.Second

// logLimit lets one line through per logEvery; the next one says how many were held back.
type logLimit struct {
	mu   sync.Mutex
	next time.Time
	held int
}

// warn logs msg with args (and the lines held back since the last one), or holds it back.
func (l *logLimit) warn(msg string, args ...any) {
	l.mu.Lock()
	now := time.Now()
	if now.Before(l.next) {
		l.held++
		l.mu.Unlock()
		return
	}
	held := l.held
	l.held, l.next = 0, now.Add(logEvery)
	l.mu.Unlock()
	if held > 0 {
		args = append(args, "suppressed", held)
	}
	slog.Warn(msg, args...) //nolint:gosec // G706: the callers' section name, document ids and Redis errors only
}

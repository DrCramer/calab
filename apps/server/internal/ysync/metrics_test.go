package ysync

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"
	"time"
)

// captureLog sends the default logger's lines to a buffer for the test.
func captureLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return &buf
}

// One warn line per logEvery: the lines in between are held back and counted on the next one.
func TestLogLimit(t *testing.T) {
	buf := captureLog(t)
	var l logLimit
	for i := 0; i < 50; i++ {
		l.warn("wiki sync: publish", "i", i)
	}
	if n := strings.Count(buf.String(), "wiki sync: publish"); n != 1 {
		t.Fatalf("%d lines within the window:\n%s", n, buf)
	}
	l.mu.Lock()
	l.next = time.Now().Add(-time.Millisecond) // the window is over
	l.mu.Unlock()
	l.warn("wiki sync: publish", "i", 50)
	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	if len(lines) != 2 || !strings.Contains(lines[1], "i=50") || !strings.Contains(lines[1], "suppressed=49") {
		t.Fatalf("after the window:\n%s", buf)
	}
}

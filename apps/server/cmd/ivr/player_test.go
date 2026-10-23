package main

import (
	"bytes"
	"context"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4/pkg/media/oggwriter"
)

// oggOf writes n 20 ms Opus frames (distinct payloads) as an Ogg/Opus file.
func oggOf(t *testing.T, n int) []byte {
	t.Helper()
	var buf bytes.Buffer
	w, err := oggwriter.NewWith(&buf, 48000, 1)
	if err != nil {
		t.Fatal(err)
	}
	for i := range n {
		p := &rtp.Packet{Header: rtp.Header{SequenceNumber: uint16(i), Timestamp: uint32(i * 960)}, Payload: []byte{0xF8, byte(i), 0xFE}} //nolint:gosec // small
		if err := w.WriteRTP(p); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestDecodeOgg(t *testing.T) {
	c, err := decodeOgg(oggOf(t, 5))
	if err != nil {
		t.Fatal(err)
	}
	if len(c.packets) != 5 || c.durs[0] != 20*time.Millisecond || c.packets[3][1] != 3 {
		t.Fatalf("clip: %d packets %v", len(c.packets), c.durs)
	}
	if _, err := decodeOgg([]byte("not ogg")); err == nil {
		t.Fatal("garbage decoded")
	}
}

func TestPlayerClipsLoopAndSilence(t *testing.T) {
	ctx := context.Background()
	c, err := decodeOgg(oggOf(t, 3))
	if err != nil {
		t.Fatal(err)
	}
	p := &player{}
	s, _ := p.NextSample(ctx)
	if !bytes.Equal(s.Data, silence) || s.Duration != silenceDur {
		t.Fatal("idle player is not silent")
	}
	done := make(chan struct{})
	p.play(c, false, func() { close(done) })
	for i := range 3 {
		s, _ = p.NextSample(ctx)
		if s.Data[1] != byte(i) {
			t.Fatalf("packet %d: %v", i, s.Data)
		}
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("no «played» after the last packet")
	}
	if s, _ = p.NextSample(ctx); !bytes.Equal(s.Data, silence) {
		t.Fatal("not silent after the clip")
	}
	// A loop wraps around and never reports «played»; stop silences it.
	p.play(c, true, nil)
	for i := range 7 {
		s, _ = p.NextSample(ctx)
		if s.Data[1] != byte(i%3) {
			t.Fatalf("loop packet %d: %v", i, s.Data)
		}
	}
	p.stop()
	if s, _ = p.NextSample(ctx); !bytes.Equal(s.Data, silence) {
		t.Fatal("not silent after stop")
	}
}

func TestConfigAndURL(t *testing.T) {
	if agentURL("https://app.calab.io") != "wss://app.calab.io/api/internal/ivr-agent" || agentURL("http://localhost:3000") != "ws://localhost:3000/api/internal/ivr-agent" {
		t.Fatal("agent URL")
	}
	t.Setenv("API_URL", "ftp://x")
	t.Setenv("IVR_AGENT_TOKEN", "t")
	t.Setenv("LIVEKIT_URL", "ws://127.0.0.1:7880")
	if _, err := loadConfig(); err == nil {
		t.Fatal("a non-http API_URL accepted")
	}
	t.Setenv("API_URL", "https://app.calab.io/")
	if c, err := loadConfig(); err != nil || c.apiURL != "https://app.calab.io" || c.cacheDir == "" {
		t.Fatalf("config: %+v %v", c, err)
	}
}

// Command ivr is the IVR worker of inbound phone calls (ADR-0117 §2): the «hands» of the
// API's call state machine. It holds an outgoing WebSocket to the API (GET
// /api/internal/ivr-agent, the shared IVR_AGENT_TOKEN), joins an inbound call's LiveKit room as
// one more participant when told to, plays voice menu prompts (Ogg/Opus files of the API, no
// transcoding) and the ringback into it, and reports the caller's keys (SipDTMF data packets of
// LiveKit SIP) and «prompt played» back. It knows no routes, rights or workspaces.
//
// The LiveKit client (livekit/server-sdk-go, pion) lives only in this binary; the API stays
// without it (ADR-0013). One replica on the stand next to livekit/sip (compose profile ivr).
//
// Environment:
//
//	API_URL            the API's public base URL, e.g. https://app.calab.io (required)
//	IVR_AGENT_TOKEN    the shared token (required; the API's IVR_AGENT_TOKEN)
//	LIVEKIT_URL        LiveKit for the worker, e.g. ws://127.0.0.1:7880 (required)
//	IVR_CACHE_DIR      prompt cache (default /tmp/ivr-cache; LRU, 200 MB)
//	IVR_RINGBACK_PATH  the ringback tone, Ogg/Opus (default /assets/ringback.ogg; missing = silence)
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
)

type config struct {
	apiURL, token, livekitURL, cacheDir, ringbackPath string
}

func loadConfig() (config, error) {
	c := config{
		apiURL: strings.TrimRight(os.Getenv("API_URL"), "/"), token: os.Getenv("IVR_AGENT_TOKEN"), livekitURL: os.Getenv("LIVEKIT_URL"),
		cacheDir: os.Getenv("IVR_CACHE_DIR"), ringbackPath: os.Getenv("IVR_RINGBACK_PATH"),
	}
	if c.cacheDir == "" {
		c.cacheDir = "/tmp/ivr-cache"
	}
	if c.ringbackPath == "" {
		c.ringbackPath = "/assets/ringback.ogg"
	}
	if c.apiURL == "" || c.token == "" || c.livekitURL == "" {
		return c, errors.New("API_URL, IVR_AGENT_TOKEN and LIVEKIT_URL are required")
	}
	u, err := url.Parse(c.apiURL)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		return c, errors.New("API_URL must be an http(s) URL")
	}
	return c, nil
}

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stderr, nil)))
	cfg, err := loadConfig()
	if err != nil {
		slog.Error("ivr: config", "err", err)
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	w := newWorker(cfg)
	w.run(ctx)
	w.closeAll()
}

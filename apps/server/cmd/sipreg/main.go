// Command sipreg is the SIP registration agent of inbound phone calls (ADR-0121): for every
// workspace account in REGISTER mode it holds a registration at the provider (REGISTER with
// digest, refresh, OPTIONS keepalive) whose Contact points at this agent, and hands the INVITEs
// that come over it to LiveKit SIP on loopback as a signalling-only B2BUA: two dialogs, the SDP
// copied as it is, the media flowing directly between the provider and LiveKit SIP. From
// LiveKit SIP on, a call is the same as in the direct mode (ADR-0117).
//
// It is the «hands» of the API: no database, rights or workspaces. It holds an outgoing
// WebSocket to the API (GET /api/internal/sipreg-agent with SIPREG_AGENT_TOKEN), gets the
// accounts there (passwords in memory only, never on disk or in logs) and reports registration
// states and calls. It has no HTTP port. On its SIP port, packets from addresses that are not a
// provider's are dropped before parsing, without an answer.
//
// The SIP stack is github.com/emiago/sipgo (pure Go; the API binary does not link it, ADR-0013).
// One replica on the stand next to livekit/sip (compose profile sipreg, network_mode host).
//
// Environment:
//
//	API_URL                  the API's public base URL, e.g. https://app.calab.io (required)
//	SIPREG_AGENT_TOKEN       the shared token (required; the API's SIPREG_AGENT_TOKEN)
//	SIP_REGISTRAR_PORT       the public SIP port of the agent, UDP and TCP (default 5080)
//	SIP_REGISTRAR_BIND       the address to listen on (default 0.0.0.0)
//	SIP_REGISTRAR_PUBLIC_IP  the public IPv4 put into Contact / Via (default: found via STUN)
//	SIP_REGISTRAR_STUN       STUN server for the public IP (default stun.l.google.com:19302; off = none)
//	LIVEKIT_SIP_ADDR         LiveKit SIP's signalling address (default 127.0.0.1:5060)
package main

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/netip"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type config struct {
	apiURL, token string
	bind          string
	port          int
	publicIP      string
	stun          string
	livekit       string // host:port
	tcp           bool
}

func loadConfig() (config, error) {
	c := config{
		apiURL: strings.TrimRight(os.Getenv("API_URL"), "/"), token: os.Getenv("SIPREG_AGENT_TOKEN"),
		bind: os.Getenv("SIP_REGISTRAR_BIND"), publicIP: os.Getenv("SIP_REGISTRAR_PUBLIC_IP"),
		stun: os.Getenv("SIP_REGISTRAR_STUN"), livekit: os.Getenv("LIVEKIT_SIP_ADDR"), port: 5080, tcp: true,
	}
	switch c.stun {
	case "":
		c.stun = "stun.l.google.com:19302"
	case "off":
		c.stun = ""
	}
	if c.bind == "" {
		c.bind = "0.0.0.0"
	}
	if c.livekit == "" {
		c.livekit = "127.0.0.1:5060"
	}
	if v := os.Getenv("SIP_REGISTRAR_PORT"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 65535 {
			return c, errors.New("SIP_REGISTRAR_PORT must be 1..65535")
		}
		c.port = n
	}
	if c.apiURL == "" || c.token == "" {
		return c, errors.New("API_URL and SIPREG_AGENT_TOKEN are required")
	}
	u, err := url.Parse(c.apiURL)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		return c, errors.New("API_URL must be an http(s) URL")
	}
	if c.publicIP != "" {
		a, err := netip.ParseAddr(c.publicIP)
		if err != nil || !a.Is4() {
			return c, errors.New("SIP_REGISTRAR_PUBLIC_IP must be an IPv4 address")
		}
	}
	if _, _, err := net.SplitHostPort(c.livekit); err != nil {
		return c, errors.New("LIVEKIT_SIP_ADDR must be host:port")
	}
	return c, nil
}

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stderr, nil)))
	cfg, err := loadConfig()
	if err != nil {
		slog.Error("sipreg: config", "err", err)
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	public := cfg.publicIP
	if public == "" && cfg.stun != "" {
		if public, err = stunPublicIP(ctx, cfg.stun, 5*time.Second); err != nil {
			slog.Error("sipreg: no public IP (set SIP_REGISTRAR_PUBLIC_IP)", "err", err)
			os.Exit(2)
		}
	}
	if public == "" {
		slog.Error("sipreg: no public IP: set SIP_REGISTRAR_PUBLIC_IP or SIP_REGISTRAR_STUN")
		os.Exit(2)
	}
	ag, err := newAgent(agentConfig{bind: cfg.bind, port: cfg.port, publicIP: public, livekit: cfg.livekit, tcp: cfg.tcp})
	if err != nil {
		slog.Error("sipreg: listen", "err", err)
		os.Exit(1)
	}
	slog.Info("sipreg: listening", "addr", ag.listenAddr(), "public", public, "livekit", cfg.livekit)
	if cfg.publicIP == "" && cfg.stun != "" {
		go ag.watchPublicIP(ctx, func(ctx context.Context) (string, error) { return stunPublicIP(ctx, cfg.stun, 5*time.Second) })
	}
	w := &wire{apiURL: cfg.apiURL, token: cfg.token, agent: ag}
	ag.emit = w.emit
	w.run(ctx)
	ag.shutdown()
}

package main

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/netip"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/emiago/sipgo/sip"
)

// Flows (ADR-0125, RFC 5626): the agent is a SIP client behind NAT, like a softphone. Over TCP
// every registrar address gets one long-lived connection that the agent dials itself; the
// registrations to that address share it, and the registrar's INVITEs come back over it, so no
// inbound port and no public address of ours are needed. Over UDP the flow is the listener's
// NAT binding towards the registrar, kept open by keepalives (registration.go).
//
// sipgo does not take a dialed connection from outside, so the connection is handed to it
// through flowListener (ServeTCP «accepts» it): from then on sipgo reads it, matches answers and
// sends requests and responses to that address over it, as over any accepted connection.

var (
	errNoDial = errors.New("sipreg: TCP to providers goes over the registration's flow only")
	crlfPing  = []byte("\r\n\r\n")
)

// tcpFlow is one connection to a registrar address.
type tcpFlow struct {
	dest  string // the registrar's ip:port
	conn  *flowConn
	local netip.AddrPort // our end of it (Contact / Via before the registrar tells us better)
	refs  int            // registrations holding it (under flowSet.mu)

	down     chan struct{} // closed when the connection ended
	downOnce sync.Once
	lastRead atomic.Int64 // unix nanos of the last bytes from the registrar
	ponged   atomic.Bool  // the registrar answers our CRLF pings (RFC 5626 §4.4.1)
}

func (f *tcpFlow) markDown() { f.downOnce.Do(func() { close(f.down) }) }

// close ends the flow: sipgo's reader sees the error, drops the connection from its pool and
// fails its transactions.
func (f *tcpFlow) close() {
	f.markDown()
	_ = f.conn.Conn.Close()
}

func (f *tcpFlow) isDown() bool {
	select {
	case <-f.down:
		return true
	default:
		return false
	}
}

// flowConn notes reads (pong, liveness) and the end of the connection.
type flowConn struct {
	net.Conn
	f *tcpFlow
}

func (c *flowConn) Read(b []byte) (int, error) {
	n, err := c.Conn.Read(b)
	if n > 0 {
		c.f.lastRead.Store(time.Now().UnixNano())
		if n == 2 && b[0] == '\r' && b[1] == '\n' {
			c.f.ponged.Store(true)
		}
	}
	if err != nil {
		c.f.markDown()
	}
	return n, err
}

func (c *flowConn) Close() error {
	c.f.markDown()
	return c.Conn.Close()
}

// flowListener hands the dialed connections to sipgo's TCP transport.
type flowListener struct {
	ch   chan net.Conn
	done chan struct{}
	once sync.Once
}

func newFlowListener() *flowListener {
	return &flowListener{ch: make(chan net.Conn), done: make(chan struct{})}
}

func (l *flowListener) Accept() (net.Conn, error) {
	select {
	case c := <-l.ch:
		return c, nil
	case <-l.done:
		return nil, net.ErrClosed
	}
}

func (l *flowListener) Close() error {
	l.once.Do(func() { close(l.done) })
	return nil
}

func (l *flowListener) Addr() net.Addr { return &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)} }

func (l *flowListener) hand(ctx context.Context, c net.Conn) bool {
	select {
	case l.ch <- c:
		return true
	case <-l.done:
		return false
	case <-ctx.Done():
		return false
	}
}

// flowSet keeps the flows by registrar address.
type flowSet struct {
	ag *agent
	l  *flowListener

	mu      sync.Mutex
	m       map[string]*tcpFlow
	dialing map[string]chan struct{}
}

func newFlowSet(ag *agent) *flowSet {
	return &flowSet{ag: ag, l: newFlowListener(), m: map[string]*tcpFlow{}, dialing: map[string]chan struct{}{}}
}

// acquire returns the live flow to dest, dialing it when there is none; release gives it back.
func (s *flowSet) acquire(ctx context.Context, dest string) (*tcpFlow, error) {
	for {
		s.mu.Lock()
		if f := s.m[dest]; f != nil && !f.isDown() {
			f.refs++
			s.mu.Unlock()
			return f, nil
		}
		old := s.m[dest]
		if wait, ok := s.dialing[dest]; ok {
			s.mu.Unlock()
			select {
			case <-wait:
				continue
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		done := make(chan struct{})
		s.dialing[dest] = done
		s.mu.Unlock()

		f, err := s.dial(ctx, dest, old)
		s.mu.Lock()
		delete(s.dialing, dest)
		close(done)
		if err == nil {
			f.refs = 1
			s.m[dest] = f
		} else if s.m[dest] == old && old != nil {
			delete(s.m, dest)
		}
		s.mu.Unlock()
		return f, err
	}
}

func (s *flowSet) release(f *tcpFlow) {
	if f == nil {
		return
	}
	s.mu.Lock()
	f.refs--
	last := f.refs <= 0
	if last && s.m[f.dest] == f {
		delete(s.m, f.dest)
	}
	s.mu.Unlock()
	if last {
		f.close()
	}
}

func (s *flowSet) closeAll() {
	s.mu.Lock()
	all := make([]*tcpFlow, 0, len(s.m))
	for _, f := range s.m {
		all = append(all, f)
	}
	s.m = map[string]*tcpFlow{}
	s.mu.Unlock()
	for _, f := range all {
		f.close()
	}
	_ = s.l.Close()
}

func (s *flowSet) dial(ctx context.Context, dest string, old *tcpFlow) (*tcpFlow, error) {
	// sipgo keys its pool by the remote address: the old connection to dest must be out of it,
	// or its late cleanup would take the new one out instead.
	if old != nil {
		old.close()
		s.awaitPool(dest, func(c net.Conn) bool { return c != old.conn })
	}
	t := s.ag.t
	d := net.Dialer{Timeout: t.requestWait, KeepAliveConfig: net.KeepAliveConfig{Enable: true, Idle: 15 * time.Second, Interval: 5 * time.Second, Count: 3}}
	if s.ag.cfg.bind != "" && s.ag.cfg.bind != "0.0.0.0" {
		d.LocalAddr = &net.TCPAddr{IP: net.ParseIP(s.ag.cfg.bind)}
	}
	dctx, cancel := context.WithTimeout(ctx, t.requestWait)
	defer cancel()
	c, err := d.DialContext(dctx, "tcp4", dest)
	if err != nil {
		return nil, err
	}
	f := &tcpFlow{dest: dest, down: make(chan struct{})}
	f.conn = &flowConn{Conn: c, f: f}
	if ap, err := netip.ParseAddrPort(c.LocalAddr().String()); err == nil {
		f.local = netip.AddrPortFrom(ap.Addr().Unmap(), ap.Port())
	}
	f.lastRead.Store(time.Now().UnixNano())
	if !s.l.hand(ctx, f.conn) {
		_ = c.Close()
		return nil, errors.New("sipreg: shutting down")
	}
	if !s.awaitPool(c.RemoteAddr().String(), func(got net.Conn) bool { return got == f.conn }) {
		f.close()
		return nil, errors.New("sipreg: the flow did not enter the transport")
	}
	slog.Info("sipreg: flow connected", "registrar", dest, "local", f.local.String())
	go s.keepalive(f)
	return f, nil
}

// awaitPool waits (≤ 2 s) until sipgo's TCP pool entry for addr satisfies ok (nil = none).
func (s *flowSet) awaitPool(addr string, ok func(net.Conn) bool) bool {
	tl := s.ag.ua.TransportLayer()
	for deadline := time.Now().Add(2 * time.Second); time.Now().Before(deadline); time.Sleep(time.Millisecond) {
		var got net.Conn
		if c, err := tl.GetConnection("tcp", addr); err == nil {
			if tc, isTCP := c.(*sip.TCPConnection); isTCP {
				got = tc.Conn
			}
			c.Ref(-1) // GetConnection took a reference
		}
		if ok(got) {
			return true
		}
	}
	return false
}

// keepalive pings the flow with a double CRLF (RFC 5626 §4.4.1): it keeps NAT and the provider's
// firewall open; when the registrar answers pings, a missing pong closes the flow (the
// registrations dial again and re-register).
func (s *flowSet) keepalive(f *tcpFlow) {
	t := time.NewTicker(s.ag.t.natKeepalive)
	defer t.Stop()
	for {
		select {
		case <-f.down:
			return
		case <-t.C:
		}
		sent := time.Now().UnixNano()
		if _, err := f.conn.Write(crlfPing); err != nil {
			f.close()
			return
		}
		if !f.ponged.Load() {
			continue
		}
		select {
		case <-f.down:
			return
		case <-time.After(s.ag.t.pongWait):
		}
		if f.lastRead.Load() < sent {
			slog.Warn("sipreg: no pong on the flow, connecting again", "registrar", f.dest)
			f.close()
			return
		}
	}
}

// refuseDial is sipgo's TCP dialer in flow mode: a request to a provider without a flow fails
// instead of opening a connection the registrations do not watch.
func refuseDial(net.Addr) net.Dialer {
	return net.Dialer{ControlContext: func(context.Context, string, string, syscall.RawConn) error {
		return errNoDial
	}}
}

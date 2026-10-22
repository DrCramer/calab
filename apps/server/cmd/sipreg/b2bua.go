package main

import (
	"bytes"
	"context"
	"log/slog"
	"math/rand/v2"
	"net"
	"net/netip"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/emiago/sipgo/sip"
	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/sipregwire"
)

// The B2BUA (ADR-0121 §2): the provider's INVITE over a registration (leg A, we are its UAS)
// becomes an INVITE of ours to LiveKit SIP on loopback (leg B, we are its UAC). Two dialogs, two
// Call-IDs; the SDP is copied as it is, so RTP flows straight between the provider and LiveKit
// SIP and the agent never sees media. LiveKit SIP's digest challenge on leg B is answered with
// the loopback trunk's credentials. In-dialog requests (BYE, INFO with DTMF, UPDATE, re-INVITE)
// cross over; session refreshes of the provider are answered here.

// providerCallHeader carries leg A's Call-ID to LiveKit SIP (the trunk copies it into the
// line's attribute calab.providerCallId).
const providerCallHeader = "X-Calab-Provider-Call-ID"

// copiedHeaders go from leg A's INVITE to leg B as they are (the caller's identity).
var copiedHeaders = []string{"P-Asserted-Identity", "Remote-Party-ID", "Privacy"}

const allowMethods = "INVITE, ACK, CANCEL, BYE, OPTIONS, INFO, UPDATE"

// leg is one dialog of a call.
type leg struct {
	callID       string
	localTag     string
	remoteTag    string
	localURI     sip.Uri // our address (From of our requests)
	remoteURI    sip.Uri
	remoteTarget sip.Uri   // the Request-URI of in-dialog requests
	routes       []sip.Uri // the route set
	cseq         uint32
	transport    string
	viaHost      string
	viaPort      int
	dest         string // host:port in-dialog requests are sent to
	contact      sip.Uri
	lastSDP      []byte // the last SDP the other end of this leg sent
	contentType  string
}

type call struct {
	ag  *agent
	acc *account

	mu        sync.Mutex
	a, b      leg
	src       string // leg A's source host:port
	bInvite   *sip.Request
	bAck      *sip.Request
	gotProv   bool
	cancelled bool
	cancelOut bool
	ended     bool
	acked     chan struct{}
	ackOnce   sync.Once
	sessExp   string // Session-Expires of leg A (mirrored with refresher=uac)
	aTimer    bool   // leg A supports session timers
}

func (ag *agent) routes() {
	ag.srv.OnInvite(guard(ag.onInvite))
	ag.srv.OnAck(guard(ag.onAck))
	ag.srv.OnBye(guard(ag.onBye))
	ag.srv.OnInfo(guard(ag.onForward))
	ag.srv.OnUpdate(guard(ag.onUpdate))
	ag.srv.OnOptions(guard(ag.onOK))
	ag.srv.OnNotify(guard(ag.onOK))
	// Not a registrar for anybody: silence (the transaction just times out).
	ag.srv.OnRegister(func(*sip.Request, sip.ServerTransaction) {})
	ag.srv.OnCancel(guard(func(req *sip.Request, tx sip.ServerTransaction) {
		ag.respond(req, tx, 481, "Call/Transaction Does Not Exist")
	}))
	ag.srv.OnNoRoute(guard(func(req *sip.Request, tx sip.ServerTransaction) {
		if ag.providerSource(req) {
			ag.respond(req, tx, 405, "Method Not Allowed")
		}
	}))
}

// guard drops requests without the headers every handler relies on (sipgo makes a transaction
// from Via and CSeq alone, so From / To / Call-ID may be missing) and keeps a panic in one
// request from taking the agent — every workspace's registration — down.
func guard(h func(*sip.Request, sip.ServerTransaction)) func(*sip.Request, sip.ServerTransaction) {
	return func(req *sip.Request, tx sip.ServerTransaction) {
		if req.From() == nil || req.To() == nil || req.CallID() == nil || req.CSeq() == nil || req.Via() == nil {
			return
		}
		defer func() {
			if p := recover(); p != nil {
				slog.Error("sipreg: request handler panicked", "method", string(req.Method), "source", srcAddr(req).String(), "panic", p)
			}
		}()
		h(req, tx)
	}
}

func srcAddr(req *sip.Request) netip.Addr {
	ap, err := netip.ParseAddrPort(req.Source())
	if err != nil {
		return netip.Addr{}
	}
	return ap.Addr().Unmap()
}

// providerSource: the request came from some account's sources (not merely loopback).
func (ag *agent) providerSource(req *sip.Request) bool {
	ip := srcAddr(req)
	for _, p := range *ag.allow.Load() {
		if p.Contains(ip) {
			return true
		}
	}
	return false
}

func (ag *agent) respond(req *sip.Request, tx sip.ServerTransaction, code int, reason string) {
	res := sip.NewResponseFromRequest(req, code, reason, nil)
	res.AppendHeader(sip.NewHeader("User-Agent", userAgent))
	_ = tx.Respond(res)
}

func (ag *agent) onOK(req *sip.Request, tx sip.ServerTransaction) {
	if !ag.providerSource(req) && !srcAddr(req).IsLoopback() {
		return
	}
	res := sip.NewResponseFromRequest(req, 200, "OK", nil)
	res.AppendHeader(sip.NewHeader("Allow", allowMethods))
	_ = tx.Respond(res)
}

// callByID finds the call of an in-dialog request and the leg it came on. The Call-ID alone is
// not enough: leg A's requests must come from the account's provider addresses and leg B's from
// LiveKit SIP, so another tenant's «provider» or a process on the host that learnt a Call-ID can
// neither hang up a call nor send a re-INVITE (new SDP) to the provider in our name.
func (ag *agent) callByID(req *sip.Request) (*call, *leg, *leg) {
	cid := req.CallID()
	if cid == nil {
		return nil, nil, nil
	}
	ag.mu.Lock()
	c := ag.calls[string(*cid)]
	ag.mu.Unlock()
	if c == nil {
		return nil, nil, nil
	}
	src := srcAddr(req)
	if c.a.callID == string(*cid) {
		if !c.acc.allows(src) {
			return nil, nil, nil
		}
		return c, &c.a, &c.b
	}
	if !ag.fromLiveKit(src) {
		return nil, nil, nil
	}
	return c, &c.b, &c.a
}

// fromLiveKit: src is LiveKit SIP's address (any loopback address when it is on loopback).
func (ag *agent) fromLiveKit(src netip.Addr) bool {
	if ag.lkIP.IsLoopback() {
		return src.IsLoopback()
	}
	return ag.lkIP.IsValid() && src.Unmap() == ag.lkIP
}

func toTag(req *sip.Request) string {
	if to := req.To(); to != nil {
		t, _ := to.Params.Get("tag")
		return t
	}
	return ""
}

func fromTag(m interface{ From() *sip.FromHeader }) string {
	if f := m.From(); f != nil {
		t, _ := f.Params.Get("tag")
		return t
	}
	return ""
}

// ---------------------------------------------------------------- a new call

func (ag *agent) onInvite(req *sip.Request, tx sip.ServerTransaction) {
	if toTag(req) != "" {
		c, from, to := ag.callByID(req)
		if c == nil {
			if ag.providerSource(req) || srcAddr(req).IsLoopback() {
				ag.respond(req, tx, 481, "Call/Transaction Does Not Exist")
			}
			return
		}
		c.reinvite(req, tx, from, to)
		return
	}
	src := srcAddr(req)
	ag.mu.Lock()
	acc := ag.byContact[req.Recipient.User]
	ag.mu.Unlock()
	if acc == nil || !acc.allows(src) {
		// A provider's INVITE to somebody we do not register: 404, at most 10 per second per
		// address. Anything else (loopback) gets nothing.
		if ag.providerSource(req) && ag.noise.allow("404:"+src.String(), ag.t.notFoundPerS, time.Second) {
			ag.respond(req, tx, 404, "Not Found")
		}
		return
	}
	if !ag.rate.allow("inv:"+src.String(), ag.t.invitesPerMin, time.Minute) {
		res := sip.NewResponseFromRequest(req, 503, "Service Unavailable", nil)
		res.AppendHeader(sip.NewHeader("Retry-After", "60"))
		_ = tx.Respond(res)
		return
	}
	if acc.pending.Add(1) > int32(ag.t.pendingMax) { //nolint:gosec // small
		acc.pending.Add(-1)
		res := sip.NewResponseFromRequest(req, 503, "Service Unavailable", nil)
		res.AppendHeader(sip.NewHeader("Retry-After", "10"))
		_ = tx.Respond(res)
		return
	}
	defer acc.pending.Add(-1)
	if c, _, _ := ag.callByID(req); c != nil {
		ag.respond(req, tx, 482, "Loop Detected")
		return
	}
	_ = tx.Respond(sip.NewResponseFromRequest(req, 100, "Trying", nil))
	c := ag.newCall(acc, req)
	c.run(req, tx)
}

func (ag *agent) newCall(acc *account, req *sip.Request) *call {
	c := &call{ag: ag, acc: acc, acked: make(chan struct{}), src: req.Source()}
	from, to := req.From(), req.To()
	viaHost, viaPort := acc.reg.sentBy()
	c.a = leg{
		callID: string(*req.CallID()), localTag: sip.GenerateTagN(16), remoteTag: fromTag(req),
		localURI: to.Address, remoteURI: from.Address, cseq: uint32(rand.IntN(10000)) + 1, //nolint:gosec // not a secret
		transport: req.Transport(), viaHost: viaHost, viaPort: viaPort, contact: acc.reg.contactURI(),
		lastSDP: req.Body(), contentType: contentType(req),
	}
	if ct := req.Contact(); ct != nil {
		c.a.remoteTarget = ct.Address
	} else {
		c.a.remoteTarget = from.Address
	}
	for _, h := range req.GetHeaders("Record-Route") {
		if rr, ok := h.(*sip.RecordRouteHeader); ok {
			c.a.routes = append(c.a.routes, rr.Address)
		}
	}
	c.a.dest = c.legADest()
	// Every response to the provider carries our tag.
	to.Params.Add("tag", c.a.localTag)
	if h := req.GetHeader("Session-Expires"); h != nil {
		c.sessExp = strings.TrimSpace(strings.Split(h.Value(), ";")[0])
	}
	if h := req.GetHeader("Supported"); h != nil && strings.Contains(strings.ToLower(h.Value()), "timer") {
		c.aTimer = true
	}

	lkHost, lkPortS, _ := net.SplitHostPort(ag.lkAddr)
	lkPort, _ := strconv.Atoi(lkPortS)
	callee := sip.Uri{Scheme: "sip", User: acc.Number, Host: lkHost, Port: lkPort}
	cp := sip.NewParams()
	cp.Add("transport", "udp")
	c.b = leg{
		callID: uuid.NewString(), localTag: sip.GenerateTagN(16), localURI: from.Address, remoteURI: callee, remoteTarget: callee,
		cseq: 1, transport: "UDP", viaHost: ag.lkLocal, viaPort: ag.port, dest: ag.lkAddr,
		contact: sip.Uri{Scheme: "sip", User: "b" + strings.ReplaceAll(uuid.NewString(), "-", "")[:16], Host: ag.lkLocal, Port: ag.port, UriParams: cp},
	}
	c.b.localURI.UriParams, c.b.localURI.Headers = nil, nil
	ag.mu.Lock()
	ag.calls[c.a.callID] = c
	ag.calls[c.b.callID] = c
	ag.mu.Unlock()
	return c
}

// legADest: where requests to the provider go. In flow mode back over the flow the INVITE came
// on (RFC 5626 §5.3: the NAT lets nothing else in, and a TCP flow is the only connection);
// otherwise its Contact (or first route) when that is one of the account's addresses, else the
// address the INVITE came from (never a third host).
func (c *call) legADest() string {
	if c.ag.flowMode {
		return c.src
	}
	target := c.a.remoteTarget
	if len(c.a.routes) > 0 {
		target = c.a.routes[0]
	}
	if ip, err := netip.ParseAddr(target.Host); err == nil && c.acc.allows(ip.Unmap()) {
		port := target.Port
		if port == 0 {
			port = sip.DefaultPort(c.a.transport)
		}
		return net.JoinHostPort(target.Host, strconv.Itoa(port))
	}
	return c.src
}

func contentType(m interface{ ContentType() *sip.ContentTypeHeader }) string {
	if h := m.ContentType(); h != nil {
		return h.Value()
	}
	return ""
}

// request builds an in-dialog request on l.
func (c *call) request(l *leg, method sip.RequestMethod, body []byte, ctype string) *sip.Request {
	req := sip.NewRequest(method, l.remoteTarget)
	req.SetTransport(l.transport)
	req.SetDestination(l.dest)
	req.AppendHeader(newVia(l.transport, l.viaHost, l.viaPort))
	mf := sip.MaxForwardsHeader(70)
	req.AppendHeader(&mf)
	fp := sip.NewParams()
	fp.Add("tag", l.localTag)
	req.AppendHeader(&sip.FromHeader{Address: l.localURI, Params: fp})
	tp := sip.NewParams()
	if l.remoteTag != "" {
		tp.Add("tag", l.remoteTag)
	}
	req.AppendHeader(&sip.ToHeader{Address: l.remoteURI, Params: tp})
	cid := sip.CallIDHeader(l.callID)
	req.AppendHeader(&cid)
	c.mu.Lock()
	if method != sip.ACK && method != sip.CANCEL {
		l.cseq++
	}
	seq := l.cseq
	c.mu.Unlock()
	req.AppendHeader(&sip.CSeqHeader{SeqNo: seq, MethodName: method})
	for _, r := range l.routes {
		req.AppendHeader(&sip.RouteHeader{Address: r})
	}
	if method == sip.INVITE || method == sip.UPDATE {
		req.AppendHeader(&sip.ContactHeader{Address: l.contact, Params: sip.NewParams()})
	}
	req.AppendHeader(sip.NewHeader("User-Agent", userAgent))
	if len(body) > 0 && ctype != "" {
		ct := sip.ContentTypeHeader(ctype)
		req.AppendHeader(&ct)
	}
	req.SetBody(body)
	return req
}

// run takes leg A's INVITE through leg B to its final answer.
func (c *call) run(aReq *sip.Request, aTx sip.ServerTransaction) {
	ag := c.ag
	breq := sip.NewRequest(sip.INVITE, c.b.remoteTarget)
	breq.SetTransport("UDP")
	breq.SetDestination(ag.lkAddr)
	breq.AppendHeader(newVia("UDP", c.b.viaHost, c.b.viaPort))
	mf := sip.MaxForwardsHeader(70)
	breq.AppendHeader(&mf)
	fp := sip.NewParams()
	fp.Add("tag", c.b.localTag)
	breq.AppendHeader(&sip.FromHeader{DisplayName: aReq.From().DisplayName, Address: c.b.localURI, Params: fp})
	breq.AppendHeader(&sip.ToHeader{Address: c.b.remoteURI, Params: sip.NewParams()})
	cid := sip.CallIDHeader(c.b.callID)
	breq.AppendHeader(&cid)
	breq.AppendHeader(&sip.CSeqHeader{SeqNo: c.b.cseq, MethodName: sip.INVITE})
	breq.AppendHeader(&sip.ContactHeader{Address: c.b.contact, Params: sip.NewParams()})
	for _, name := range copiedHeaders {
		for _, h := range aReq.GetHeaders(name) {
			breq.AppendHeader(sip.NewHeader(name, h.Value()))
		}
	}
	breq.AppendHeader(sip.NewHeader(providerCallHeader, c.a.callID))
	breq.AppendHeader(sip.NewHeader("Allow", allowMethods))
	breq.AppendHeader(sip.NewHeader("User-Agent", userAgent))
	if ct := contentType(aReq); ct != "" {
		h := sip.ContentTypeHeader(ct)
		breq.AppendHeader(&h)
	}
	breq.SetBody(aReq.Body())

	ag.emit(sipregwire.Event{Op: sipregwire.OpInvite, WS: c.acc.WS, ProviderCallID: c.a.callID, LegBCallID: c.b.callID,
		From: aReq.From().Address.User, To: aReq.To().Address.User, Source: srcAddr(aReq).String()})
	slog.Info("sipreg: inbound call", "ws", c.acc.WS, "provider_call_id", c.a.callID, "leg_b_call_id", c.b.callID,
		"from", maskNumber(aReq.From().Address.User), "source", srcAddr(aReq).String())

	if st, ok := aTx.(*sip.ServerTx); ok {
		st.OnCancel(func(*sip.Request) { c.onCancelA() })
	}
	code := c.inviteB(aReq, aTx, breq)
	ag.emit(sipregwire.Event{Op: sipregwire.OpInviteResult, WS: c.acc.WS, ProviderCallID: c.a.callID, Code: code})
	if code < 200 || code >= 300 {
		c.forget()
	}
}

// inviteB runs leg B's INVITE (answering one digest challenge) and answers leg A; it returns the
// final code leg A got.
func (c *call) inviteB(aReq *sip.Request, aTx sip.ServerTransaction, breq *sip.Request) int {
	ag := c.ag
	ctx, cancel := context.WithTimeout(ag.ctx, ag.t.legBFinal)
	defer cancel()
	challenged := false
	for {
		c.mu.Lock()
		c.bInvite, c.gotProv = breq, false
		c.mu.Unlock()
		tx, err := ag.cli.TransactionRequest(ctx, breq, ag.prebuilt)
		if err != nil {
			return c.failA(aReq, aTx, 503)
		}
		noAnswer := time.NewTimer(ag.t.legBNoAnswer)
		var final *sip.Response
	wait:
		for {
			select {
			case res := <-tx.Responses():
				noAnswer.Stop()
				if res.IsProvisional() {
					c.onProvisional(aReq, aTx, res)
					continue
				}
				final = res
				break wait
			case <-noAnswer.C:
				slog.Warn("sipreg: LiveKit SIP does not answer", "ws", c.acc.WS, "leg_b_call_id", c.b.callID)
				c.sendCancelB()
				tx.Terminate()
				return c.failA(aReq, aTx, 503)
			case <-tx.Done():
				noAnswer.Stop()
				return c.failA(aReq, aTx, 503)
			case <-ctx.Done():
				noAnswer.Stop()
				c.sendCancelB()
				tx.Terminate()
				return c.failA(aReq, aTx, 408)
			}
		}
		if (final.StatusCode == 401 || final.StatusCode == 407) && !challenged {
			challenged = true
			tx.Terminate()
			if _, err := authorize(breq, final, c.acc.TrunkUser, c.acc.TrunkPassword); err != nil {
				return c.failA(aReq, aTx, 503)
			}
			c.mu.Lock()
			c.b.cseq++
			breq.CSeq().SeqNo = c.b.cseq
			c.mu.Unlock()
			breq.RemoveHeader("Via")
			breq.PrependHeader(newVia("UDP", c.b.viaHost, c.b.viaPort))
			c.mu.Lock()
			cancelled := c.cancelled
			c.mu.Unlock()
			if cancelled {
				return 487
			}
			continue
		}
		if final.IsSuccess() {
			go c.drainB(tx)
			return c.answered(aReq, aTx, final)
		}
		tx.Terminate()
		code := final.StatusCode
		if code == 401 || code == 407 {
			slog.Warn("sipreg: LiveKit SIP refused the trunk credentials", "ws", c.acc.WS)
			code = 503
		}
		return c.failA(aReq, aTx, code)
	}
}

// drainB re-ACKs retransmitted 2xx of leg B's INVITE while its transaction lives.
func (c *call) drainB(tx sip.ClientTransaction) {
	defer tx.Terminate()
	for {
		select {
		case res := <-tx.Responses():
			if res.IsSuccess() {
				c.ackB(res)
			}
		case <-tx.Done():
			return
		}
	}
}

func (c *call) onProvisional(aReq *sip.Request, aTx sip.ServerTransaction, res *sip.Response) {
	c.mu.Lock()
	c.gotProv = true
	cancelled, sent := c.cancelled, c.cancelOut
	c.mu.Unlock()
	if cancelled && !sent {
		c.sendCancelB()
		return
	}
	if res.StatusCode == 100 || cancelled {
		return
	}
	var body []byte
	if res.StatusCode == 183 {
		body = res.Body()
	}
	out := sip.NewResponseFromRequest(aReq, res.StatusCode, res.Reason, body)
	out.AppendHeader(&sip.ContactHeader{Address: c.a.contact, Params: sip.NewParams()})
	if len(body) > 0 {
		if ct := contentType(res); ct != "" {
			h := sip.ContentTypeHeader(ct)
			out.AppendHeader(&h)
		}
	}
	_ = aTx.Respond(out)
}

// failA answers leg A with a final error (unless the provider cancelled: it got 487).
func (c *call) failA(aReq *sip.Request, aTx sip.ServerTransaction, code int) int {
	c.mu.Lock()
	cancelled := c.cancelled
	c.mu.Unlock()
	if cancelled {
		return 487
	}
	reason := map[int]string{404: "Not Found", 408: "Request Timeout", 480: "Temporarily Unavailable", 486: "Busy Here",
		487: "Request Terminated", 503: "Service Unavailable", 603: "Decline"}[code]
	if reason == "" {
		reason = "Call Failed"
	}
	if code < 300 || code > 699 {
		code, reason = 500, "Server Internal Error"
	}
	res := sip.NewResponseFromRequest(aReq, code, reason, nil)
	if code == 503 {
		res.AppendHeader(sip.NewHeader("Retry-After", "30"))
	}
	_ = aTx.Respond(res)
	return code
}

// answered: LiveKit SIP took the call — ACK leg B, answer leg A with its SDP and wait for the
// provider's ACK (retransmitting the 2xx over UDP).
func (c *call) answered(aReq *sip.Request, aTx sip.ServerTransaction, res *sip.Response) int {
	c.mu.Lock()
	c.b.remoteTag, _ = res.To().Params.Get("tag")
	if ct := res.Contact(); ct != nil {
		c.b.remoteTarget = ct.Address
	}
	c.b.routes = nil
	rrs := res.GetHeaders("Record-Route")
	for i := len(rrs) - 1; i >= 0; i-- {
		if rr, ok := rrs[i].(*sip.RecordRouteHeader); ok {
			c.b.routes = append(c.b.routes, rr.Address)
		}
	}
	c.b.lastSDP, c.b.contentType = res.Body(), contentType(res)
	cancelled := c.cancelled
	c.mu.Unlock()
	c.ackB(res)
	if cancelled {
		go c.hangup("provider")
		return 487
	}
	out := c.okA(aReq, res.Body(), c.b.contentType)
	if err := aTx.Respond(out); err != nil {
		go c.hangup("provider")
		return 500
	}
	slog.Info("sipreg: call answered", "ws", c.acc.WS, "provider_call_id", c.a.callID)
	if !sip.IsReliable(c.a.transport) {
		go c.retransmitOK(aTx, out)
	}
	return 200
}

// okA is a 2xx to the provider (the INVITE or a re-INVITE) with our Contact and the session
// timer mirrored (the provider refreshes; refreshes are answered here).
func (c *call) okA(req *sip.Request, body []byte, ctype string) *sip.Response {
	out := sip.NewResponseFromRequest(req, 200, "OK", body)
	out.AppendHeader(&sip.ContactHeader{Address: c.a.contact, Params: sip.NewParams()})
	out.AppendHeader(sip.NewHeader("Allow", allowMethods))
	if c.sessExp != "" {
		out.AppendHeader(sip.NewHeader("Session-Expires", c.sessExp+";refresher=uac"))
		if c.aTimer {
			out.AppendHeader(sip.NewHeader("Require", "timer"))
		}
	}
	if len(body) > 0 && ctype != "" {
		h := sip.ContentTypeHeader(ctype)
		out.AppendHeader(&h)
	}
	return out
}

func (c *call) retransmitOK(aTx sip.ServerTransaction, out *sip.Response) {
	every := 500 * time.Millisecond
	deadline := time.After(c.ag.t.ackWait)
	for {
		select {
		case <-c.acked:
			return
		case <-deadline:
			slog.Warn("sipreg: no ACK from the provider, hanging up", "ws", c.acc.WS, "provider_call_id", c.a.callID)
			c.hangup("provider")
			return
		case <-time.After(every):
			_ = aTx.Respond(out)
			every = min(every*2, 4*time.Second)
		}
	}
}

// ackB sends (or re-sends) the ACK of leg B's 2xx.
func (c *call) ackB(res *sip.Response) {
	c.mu.Lock()
	ack := c.bAck
	if ack == nil {
		inv := c.bInvite
		ack = sip.NewRequest(sip.ACK, c.b.remoteTarget)
		ack.SetTransport("UDP")
		ack.SetDestination(c.ag.lkAddr)
		ack.AppendHeader(newVia("UDP", c.b.viaHost, c.b.viaPort))
		mf := sip.MaxForwardsHeader(70)
		ack.AppendHeader(&mf)
		fp := sip.NewParams()
		fp.Add("tag", c.b.localTag)
		ack.AppendHeader(&sip.FromHeader{Address: c.b.localURI, Params: fp})
		tp := sip.NewParams()
		if t, _ := res.To().Params.Get("tag"); t != "" {
			tp.Add("tag", t)
		}
		ack.AppendHeader(&sip.ToHeader{Address: c.b.remoteURI, Params: tp})
		cid := sip.CallIDHeader(c.b.callID)
		ack.AppendHeader(&cid)
		seq := c.b.cseq
		if inv != nil && inv.CSeq() != nil {
			seq = inv.CSeq().SeqNo
		}
		ack.AppendHeader(&sip.CSeqHeader{SeqNo: seq, MethodName: sip.ACK})
		for _, r := range c.b.routes {
			ack.AppendHeader(&sip.RouteHeader{Address: r})
		}
		ack.SetBody(nil)
		c.bAck = ack
	}
	c.mu.Unlock()
	_ = c.ag.cli.WriteRequest(ack, c.ag.prebuilt)
}

// onCancelA: the provider cancelled before the answer (sipgo already sent 200 / 487).
func (c *call) onCancelA() {
	c.mu.Lock()
	c.cancelled = true
	prov := c.gotProv
	c.mu.Unlock()
	slog.Info("sipreg: call cancelled by the provider", "ws", c.acc.WS, "provider_call_id", c.a.callID)
	if prov {
		c.sendCancelB()
	}
}

// sendCancelB cancels leg B's INVITE (once).
func (c *call) sendCancelB() {
	c.mu.Lock()
	inv := c.bInvite
	if c.cancelOut || inv == nil {
		c.mu.Unlock()
		return
	}
	c.cancelOut = true
	c.mu.Unlock()
	cr := sip.NewRequest(sip.CANCEL, inv.Recipient)
	cr.SetTransport("UDP")
	cr.SetDestination(c.ag.lkAddr)
	cr.AppendHeader(sip.HeaderClone(inv.Via()))
	mf := sip.MaxForwardsHeader(70)
	cr.AppendHeader(&mf)
	cr.AppendHeader(sip.HeaderClone(inv.From()))
	cr.AppendHeader(sip.HeaderClone(inv.To()))
	cr.AppendHeader(sip.HeaderClone(inv.CallID()))
	cr.AppendHeader(&sip.CSeqHeader{SeqNo: inv.CSeq().SeqNo, MethodName: sip.CANCEL})
	cr.SetBody(nil)
	go func() { _, _ = c.ag.do(c.ag.ctx, cr, c.ag.t.requestWait) }()
}

// ---------------------------------------------------------------- in the dialog

func (ag *agent) onAck(req *sip.Request, _ sip.ServerTransaction) {
	c, from, _ := ag.callByID(req)
	if c == nil || from != &c.a {
		return
	}
	c.ackOnce.Do(func() { close(c.acked) })
}

func (ag *agent) onBye(req *sip.Request, tx sip.ServerTransaction) {
	c, from, to := ag.callByID(req)
	if c == nil {
		if ag.providerSource(req) || srcAddr(req).IsLoopback() {
			ag.respond(req, tx, 481, "Call/Transaction Does Not Exist")
		}
		return
	}
	ag.respond(req, tx, 200, "OK")
	by := "provider"
	if from == &c.b {
		by = "livekit"
	}
	c.mu.Lock()
	if c.ended {
		c.mu.Unlock()
		return
	}
	c.ended = true
	c.mu.Unlock()
	slog.Info("sipreg: call ended", "ws", c.acc.WS, "provider_call_id", c.a.callID, "by", by)
	_, _ = ag.do(ag.ctx, c.request(to, sip.BYE, nil, ""), ag.t.requestWait)
	c.finish(by)
}

// hangup ends both legs from here (no ACK, a cancelled call answered anyway).
func (c *call) hangup(by string) {
	c.mu.Lock()
	if c.ended {
		c.mu.Unlock()
		return
	}
	c.ended = true
	answeredA := c.a.remoteTag != "" && !c.cancelled
	c.mu.Unlock()
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		_, _ = c.ag.do(c.ag.ctx, c.request(&c.b, sip.BYE, nil, ""), c.ag.t.requestWait)
	}()
	if answeredA {
		_, _ = c.ag.do(c.ag.ctx, c.request(&c.a, sip.BYE, nil, ""), c.ag.t.requestWait)
	}
	wg.Wait()
	c.finish(by)
}

func (c *call) finish(by string) {
	c.ag.emit(sipregwire.Event{Op: sipregwire.OpBye, WS: c.acc.WS, ProviderCallID: c.a.callID, By: by})
	c.forget()
}

func (c *call) forget() {
	c.ag.mu.Lock()
	delete(c.ag.calls, c.a.callID)
	delete(c.ag.calls, c.b.callID)
	c.ag.mu.Unlock()
}

// relay sends req's counterpart on to and answers the original with its final code (and body).
func (c *call) relay(req *sip.Request, tx sip.ServerTransaction, to *leg) {
	res, err := c.ag.do(c.ag.ctx, c.request(to, req.Method, req.Body(), contentType(req)), c.ag.t.requestWait)
	if err != nil {
		c.ag.respond(req, tx, 408, "Request Timeout")
		return
	}
	out := sip.NewResponseFromRequest(req, res.StatusCode, res.Reason, res.Body())
	if ct := contentType(res); ct != "" && len(res.Body()) > 0 {
		h := sip.ContentTypeHeader(ct)
		out.AppendHeader(&h)
	}
	_ = tx.Respond(out)
}

// onForward: INFO (DTMF) and other in-dialog requests cross to the other leg.
func (ag *agent) onForward(req *sip.Request, tx sip.ServerTransaction) {
	c, _, to := ag.callByID(req)
	if c == nil {
		if ag.providerSource(req) || srcAddr(req).IsLoopback() {
			ag.respond(req, tx, 481, "Call/Transaction Does Not Exist")
		}
		return
	}
	c.relay(req, tx, to)
}

// onUpdate: a session refresh without SDP is answered here; an UPDATE with SDP crosses over.
func (ag *agent) onUpdate(req *sip.Request, tx sip.ServerTransaction) {
	c, from, to := ag.callByID(req)
	if c == nil {
		if ag.providerSource(req) || srcAddr(req).IsLoopback() {
			ag.respond(req, tx, 481, "Call/Transaction Does Not Exist")
		}
		return
	}
	if len(req.Body()) == 0 {
		if from == &c.a {
			_ = tx.Respond(c.okA(req, nil, ""))
		} else {
			ag.respond(req, tx, 200, "OK")
		}
		return
	}
	c.relay(req, tx, to)
}

// reinvite: the provider's re-INVITE with the SDP it already sent (a session refresh) is
// answered here with LiveKit's SDP; a new SDP (hold, a codec change) crosses to leg B.
func (c *call) reinvite(req *sip.Request, tx sip.ServerTransaction, from, to *leg) {
	c.mu.Lock()
	same := len(req.Body()) == 0 || bytes.Equal(req.Body(), from.lastSDP)
	answer, answerType := to.lastSDP, to.contentType
	c.mu.Unlock()
	if same && from == &c.a {
		_ = tx.Respond(c.okA(req, answer, answerType))
		return
	}
	breq := c.request(to, sip.INVITE, req.Body(), contentType(req))
	res, err := c.ag.do(c.ag.ctx, breq, c.ag.t.requestWait*2)
	if err != nil {
		c.ag.respond(req, tx, 408, "Request Timeout")
		return
	}
	if res.IsSuccess() {
		ack := c.request(to, sip.ACK, nil, "")
		ack.CSeq().SeqNo = breq.CSeq().SeqNo
		_ = c.ag.cli.WriteRequest(ack, c.ag.prebuilt)
		c.mu.Lock()
		from.lastSDP = slices.Clone(req.Body())
		to.lastSDP, to.contentType = res.Body(), contentType(res)
		c.mu.Unlock()
		if from == &c.a {
			_ = tx.Respond(c.okA(req, res.Body(), contentType(res)))
			return
		}
		out := sip.NewResponseFromRequest(req, 200, "OK", res.Body())
		out.AppendHeader(&sip.ContactHeader{Address: from.contact, Params: sip.NewParams()})
		if ct := contentType(res); ct != "" {
			h := sip.ContentTypeHeader(ct)
			out.AppendHeader(&h)
		}
		_ = tx.Respond(out)
		return
	}
	c.ag.respond(req, tx, res.StatusCode, res.Reason)
}

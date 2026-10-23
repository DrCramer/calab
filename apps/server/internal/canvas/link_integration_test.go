//go:build integration

package canvas

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/redisx"
	"github.com/calaba/calaba/server/internal/ysync"
)

var codeRe = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

// addrs are client addresses of one test run: the anonymous socket sets are keyed by the client
// IP across links and outlive a run by their TTL, so every run takes its own addresses.
type addrs struct{ a, b byte }

func newAddrs() addrs {
	u := uuid.New()
	return addrs{u[0], u[1]}
}

// v4 is an IPv4 address of the run, v6 one of the /64 number net of the run.
func (x addrs) v4(n int) string { return fmt.Sprintf("10.%d.%d.%d", x.a, x.b, n) }
func (x addrs) v6(net int, host string) string {
	return fmt.Sprintf("2001:db8:%02x%02x:%x::%s", x.a, x.b, net, host)
}

func linkPath(id string) string     { return item(id) + "/link" }
func publicPath(code string) string { return "/api/public/canvas/" + code }

// link makes (or changes) the public link of a canvas as user.
func (e *env) link(user uuid.UUID, id string, days uint32, want int) *v1.CanvasLinkResponse {
	e.t.Helper()
	var out v1.CanvasLinkResponse
	e.must(want, user, "POST", linkPath(id), &v1.CreateCanvasLinkRequest{ExpiresInDays: days}, &out)
	return &out
}

func (e *env) exec(sql string, args ...any) {
	e.t.Helper()
	if _, err := e.d.Pool.Exec(context.Background(), sql, args...); err != nil {
		e.t.Fatal(err)
	}
}

func (e *env) count(sql string, args ...any) int {
	e.t.Helper()
	var n int
	if err := e.d.Pool.QueryRow(context.Background(), sql, args...).Scan(&n); err != nil {
		e.t.Fatal(err)
	}
	return n
}

// public is the service behind the client-IP middleware: X-Forwarded-For from the loopback
// peer is the client's address (as behind the production proxy).
func (e *env) public() *httptest.Server {
	e.t.Helper()
	loop := []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8"), netip.MustParsePrefix("::1/128")}
	srv := httptest.NewServer(httpx.WithClientIP(loop)(e.mux))
	e.t.Cleanup(srv.Close)
	return srv
}

// view opens the anonymous socket of a link from client address ip: no token frame at all.
func (e *env) view(srv *httptest.Server, code, ip string) *client {
	e.t.Helper()
	ws, status := e.dialView(srv, code, ip)
	if ws == nil {
		e.t.Fatalf("anonymous socket refused: %d", status)
	}
	return &client{t: e.t, ws: ws}
}

func (e *env) dialView(srv *httptest.Server, code, ip string) (*websocket.Conn, int) {
	e.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + publicPath(code) + "/sync"
	ws, resp, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPHeader: http.Header{"X-Forwarded-For": {ip}}})
	status := 0
	if resp != nil {
		status = resp.StatusCode
		if resp.Body != nil {
			_ = resp.Body.Close()
		}
	}
	if err != nil {
		return nil, status
	}
	ws.SetReadLimit(8 << 20)
	e.t.Cleanup(func() { _ = ws.CloseNow() })
	return ws, status
}

// The link is managed by the owner of the canvas or CANVAS_MANAGE only; a writer, a viewer, a
// guest, an outsider cannot (404 without CANVAS_VIEW); not for a folder, the trash, a restricted
// canvas or one below a restricted folder; one live link per canvas, its code random and fixed
// while it lives; the journal records it.
func TestCanvasLinkManage(t *testing.T) {
	e := newEnv(t, ysync.Config{})
	e.svc.PublicURL = "https://app.test"
	c := e.create(e.alice, "", "Board")
	var none v1.CanvasLinkResponse
	e.must(200, e.alice, "GET", linkPath(c.GetId()), nil, &none)
	if none.GetLink() != nil || none.GetUrl() != "" {
		t.Fatalf("a link before any: %v", &none)
	}
	l := e.link(e.alice, c.GetId(), 0, 201)
	code := l.GetLink().GetCode()
	if !codeRe.MatchString(code) || l.GetUrl() != "https://app.test/c/"+code || l.GetLink().GetExpiresAt() != nil {
		t.Fatalf("link %v", l)
	}
	// While it lives a POST changes its expiry and keeps the code.
	l7 := e.link(e.alice, c.GetId(), 7, 200)
	if l7.GetLink().GetCode() != code || l7.GetLink().GetExpiresAt() == nil ||
		time.Until(l7.GetLink().GetExpiresAt().AsTime()) < 6*24*time.Hour {
		t.Fatalf("changed link %v", l7)
	}
	e.must(422, e.alice, "POST", linkPath(c.GetId()), &v1.CreateCanvasLinkRequest{ExpiresInDays: 3}, nil)
	// A member with CANVAS_WRITE and a viewer may not; the workspace admin (CANVAS_MANAGE) may.
	e.must(200, e.alice, "PUT", item(c.GetId())+"/permissions", &v1.UpdateCanvasPermissionsRequest{Entries: []*v1.CanvasPermissionEntry{
		{TargetType: user, TargetId: e.guest.String(), Allow: uint64(perm.CanvasView)}}}, nil)
	for _, u := range []uuid.UUID{e.bob, e.guest} {
		e.must(403, u, "GET", linkPath(c.GetId()), nil, nil)
		e.must(403, u, "POST", linkPath(c.GetId()), &v1.CreateCanvasLinkRequest{}, nil)
		e.must(403, u, "DELETE", linkPath(c.GetId()), nil, nil)
	}
	e.must(404, e.outsider, "GET", linkPath(c.GetId()), nil, nil)
	e.must(404, e.outsider, "POST", linkPath(c.GetId()), &v1.CreateCanvasLinkRequest{}, nil)
	e.must(404, e.outsider, "DELETE", linkPath(c.GetId()), nil, nil)
	var got v1.CanvasLinkResponse
	e.must(200, e.admin, "GET", linkPath(c.GetId()), nil, &got)
	if got.GetLink().GetCode() != code {
		t.Fatalf("admin sees %v", &got)
	}
	// Revoke: 204, then 404; a new link has a new code.
	e.must(204, e.admin, "DELETE", linkPath(c.GetId()), nil, nil)
	e.must(404, e.alice, "DELETE", linkPath(c.GetId()), nil, nil)
	e.must(200, e.alice, "GET", linkPath(c.GetId()), nil, &none)
	if none.GetLink() != nil {
		t.Fatal("a revoked link is still shown")
	}
	codes := map[string]bool{code: true}
	for i := 0; i < 3; i++ {
		n := e.link(e.alice, c.GetId(), 1, 201).GetLink().GetCode()
		if codes[n] || !codeRe.MatchString(n) {
			t.Fatalf("code %q reused or malformed", n)
		}
		codes[n] = true
		e.must(204, e.alice, "DELETE", linkPath(c.GetId()), nil, nil)
	}
	if n := e.count(`SELECT count(*) FROM canvas_links WHERE canvas_id = $1 AND revoked_at IS NULL`, c.GetId()); n != 0 {
		t.Fatalf("%d live links after revoking", n)
	}
	// An expired link that was never revoked does not block a new one.
	e.link(e.alice, c.GetId(), 1, 201)
	e.exec(`UPDATE canvas_links SET expires_at = now() - interval '1 second' WHERE canvas_id = $1`, c.GetId())
	e.must(200, e.alice, "GET", linkPath(c.GetId()), nil, &none)
	if none.GetLink() != nil {
		t.Fatal("an expired link is shown")
	}
	e.link(e.alice, c.GetId(), 0, 201)
	// The journal: link_on / link_off, without the code.
	var acts v1.CanvasActivityPage
	e.must(200, e.alice, "GET", item(c.GetId())+"/activity", nil, &acts)
	on, off := 0, 0
	for _, a := range acts.GetActivities() {
		switch a.GetKind() {
		case v1.CanvasActivityKind_CANVAS_ACTIVITY_KIND_LINK_ON:
			on++
		case v1.CanvasActivityKind_CANVAS_ACTIVITY_KIND_LINK_OFF:
			off++
		}
		if raw, _ := proto.Marshal(a); bytes.Contains(raw, []byte(code)) {
			t.Fatal("the journal carries a link code")
		}
	}
	if on != 6 || off != 4 {
		t.Fatalf("journal link_on %d link_off %d", on, off)
	}

	// Not for a folder, a restricted canvas, one below a restricted folder, one in the trash.
	f := e.mkdir(e.alice, "", "Folder")
	e.must(409, e.alice, "POST", linkPath(f.GetId()), &v1.CreateCanvasLinkRequest{}, nil)
	e.must(409, e.alice, "GET", linkPath(f.GetId()), nil, nil)
	priv := e.create(e.alice, "", "Private")
	e.must(200, e.alice, "PATCH", item(priv.GetId()), &v1.UpdateCanvasItemRequest{Restricted: proto.Bool(true)}, nil)
	w := e.call(e.alice, "POST", linkPath(priv.GetId()), &v1.CreateCanvasLinkRequest{})
	if w.Code != 409 || !strings.Contains(w.Body.String(), "CANVAS_RESTRICTED") {
		t.Fatalf("a link on a restricted canvas: %d %s", w.Code, w.Body.String())
	}
	pf := e.mkdir(e.alice, "", "Private folder")
	e.must(200, e.alice, "PATCH", item(pf.GetId()), &v1.UpdateCanvasItemRequest{Restricted: proto.Bool(true)}, nil)
	inside := e.create(e.alice, pf.GetId(), "Inside")
	e.must(409, e.alice, "POST", linkPath(inside.GetId()), &v1.CreateCanvasLinkRequest{}, nil)
	trashed := e.create(e.alice, "", "Trashed")
	e.must(200, e.alice, "POST", item(trashed.GetId())+"/trash", nil, nil)
	e.must(409, e.alice, "POST", linkPath(trashed.GetId()), &v1.CreateCanvasLinkRequest{}, nil)
	// A suspended workspace: no new link.
	e.exec(`UPDATE workspaces SET suspended_at = now() WHERE id = $1`, e.ws)
	other := c.GetId()
	e.must(403, e.alice, "DELETE", linkPath(other), nil, nil)
	e.must(403, e.alice, "POST", linkPath(other), &v1.CreateCanvasLinkRequest{}, nil)
}

// The anonymous name: noindex / no-store, a view counted per GET (not per HEAD), the same 404 for
// an unknown, malformed, revoked, expired, restricted, trashed, deleted code and a suspended
// workspace; a code opens its own canvas only; the per-IP budget.
func TestCanvasLinkPublicPage(t *testing.T) {
	e := newEnv(t, ysync.Config{})
	a := e.create(e.alice, "", "Alpha")
	b := e.create(e.alice, "", "Beta")
	ca := e.link(e.alice, a.GetId(), 0, 201).GetLink().GetCode()
	cb := e.link(e.alice, b.GetId(), 0, 201).GetLink().GetCode()
	for i := 0; i < 2; i++ {
		w := e.call(uuid.Nil, "GET", publicPath(ca), nil)
		if w.Code != 200 || w.Header().Get("X-Robots-Tag") != "noindex, nofollow" || w.Header().Get("Cache-Control") != "no-store" ||
			w.Header().Get("Referrer-Policy") != "no-referrer" {
			t.Fatalf("public page %d %v", w.Code, w.Header())
		}
	}
	if w := e.call(uuid.Nil, "HEAD", publicPath(ca), nil); w.Code != 200 {
		t.Fatalf("HEAD %d", w.Code)
	}
	var pc v1.PublicCanvas
	e.must(200, uuid.Nil, "GET", publicPath(cb), nil, &pc)
	if pc.GetName() != "Beta" || !pc.GetReadOnly() || pc.GetUpdatedAt() == nil {
		t.Fatalf("public canvas %v", &pc)
	}
	var l v1.CanvasLinkResponse
	e.must(200, e.alice, "GET", linkPath(a.GetId()), nil, &l)
	if l.GetLink().GetViews() != 2 {
		t.Fatalf("views %d, want 2 (HEAD not counted)", l.GetLink().GetViews())
	}

	notFound := func(code, why string) []byte {
		t.Helper()
		w := e.call(uuid.Nil, "GET", publicPath(code), nil)
		if w.Code != 404 || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("%s: %d %s", why, w.Code, w.Body.String())
		}
		return w.Body.Bytes()
	}
	ref := notFound(strings.Repeat("A", CodeLength), "unknown")
	same := func(code, why string) {
		t.Helper()
		if got := notFound(code, why); !bytes.Equal(got, ref) {
			t.Fatalf("%s: %s differs from %s", why, got, ref)
		}
	}
	same("short", "malformed")
	same(strings.Repeat("!", CodeLength), "bad alphabet")
	// Revoked.
	r := e.create(e.alice, "", "Revoked")
	cr := e.link(e.alice, r.GetId(), 0, 201).GetLink().GetCode()
	e.must(204, e.alice, "DELETE", linkPath(r.GetId()), nil, nil)
	same(cr, "revoked")
	// Expired.
	x := e.create(e.alice, "", "Expired")
	cx := e.link(e.alice, x.GetId(), 1, 201).GetLink().GetCode()
	e.exec(`UPDATE canvas_links SET expires_at = now() - interval '1 second' WHERE code = $1`, cx)
	same(cx, "expired")
	// Restricted behind the API's back (the link row stays live): the chain is checked anyway.
	f := e.mkdir(e.alice, "", "Folder")
	in := e.create(e.alice, f.GetId(), "Inside")
	ci := e.link(e.alice, in.GetId(), 0, 201).GetLink().GetCode()
	e.exec(`UPDATE canvas_items SET restricted = true WHERE id = $1`, f.GetId())
	same(ci, "restricted folder")
	// In the trash behind the API's back, and through it (the trash revokes).
	tr := e.create(e.alice, "", "Trash")
	ct := e.link(e.alice, tr.GetId(), 0, 201).GetLink().GetCode()
	e.exec(`UPDATE canvas_items SET trashed_at = now() WHERE id = $1`, tr.GetId())
	same(ct, "trashed")
	e.exec(`UPDATE canvas_items SET trashed_at = NULL WHERE id = $1`, tr.GetId())
	e.must(200, uuid.Nil, "GET", publicPath(ct), nil, nil)
	e.must(200, e.alice, "POST", item(tr.GetId())+"/trash", nil, nil)
	same(ct, "trashed by the API")
	e.must(200, e.alice, "POST", item(tr.GetId())+"/restore", nil, nil)
	same(ct, "restored after the trash: the link stays revoked")
	// Deleted forever: CASCADE.
	e.must(200, e.alice, "POST", item(tr.GetId())+"/trash", nil, nil)
	e.must(204, e.alice, "DELETE", item(tr.GetId()), nil, nil)
	if n := e.count(`SELECT count(*) FROM canvas_links WHERE canvas_id = $1`, tr.GetId()); n != 0 {
		t.Fatalf("links of a deleted canvas: %d", n)
	}
	same(ct, "deleted")
	// The per-IP budget (60 per minute in production).
	e.svc.LinkReadLimit = redisx.NewRateLimiter(e.rc, "rl:test-canvas-link:"+uuid.NewString()+":", 2, 0.001)
	e.must(200, uuid.Nil, "GET", publicPath(cb), nil, nil)
	e.must(200, uuid.Nil, "GET", publicPath(cb), nil, nil)
	e.must(429, uuid.Nil, "GET", publicPath(cb), nil, nil)
	e.svc.LinkReadLimit = nil
	// A suspended workspace.
	e.exec(`UPDATE workspaces SET suspended_at = now() WHERE id = $1`, e.ws)
	same(ca, "suspended")
}

// The anonymous socket: the snapshot and every update of a writer, never awareness nor
// COMPACT_REQUEST; any frame from it (UPDATE, SNAPSHOT_POST, AWARENESS, text) closes it 4013 and
// changes nothing; a refused code is a plain 404 before the upgrade; a code reads its own canvas.
func TestCanvasLinkSocketReceiveOnly(t *testing.T) {
	e := newEnv(t, ysync.Config{CompactUpdates: 1, CompactCheckEvery: -1, CompactCooldown: time.Millisecond})
	srv := e.public()
	ip := newAddrs()
	c := e.create(e.alice, "", "Live")
	other := e.create(e.alice, "", "Other")
	code := e.link(e.alice, c.GetId(), 0, 201).GetLink().GetCode()
	e.link(e.alice, other.GetId(), 0, 201)
	w := e.dial(e.alice, c.GetId())
	w.next(frameSnapshot)
	w.send(updateFrame(0, []byte("u1;")))
	w.next(frameUpdate)
	ow := e.dial(e.alice, other.GetId())
	ow.next(frameSnapshot)
	ow.send(updateFrame(0, []byte("other;")))
	ow.next(frameUpdate)

	v := e.view(srv, code, ip.v4(1))
	var rv replica
	v.catchUp(&rv, 1)
	if string(rv.doc[len(ysync.EmptyState):]) != "u1;" {
		t.Fatalf("viewer got %q", rv.doc)
	}
	// Awareness of a member is not relayed to the viewer, a later update is.
	w.send([]byte{frameAwareness, 9, 9})
	w.send(updateFrame(0, []byte("u2;")))
	w.send(updateFrame(0, []byte("u3;")))
	for rv.last < 3 {
		rv.apply(t, v.next(frameUpdate)) // a COMPACT_REQUEST or an AWARENESS here fails apply
	}
	if string(rv.doc[len(ysync.EmptyState):]) != "u1;u2;u3;" {
		t.Fatalf("viewer doc %q", rv.doc)
	}
	// The writer was asked to compact (CompactUpdates 1); the viewer was not (checked above).
	for {
		f, _ := w.read()
		if f == nil {
			t.Fatal("writer closed")
		}
		if f[0] == frameCompact {
			break
		}
	}
	before := e.count(`SELECT count(*) FROM canvas_updates WHERE canvas_id = $1`, c.GetId())
	sent := map[string][]byte{
		"update":        updateFrame(0, []byte("evil;")),
		"snapshot post": post(3, snapshotMeta{PlainText: "evil"}, []byte("evil")),
		"awareness":     {frameAwareness, 1, 2, 3},
		"unknown":       {0x7F},
	}
	for what, f := range sent {
		t.Log("a viewer sends", what)
		x := e.view(srv, code, ip.v4(2))
		x.next(frameSnapshot)
		x.send(f)
		x.closed(ysync.CloseReceiveOnly)
	}
	tx := e.view(srv, code, ip.v4(3))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := tx.ws.Write(ctx, websocket.MessageText, []byte(e.alice.String())); err != nil { // a token is no use either
		t.Fatal(err)
	}
	tx.closed(ysync.CloseReceiveOnly)
	if after := e.count(`SELECT count(*) FROM canvas_updates WHERE canvas_id = $1`, c.GetId()); after != before {
		t.Fatalf("the viewers changed the updates: %d → %d", before, after)
	}
	if n := e.count(`SELECT count(*) FROM canvas_snapshots WHERE canvas_id = $1`, c.GetId()); n != 0 {
		t.Fatalf("a viewer stored a snapshot (%d)", n)
	}
	// The writer still writes, a fresh viewer reads it; nothing of the other canvas comes along.
	w.send(updateFrame(0, []byte("u4;")))
	v.next(frameUpdate)
	y := e.view(srv, code, ip.v4(4))
	var ry replica
	y.catchUp(&ry, 4)
	if bytes.Contains(ry.doc, []byte("other;")) || bytes.Contains(ry.doc, []byte("evil")) {
		t.Fatalf("viewer doc %q", ry.doc)
	}
	// A refused code is a 404 before any upgrade.
	for _, bad := range []string{strings.Repeat("A", CodeLength), "short"} {
		if ws, status := e.dialView(srv, bad, ip.v4(5)); ws != nil || status != http.StatusNotFound {
			t.Fatalf("code %q: upgraded=%v status %d", bad, ws != nil, status)
		}
	}
}

// A revoke, an expiry, the trash, restricted (on the canvas or a folder above, a move into a
// restricted folder) close the live anonymous sockets within seconds; the links stay revoked.
func TestCanvasLinkSocketCloses(t *testing.T) {
	e := newEnv(t, ysync.Config{})
	srv := e.public()
	ip := newAddrs()
	open := func(parent, name string) (*v1.CanvasItem, string, *client) {
		t.Helper()
		c := e.create(e.alice, parent, name)
		code := e.link(e.alice, c.GetId(), 0, 201).GetLink().GetCode()
		v := e.view(srv, code, ip.v4(1))
		v.next(frameSnapshot)
		return c, code, v
	}
	// A member's socket on the same canvas is not affected by a revoke.
	c, _, v := open("", "Revoke")
	m := e.dial(e.bob, c.GetId())
	m.next(frameSnapshot)
	e.must(204, e.alice, "DELETE", linkPath(c.GetId()), nil, nil)
	v.closed(ysync.CloseNotFound)
	m.quiet(e.dial(e.alice, c.GetId()))

	// Expiry: the socket's own timer, no event at all.
	c2 := e.create(e.alice, "", "Expiry")
	code2 := e.link(e.alice, c2.GetId(), 1, 201).GetLink().GetCode()
	e.exec(`UPDATE canvas_links SET expires_at = now() + interval '1500 milliseconds' WHERE code = $1`, code2)
	v2 := e.view(srv, code2, ip.v4(1))
	v2.next(frameSnapshot)
	v2.closed(ysync.CloseNotFound)

	// The trash.
	c3, _, v3 := open("", "Trash")
	e.must(200, e.alice, "POST", item(c3.GetId())+"/trash", nil, nil)
	v3.closed(ysync.CloseNotFound)

	// restricted on the canvas; the link stays revoked when it goes off again.
	c4, _, v4 := open("", "Restricted")
	e.must(200, e.alice, "PATCH", item(c4.GetId()), &v1.UpdateCanvasItemRequest{Restricted: proto.Bool(true)}, nil)
	v4.closed(ysync.CloseNotFound)
	e.must(200, e.alice, "PATCH", item(c4.GetId()), &v1.UpdateCanvasItemRequest{Restricted: proto.Bool(false)}, nil)
	var l v1.CanvasLinkResponse
	e.must(200, e.alice, "GET", linkPath(c4.GetId()), nil, &l)
	if l.GetLink() != nil {
		t.Fatal("a link came back with restricted off")
	}

	// restricted on a folder above (through the permissions route).
	f := e.mkdir(e.alice, "", "Folder")
	c5, _, v5 := open(f.GetId(), "Below")
	e.must(200, e.alice, "PUT", item(f.GetId())+"/permissions", &v1.UpdateCanvasPermissionsRequest{Restricted: proto.Bool(true)}, nil)
	v5.closed(ysync.CloseNotFound)
	if n := e.count(`SELECT count(*) FROM canvas_links WHERE canvas_id = $1 AND revoked_at IS NULL`, c5.GetId()); n != 0 {
		t.Fatal("the link below a restricted folder is live")
	}

	// A move into a restricted folder.
	priv := e.mkdir(e.alice, "", "Private")
	e.must(200, e.alice, "PATCH", item(priv.GetId()), &v1.UpdateCanvasItemRequest{Restricted: proto.Bool(true)}, nil)
	c6, _, v6 := open("", "Moved")
	e.must(200, e.alice, "PATCH", item(c6.GetId()), &v1.UpdateCanvasItemRequest{ParentId: proto.String(priv.GetId())}, nil)
	v6.closed(ysync.CloseNotFound)

	// A change of the expiry reaches a live socket (it re-reads the link): still open.
	c7, _, v7 := open("", "Prolonged")
	e.link(e.alice, c7.GetId(), 30, 200)
	w := e.dial(e.alice, c7.GetId())
	w.next(frameSnapshot)
	w.send(updateFrame(0, []byte("still;")))
	if f := v7.next(frameUpdate); string(f[9:]) != "still;" {
		t.Fatalf("viewer after the expiry change: %x", f)
	}
}

// Socket limits: per link, per client IP (across links; an IPv6 /64 is one client), the connect
// rate per IP; members are not counted.
func TestCanvasLinkSocketLimits(t *testing.T) {
	e := newEnv(t, ysync.Config{})
	e.svc.ViewersPerLink, e.svc.ViewersPerIP = 2, 2
	srv := e.public()
	ip := newAddrs()
	code := func(name string) (*v1.CanvasItem, string) {
		t.Helper()
		c := e.create(e.alice, "", name)
		return c, e.link(e.alice, c.GetId(), 0, 201).GetLink().GetCode()
	}
	a, ca := code("A")
	_, cb := code("B")
	// Per link: two viewers from two addresses, the third is refused.
	for _, addr := range []string{ip.v4(1), ip.v4(2)} {
		e.view(srv, ca, addr).next(frameSnapshot)
	}
	e.view(srv, ca, ip.v4(3)).closed(ysync.CloseRate)
	// Members are not counted: they still connect.
	e.dial(e.alice, a.GetId()).next(frameSnapshot)
	// Per IP across links: 192.0.2.1 holds one on A, gets one on B, the third is refused.
	e.view(srv, cb, ip.v4(1)).next(frameSnapshot)
	e.view(srv, cb, ip.v4(1)).closed(ysync.CloseRate)
	// One IPv6 /64 is one client: two hosts of it hold two sockets, a third host is refused, a
	// host of another /64 is not.
	_, cd := code("D")
	_, ce := code("E")
	_, cf := code("F")
	e.view(srv, cd, ip.v6(1, "1")).next(frameSnapshot)
	e.view(srv, ce, ip.v6(1, "ffff")).next(frameSnapshot)
	e.view(srv, cf, ip.v6(1, "abcd:0:1")).closed(ysync.CloseRate)
	e.view(srv, cf, ip.v6(9, "1")).next(frameSnapshot)
	// Connect rate per IP: a refused connect is a 429 before the upgrade.
	e.svc.LinkSyncLimit = redisx.NewRateLimiter(e.rc, "rl:test-canvas-ws:"+uuid.NewString()+":", 1, 0.001)
	_, cg := code("G")
	e.view(srv, cg, ip.v4(50)).next(frameSnapshot)
	if ws, status := e.dialView(srv, cg, ip.v4(50)); ws != nil || status != http.StatusTooManyRequests {
		t.Fatalf("connect rate: upgraded=%v status %d", ws != nil, status)
	}
	e.view(srv, cg, ip.v4(51)).next(frameSnapshot) // another address has its own budget
}

// A viewer socket lives at most ViewerMaxLife, then closes 4000 (reconnect); a member's does not.
func TestCanvasLinkSocketLife(t *testing.T) {
	e := newEnv(t, ysync.Config{ViewerMaxLife: 1500 * time.Millisecond})
	srv := e.public()
	ip := newAddrs()
	c := e.create(e.alice, "", "Life")
	code := e.link(e.alice, c.GetId(), 0, 201).GetLink().GetCode()
	m := e.dial(e.alice, c.GetId())
	m.next(frameSnapshot)
	v := e.view(srv, code, ip.v4(60))
	v.next(frameSnapshot)
	v.closed(ysync.CloseTryAgain)
	m.quiet(e.dial(e.bob, c.GetId()))
}

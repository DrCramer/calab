//go:build integration

package app_test

import (
	"context"
	"net/http/httptest"
	"net/netip"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/app"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/rtc"
)

// fakeIVR stands in for the IVR worker (ADR-0117 §2): it records the commands.
type fakeIVR struct {
	mu   sync.Mutex
	cmds []string
}

func (f *fakeIVR) add(c string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.cmds = append(f.cmds, c)
	return nil
}

func (f *fakeIVR) Available(context.Context) bool { return true }
func (f *fakeIVR) Join(_ context.Context, call uuid.UUID, room, _ string) error {
	return f.add("join " + call.String() + " " + room)
}
func (f *fakeIVR) Play(_ context.Context, call uuid.UUID, p rtc.IVRPlay) error {
	return f.add("play " + call.String() + " " + p.Builtin + p.FileID)
}
func (f *fakeIVR) Stop(_ context.Context, call uuid.UUID) error {
	return f.add("stop " + call.String())
}
func (f *fakeIVR) Leave(_ context.Context, call uuid.UUID) error {
	return f.add("leave " + call.String())
}

func (f *fakeIVR) has(c string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Contains(f.cmds, c)
}

// inboundApp is a second API instance with an IVR worker (the shared one runs without a worker
// token, so it takes no inbound calls), on the same Postgres and Valkey: its events reach the
// gateways of the shared instance.
func inboundApp(t *testing.T) (*app.App, *httptest.Server, *fakeSIP, *fakeIVR) {
	t.Helper()
	cfg := *testCfg
	cfg.IVRAgentToken = "it-ivr-token"
	fs, agent := &fakeSIP{}, &fakeIVR{}
	a := app.New(app.Deps{Config: &cfg, DB: testDB, Redis: testRedis, Events: events.Redis{C: testRedis}, Blob: testStore, LiveKit: lkRec,
		Mail: testMail, SIP: fs, IVRAgent: agent, UnfurlAllowAddr: func(netip.Addr) bool { return true }})
	server := httptest.NewServer(a.Handler)
	t.Cleanup(server.Close)
	return a, server, fs, agent
}

func inboundLine(number string) *rtc.Participant {
	return &rtc.Participant{Identity: "sip_" + number, Attributes: map[string]string{
		rtc.AttrSIPPhoneNumber: number, rtc.AttrSIPCallID: "SCL_" + uniq(""), rtc.AttrSIPCallStatus: "active", rtc.AttrSIPTrunkNumber: "74951234567",
	}}
}

// TestSIPInboundCall (ADR-0117 §4): the inbound settings, a call to a person's number — the
// ring on the member's devices, accept with a token for the call's room only, the caller
// hanging up — a decline, inbound switched off with a call ringing, and refusals on a server
// without an IVR worker.
func TestSIPInboundCall(t *testing.T) {
	ctx := context.Background()
	a, server, fs, agent := inboundApp(t)
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	wid := ws.GetId()
	setPlan(t, wid, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_ENTERPRISE})
	bob := register(t, invite(t, o, wid))
	carol := register(t, invite(t, o, wid))
	bobG := dialGW(t)
	bobG.identify(bob.token)
	base := "/api/workspaces/" + wid + "/sip"
	o.must(200, "PUT", base, &v1.PutSipSettingsRequest{Enabled: true, Provider: "Zadarma", Host: "203.0.113.10", CallerId: "+74951234567"}, nil)
	var ext v1.SipExtensionResponse
	o.must(201, "POST", base+"/extensions", &v1.CreateSipExtensionRequest{Number: "101", UserId: bob.id}, &ext)
	toBob := &v1.SipRouteTarget{Kind: v1.SipRouteKind_SIP_ROUTE_KIND_EXTENSION, Id: ext.GetExtension().GetId()}

	// The shared instance has no IVR worker: inbound cannot be switched on, a call is refused
	// without a journal row.
	o.wantErr(409, v1.ErrorCode_ERROR_CODE_SIP_DISABLED, "PUT", base+"/inbound", &v1.PutSipInboundRequest{Enabled: true, Target: toBob})
	refused := rtc.InboundRoomPrefix(uuid.MustParse(wid)) + "_+79160000000_" + uniq("")
	if err := testApp.SIP.Inbound(ctx, rtc.EventParticipantJoined, refused, inboundLine("+79160000000")); err != nil {
		t.Fatal(err)
	}
	if _, err := testDB.Q.GetSipCallByLKRoom(ctx, refused); err == nil {
		t.Fatal("a call on a server without an IVR worker was journaled")
	}

	// Settings: MANAGE_INTEGRATIONS only; a target is required; no open ranges.
	pushHTTP(t, server, bob, 403, "PUT", base+"/inbound", &v1.PutSipInboundRequest{Enabled: true, Target: toBob}, nil)
	pushHTTP(t, server, o, 422, "PUT", base+"/inbound", &v1.PutSipInboundRequest{Enabled: true}, nil)
	pushHTTP(t, server, o, 422, "PUT", base+"/inbound", &v1.PutSipInboundRequest{Enabled: true, Target: toBob, AllowedCidrs: []string{"0.0.0.0/0"}}, nil)
	var put v1.PutSipInboundResponse
	pushHTTP(t, server, o, 200, "PUT", base+"/inbound", &v1.PutSipInboundRequest{Enabled: true, Target: toBob, AllowedCidrs: []string{"198.51.100.0/24"}}, &put)
	st := put.GetSettings()
	if !st.GetInboundEnabled() || !st.GetInboundSaved() || st.GetInboundTarget().GetId() != toBob.GetId() || !slices.Equal(st.GetInboundAllowedCidrs(), []string{"198.51.100.0/24"}) {
		t.Fatalf("inbound settings: %v", st)
	}
	fs.mu.Lock()
	if len(fs.inTrunks) != 1 || len(fs.rules) != 1 {
		t.Fatalf("LiveKit objects: %v %v", fs.inTrunks, fs.rules)
	}
	for _, tr := range fs.inTrunks {
		if !slices.Equal(tr.Numbers, []string{"+74951234567", "74951234567"}) || !slices.Equal(tr.AllowedAddresses, []string{"203.0.113.10", "198.51.100.0/24"}) {
			t.Fatalf("trunk: %+v", tr)
		}
	}
	for _, r := range fs.rules {
		if r.RoomPrefix != "sipin_"+wid || r.MaxParticipants == 0 || len(r.TrunkIDs) != 1 {
			t.Fatalf("rule: %+v", r)
		}
	}
	fs.mu.Unlock()
	// An IPv4-mapped range is an IPv4 range: «::ffff:128.0.0.0/97» is 128.0.0.0/1.
	pushHTTP(t, server, o, 422, "PUT", base+"/inbound", &v1.PutSipInboundRequest{Enabled: true, Target: toBob, AllowedCidrs: []string{"::ffff:128.0.0.0/97"}}, nil)
	// Another workspace cannot take inbound calls on this number (it would take this one's calls),
	// neither by switching inbound on nor by moving its caller ID onto it later.
	ws2 := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId()
	setPlan(t, ws2, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_ENTERPRISE})
	base2 := "/api/workspaces/" + ws2 + "/sip"
	o.must(200, "PUT", base2, &v1.PutSipSettingsRequest{Enabled: true, Provider: "Zadarma", Host: "203.0.113.10", CallerId: "+74951234567"}, nil)
	var ext2 v1.SipExtensionResponse
	o.must(201, "POST", base2+"/extensions", &v1.CreateSipExtensionRequest{Number: "101", UserId: o.id}, &ext2)
	toO := &v1.SipRouteTarget{Kind: v1.SipRouteKind_SIP_ROUTE_KIND_EXTENSION, Id: ext2.GetExtension().GetId()}
	pushHTTP(t, server, o, 409, "PUT", base2+"/inbound", &v1.PutSipInboundRequest{Enabled: true, Target: toO}, nil)
	pushHTTP(t, server, o, 200, "PUT", base2, &v1.PutSipSettingsRequest{Enabled: true, Provider: "Zadarma", Host: "203.0.113.10", CallerId: "+74957654321"}, nil)
	pushHTTP(t, server, o, 200, "PUT", base2+"/inbound", &v1.PutSipInboundRequest{Enabled: true, Target: toO}, nil)
	pushHTTP(t, server, o, 409, "PUT", base2, &v1.PutSipSettingsRequest{Enabled: true, Provider: "Zadarma", Host: "203.0.113.10", CallerId: "+74951234567"}, nil)
	pushHTTP(t, server, o, 200, "PUT", base2+"/inbound", &v1.PutSipInboundRequest{Enabled: false}, nil)
	fs.mu.Lock()
	if len(fs.inTrunks) != 1 || len(fs.rules) != 1 {
		t.Fatalf("LiveKit objects after the second workspace: %v %v", fs.inTrunks, fs.rules)
	}
	fs.mu.Unlock()

	// A call rings bob.
	room := rtc.InboundRoomPrefix(uuid.MustParse(wid)) + "_+79161234567_" + uniq("")
	line := inboundLine("+79161234567")
	if err := a.SIP.Inbound(ctx, rtc.EventParticipantJoined, room, line); err != nil {
		t.Fatal(err)
	}
	ring := bobG.wait("SIP_INBOUND_RING", func(e *v1.DispatchEvent) bool {
		return e.GetSipInboundRing().GetCall().GetNumber() == "+79161234567"
	}).GetSipInboundRing().GetCall()
	if ring.GetDirection() != v1.SipCallDirection_SIP_CALL_DIRECTION_IN || ring.GetStatus() != v1.SipCallStatus_SIP_CALL_STATUS_RINGING ||
		!slices.Equal(ring.GetRingingUserIds(), []string{bob.id}) || ring.GetRoomId() != "" {
		t.Fatalf("ring: %v", ring)
	}
	cid := ring.GetId()
	if !agent.has("join "+cid+" "+room) || !agent.has("play "+cid+" ringback") {
		t.Fatalf("worker: %v", agent.cmds)
	}
	// A redelivered webhook makes no second call.
	if err := a.SIP.Inbound(ctx, rtc.EventParticipantJoined, room, line); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := testDB.Pool.QueryRow(ctx, "SELECT count(*) FROM sip_calls WHERE lk_room = $1", room).Scan(&n); err != nil || n != 1 {
		t.Fatalf("calls of the room: %d %v", n, err)
	}

	// Only whom it rings may take it.
	pushHTTP(t, server, carol, 404, "POST", "/api/sip/inbound/"+cid+"/accept", nil, nil)
	pushHTTP(t, server, o, 404, "POST", "/api/sip/inbound/"+cid+"/accept", nil, nil)
	pushHTTP(t, server, carol, 403, "DELETE", "/api/sip/inbound/"+cid, nil, nil)
	var acc v1.SipInboundAcceptResponse
	pushHTTP(t, server, bob, 200, "POST", "/api/sip/inbound/"+cid+"/accept", nil, &acc)
	if acc.GetCall().GetStatus() != v1.SipCallStatus_SIP_CALL_STATUS_ACTIVE || acc.GetCall().GetAnsweredBy() != bob.id ||
		acc.GetJoin().GetToken() == "" || acc.GetJoin().GetIdentity() != rtc.AnswerIdentity(uuid.MustParse(bob.id)) {
		t.Fatalf("accept: %v", &acc)
	}
	// The token joins this call's room only, with the microphone.
	var claims struct {
		jwt.RegisteredClaims
		Video struct {
			Room    string   `json:"room"`
			Sources []string `json:"canPublishSources"`
		} `json:"video"`
	}
	if _, _, err := jwt.NewParser().ParseUnverified(acc.GetJoin().GetToken(), &claims); err != nil ||
		claims.Video.Room != room || !slices.Equal(claims.Video.Sources, []string{"microphone"}) {
		t.Fatalf("token: %v %+v", err, claims.Video)
	}
	pushHTTP(t, server, bob, 409, "POST", "/api/sip/inbound/"+cid+"/accept", nil, nil)
	if !agent.has("leave " + cid) {
		t.Fatalf("worker after the answer: %v", agent.cmds)
	}
	var join v1.JoinVoiceResponse
	pushHTTP(t, server, bob, 200, "POST", "/api/sip/inbound/"+cid+"/join", nil, &join)
	pushHTTP(t, server, carol, 404, "POST", "/api/sip/inbound/"+cid+"/join", nil, nil)

	// The caller hangs up.
	if err := a.SIP.Inbound(ctx, rtc.EventParticipantLeft, room, line); err != nil {
		t.Fatal(err)
	}
	bobG.wait("SIP_CALL_UPDATE ended", func(e *v1.DispatchEvent) bool {
		c := e.GetSipCallUpdate().GetCall()
		return c.GetId() == cid && c.GetStatus() == v1.SipCallStatus_SIP_CALL_STATUS_ENDED && c.GetReason() == "remote"
	})
	var journal v1.ListSipCallsResponse
	o.must(200, "GET", "/api/workspaces/"+wid+"/calls", nil, &journal)
	if !slices.ContainsFunc(journal.GetCalls(), func(c *v1.SipCall) bool {
		return c.GetId() == cid && c.GetAnsweredBy() == bob.id && strings.HasPrefix(c.GetRoute(), "ext:")
	}) {
		t.Fatalf("journal: %v", journal.GetCalls())
	}

	// bob declines the next call: nobody else to ring, it ends.
	room2 := rtc.InboundRoomPrefix(uuid.MustParse(wid)) + "_+79162222222_" + uniq("")
	if err := a.SIP.Inbound(ctx, rtc.EventParticipantJoined, room2, inboundLine("+79162222222")); err != nil {
		t.Fatal(err)
	}
	cid2 := bobG.wait("second ring", func(e *v1.DispatchEvent) bool {
		return e.GetSipInboundRing().GetCall().GetNumber() == "+79162222222"
	}).GetSipInboundRing().GetCall().GetId()
	pushHTTP(t, server, bob, 204, "POST", "/api/sip/inbound/"+cid2+"/decline", nil, nil)
	bobG.wait("declined", func(e *v1.DispatchEvent) bool {
		c := e.GetSipCallUpdate().GetCall()
		return c.GetId() == cid2 && c.GetStatus() == v1.SipCallStatus_SIP_CALL_STATUS_ENDED && c.GetReason() == "declined"
	})

	// Inbound switched off while a call rings: the call ends, LiveKit's objects go.
	room3 := rtc.InboundRoomPrefix(uuid.MustParse(wid)) + "_+79163333333_" + uniq("")
	if err := a.SIP.Inbound(ctx, rtc.EventParticipantJoined, room3, inboundLine("+79163333333")); err != nil {
		t.Fatal(err)
	}
	cid3 := bobG.wait("third ring", func(e *v1.DispatchEvent) bool {
		return e.GetSipInboundRing().GetCall().GetNumber() == "+79163333333"
	}).GetSipInboundRing().GetCall().GetId()
	pushHTTP(t, server, o, 200, "PUT", base+"/inbound", &v1.PutSipInboundRequest{Enabled: false, Target: toBob}, &put)
	if put.GetSettings().GetInboundEnabled() || put.GetSettings().GetInboundSaved() {
		t.Fatalf("off: %v", put.GetSettings())
	}
	bobG.wait("disabled", func(e *v1.DispatchEvent) bool {
		c := e.GetSipCallUpdate().GetCall()
		return c.GetId() == cid3 && c.GetStatus() == v1.SipCallStatus_SIP_CALL_STATUS_ENDED && c.GetReason() == "disabled"
	})
	fs.mu.Lock()
	if len(fs.inTrunks) != 0 || len(fs.rules) != 0 {
		t.Fatalf("LiveKit objects left: %v %v", fs.inTrunks, fs.rules)
	}
	fs.mu.Unlock()
	// A call after that is refused and journaled as such.
	room4 := rtc.InboundRoomPrefix(uuid.MustParse(wid)) + "_+79164444444_" + uniq("")
	if err := a.SIP.Inbound(ctx, rtc.EventParticipantJoined, room4, inboundLine("+79164444444")); err != nil {
		t.Fatal(err)
	}
	if c, err := testDB.Q.GetSipCallByLKRoom(ctx, room4); err != nil || c.Status != "failed" || c.Reason != "disabled" {
		t.Fatalf("a call with inbound off: %+v %v", c, err)
	}
}

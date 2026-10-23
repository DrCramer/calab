//go:build integration

package app_test

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"net/netip"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/app"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/redisx"
	"github.com/calaba/calaba/server/internal/rtc"
)

// TestSIPTransfer (ADR-0132): bob answers an inbound call and hands it over — refusals (not on
// the call, two targets, himself, an unknown number), a transfer by number that he cancels, one
// to carol by member that she answers (the call is hers, bob is told), and carol's transfer to a
// group with a 5 s fallback that nobody answers: the call comes back to her.
func TestSIPTransfer(t *testing.T) {
	ctx := context.Background()
	cfg := *testCfg
	cfg.IVRAgentToken = "it-ivr-token"
	sfu := &roomSFU{LiveKit: lkRec, in: map[string]bool{}}
	a := app.New(app.Deps{Config: &cfg, DB: testDB, Redis: testRedis, Events: events.Redis{C: testRedis}, Blob: testStore, LiveKit: sfu,
		Mail: testMail, SIP: &fakeSIP{}, IVRAgent: &fakeIVR{}, UnfurlAllowAddr: func(netip.Addr) bool { return true }})
	server := httptest.NewServer(a.Handler)
	t.Cleanup(server.Close)
	o := owner(t)
	wid := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId()
	setPlan(t, wid, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_ENTERPRISE})
	bob := register(t, invite(t, o, wid))
	carol := register(t, invite(t, o, wid))
	dave := register(t, invite(t, o, wid))
	bobG, carolG, oG := dialGW(t), dialGW(t), dialGW(t)
	bobG.identify(bob.token)
	carolG.identify(carol.token)
	oG.identify(o.token)
	base := "/api/workspaces/" + wid + "/sip"
	o.must(200, "PUT", base, &v1.PutSipSettingsRequest{Enabled: true, Provider: "Zadarma", Host: "203.0.113.10", CallerId: "+74951230184"}, nil)
	var bobExt, carolExt v1.SipExtensionResponse
	o.must(201, "POST", base+"/extensions", &v1.CreateSipExtensionRequest{Number: "101", UserId: bob.id}, &bobExt)
	o.must(201, "POST", base+"/extensions", &v1.CreateSipExtensionRequest{Number: "102", UserId: carol.id}, &carolExt)
	var g v1.SipGroupResponse
	o.must(201, "POST", base+"/groups", &v1.CreateSipGroupRequest{Name: "Поддержка", Number: "1001",
		Members: &v1.SipGroupMembers{ExtensionIds: []string{bobExt.GetExtension().GetId()}}, FallbackEnabled: true, FallbackSec: 5,
		OnFail: &v1.SipRouteTarget{Kind: v1.SipRouteKind_SIP_ROUTE_KIND_HANGUP}}, &g)
	pushHTTP(t, server, o, 200, "PUT", base+"/inbound", &v1.PutSipInboundRequest{Enabled: true,
		Target: &v1.SipRouteTarget{Kind: v1.SipRouteKind_SIP_ROUTE_KIND_EXTENSION, Id: bobExt.GetExtension().GetId()}}, nil)
	// The numbers' list names the group of a group number (the picker of a member).
	var exts v1.ListSipExtensionsResponse
	pushHTTP(t, server, carol, 200, "GET", base+"/extensions", nil, &exts)
	if !slices.ContainsFunc(exts.GetExtensions(), func(e *v1.SipExtension) bool {
		return e.GetNumber() == "1001" && e.GetGroupName() == "Поддержка"
	}) {
		t.Fatalf("group name: %v", exts.GetExtensions())
	}

	room := rtc.InboundRoomPrefix(uuid.MustParse(wid)) + "_+79167777777_" + uniq("")
	line := inboundLine("+79167777777")
	if err := a.SIP.Inbound(ctx, rtc.EventParticipantJoined, room, line); err != nil {
		t.Fatal(err)
	}
	cid := bobG.wait("the call rings bob", func(e *v1.DispatchEvent) bool {
		return e.GetSipInboundRing().GetCall().GetNumber() == "+79167777777"
	}).GetSipInboundRing().GetCall().GetId()
	xfer := base + "/calls/" + cid + "/transfer"
	// Not answered yet: nothing to hand over.
	pushHTTP(t, server, o, 409, "POST", xfer, &v1.TransferSipCallRequest{Number: "102"}, nil)
	pushHTTP(t, server, bob, 200, "POST", "/api/sip/inbound/"+cid+"/accept", nil, nil)

	// Refusals: carol is not on the call; one target only; not himself; a number that exists.
	pushHTTP(t, server, carol, 403, "POST", xfer, &v1.TransferSipCallRequest{Number: "102"}, nil)
	pushHTTP(t, server, bob, 422, "POST", xfer, &v1.TransferSipCallRequest{Number: "102", UserId: carol.id}, nil)
	pushHTTP(t, server, bob, 422, "POST", xfer, &v1.TransferSipCallRequest{}, nil)
	pushHTTP(t, server, bob, 422, "POST", xfer, &v1.TransferSipCallRequest{Number: "101"}, nil)
	pushHTTP(t, server, bob, 422, "POST", xfer, &v1.TransferSipCallRequest{Number: "999"}, nil)
	pushHTTP(t, server, bob, 404, "POST", "/api/workspaces/"+uuid.NewString()+"/sip/calls/"+cid+"/transfer", &v1.TransferSipCallRequest{Number: "102"}, nil)
	pushHTTP(t, server, bob, 409, "DELETE", xfer, nil, nil)

	// By number: carol rings, the call stays bob's (ACTIVE, answered_by bob); bob cancels.
	var res v1.SipCallResponse
	pushHTTP(t, server, bob, 200, "POST", xfer, &v1.TransferSipCallRequest{Number: "102"}, &res)
	if c := res.GetCall(); c.GetStatus() != v1.SipCallStatus_SIP_CALL_STATUS_ACTIVE || c.GetAnsweredBy() != bob.id || !slices.Equal(c.GetRingingUserIds(), []string{carol.id}) {
		t.Fatalf("transfer: %v", c)
	}
	carolG.wait("the transfer rings carol", func(e *v1.DispatchEvent) bool {
		c := e.GetSipInboundRing().GetCall()
		return c.GetId() == cid && c.GetAnsweredBy() == bob.id && slices.Equal(c.GetRingingUserIds(), []string{carol.id})
	})
	bobG.wait("bob sees the transfer ring", func(e *v1.DispatchEvent) bool {
		c := e.GetSipCallUpdate().GetCall()
		return c.GetId() == cid && slices.Equal(c.GetRingingUserIds(), []string{carol.id})
	})
	var active v1.ListSipActiveCallsResponse
	o.must(200, "GET", base+"/calls", nil, &active)
	if len(active.GetCalls()) != 1 || active.GetCalls()[0].GetStep() != v1.SipActiveStep_SIP_ACTIVE_STEP_CONNECTED ||
		active.GetCalls()[0].GetCall().GetAnsweredBy() != bob.id || !slices.Equal(active.GetCalls()[0].GetCall().GetRingingUserIds(), []string{carol.id}) {
		t.Fatalf("active while transferring: %v", active.GetCalls())
	}
	pushHTTP(t, server, bob, 409, "POST", xfer, &v1.TransferSipCallRequest{UserId: dave.id}, nil)
	pushHTTP(t, server, bob, 200, "DELETE", xfer, nil, &res)
	if c := res.GetCall(); c.GetAnsweredBy() != bob.id || len(c.GetRingingUserIds()) != 0 || c.GetStatus() != v1.SipCallStatus_SIP_CALL_STATUS_ACTIVE {
		t.Fatalf("cancelled: %v", c)
	}
	carolG.wait("carol stops ringing", func(e *v1.DispatchEvent) bool {
		c := e.GetSipCallUpdate().GetCall()
		return c.GetId() == cid && len(c.GetRingingUserIds()) == 0
	})
	pushHTTP(t, server, carol, 409, "POST", "/api/sip/inbound/"+cid+"/accept", nil, nil)

	// By member: carol answers — the call is hers; bob stays with the caller until she is in the
	// room, then he is told it is not his any more and taken out of it.
	pushHTTP(t, server, bob, 200, "POST", xfer, &v1.TransferSipCallRequest{UserId: carol.id}, nil)
	var acc v1.SipInboundAcceptResponse
	pushHTTP(t, server, carol, 200, "POST", "/api/sip/inbound/"+cid+"/accept", nil, &acc)
	if c := acc.GetCall(); c.GetAnsweredBy() != carol.id || c.GetStatus() != v1.SipCallStatus_SIP_CALL_STATUS_ACTIVE || len(c.GetRingingUserIds()) != 0 || acc.GetJoin().GetToken() == "" {
		t.Fatalf("taken: %v", &acc)
	}
	bobID, carolID := rtc.AnswerIdentity(uuid.MustParse(bob.id)), rtc.AnswerIdentity(uuid.MustParse(carol.id))
	// Still connecting: a second transfer waits, bob is not out of the room.
	pushHTTP(t, server, carol, 409, "POST", xfer, &v1.TransferSipCallRequest{UserId: dave.id}, nil)
	if sfu.wasRemoved(bobID) {
		t.Fatal("bob removed before carol connected")
	}
	sfu.join(room, carolID)
	if err := a.SIP.Inbound(ctx, rtc.EventParticipantJoined, room, &rtc.Participant{Identity: carolID}); err != nil {
		t.Fatal(err)
	}
	bobG.wait("bob is released", func(e *v1.DispatchEvent) bool {
		c := e.GetSipCallUpdate().GetCall()
		return c.GetId() == cid && c.GetAnsweredBy() == carol.id
	})
	if !sfu.wasRemoved(bobID) {
		t.Fatal("bob still in the room")
	}
	pushHTTP(t, server, bob, 403, "POST", xfer, &v1.TransferSipCallRequest{Number: "1001"}, nil)
	pushHTTP(t, server, bob, 404, "POST", "/api/sip/inbound/"+cid+"/join", nil, nil)

	// carol hands it to the group (bob, 5 s fallback); nobody answers: it comes back to her.
	pushHTTP(t, server, carol, 200, "POST", xfer, &v1.TransferSipCallRequest{ExtensionId: g.GetGroup().GetExtension().GetId()}, nil)
	bobG.wait("the group rings bob", func(e *v1.DispatchEvent) bool { return e.GetSipInboundRing().GetCall().GetId() == cid })
	time.Sleep(5100 * time.Millisecond)
	a.SIP.InboundTick(ctx)
	carolG.wait("back with carol", func(e *v1.DispatchEvent) bool {
		c := e.GetSipCallUpdate().GetCall()
		return c.GetId() == cid && c.GetAnsweredBy() == carol.id && len(c.GetRingingUserIds()) == 0 && strings.HasSuffix(c.GetRoute(), "transfer:no_answer")
	})
	row, err := testDB.Q.GetSipCallByLKRoom(ctx, room)
	if err != nil || row.Status != "active" || row.AnsweredBy == nil || row.AnsweredBy.String() != carol.id ||
		!strings.Contains(row.Route, "transfer:ext:"+carolExt.GetExtension().GetId()) || !strings.Contains(row.Route, "transfer:cancelled") ||
		!strings.Contains(row.Route, "transfer:answered") {
		t.Fatalf("journal: %+v %v", row, err)
	}
	// An admin (MANAGE_INTEGRATIONS) may hand over a call they are not on.
	pushHTTP(t, server, o, 200, "POST", xfer, &v1.TransferSipCallRequest{UserId: bob.id}, nil)
	pushHTTP(t, server, o, 200, "DELETE", xfer, nil, nil)
	// bob answers a transfer but never connects: after the grace the call is carol's again
	// (she never left the room), and bob hears it.
	pushHTTP(t, server, o, 200, "POST", xfer, &v1.TransferSipCallRequest{UserId: bob.id}, nil)
	pushHTTP(t, server, bob, 200, "POST", "/api/sip/inbound/"+cid+"/accept", nil, nil)
	expireNow(ctx, t, cid)
	a.SIP.InboundTick(ctx)
	carolG.wait("back with carol: bob never connected", func(e *v1.DispatchEvent) bool {
		c := e.GetSipCallUpdate().GetCall()
		return c.GetId() == cid && c.GetAnsweredBy() == carol.id && strings.HasSuffix(c.GetRoute(), "transfer:not_connected")
	})
	bobG.wait("bob hears it is back with carol", func(e *v1.DispatchEvent) bool {
		c := e.GetSipCallUpdate().GetCall()
		return c.GetId() == cid && c.GetAnsweredBy() == carol.id && len(c.GetRingingUserIds()) == 0
	})
	// The caller hangs up: the call ends as usual.
	if err := a.SIP.Inbound(ctx, rtc.EventParticipantLeft, room, line); err != nil {
		t.Fatal(err)
	}
	carolG.wait("ended", func(e *v1.DispatchEvent) bool {
		c := e.GetSipCallUpdate().GetCall()
		return c.GetId() == cid && c.GetStatus() == v1.SipCallStatus_SIP_CALL_STATUS_ENDED
	})
	pushHTTP(t, server, carol, 409, "POST", xfer, &v1.TransferSipCallRequest{UserId: bob.id}, nil)
}

// expireNow moves the deadline of inbound call cid into the past (a grace the test does not
// wait out).
func expireNow(ctx context.Context, t *testing.T, cid string) {
	t.Helper()
	key := redisx.Key("sipin:" + cid)
	raw, err := testRedis.Do(ctx, testRedis.B().Get().Key(key).Build()).ToString()
	if err != nil {
		t.Fatal(err)
	}
	var rec map[string]any
	if err := json.Unmarshal([]byte(raw), &rec); err != nil {
		t.Fatal(err)
	}
	past := time.Now().Add(-time.Second).UnixMilli()
	rec["deadline"] = past
	b, _ := json.Marshal(rec)
	if err := testRedis.Do(ctx, testRedis.B().Set().Key(key).Value(string(b)).Keepttl().Build()).Error(); err != nil {
		t.Fatal(err)
	}
	if err := testRedis.Do(ctx, testRedis.B().Zadd().Key(redisx.Key("sipin:due")).ScoreMember().ScoreMember(float64(past), cid).Build()).Error(); err != nil {
		t.Fatal(err)
	}
}

// roomSFU: LiveKit whose rooms hold who the test put in them (GetParticipant / RemoveParticipant).
type roomSFU struct {
	rtc.LiveKit
	mu      sync.Mutex
	in      map[string]bool
	removed []string
}

func (s *roomSFU) join(room, identity string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.in[room+"/"+identity] = true
}

func (s *roomSFU) GetParticipant(_ context.Context, room, identity string) (*rtc.Participant, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.in[room+"/"+identity] {
		return nil, &rtc.Error{Code: "not_found", Status: 404}
	}
	return &rtc.Participant{Identity: identity}, nil
}

func (s *roomSFU) RemoveParticipant(_ context.Context, room, identity string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.in, room+"/"+identity)
	s.removed = append(s.removed, identity)
	return nil
}

func (s *roomSFU) wasRemoved(identity string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Contains(s.removed, identity)
}

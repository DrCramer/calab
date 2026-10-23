//go:build integration

package app_test

import (
	"context"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/rtc"
)

// TestSIPTransfer (ADR-0132): bob answers an inbound call and hands it over — refusals (not on
// the call, two targets, himself, an unknown number), a transfer by number that he cancels, one
// to carol by member that she answers (the call is hers, bob is told), and carol's transfer to a
// group with a 5 s fallback that nobody answers: the call comes back to her.
func TestSIPTransfer(t *testing.T) {
	ctx := context.Background()
	a, server, _, _ := inboundApp(t)
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

	// By member: carol answers — the call is hers, bob is told it is not his any more.
	pushHTTP(t, server, bob, 200, "POST", xfer, &v1.TransferSipCallRequest{UserId: carol.id}, nil)
	var acc v1.SipInboundAcceptResponse
	pushHTTP(t, server, carol, 200, "POST", "/api/sip/inbound/"+cid+"/accept", nil, &acc)
	if c := acc.GetCall(); c.GetAnsweredBy() != carol.id || c.GetStatus() != v1.SipCallStatus_SIP_CALL_STATUS_ACTIVE || len(c.GetRingingUserIds()) != 0 || acc.GetJoin().GetToken() == "" {
		t.Fatalf("taken: %v", &acc)
	}
	bobG.wait("bob is released", func(e *v1.DispatchEvent) bool {
		c := e.GetSipCallUpdate().GetCall()
		return c.GetId() == cid && c.GetAnsweredBy() == carol.id
	})
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

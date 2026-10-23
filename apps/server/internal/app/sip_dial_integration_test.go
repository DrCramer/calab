//go:build integration

package app_test

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/ivrwire"
	"github.com/calaba/calaba/server/internal/rtc"
)

func (f *fakeIVR) count(c string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, x := range f.cmds {
		if x == c {
			n++
		}
	}
	return n
}

// TestSIPInboundDialExtension (ADR-0129): keys count while the prompt plays (barge-in); a menu
// with dialing on connects a dialed number; a number closed to external callers is «not
// found» to them (the menu plays again), while a key routed to it still rings it.
func TestSIPInboundDialExtension(t *testing.T) {
	ctx := context.Background()
	a, server, _, agent := inboundApp(t)
	o := owner(t)
	wid := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId()
	setPlan(t, wid, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_ENTERPRISE})
	bob := register(t, invite(t, o, wid))
	carol := register(t, invite(t, o, wid))
	bobG, carolG := dialGW(t), dialGW(t)
	bobG.identify(bob.token)
	carolG.identify(carol.token)
	base := "/api/workspaces/" + wid + "/sip"
	o.must(200, "PUT", base, &v1.PutSipSettingsRequest{Enabled: true, Provider: "Zadarma", Host: "203.0.113.10", CallerId: "+74951234569"}, nil)
	var bobExt, carolExt v1.SipExtensionResponse
	o.must(201, "POST", base+"/extensions", &v1.CreateSipExtensionRequest{Number: "101", UserId: bob.id, ExternalBlocked: true}, &bobExt)
	if !bobExt.GetExtension().GetExternalBlocked() {
		t.Fatalf("blocked: %v", bobExt.GetExtension())
	}
	o.must(201, "POST", base+"/extensions", &v1.CreateSipExtensionRequest{Number: "102", UserId: carol.id}, &carolExt)
	var g v1.SipGroupResponse
	o.must(201, "POST", base+"/groups", &v1.CreateSipGroupRequest{Name: "Продажи", Number: "1001",
		Members: &v1.SipGroupMembers{ExtensionIds: []string{carolExt.GetExtension().GetId()}}}, &g)
	yes, no := true, false
	o.must(422, "PATCH", base+"/extensions/"+g.GetGroup().GetExtension().GetId(), &v1.UpdateSipExtensionRequest{ExternalBlocked: &yes}, nil)
	var upd v1.SipExtensionResponse
	o.must(200, "PATCH", base+"/extensions/"+carolExt.GetExtension().GetId(), &v1.UpdateSipExtensionRequest{ExternalBlocked: &yes}, &upd)
	if !upd.GetExtension().GetExternalBlocked() {
		t.Fatalf("patch blocked: %v", upd.GetExtension())
	}
	o.must(200, "PATCH", base+"/extensions/"+carolExt.GetExtension().GetId(), &v1.UpdateSipExtensionRequest{ExternalBlocked: &no}, &upd)

	toBob := &v1.SipRouteTarget{Kind: v1.SipRouteKind_SIP_ROUTE_KIND_EXTENSION, Id: bobExt.GetExtension().GetId()}
	toGroup := &v1.SipRouteTarget{Kind: v1.SipRouteKind_SIP_ROUTE_KIND_GROUP, Id: g.GetGroup().GetId()}
	var m v1.SipIvrMenuResponse
	o.must(201, "POST", base+"/ivr", &v1.CreateSipIvrMenuRequest{Name: "Главное", DialExtensions: true,
		Items: &v1.SipIvrItems{Items: []*v1.SipIvrItem{{Digit: "1", Action: toGroup}, {Digit: "2", Action: toBob}}}}, &m)
	if !m.GetMenu().GetDialExtensions() {
		t.Fatalf("dialing: %v", m.GetMenu())
	}
	var mm v1.SipIvrMenuResponse
	o.must(200, "PATCH", base+"/ivr/"+m.GetMenu().GetId(), &v1.UpdateSipIvrMenuRequest{DialExtensions: &no}, &mm)
	if mm.GetMenu().GetDialExtensions() {
		t.Fatal("dialing stays on")
	}
	o.must(200, "PATCH", base+"/ivr/"+m.GetMenu().GetId(), &v1.UpdateSipIvrMenuRequest{DialExtensions: &yes}, &mm)
	// A prompt without ffmpeg: any file of the workspace stands in for the converted one.
	prompt := soundUpload(t, o, wid, "prompt.wav", "audio/wav", toneWav(0.5))
	if _, err := testDB.Pool.Exec(ctx, "UPDATE sip_ivr_menus SET prompt_file_id = $1, prompt_duration_ms = 20000 WHERE id = $2", prompt, m.GetMenu().GetId()); err != nil {
		t.Fatal(err)
	}
	pushHTTP(t, server, o, 200, "PUT", base+"/inbound", &v1.PutSipInboundRequest{Enabled: true,
		Target: &v1.SipRouteTarget{Kind: v1.SipRouteKind_SIP_ROUTE_KIND_MENU, Id: m.GetMenu().GetId()}}, nil)

	call := func(number string) string {
		t.Helper()
		room := rtc.InboundRoomPrefix(uuid.MustParse(wid)) + "_" + number + "_" + uniq("")
		if err := a.SIP.Inbound(ctx, rtc.EventParticipantJoined, room, inboundLine(number)); err != nil {
			t.Fatal(err)
		}
		c, err := testDB.Q.GetSipCallByLKRoom(ctx, room)
		if err != nil {
			t.Fatal(err)
		}
		if !agent.has("play " + c.ID.String() + " " + prompt) {
			t.Fatalf("the prompt does not play: %v", agent.cmds)
		}
		return c.ID.String()
	}
	press := func(cid, digits string) {
		for _, d := range digits {
			a.SIP.AgentEvent(ctx, ivrwire.Event{Op: ivrwire.OpDTMF, Call: cid, Digit: string(d)})
		}
	}

	// 1 0 2 mid-prompt: the first digit stops the prompt, 102 rings carol.
	cid := call("+79161110001")
	press(cid, "1")
	if !agent.has("stop " + cid) {
		t.Fatalf("barge-in: %v", agent.cmds)
	}
	press(cid, "02")
	carolG.wait("102 rings carol", func(e *v1.DispatchEvent) bool { return e.GetSipInboundRing().GetCall().GetId() == cid })
	pushHTTP(t, server, carol, 204, "POST", "/api/sip/inbound/"+cid+"/decline", nil, nil) // carol is free again

	// 101 is closed to external callers: the menu plays again, bob does not ring; the key 2
	// routed to him still rings him.
	cid = call("+79161110002")
	press(cid, "101")
	if n := agent.count("play " + cid + " " + prompt); n != 2 {
		t.Fatalf("not found: the menu plays %d times", n)
	}
	bobG.quiet("101 closed", 300*time.Millisecond, func(e *v1.DispatchEvent) bool { return e.GetSipInboundRing().GetCall().GetId() == cid })
	press(cid, "2")
	bobG.wait("the key 2 rings bob", func(e *v1.DispatchEvent) bool { return e.GetSipInboundRing().GetCall().GetId() == cid })

	// «1» — numbers start with it: after the 3 s pause it is the key 1 (the group), without the tick.
	cid = call("+79161110003")
	press(cid, "1")
	time.Sleep(3500 * time.Millisecond)
	carolG.wait("the key 1 after the pause", func(e *v1.DispatchEvent) bool { return e.GetSipInboundRing().GetCall().GetId() == cid })
}

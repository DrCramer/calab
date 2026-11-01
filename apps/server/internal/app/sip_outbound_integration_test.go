//go:build integration

package app_test

import (
	"context"
	"net/http/httptest"
	"net/netip"
	"slices"
	"testing"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/app"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/redisx"
	"github.com/calaba/calaba/server/internal/rtc"
	"github.com/calaba/calaba/server/internal/sip"
)

// personalApp is an API instance for personal calls with short waits (the caller's 15 s to get
// in, the 30 s grace) and its own SIP and egress fakes, on the shared Postgres and Valkey.
func personalApp(t *testing.T) (*app.App, *httptest.Server, *fakeSIP, *phoneEgress) {
	t.Helper()
	cfg := *testCfg
	fs, eg := &fakeSIP{}, &phoneEgress{}
	a := app.New(app.Deps{Config: &cfg, DB: testDB, Redis: testRedis, Events: events.Redis{C: testRedis}, Blob: testStore, LiveKit: lkRec,
		Mail: testMail, SIP: fs, Egress: eg, UnfurlAllowAddr: func(netip.Addr) bool { return true },
		SIPOptions: sip.Options{PersonalJoinWait: 2 * time.Second, PersonalGrace: 300 * time.Millisecond}})
	server := httptest.NewServer(a.Handler)
	t.Cleanup(server.Close)
	return a, server, fs, eg
}

func dialedCount(f *fakeSIP, identity string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, c := range f.calls {
		if c.Identity == identity {
			n++
		}
	}
	return n
}

// TestSIPPersonalCall (ADR-0137 §3): who may place a personal call (PLACE_CALLS of the
// workspace itself, people only, the plan, allowed prefixes, the hourly limits), the number
// dialed only after the caller got into the call's own room, the caller's 15 s to get in, busy
// (a second call, a one-to-one call to the caller), each side ending it, the caller gone,
// caller ID on the call, READY, the recording of the call's room and its journal.
func TestSIPPersonalCall(t *testing.T) {
	liveKitUp(t)
	ctx := context.Background()
	a, server, fs, eg := personalApp(t)
	o := owner(t)
	wid := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId()
	setPlan(t, wid, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_ENTERPRISE})
	bob := register(t, invite(t, o, wid))
	carol := register(t, invite(t, o, wid))
	base := "/api/workspaces/" + wid + "/sip"
	calls := base + "/calls"
	call := func(u *user, status int, req *v1.PlaceSipPersonalCallRequest) *v1.PlaceSipPersonalCallResponse {
		t.Helper()
		var out v1.PlaceSipPersonalCallResponse
		if status != 201 {
			pushHTTP(t, server, u, status, "POST", calls, req, nil)
			return &out
		}
		pushHTTP(t, server, u, status, "POST", calls, req, &out)
		return &out
	}
	num := &v1.PlaceSipPersonalCallRequest{Number: "8 916 444-00-01"}

	// Telephony off: SIP_DISABLED (after the bit and the plan).
	call(o, 409, num)
	pushHTTP(t, server, o, 200, "PUT", base, &v1.PutSipSettingsRequest{Enabled: true, Provider: "Zadarma", Host: "203.0.113.10",
		CallerId: "+74951230338", AllowedPrefixes: []string{"+7"}}, nil)
	o.must(200, "PUT", base+"/recording", &v1.PutSipRecordingRequest{RecordOutbound: true}, nil)

	// The bit of the workspace itself: an allow in a room does not count.
	call(bob, 403, num)
	vroom := voiceRoom(t, o, wid, "Переговорка", 0)
	o.must(200, "PUT", "/api/rooms/"+vroom+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: []*v1.RoomPermissionOverride{
		{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER, TargetId: bob.id, Allow: uint64(perm.PlaceCalls)},
	}}, nil)
	call(bob, 403, num)
	callers := newRole(t, o, wid, "Звонящие", perm.PlaceCalls)
	if st, _ := setMemberRoles(o, wid, bob.id, callers.GetId()); st != 200 {
		t.Fatalf("bob's role: %d", st)
	}
	// Bots never (their own LiveKit client would be needed), guests never.
	b := createBot(t, o, wid, "Dialer")
	if st, _ := setMemberRoles(o, wid, b.id, callers.GetId()); st != 200 {
		t.Fatalf("bot role: %d", st)
	}
	if st := b.do("POST", calls, num, nil); st != 403 {
		t.Fatalf("a bot calls: %d", st)
	}
	rid := textRoom(t, o, wid, "general", false)
	link := roomLink(t, o, rid, &v1.CreateRoomInviteRequest{})
	gina := register(t, invite(t, o, createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId()))
	gina.must(200, "POST", "/api/room-invites/"+link.GetCode()+"/join", nil, nil)
	call(gina, 403, num)
	// Numbers: not a number, outside the allowed prefixes, a contact that does not have it.
	call(bob, 422, &v1.PlaceSipPersonalCallRequest{Number: "123"})
	call(bob, 422, &v1.PlaceSipPersonalCallRequest{Number: "+44 20 7946 0958"})
	var cr v1.SipContactResponse
	o.must(201, "POST", base+"/contacts", &v1.SipContactInput{Name: "Анна", Company: "ООО Ромашка",
		Phones: []*v1.SipContactPhone{{Number: "+79164440001"}}}, &cr)
	other := uuid.NewString()
	call(bob, 422, &v1.PlaceSipPersonalCallRequest{Number: "+79164440002", ContactId: cr.GetContact().GetId()})
	call(bob, 422, &v1.PlaceSipPersonalCallRequest{Number: "+79164440001", ContactId: other})

	// Place: DIALING, no room, a token for the call's own room; nothing dialed yet.
	bobG := dialGW(t)
	bobG.identify(bob.token)
	r1 := call(bob, 201, &v1.PlaceSipPersonalCallRequest{Number: "(916) 444-00-01", ContactId: cr.GetContact().GetId()})
	c1 := r1.GetCall()
	lkRoom := rtc.OutboundRoomName(uuid.MustParse(wid), uuid.MustParse(c1.GetId()))
	if c1.GetStatus() != v1.SipCallStatus_SIP_CALL_STATUS_DIALING || c1.GetOrigin() != v1.SipCallOrigin_SIP_CALL_ORIGIN_PERSONAL ||
		c1.GetRoomId() != "" || c1.GetNumber() != "+79164440001" || c1.GetStartedBy() != bob.id || c1.GetCallerName() != "Анна" ||
		c1.GetContactId() != cr.GetContact().GetId() || r1.GetJoin().GetIdentity() != rtc.CallerIdentity(uuid.MustParse(bob.id)) ||
		r1.GetJoin().GetToken() == "" || !r1.GetJoin().GetCanSpeak() {
		t.Fatalf("placed: %v", r1)
	}
	bobG.wait("SIP_CALL_UPDATE dialing with caller ID", func(e *v1.DispatchEvent) bool {
		c := e.GetSipCallUpdate().GetCall()
		return c.GetId() == c1.GetId() && c.GetCallerCompany() == "ООО Ромашка"
	})
	// Busy: a second call, and a one-to-one call to bob.
	call(bob, 409, num)
	var dm v1.CreateDmResponse
	carol.must(201, "POST", "/api/dms", &v1.CreateDmRequest{UserId: bob.id}, &dm)
	if code := errCode(t, carol, "POST", "/api/dms/"+dm.GetDm().GetRoom().GetId()+"/call"); code != v1.ErrorCode_ERROR_CODE_BUSY {
		t.Fatalf("a DM call to bob on the phone: %v", code)
	}
	// READY carries it for bob.
	found := false
	bobG = dialGW(t) // replaces the session of the test's earlier one
	for _, w := range bobG.identify(bob.token).GetWorkspaces() {
		for _, c := range w.GetSipCalls() {
			found = found || (c.GetId() == c1.GetId() && c.GetCallerName() == "Анна")
		}
	}
	if !found {
		t.Fatal("READY without the personal call")
	}
	time.Sleep(200 * time.Millisecond)
	if dialedCount(fs, c1.GetParticipantIdentity()) != 0 {
		t.Fatal("dialed before the caller got in")
	}
	// The caller gets in (twice: a redelivered webhook) → one dial into the call's room.
	caller := &rtc.Participant{Identity: rtc.CallerIdentity(uuid.MustParse(bob.id))}
	for range 2 {
		if err := a.SIP.Outbound(ctx, rtc.EventParticipantJoined, lkRoom, caller); err != nil {
			t.Fatal(err)
		}
	}
	d := fs.dialed(t, c1.GetParticipantIdentity())
	if d.Room != lkRoom || d.CallTo != "79164440001" || !d.WaitUntilAnswered {
		t.Fatalf("dial: %+v", d)
	}
	time.Sleep(2200 * time.Millisecond) // past the join wait: the call goes on
	line := &rtc.Participant{Identity: c1.GetParticipantIdentity(), Attributes: map[string]string{rtc.AttrSIPCallStatus: "ringing"}}
	if err := a.SIP.Outbound(ctx, rtc.EventParticipantJoined, lkRoom, line); err != nil {
		t.Fatal(err)
	}
	if dialedCount(fs, c1.GetParticipantIdentity()) != 1 {
		t.Fatal("dialed twice")
	}
	fs.answer(c1.GetParticipantIdentity())
	bobG.wait("SIP_CALL_UPDATE active", func(e *v1.DispatchEvent) bool {
		c := e.GetSipCallUpdate().GetCall()
		return c.GetId() == c1.GetId() && c.GetStatus() == v1.SipCallStatus_SIP_CALL_STATUS_ACTIVE
	})
	// The call's own room is recorded (only the two sides).
	if st := eg.started(t, 1); st.room != lkRoom {
		t.Fatalf("recorded room: %s", st.room)
	}
	// The callee hangs up: the line leaves → ENDED remote; bob is free; the room goes.
	if err := a.SIP.Outbound(ctx, rtc.EventParticipantLeft, lkRoom, line); err != nil {
		t.Fatal(err)
	}
	bobG.wait("SIP_CALL_UPDATE ended", func(e *v1.DispatchEvent) bool {
		c := e.GetSipCallUpdate().GetCall()
		return c.GetId() == c1.GetId() && c.GetStatus() == v1.SipCallStatus_SIP_CALL_STATUS_ENDED && c.GetReason() == "remote"
	})
	waitUntil(t, "room closed", func() bool { return lkRec.wasDeleted(lkRoom) })
	if got := journalKinds(t, c1.GetId()); !slices.Equal(got[:3], []string{"started", "dialing", "provider_ringing"}) ||
		!slices.Contains(got, "answered") || got[len(got)-1] != "ended" && got[len(got)-1] != "recording" {
		t.Fatalf("journal: %v", got)
	}
	var det v1.GetSipJournalEntryResponse
	bob.must(200, "GET", base+"/journal/"+c1.GetId(), nil, &det)
	if en := det.GetEntry(); en.GetOrigin() != v1.SipCallOrigin_SIP_CALL_ORIGIN_PERSONAL || en.GetContact().GetName() != "Анна" ||
		len(en.GetParties()) != 1 || !en.GetParties()[0].GetPlaced() {
		t.Fatalf("journal entry: %v", en)
	}

	// The caller never gets in: FAILED not_connected after the wait; bob is free again.
	r2 := call(bob, 201, num)
	bobG.wait("not_connected", func(e *v1.DispatchEvent) bool {
		c := e.GetSipCallUpdate().GetCall()
		return c.GetId() == r2.GetCall().GetId() && c.GetStatus() == v1.SipCallStatus_SIP_CALL_STATUS_FAILED && c.GetReason() == "not_connected"
	})
	// A late join dials nothing.
	lk2 := rtc.OutboundRoomName(uuid.MustParse(wid), uuid.MustParse(r2.GetCall().GetId()))
	if err := a.SIP.Outbound(ctx, rtc.EventParticipantJoined, lk2, caller); err != nil {
		t.Fatal(err)
	}
	if dialedCount(fs, r2.GetCall().GetParticipantIdentity()) != 0 {
		t.Fatal("a late caller dialed")
	}

	// Hang up while dialing: the caller («cancelled»); someone else 403; MANAGE_INTEGRATIONS ends
	// someone's call («hangup_moderator»).
	r3 := call(bob, 201, num)
	var hr v1.SipCallResponse
	pushHTTP(t, server, carol, 403, "DELETE", calls+"/"+r3.GetCall().GetId(), nil, nil)
	pushHTTP(t, server, bob, 200, "DELETE", calls+"/"+r3.GetCall().GetId(), nil, &hr)
	if hr.GetCall().GetReason() != "cancelled" || hr.GetCall().GetEndedBy() != bob.id {
		t.Fatalf("cancel: %v", hr.GetCall())
	}
	pushHTTP(t, server, bob, 409, "DELETE", calls+"/"+r3.GetCall().GetId(), nil, nil)
	r4 := call(bob, 201, num)
	pushHTTP(t, server, o, 200, "DELETE", calls+"/"+r4.GetCall().GetId(), nil, &hr)
	if hr.GetCall().GetReason() != "hangup_moderator" {
		t.Fatalf("moderator: %v", hr.GetCall())
	}
	// Not a personal call of this workspace: 404.
	pushHTTP(t, server, o, 404, "DELETE", "/api/workspaces/"+createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId()+
		"/sip/calls/"+r4.GetCall().GetId(), nil, nil)

	// The caller leaves an answered call and does not come back: ENDED lost.
	r5 := call(bob, 201, num)
	lk5 := rtc.OutboundRoomName(uuid.MustParse(wid), uuid.MustParse(r5.GetCall().GetId()))
	if err := a.SIP.Outbound(ctx, rtc.EventParticipantJoined, lk5, caller); err != nil {
		t.Fatal(err)
	}
	fs.answer(r5.GetCall().GetParticipantIdentity())
	bobG.wait("r5 active", func(e *v1.DispatchEvent) bool {
		c := e.GetSipCallUpdate().GetCall()
		return c.GetId() == r5.GetCall().GetId() && c.GetStatus() == v1.SipCallStatus_SIP_CALL_STATUS_ACTIVE
	})
	if err := a.SIP.Outbound(ctx, rtc.EventParticipantLeft, lk5, caller); err != nil {
		t.Fatal(err)
	}
	bobG.wait("r5 lost", func(e *v1.DispatchEvent) bool {
		c := e.GetSipCallUpdate().GetCall()
		return c.GetId() == r5.GetCall().GetId() && c.GetStatus() == v1.SipCallStatus_SIP_CALL_STATUS_ENDED && c.GetReason() == "lost"
	})

	// The hourly limits (the workspace's policy): 1 per member here, on buckets of the test.
	a.SIP.UserCallLimit = redisx.NewRateLimiter(testRedis, "rl:sip-call-u-pit:", 1, 0.001)
	o.must(200, "PUT", base+"/policy", &v1.PutSipPolicyRequest{OutPerUserHour: 1}, nil)
	r6 := call(bob, 201, num)
	pushHTTP(t, server, bob, 200, "DELETE", calls+"/"+r6.GetCall().GetId(), nil, nil)
	call(bob, 429, num)
	// A plan without telephony: PLAN_LIMIT (asked of the shared instance, whose plan cache the
	// admin change refreshed).
	setPlan(t, wid, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_TEAM, OverrideLimits: true})
	o.wantErr(409, v1.ErrorCode_ERROR_CODE_CONFLICT, "POST", calls, num)
	if reason, _ := errReason(o.client); reason != "PLAN_LIMIT" {
		t.Fatalf("plan: %q", reason)
	}
}

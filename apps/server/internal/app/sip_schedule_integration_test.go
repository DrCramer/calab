//go:build integration

package app_test

import (
	"context"
	"slices"
	"testing"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/rtc"
)

// closedNow is a week of working hours that is closed right now in Moscow: one minute on the
// weekday three days ahead.
func closedNow(t *testing.T) []*v1.SipScheduleInterval {
	t.Helper()
	loc, err := time.LoadLocation("Europe/Moscow")
	if err != nil {
		t.Fatal(err)
	}
	iso := uint32((time.Now().In(loc).Weekday() + 3) % 7) //nolint:gosec // 0..6
	if iso == 0 {
		iso = 7 // Sunday
	}
	return []*v1.SipScheduleInterval{{Weekday: iso, StartMin: 600, EndMin: 601}}
}

// TestSIPScheduleOffHours (ADR-0138): the schedule's validation and rights, an off-hours call
// going to a person's number instead of the entry point (the ring says off_hours, the journal
// has the SCHEDULE step), and an off-hours «hang up» (reason off_hours, a missed call).
func TestSIPScheduleOffHours(t *testing.T) {
	ctx := context.Background()
	a, server, _, _ := inboundApp(t)
	o := owner(t)
	wid := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId()
	setPlan(t, wid, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_ENTERPRISE})
	bob := register(t, invite(t, o, wid))
	carol := register(t, invite(t, o, wid))
	bobG, carolG := dialGW(t), dialGW(t)
	bobG.identify(bob.token)
	carolG.identify(carol.token)
	base := "/api/workspaces/" + wid + "/sip"
	schedule := func(sc *v1.SipSchedule) *v1.PutSipScheduleRequest { return &v1.PutSipScheduleRequest{Schedule: sc} }
	week := []*v1.SipScheduleInterval{{Weekday: 1, StartMin: 540, EndMin: 1080}}

	// Before the provider settings: nothing to attach the schedule to.
	pushHTTP(t, server, o, 409, "PUT", base+"/schedule", schedule(&v1.SipSchedule{Hours: week}), nil)
	o.must(200, "PUT", base, &v1.PutSipSettingsRequest{Enabled: true, Provider: "Zadarma", Host: "203.0.113.10", CallerId: "+74951230138"}, nil)
	var bobExt, carolExt v1.SipExtensionResponse
	o.must(201, "POST", base+"/extensions", &v1.CreateSipExtensionRequest{Number: "101", UserId: bob.id}, &bobExt)
	o.must(201, "POST", base+"/extensions", &v1.CreateSipExtensionRequest{Number: "102", UserId: carol.id}, &carolExt)
	toCarol := &v1.SipRouteTarget{Kind: v1.SipRouteKind_SIP_ROUTE_KIND_EXTENSION, Id: carolExt.GetExtension().GetId()}
	pushHTTP(t, server, o, 200, "PUT", base+"/inbound", &v1.PutSipInboundRequest{Enabled: true,
		Target: &v1.SipRouteTarget{Kind: v1.SipRouteKind_SIP_ROUTE_KIND_EXTENSION, Id: bobExt.GetExtension().GetId()}}, nil)

	// MANAGE_INTEGRATIONS only; sane intervals, a real zone, a known target.
	pushHTTP(t, server, bob, 403, "PUT", base+"/schedule", schedule(&v1.SipSchedule{Enabled: true, Hours: week}), nil)
	for name, bad := range map[string]*v1.SipSchedule{
		"overlap":                       {Enabled: true, Hours: []*v1.SipScheduleInterval{{Weekday: 1, StartMin: 540, EndMin: 780}, {Weekday: 1, StartMin: 720, EndMin: 1080}}},
		"night shift into the next day": {Enabled: true, Hours: []*v1.SipScheduleInterval{{Weekday: 5, StartMin: 1320, EndMin: 180}, {Weekday: 6, StartMin: 120, EndMin: 240}}},
		"empty interval":                {Enabled: true, Hours: []*v1.SipScheduleInterval{{Weekday: 1, StartMin: 600, EndMin: 600}}},
		"weekday":                       {Enabled: true, Hours: []*v1.SipScheduleInterval{{Weekday: 8, StartMin: 0, EndMin: 60}}},
		"no hours":                      {Enabled: true},
		"zone":                          {Enabled: true, Hours: week, TimeZone: "Mars/Olympus"},
		"repeat":                        {Enabled: true, Hours: week, OffHours: &v1.SipRouteTarget{Kind: v1.SipRouteKind_SIP_ROUTE_KIND_REPEAT}},
		"target":                        {Enabled: true, Hours: week, OffHours: &v1.SipRouteTarget{Kind: v1.SipRouteKind_SIP_ROUTE_KIND_MENU, Id: uuid.NewString()}},
	} {
		t.Run(name, func(t *testing.T) { pushHTTP(t, server, o, 422, "PUT", base+"/schedule", schedule(bad), nil) })
	}
	var put v1.PutSipScheduleResponse
	pushHTTP(t, server, o, 200, "PUT", base+"/schedule", schedule(&v1.SipSchedule{Enabled: true, Hours: closedNow(t),
		ProductionCalendarRu: true, OffHours: toCarol}), &put)
	sc := put.GetSettings().GetSchedule()
	if !sc.GetEnabled() || sc.GetTimeZone() != "Europe/Moscow" || len(sc.GetHours()) != 1 || !sc.GetProductionCalendarRu() ||
		sc.GetOffHours().GetId() != toCarol.GetId() || sc.GetNoticeFileId() != "" || !put.GetSettings().GetInboundEnabled() {
		t.Fatalf("schedule: %v", sc)
	}
	var got v1.GetSipSettingsResponse
	o.must(200, "GET", base, nil, &got)
	if got.GetSettings().GetSchedule().GetOffHours().GetId() != toCarol.GetId() {
		t.Fatalf("GET schedule: %v", got.GetSettings().GetSchedule())
	}

	// Off hours: carol rings instead of bob, and her ring says why.
	room := rtc.InboundRoomPrefix(uuid.MustParse(wid)) + "_+79166666666_" + uniq("")
	if err := a.SIP.Inbound(ctx, rtc.EventParticipantJoined, room, inboundLine("+79166666666")); err != nil {
		t.Fatal(err)
	}
	ring := carolG.wait("off hours ring carol", func(e *v1.DispatchEvent) bool {
		return e.GetSipInboundRing().GetCall().GetNumber() == "+79166666666"
	}).GetSipInboundRing().GetCall()
	if !ring.GetOffHours() || ring.GetViaFallback() || !slices.Equal(ring.GetRingingUserIds(), []string{carol.id}) {
		t.Fatalf("ring: %v", ring)
	}
	bobG.quiet("bob does not ring off hours", 300*time.Millisecond, func(e *v1.DispatchEvent) bool {
		return e.GetSipInboundRing().GetCall().GetId() == ring.GetId()
	})
	var detail v1.GetSipJournalEntryResponse
	o.must(200, "GET", base+"/journal/"+ring.GetId(), nil, &detail)
	evs := detail.GetEvents()
	if len(evs) < 3 || evs[0].GetKind() != v1.SipCallEventKind_SIP_CALL_EVENT_KIND_STARTED ||
		evs[1].GetKind() != v1.SipCallEventKind_SIP_CALL_EVENT_KIND_SCHEDULE || evs[1].GetReason() != "off_hours" ||
		evs[1].GetTargetKind() != v1.SipCallTargetKind_SIP_CALL_TARGET_KIND_EXTENSION || evs[1].GetTargetId() != toCarol.GetId() ||
		evs[1].GetTargetName() != "102" || evs[2].GetKind() != v1.SipCallEventKind_SIP_CALL_EVENT_KIND_RING {
		t.Fatalf("journal events: %v", evs)
	}
	pushHTTP(t, server, carol, 204, "POST", "/api/sip/inbound/"+ring.GetId()+"/decline", nil, nil)

	// Off hours «hang up»: the call ends at once, reason off_hours, and counts as missed.
	pushHTTP(t, server, o, 200, "PUT", base+"/schedule", schedule(&v1.SipSchedule{Enabled: true, Hours: closedNow(t),
		OffHours: &v1.SipRouteTarget{Kind: v1.SipRouteKind_SIP_ROUTE_KIND_HANGUP}}), &put)
	room2 := rtc.InboundRoomPrefix(uuid.MustParse(wid)) + "_+79167777777_" + uniq("")
	if err := a.SIP.Inbound(ctx, rtc.EventParticipantJoined, room2, inboundLine("+79167777777")); err != nil {
		t.Fatal(err)
	}
	c, err := testDB.Q.GetSipCallByLKRoom(ctx, room2)
	if err != nil || c.Status != "ended" || c.Reason != "off_hours" || !c.Missed {
		t.Fatalf("off hours hang up: %+v %v", c, err)
	}
	o.must(200, "GET", base+"/journal/"+c.ID.String(), nil, &detail)
	evs = detail.GetEvents()
	if len(evs) != 3 || evs[1].GetKind() != v1.SipCallEventKind_SIP_CALL_EVENT_KIND_SCHEDULE || evs[1].GetTargetKind() != v1.SipCallTargetKind_SIP_CALL_TARGET_KIND_UNSPECIFIED ||
		evs[2].GetKind() != v1.SipCallEventKind_SIP_CALL_EVENT_KIND_ENDED || evs[2].GetReason() != "off_hours" {
		t.Fatalf("hang up events: %v", evs)
	}

	// Switched off: the entry point again.
	pushHTTP(t, server, o, 200, "PUT", base+"/schedule", schedule(&v1.SipSchedule{Enabled: false, Hours: closedNow(t)}), &put)
	room3 := rtc.InboundRoomPrefix(uuid.MustParse(wid)) + "_+79168888888_" + uniq("")
	if err := a.SIP.Inbound(ctx, rtc.EventParticipantJoined, room3, inboundLine("+79168888888")); err != nil {
		t.Fatal(err)
	}
	if r := bobG.wait("the entry point rings bob", func(e *v1.DispatchEvent) bool {
		return e.GetSipInboundRing().GetCall().GetNumber() == "+79168888888"
	}).GetSipInboundRing().GetCall(); r.GetOffHours() {
		t.Fatalf("schedule off: %v", r)
	}
}

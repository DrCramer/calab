//go:build integration

package app_test

import (
	"context"
	"encoding/json"
	"net/url"
	"slices"
	"testing"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/rtc"
	"github.com/calaba/calaba/server/internal/sip"
)

func journalKinds(t *testing.T, call string) []string {
	t.Helper()
	evs, err := testDB.Q.ListSipCallEvents(context.Background(), uuid.MustParse(call))
	if err != nil {
		t.Fatal(err)
	}
	out := make([]string, len(evs))
	for i, e := range evs {
		out[i] = e.Kind
	}
	return out
}

func journalIDs(r *v1.ListSipJournalResponse) []string {
	out := []string{}
	for _, e := range r.GetEntries() {
		out = append(out, e.GetCall().GetId())
	}
	return out
}

// TestSIPJournal (ADR-0137 §1): an inbound call through a group — a decline, an answer, a
// transfer to a member who takes it, the caller hangs up — and a missed one: their events in
// order with times, parties, idempotent writes; the journal API's visibility (mine / all /
// guests), filters and pages; SIP_JOURNAL_ENTRY and the missed badge (READY, «seen»); the
// recording's event, an outbound call's duplicate webhooks, legacy calls and retention.
func TestSIPJournal(t *testing.T) {
	ctx := context.Background()
	a, server, _, _ := inboundApp(t)
	o := owner(t)
	wid := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId()
	setPlan(t, wid, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_ENTERPRISE})
	bob := register(t, invite(t, o, wid))
	carol := register(t, invite(t, o, wid))
	dave := register(t, invite(t, o, wid))
	eve := register(t, invite(t, o, wid))
	oG, bobG, carolG, daveG, eveG := dialGW(t), dialGW(t), dialGW(t), dialGW(t), dialGW(t)
	oG.identify(o.token)
	bobG.identify(bob.token)
	carolG.identify(carol.token)
	daveG.identify(dave.token)
	eveG.identify(eve.token)
	base := "/api/workspaces/" + wid + "/sip"
	o.must(200, "PUT", base, &v1.PutSipSettingsRequest{Enabled: true, Provider: "Zadarma", Host: "203.0.113.10", CallerId: "+74951230137"}, nil)
	var bobExt, carolExt v1.SipExtensionResponse
	o.must(201, "POST", base+"/extensions", &v1.CreateSipExtensionRequest{Number: "101", UserId: bob.id}, &bobExt)
	o.must(201, "POST", base+"/extensions", &v1.CreateSipExtensionRequest{Number: "102", UserId: carol.id}, &carolExt)
	var g v1.SipGroupResponse
	o.must(201, "POST", base+"/groups", &v1.CreateSipGroupRequest{Name: "Продажи", Number: "1001",
		Members: &v1.SipGroupMembers{ExtensionIds: []string{bobExt.GetExtension().GetId(), carolExt.GetExtension().GetId()}}}, &g)
	pushHTTP(t, server, o, 200, "PUT", base+"/inbound", &v1.PutSipInboundRequest{Enabled: true,
		Target: &v1.SipRouteTarget{Kind: v1.SipRouteKind_SIP_ROUTE_KIND_GROUP, Id: g.GetGroup().GetId()}}, nil)

	ring := func(number string) (string, string, *rtc.Participant) {
		t.Helper()
		room := rtc.InboundRoomPrefix(uuid.MustParse(wid)) + "_" + number + "_" + uniq("")
		line := inboundLine(number)
		if err := a.SIP.Inbound(ctx, rtc.EventParticipantJoined, room, line); err != nil {
			t.Fatal(err)
		}
		cid := bobG.wait("the group rings bob", func(e *v1.DispatchEvent) bool {
			return e.GetSipInboundRing().GetCall().GetNumber() == number
		}).GetSipInboundRing().GetCall().GetId()
		return cid, room, line
	}
	ended := func(gw *gw, cid string) *v1.SipJournalEntry {
		t.Helper()
		return gw.wait("SIP_JOURNAL_ENTRY ended", func(e *v1.DispatchEvent) bool {
			en := e.GetSipJournalEntry().GetEntry()
			return en.GetCall().GetId() == cid && en.GetCall().GetStatus() == v1.SipCallStatus_SIP_CALL_STATUS_ENDED
		}).GetSipJournalEntry().GetEntry()
	}

	// Call 1: carol declines, bob answers and hands it to dave, the caller hangs up.
	cid1, room1, line1 := ring("+79161110001")
	oG.wait("SIP_JOURNAL_ENTRY of a new call", func(e *v1.DispatchEvent) bool {
		return e.GetSipJournalEntry().GetEntry().GetCall().GetId() == cid1
	})
	pushHTTP(t, server, carol, 204, "POST", "/api/sip/inbound/"+cid1+"/decline", nil, nil)
	pushHTTP(t, server, bob, 200, "POST", "/api/sip/inbound/"+cid1+"/accept", nil, nil)
	pushHTTP(t, server, bob, 200, "POST", base+"/calls/"+cid1+"/transfer", &v1.TransferSipCallRequest{UserId: dave.id}, nil)
	pushHTTP(t, server, dave, 200, "POST", "/api/sip/inbound/"+cid1+"/accept", nil, nil)
	if err := a.SIP.Inbound(ctx, rtc.EventParticipantLeft, room1, line1); err != nil {
		t.Fatal(err)
	}
	e1 := ended(oG, cid1)
	ended(bobG, cid1)
	ended(daveG, cid1)
	eveG.quiet("no journal for a member outside the call", 300*time.Millisecond, func(e *v1.DispatchEvent) bool { return e.GetSipJournalEntry() != nil })

	want := []string{"started", "group", "ring", "ring", "ring_end", "answered", "transfer", "ring", "transfer_end", "ended"}
	if got := journalKinds(t, cid1); !slices.Equal(got, want) {
		t.Fatalf("events: %v", got)
	}
	evs, _ := testDB.Q.ListSipCallEvents(ctx, uuid.MustParse(cid1))
	for i, ev := range evs {
		if int(ev.Seq) != i+1 || (i > 0 && ev.At.Before(evs[i-1].At)) {
			t.Fatalf("order: %+v", evs)
		}
	}
	is := func(ev sqlc.SipCallEvent, user, reason string) bool {
		return ev.Reason == reason && ((user == "" && ev.UserID == nil) || (ev.UserID != nil && ev.UserID.String() == user))
	}
	if evs[0].Digits != "+74951234567" || evs[0].Reason != "direct" || evs[1].TargetName != "Продажи" || evs[1].Reason != "ring_all" ||
		!is(evs[4], carol.id, "declined") || !is(evs[5], bob.id, "") || !is(evs[6], bob.id, "") || evs[6].PeerUserID.String() != dave.id ||
		!is(evs[7], dave.id, "") || !is(evs[8], dave.id, "answered") || !is(evs[9], "", "remote") {
		t.Fatalf("details: %+v", evs)
	}
	if e1.GetOrigin() != v1.SipCallOrigin_SIP_CALL_ORIGIN_INBOUND || e1.GetPeerE164() != "+79161110001" || e1.GetMissed() || !e1.GetHasEvents() || len(e1.GetParties()) != 3 {
		t.Fatalf("entry: %v", e1)
	}
	parties := map[string]*v1.SipCallParty{}
	for _, p := range e1.GetParties() {
		parties[p.GetUserId()] = p
	}
	if p := parties[bob.id]; !p.GetRang() || !p.GetAnswered() || !p.GetTransferred() || p.GetPlaced() {
		t.Fatalf("bob: %v", p)
	}
	if p := parties[carol.id]; !p.GetRang() || p.GetAnswered() {
		t.Fatalf("carol: %v", p)
	}
	if p := parties[dave.id]; !p.GetRang() || !p.GetAnswered() || p.GetTransferred() {
		t.Fatalf("dave: %v", p)
	}
	// A retried transition writes the same seq again: nothing changes.
	again, _ := json.Marshal([]sip.Event{{Seq: 2, At: time.Now(), Kind: sip.EvKey, Digits: "9"}})
	if err := testDB.Q.InsertSipCallEvents(ctx, sqlc.InsertSipCallEventsParams{CallID: uuid.MustParse(cid1), Events: again}); err != nil {
		t.Fatal(err)
	}
	if got := journalKinds(t, cid1); !slices.Equal(got, want) {
		t.Fatalf("after a retry: %v", got)
	}

	// Call 2: both decline — missed; both get the badge.
	cid2, _, _ := ring("+79162220002")
	pushHTTP(t, server, carol, 204, "POST", "/api/sip/inbound/"+cid2+"/decline", nil, nil)
	pushHTTP(t, server, bob, 204, "POST", "/api/sip/inbound/"+cid2+"/decline", nil, nil)
	if e2 := ended(oG, cid2); !e2.GetMissed() || e2.GetCall().GetReason() != "declined" {
		t.Fatalf("missed: %v", e2)
	}
	for _, w := range []*gw{bobG, carolG} {
		w.wait("SIP_MISSED_CHANGED", func(e *v1.DispatchEvent) bool {
			m := e.GetSipMissedChanged()
			return m.GetWorkspaceId() == wid && m.GetCount() == 1
		})
	}
	daveG.quiet("no badge for who it did not ring", 300*time.Millisecond, func(e *v1.DispatchEvent) bool { return e.GetSipMissedChanged() != nil })
	// READY on a new connection (it replaces the user's earlier session of the test).
	snapMissed := func(token string) (uint32, *gw) {
		t.Helper()
		g := dialGW(t)
		for _, s := range g.identify(token).GetWorkspaces() {
			if s.GetWorkspace().GetId() == wid {
				return s.GetSipMissed(), g
			}
		}
		t.Fatal("no snapshot")
		return 0, nil
	}
	if n, g := snapMissed(bob.token); n != 1 {
		t.Fatalf("bob's READY: %d", n)
	} else {
		bobG = g
	}
	if n, _ := snapMissed(dave.token); n != 0 {
		t.Fatalf("dave's READY: %d", n)
	}

	// The journal: mine / all, filters, pages.
	list := func(u *user, status int, query string) *v1.ListSipJournalResponse {
		t.Helper()
		var out v1.ListSipJournalResponse
		u.must(status, "GET", base+"/journal?"+query, nil, &out)
		return &out
	}
	if ids := journalIDs(list(o, 200, "scope=all")); !slices.Equal(ids, []string{cid2, cid1}) {
		t.Fatalf("all: %v", ids)
	}
	if ids := journalIDs(list(bob, 200, "")); !slices.Equal(ids, []string{cid2, cid1}) {
		t.Fatalf("bob's: %v", ids)
	}
	if ids := journalIDs(list(bob, 200, "filter=missed")); !slices.Equal(ids, []string{cid2}) {
		t.Fatalf("bob's missed: %v", ids)
	}
	if ids := journalIDs(list(dave, 200, "scope=mine")); !slices.Equal(ids, []string{cid1}) {
		t.Fatalf("dave's: %v", ids)
	}
	if ids := journalIDs(list(dave, 200, "filter=missed")); len(ids) != 0 {
		t.Fatalf("dave's missed: %v", ids)
	}
	if ids := journalIDs(list(eve, 200, "")); len(ids) != 0 {
		t.Fatalf("eve's: %v", ids)
	}
	list(eve, 403, "scope=all")
	list(bob, 422, "user="+dave.id)
	list(o, 422, "scope=everything")
	list(o, 422, "filter=lost")
	list(o, 422, "limit=0")
	list(o, 422, "cursor=nonsense")
	if ids := journalIDs(list(o, 200, "scope=all&user="+dave.id)); !slices.Equal(ids, []string{cid1}) {
		t.Fatalf("dave's by an admin: %v", ids)
	}
	if ids := journalIDs(list(o, 200, "scope=all&filter=in")); len(ids) != 2 {
		t.Fatalf("in: %v", ids)
	}
	if ids := journalIDs(list(o, 200, "scope=all&filter=out")); len(ids) != 0 {
		t.Fatalf("out: %v", ids)
	}
	if ids := journalIDs(list(o, 200, "scope=all&q="+url.QueryEscape("+7 916 222"))); !slices.Equal(ids, []string{cid2}) {
		t.Fatalf("by number: %v", ids)
	}
	if ids := journalIDs(list(o, 200, "scope=all&q="+url.QueryEscape("Анна"))); len(ids) != 0 {
		t.Fatalf("by name before contacts: %v", ids)
	}
	if ids := journalIDs(list(o, 200, "scope=all&from="+url.QueryEscape(time.Now().Add(time.Hour).Format(time.RFC3339)))); len(ids) != 0 {
		t.Fatalf("from the future: %v", ids)
	}
	p1 := list(o, 200, "scope=all&limit=1")
	if !slices.Equal(journalIDs(p1), []string{cid2}) || p1.GetNextCursor() == "" {
		t.Fatalf("page 1: %v", p1)
	}
	p2 := list(o, 200, "scope=all&limit=1&cursor="+url.QueryEscape(p1.GetNextCursor()))
	if !slices.Equal(journalIDs(p2), []string{cid1}) {
		t.Fatalf("page 2: %v", p2)
	}
	if p3 := list(o, 200, "scope=all&limit=1&cursor="+url.QueryEscape(p2.GetNextCursor())); p2.GetNextCursor() != "" && len(p3.GetEntries()) != 0 {
		t.Fatalf("page 3: %v", p3)
	}

	// The detail: parties and VIEW_JOURNALS; never outsiders.
	var d v1.GetSipJournalEntryResponse
	bob.must(200, "GET", base+"/journal/"+cid1, nil, &d)
	if len(d.GetEvents()) != len(want) || d.GetEvents()[0].GetAt() == nil || d.GetRecording() != nil ||
		d.GetEvents()[1].GetKind() != v1.SipCallEventKind_SIP_CALL_EVENT_KIND_GROUP || d.GetEvents()[1].GetTargetKind() != v1.SipCallTargetKind_SIP_CALL_TARGET_KIND_GROUP {
		t.Fatalf("detail: %v", &d)
	}
	o.must(200, "GET", base+"/journal/"+cid1, nil, nil)
	eve.must(404, "GET", base+"/journal/"+cid1, nil, nil)
	dave.must(404, "GET", base+"/journal/"+cid2, nil, nil)
	o.must(404, "GET", "/api/workspaces/"+createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId()+"/sip/journal/"+cid1, nil, nil)

	// A guest has no journal.
	rid := textRoom(t, o, wid, "general", false)
	link := roomLink(t, o, rid, &v1.CreateRoomInviteRequest{})
	gina := register(t, invite(t, o, createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId()))
	gina.must(200, "POST", "/api/room-invites/"+link.GetCode()+"/join", nil, nil)
	gina.must(403, "GET", base+"/journal", nil, nil)
	gina.must(403, "GET", base+"/journal/"+cid1, nil, nil)

	// «Seen» clears the badge on every device.
	bob.must(204, "POST", base+"/journal/seen", nil, nil)
	bobG.wait("SIP_MISSED_CHANGED 0", func(e *v1.DispatchEvent) bool {
		m := e.GetSipMissedChanged()
		return m.GetWorkspaceId() == wid && m.GetCount() == 0
	})
	if n, _ := snapMissed(bob.token); n != 0 {
		t.Fatalf("bob's READY after seen: %d", n)
	}

	// The recording's steps come from outside the machine: numbers past its own.
	a.SIP.RecordingEvent(ctx, uuid.MustParse(cid1), "stored")
	evs, _ = testDB.Q.ListSipCallEvents(ctx, uuid.MustParse(cid1))
	if last := evs[len(evs)-1]; last.Kind != "recording" || last.Reason != "stored" || last.Seq != 1_000_001 {
		t.Fatalf("recording event: %+v", last)
	}

	// A call from before the journal: its route without times.
	if _, err := testDB.Pool.Exec(ctx, "DELETE FROM sip_call_events WHERE call_id = $1", cid2); err != nil {
		t.Fatal(err)
	}
	bob.must(200, "GET", base+"/journal/"+cid2, nil, &d)
	if d.GetEntry().GetHasEvents() || len(d.GetEvents()) != 3 || d.GetEvents()[1].GetTargetId() != g.GetGroup().GetId() ||
		d.GetEvents()[0].GetAt() != nil || d.GetEvents()[2].GetReason() != "declined" {
		t.Fatalf("legacy detail: %v", &d)
	}

	// An outbound room call: LiveKit's webhook twice gives one ANSWERED, the end one ENDED.
	vroom := uuid.MustParse(voiceRoom(t, o, wid, "Звонки", 0))
	oid := uuid.Must(uuid.NewV7())
	if _, err := testDB.Q.InsertSipCall(ctx, sqlc.InsertSipCallParams{ID: oid, WorkspaceID: uuid.MustParse(wid), RoomID: &vroom,
		Number: "+74957654321", StartedBy: ptrUUID(uuid.MustParse(o.id)), ParticipantIdentity: rtc.SIPIdentity(oid), Origin: "room",
		PeerE164: "+74957654321"}); err != nil {
		t.Fatal(err)
	}
	lineOut := &rtc.Participant{Identity: rtc.SIPIdentity(oid), Attributes: map[string]string{rtc.AttrSIPCallStatus: "active", rtc.AttrSIPCallID: "SCL_o"}}
	for range 2 {
		if err := a.SIP.SIPParticipant(ctx, rtc.EventParticipantJoined, uuid.MustParse(wid), vroom, lineOut); err != nil {
			t.Fatal(err)
		}
	}
	for range 2 {
		if err := a.SIP.SIPParticipant(ctx, rtc.EventParticipantLeft, uuid.MustParse(wid), vroom, lineOut); err != nil {
			t.Fatal(err)
		}
	}
	if got := journalKinds(t, oid.String()); !slices.Equal(got, []string{"answered", "ended"}) {
		t.Fatalf("outbound events: %v", got)
	}
	if ids := journalIDs(list(o, 200, "scope=all&filter=out")); !slices.Equal(ids, []string{oid.String()}) {
		t.Fatalf("out: %v", ids)
	}

	// Retention: 12 months by default; another workspace keeps 36.
	ws2 := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId()
	setPlan(t, ws2, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_ENTERPRISE})
	o.must(200, "PUT", "/api/workspaces/"+ws2+"/sip", &v1.PutSipSettingsRequest{Enabled: true, Provider: "Zadarma", Host: "203.0.113.10", CallerId: "+74951230138"}, nil)
	o.must(200, "PUT", "/api/workspaces/"+ws2+"/sip/policy", &v1.PutSipPolicyRequest{RetentionMonths: 36}, nil)
	old2 := uuid.Must(uuid.NewV7())
	if _, err := testDB.Q.InsertSipCall(ctx, sqlc.InsertSipCallParams{ID: old2, WorkspaceID: uuid.MustParse(ws2), Number: "+74950000000",
		ParticipantIdentity: rtc.SIPIdentity(old2), Origin: "test", PeerE164: "+74950000000"}); err != nil {
		t.Fatal(err)
	}
	ago := time.Now().AddDate(0, -13, 0)
	if _, err := testDB.Pool.Exec(ctx, "UPDATE sip_calls SET started_at = $2, status = 'ended' WHERE id = ANY($1)", []uuid.UUID{uuid.MustParse(cid1), old2}, ago); err != nil {
		t.Fatal(err)
	}
	if n := a.SIP.PurgeExpired(ctx, time.Now()); n < 1 {
		t.Fatalf("purged %d", n)
	}
	if _, err := testDB.Q.GetSipCall(ctx, uuid.MustParse(cid1)); err == nil {
		t.Fatal("a call older than a year stays")
	}
	if got := journalKinds(t, cid1); len(got) != 0 {
		t.Fatalf("its events stay: %v", got)
	}
	if _, err := testDB.Q.GetSipCall(ctx, old2); err != nil {
		t.Fatalf("a call within 36 months went: %v", err)
	}
	if _, err := testDB.Q.GetSipCall(ctx, uuid.MustParse(cid2)); err != nil {
		t.Fatalf("a recent call went: %v", err)
	}
}

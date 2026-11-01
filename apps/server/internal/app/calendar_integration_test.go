//go:build integration

package app_test

import (
	"context"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/mail"
)

// Workspace calendar (ADR-0038): run with -run 'Event'.

type calTeam struct {
	o, bob, carol, gus *user
	ws                 *v1.Workspace
	voice              *v1.Room
	text               string
}

func calSetup(t *testing.T) calTeam {
	t.Helper()
	o, bob, ws, voice := setupTeam(t)
	code := invite(t, o, ws.GetId())
	carol, gus := register(t, code), register(t, code)
	guest := v1.WorkspaceRole_WORKSPACE_ROLE_GUEST
	o.must(200, "PATCH", "/api/workspaces/"+ws.GetId()+"/members/"+gus.id, &v1.UpdateMemberRequest{Role: &guest}, nil)
	return calTeam{o: o, bob: bob, carol: carol, gus: gus, ws: ws, voice: voice, text: textRoom(t, o, ws.GetId(), "chat", false)}
}

func ts(t time.Time) *timestamppb.Timestamp { return timestamppb.New(t) }

func att(userID string, required bool) *v1.CalendarEventAttendeeInput {
	return &v1.CalendarEventAttendeeInput{UserId: userID, Required: required}
}

func ext(email string) *v1.CalendarEventAttendeeInput {
	return &v1.CalendarEventAttendeeInput{Email: email}
}

func createEvent(t *testing.T, u *user, wsID string, req *v1.CreateCalendarEventRequest) *v1.CalendarEvent {
	t.Helper()
	var resp v1.CalendarEventResponse
	u.must(201, "POST", "/api/workspaces/"+wsID+"/events", req, &resp)
	return resp.GetEvent()
}

func listEvents(t *testing.T, u *user, wsID string, from, to time.Time) []*v1.CalendarEvent {
	t.Helper()
	var resp v1.ListCalendarEventsResponse
	u.must(200, "GET", "/api/workspaces/"+wsID+"/events?from="+url.QueryEscape(from.Format(time.RFC3339))+"&to="+url.QueryEscape(to.Format(time.RFC3339)), nil, &resp)
	return resp.GetEvents()
}

func attendeeOf(e *v1.CalendarEvent, userID, email string) *v1.CalendarEventAttendee {
	for _, a := range e.GetAttendees() {
		if (userID != "" && a.GetUserId() == userID) || (email != "" && a.GetEmail() == email) {
			return a
		}
	}
	return nil
}

// unfoldICS undoes RFC 5545 line folding.
func unfoldICS(s string) string { return strings.ReplaceAll(s, "\r\n ", "") }

func waitMail(t *testing.T, to string, tmpl mail.Template, n int) mail.Message {
	t.Helper()
	m, ok := testMail.WaitN(mailWait, n, func(m mail.Message) bool { return m.To == to && m.Template == tmpl })
	if !ok {
		t.Fatalf("no mail #%d %s to %s", n, tmpl, to)
	}
	return m
}

func TestEventCRUDAndPermissions(t *testing.T) {
	c := calSetup(t)
	wsID := c.ws.GetId()
	start := time.Now().Add(48 * time.Hour).Truncate(time.Minute)
	base := func() *v1.CreateCalendarEventRequest {
		return &v1.CreateCalendarEventRequest{Title: "Планёрка", StartsAt: ts(start), EndsAt: ts(start.Add(time.Hour)), Tz: "Europe/Moscow",
			RoomId: c.voice.GetId(), Attendees: []*v1.CalendarEventAttendeeInput{att(c.carol.id, true)}}
	}

	// Validation.
	bad := map[string]func(r *v1.CreateCalendarEventRequest){
		"no title":      func(r *v1.CreateCalendarEventRequest) { r.Title = " " },
		"long title":    func(r *v1.CreateCalendarEventRequest) { r.Title = strings.Repeat("x", 121) },
		"ends early":    func(r *v1.CreateCalendarEventRequest) { r.EndsAt = r.StartsAt },
		"too long":      func(r *v1.CreateCalendarEventRequest) { r.EndsAt = ts(start.Add(9 * 24 * time.Hour)) },
		"bad tz":        func(r *v1.CreateCalendarEventRequest) { r.Tz = "Mars/Olympus" },
		"text room":     func(r *v1.CreateCalendarEventRequest) { r.RoomId = c.text },
		"guest invitee": func(r *v1.CreateCalendarEventRequest) { r.Attendees = append(r.Attendees, att(c.gus.id, true)) },
		"stranger":      func(r *v1.CreateCalendarEventRequest) { r.Attendees = append(r.Attendees, att(uuid.NewString(), true)) },
		"bad email":     func(r *v1.CreateCalendarEventRequest) { r.Attendees = append(r.Attendees, ext("not an email")) },
		"both": func(r *v1.CreateCalendarEventRequest) {
			r.Attendees = append(r.Attendees, &v1.CalendarEventAttendeeInput{UserId: c.o.id, Email: "a@b.cd"})
		},
		"21 externals": func(r *v1.CreateCalendarEventRequest) {
			for i := range 21 {
				r.Attendees = append(r.Attendees, ext("x"+string(rune('a'+i))+"@outside.org"))
			}
		},
		"until before": func(r *v1.CreateCalendarEventRequest) {
			r.Repeat, r.RepeatUntil = v1.EventRepeat_EVENT_REPEAT_WEEKLY, ts(start.Add(-time.Hour))
		},
	}
	for name, mod := range bad {
		r := base()
		mod(r)
		if st := c.bob.do("POST", "/api/workspaces/"+wsID+"/events", r, nil); st != 422 {
			t.Errorf("%s: %d, want 422", name, st)
		}
	}
	// Guests see no calendar.
	c.gus.must(403, "GET", "/api/workspaces/"+wsID+"/events?from="+url.QueryEscape(start.Format(time.RFC3339))+"&to="+url.QueryEscape(start.Add(time.Hour).Format(time.RFC3339)), nil, nil)
	c.gus.must(403, "POST", "/api/workspaces/"+wsID+"/events", base(), nil)

	// carol's gateway sees the event; the guest's does not.
	cg := dialGW(t)
	defer func() { _ = cg.ws.CloseNow() }()
	cg.identify(c.carol.token)
	gg := dialGW(t)
	defer func() { _ = gg.ws.CloseNow() }()
	gg.identify(c.gus.token)

	// bob (a member) creates a meeting with carol and an external address.
	r := base()
	r.Description = "Итоги недели"
	r.Attendees = append(r.Attendees, ext("Partner@Outside.org"))
	ev := createEvent(t, c.bob, wsID, r)
	if ev.GetOrganizerId() != c.bob.id || ev.GetMyStatus() != v1.AttendeeStatus_ATTENDEE_STATUS_ACCEPTED || !ev.GetCanEdit() ||
		ev.GetCounts().GetAccepted() != 1 || ev.GetCounts().GetPending() != 2 || len(ev.GetAttendees()) != 3 {
		t.Fatalf("created: %v", ev)
	}
	if a := attendeeOf(ev, "", "partner@outside.org"); a == nil || a.GetRequired() {
		t.Fatalf("external attendee (lower-cased, optional): %v", ev.GetAttendees())
	}
	if ev.GetGuestLinks() {
		t.Error("bob has no MANAGE_ROOM: no guest links")
	}
	got := cg.wait("EVENT_CREATE", func(e *v1.DispatchEvent) bool { return e.GetEventCreate().GetEvent().GetId() == ev.GetId() })
	if attendeeOf(got.GetEventCreate().GetEvent(), "", "partner@outside.org") == nil {
		t.Error("an attendee sees the external address in full")
	}
	gg.quiet("EVENT_CREATE for a guest", 300*time.Millisecond, func(e *v1.DispatchEvent) bool { return e.GetEventCreate() != nil })

	// The owner (not involved, sees the room, MANAGE_ROOM) sees the address in full; a plain
	// member viewer of the room would see it masked (checked with a fresh member).
	dave := register(t, invite(t, c.o, wsID))
	var dv v1.CalendarEventResponse
	dave.must(200, "GET", "/api/events/"+ev.GetId(), nil, &dv)
	if a := dv.GetEvent().GetAttendees(); dv.GetEvent().GetCanEdit() || attendeeOf(dv.GetEvent(), "", "p***@outside.org") == nil || len(a) != 3 {
		t.Fatalf("masked for a viewer: %v", dv.GetEvent())
	}

	// List: one occurrence in the window, with my_status.
	list := listEvents(t, c.carol, wsID, start.Add(-time.Hour), start.Add(2*time.Hour))
	if len(list) != 1 || list[0].GetMyStatus() != v1.AttendeeStatus_ATTENDEE_STATUS_PENDING || !list[0].GetOccurrenceAt().AsTime().Equal(start) {
		t.Fatalf("list: %v", list)
	}
	c.carol.must(422, "GET", "/api/workspaces/"+wsID+"/events?from=x&to=y", nil, nil)

	// RSVP: carol answers; dave is not an attendee.
	var rs v1.CalendarEventResponse
	c.carol.must(200, "PUT", "/api/events/"+ev.GetId()+"/rsvp", &v1.RsvpCalendarEventRequest{Status: v1.AttendeeStatus_ATTENDEE_STATUS_MAYBE}, &rs)
	if rs.GetEvent().GetMyStatus() != v1.AttendeeStatus_ATTENDEE_STATUS_MAYBE || rs.GetEvent().GetCounts().GetMaybe() != 1 {
		t.Fatalf("rsvp: %v", rs.GetEvent())
	}
	dave.must(403, "PUT", "/api/events/"+ev.GetId()+"/rsvp", &v1.RsvpCalendarEventRequest{Status: v1.AttendeeStatus_ATTENDEE_STATUS_ACCEPTED}, nil)
	c.carol.must(422, "PUT", "/api/events/"+ev.GetId()+"/rsvp", &v1.RsvpCalendarEventRequest{}, nil)
	cg.wait("EVENT_RSVP", func(e *v1.DispatchEvent) bool {
		return e.GetEventRsvp().GetAttendee().GetUserId() == c.carol.id && e.GetEventRsvp().GetCounts().GetMaybe() == 1
	})

	// Editing: carol (attendee, no MANAGE_ROOM) may not; the owner (MANAGE_ROOM) may.
	title := "Планёрка (перенос)"
	c.carol.must(403, "PATCH", "/api/events/"+ev.GetId(), &v1.UpdateCalendarEventRequest{Title: &title}, nil)
	var up v1.CalendarEventResponse
	c.o.must(200, "PATCH", "/api/events/"+ev.GetId(), &v1.UpdateCalendarEventRequest{Title: &title, StartsAt: ts(start.Add(time.Hour)), EndsAt: ts(start.Add(2 * time.Hour))}, &up)
	if up.GetEvent().GetTitle() != title || up.GetEvent().GetSequence() != 1 || attendeeOf(up.GetEvent(), c.carol.id, "").GetStatus() != v1.AttendeeStatus_ATTENDEE_STATUS_MAYBE {
		t.Fatalf("patch: %v", up.GetEvent())
	}
	cg.wait("EVENT_UPDATE", func(e *v1.DispatchEvent) bool { return e.GetEventUpdate().GetEvent().GetTitle() == title })

	// Removing carol: she gets EVENT_DELETE of the old state first (she still sees the room, so
	// EVENT_UPDATE follows), and the list keeps the organizer and the external attendee.
	c.bob.must(200, "PATCH", "/api/events/"+ev.GetId(), &v1.UpdateCalendarEventRequest{SetAttendees: true,
		Attendees: []*v1.CalendarEventAttendeeInput{ext("partner@outside.org")}}, &up)
	if len(up.GetEvent().GetAttendees()) != 2 || attendeeOf(up.GetEvent(), c.carol.id, "") != nil || up.GetEvent().GetMyStatus() != v1.AttendeeStatus_ATTENDEE_STATUS_ACCEPTED {
		t.Fatalf("attendees replaced: %v", up.GetEvent().GetAttendees())
	}
	cg.wait("EVENT_DELETE (moved out)", func(e *v1.DispatchEvent) bool {
		return e.GetEventDelete().GetEvent().GetId() == ev.GetId() && e.GetEventDelete().GetEvent().GetCancelledAt() == nil
	})

	// A meeting without a room is seen by its attendees only.
	private := createEvent(t, c.bob, wsID, &v1.CreateCalendarEventRequest{Title: "1:1", StartsAt: ts(start), EndsAt: ts(start.Add(30 * time.Minute)),
		Tz: "UTC", Attendees: []*v1.CalendarEventAttendeeInput{att(c.carol.id, true)}})
	c.carol.must(200, "GET", "/api/events/"+private.GetId(), nil, nil)
	dave.must(404, "GET", "/api/events/"+private.GetId(), nil, nil)
	c.o.must(404, "GET", "/api/events/"+private.GetId(), nil, nil)
	if l := listEvents(t, dave, wsID, start.Add(-time.Hour), start.Add(3*time.Hour)); len(l) != 1 || l[0].GetId() != ev.GetId() {
		t.Fatalf("dave's list: %v", l)
	}
	// …and edited by its organizer or MANAGE_WORKSPACE: the owner cannot see it, so 404.
	c.o.must(404, "DELETE", "/api/events/"+private.GetId(), nil, nil)
	c.carol.must(403, "DELETE", "/api/events/"+private.GetId(), nil, nil)

	// Today (for the icon): carol's 1:1 is not today; a meeting in an hour is.
	soon := createEvent(t, c.bob, wsID, &v1.CreateCalendarEventRequest{Title: "Скоро", StartsAt: ts(time.Now().Add(time.Hour)),
		EndsAt: ts(time.Now().Add(90 * time.Minute)), Tz: "UTC", Attendees: []*v1.CalendarEventAttendeeInput{att(c.carol.id, false)}})
	var today v1.TodayCalendarEventsResponse
	c.carol.must(200, "GET", "/api/me/events/today?tz=UTC", nil, &today)
	found := false
	for _, e := range today.GetEvents() {
		found = found || e.GetId() == soon.GetId()
		if e.GetId() == private.GetId() {
			t.Error("tomorrow's meeting in today")
		}
	}
	// Past 23:00 UTC the meeting in an hour is tomorrow.
	if !found && time.Now().UTC().Hour() < 22 || int(today.GetCount()) != len(today.GetEvents()) {
		t.Fatalf("today: %v", today.GetEvents())
	}
	c.carol.must(200, "PUT", "/api/events/"+soon.GetId()+"/rsvp", &v1.RsvpCalendarEventRequest{Status: v1.AttendeeStatus_ATTENDEE_STATUS_DECLINED}, nil)
	c.carol.must(200, "GET", "/api/me/events/today?tz=UTC", nil, &today)
	for _, e := range today.GetEvents() {
		if e.GetId() == soon.GetId() {
			t.Error("a declined meeting in today")
		}
	}

	// Cancel: EVENT_DELETE with cancelled_at; GET still shows it (deep link), PATCH is 404.
	c.o.must(204, "DELETE", "/api/events/"+ev.GetId(), nil, nil)
	var cancelled v1.CalendarEventResponse
	c.bob.must(200, "GET", "/api/events/"+ev.GetId(), nil, &cancelled)
	if cancelled.GetEvent().GetCancelledAt() == nil {
		t.Fatal("cancelled_at")
	}
	c.bob.must(404, "PATCH", "/api/events/"+ev.GetId(), &v1.UpdateCalendarEventRequest{Title: &title}, nil)
	if l := listEvents(t, c.bob, wsID, start, start.Add(3*time.Hour)); len(l) != 1 || l[0].GetId() != private.GetId() {
		t.Fatalf("list after cancel: %v", l)
	}
}

func TestEventRecurringAndException(t *testing.T) {
	c := calSetup(t)
	wsID := c.ws.GetId()
	msk, _ := time.LoadLocation("Europe/Moscow")
	d := time.Now().In(msk).AddDate(0, 0, 3)
	start := time.Date(d.Year(), d.Month(), d.Day(), 10, 0, 0, 0, msk)
	ev := createEvent(t, c.o, wsID, &v1.CreateCalendarEventRequest{Title: "Weekly", StartsAt: ts(start), EndsAt: ts(start.Add(30 * time.Minute)),
		Tz: "Europe/Moscow", Repeat: v1.EventRepeat_EVENT_REPEAT_WEEKLY, RepeatUntil: ts(start.AddDate(0, 0, 14)), RoomId: c.voice.GetId()})
	if ev.GetRepeat() != v1.EventRepeat_EVENT_REPEAT_WEEKLY || ev.GetRepeatUntil() == nil {
		t.Fatalf("series: %v", ev)
	}
	occ := listEvents(t, c.bob, wsID, start.Add(-time.Hour), start.AddDate(0, 0, 30))
	if len(occ) != 3 || !occ[1].GetOccurrenceAt().AsTime().Equal(start.AddDate(0, 0, 7)) || occ[2].GetStartsAt().AsTime().In(msk).Hour() != 10 {
		t.Fatalf("occurrences: %v", occ)
	}
	second := start.AddDate(0, 0, 7).UTC().Format(time.RFC3339)
	c.o.must(422, "DELETE", "/api/events/"+ev.GetId()+"?occurrence="+url.QueryEscape(start.Add(time.Minute).Format(time.RFC3339)), nil, nil)
	c.bob.must(403, "DELETE", "/api/events/"+ev.GetId()+"?occurrence="+url.QueryEscape(second), nil, nil)
	c.o.must(204, "DELETE", "/api/events/"+ev.GetId()+"?occurrence="+url.QueryEscape(second), nil, nil)
	occ = listEvents(t, c.bob, wsID, start.Add(-time.Hour), start.AddDate(0, 0, 30))
	if len(occ) != 2 || len(occ[0].GetCancelledOccurrences()) != 1 || occ[0].GetSequence() != 1 {
		t.Fatalf("after the exception: %v", occ)
	}
}

func TestEventMailAndGuestLinks(t *testing.T) {
	c := calSetup(t)
	wsID := c.ws.GetId()
	partner := uniq("partner") + "@outside.org"
	rival := uniq("rival") + "@elsewhere.org" // another outside attendee: partner must not see this address
	unverified := register(t, invite(t, c.o, wsID))
	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE users SET email_verified_at = NULL WHERE id = $1", unverified.id); err != nil {
		t.Fatal(err)
	}
	start := time.Now().Add(72 * time.Hour).Truncate(time.Minute)
	// The owner (MANAGE_ROOM) invites: the external attendee gets a guest link.
	ev := createEvent(t, c.o, wsID, &v1.CreateCalendarEventRequest{Title: "Демо; клиент", Description: "Повестка", StartsAt: ts(start),
		EndsAt: ts(start.Add(time.Hour)), Tz: "Europe/Moscow", RoomId: c.voice.GetId(),
		Attendees: []*v1.CalendarEventAttendeeInput{att(c.bob.id, true), att(unverified.id, false), ext(partner), ext(rival)}})
	if !ev.GetGuestLinks() {
		t.Fatalf("guest links: %v", ev)
	}
	m := waitMail(t, partner, mail.TemplateEventInvite, 1)
	ics := unfoldICS(m.Calendar)
	for _, want := range []string{"METHOD:REQUEST", "UID:" + ev.GetId() + "@calab", "SEQUENCE:0", "SUMMARY:Демо\\; клиент",
		"ATTENDEE;ROLE=OPT-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:" + partner, "mailto:" + c.o.email,
		"URL:https://app.example.com/e/" + ev.GetId(), "DTSTART:" + start.UTC().Format("20060102T150405Z")} {
		if !strings.Contains(ics, want) {
			t.Errorf("ics: no %q in\n%s", want, ics)
		}
	}
	// Outside recipients: the organizer and their own line only, colleagues by name.
	if strings.Contains(ics, c.bob.email) || strings.Contains(ics, rival) || strings.Contains(m.Params["attendees"], rival) ||
		!strings.Contains(m.Params["attendees"], partner) {
		t.Errorf("external invite leaks addresses: %q\n%s", m.Params["attendees"], ics)
	}
	if m.CalendarMethod != "REQUEST" || m.ReplyTo != c.o.email || !strings.Contains(m.Subject, "Демо; клиент") {
		t.Errorf("mail: %q %q %q", m.CalendarMethod, m.ReplyTo, m.Subject)
	}
	guestURL := m.Params["guest_url"]
	if !strings.HasPrefix(guestURL, "https://app.example.com/r/") || !strings.HasPrefix(m.Params["rsvp_accept"], "https://app.example.com/e/"+ev.GetId()+"/rsvp?t=") {
		t.Fatalf("links: %v", m.Params)
	}
	bm := waitMail(t, c.bob.email, mail.TemplateEventInvite, 1)
	if bm.Params["guest_url"] != "" || bm.Params["rsvp_accept"] != "" {
		t.Error("members get no guest / answer links")
	}
	if bi := unfoldICS(bm.Calendar); !strings.Contains(bi, "mailto:"+partner) || !strings.Contains(bi, "mailto:"+rival) || !strings.Contains(bi, "mailto:"+c.bob.email) {
		t.Errorf("member invite lists every attendee: %s", bi)
	}
	time.Sleep(300 * time.Millisecond)
	if n := testMail.Count(func(m mail.Message) bool { return m.To == unverified.email && m.Template == mail.TemplateEventInvite }); n != 0 {
		t.Error("mail to an unverified address")
	}

	// The guest link: before the window 409 INVITE_NOT_YET_VALID; the preview shows not_before.
	code := strings.TrimPrefix(guestURL, "https://app.example.com/r/")
	anon := &client{t: t, ip: "10.9.1.1"}
	var pv v1.GetRoomInviteResponse
	anon.must(200, "GET", "/api/room-invites/"+code, nil, &pv)
	if !pv.GetNotBefore().AsTime().Equal(start.Add(-15*time.Minute)) || !pv.GetExpiresAt().AsTime().Equal(start.Add(2*time.Hour)) {
		t.Fatalf("preview window: %v", &pv)
	}
	st, e := anon.apiErrBody("POST", "/api/room-invites/"+code+"/join", &v1.JoinRoomInviteRequest{Nickname: "Partner"})
	if st != 409 || e.GetCode() != v1.ErrorCode_ERROR_CODE_INVITE_NOT_YET_VALID {
		t.Fatalf("early join: %d %v", st, e)
	}
	var links v1.ListRoomInvitesResponse
	c.o.must(200, "GET", "/api/rooms/"+c.voice.GetId()+"/invites", nil, &links)
	var link *v1.RoomInvite
	for _, l := range links.GetInvites() {
		if l.GetCode() == code {
			link = l
		}
	}
	if link == nil || link.GetEventId() != ev.GetId() || link.GetMaxUses() != 1 || link.GetAllowFiles() || !link.GetAllowSpeak() {
		t.Fatalf("meeting link: %v", link)
	}

	// Signed answer: preview, answer, idempotent; tampered → 404.
	tok, _ := url.QueryUnescape(strings.SplitN(m.Params["rsvp_decline"], "?t=", 2)[1])
	var ans v1.EventRsvpTokenResponse
	anon.must(200, "GET", "/api/event-rsvp?t="+url.QueryEscape(tok), nil, &ans)
	if ans.GetTitle() != "Демо; клиент" || ans.GetStatus() != v1.AttendeeStatus_ATTENDEE_STATUS_DECLINED || ans.GetEmail() != partner {
		t.Fatalf("preview: %v", &ans)
	}
	anon.must(200, "POST", "/api/event-rsvp", &v1.EventRsvpTokenRequest{Token: tok}, &ans)
	anon.must(200, "POST", "/api/event-rsvp", &v1.EventRsvpTokenRequest{Token: tok}, &ans)
	var got v1.CalendarEventResponse
	c.o.must(200, "GET", "/api/events/"+ev.GetId(), nil, &got)
	if a := attendeeOf(got.GetEvent(), "", partner); a.GetStatus() != v1.AttendeeStatus_ATTENDEE_STATUS_DECLINED || a.GetRespondedAt() == nil {
		t.Fatalf("external answer: %v", a)
	}
	anon.must(404, "GET", "/api/event-rsvp?t="+url.QueryEscape(tok[:len(tok)-2]+"AA"), nil, nil)
	anon.must(404, "POST", "/api/event-rsvp", &v1.EventRsvpTokenRequest{Token: "junk"}, nil)

	// Update: SEQUENCE 1, the link follows the new time; removing the partner revokes it and
	// mails CANCEL.
	newStart := start.Add(24 * time.Hour)
	c.o.must(200, "PATCH", "/api/events/"+ev.GetId(), &v1.UpdateCalendarEventRequest{StartsAt: ts(newStart), EndsAt: ts(newStart.Add(time.Hour))}, nil)
	um := waitMail(t, partner, mail.TemplateEventUpdate, 1)
	if !strings.Contains(unfoldICS(um.Calendar), "SEQUENCE:1") || um.Params["guest_url"] != guestURL {
		t.Errorf("update mail: %v", um.Params)
	}
	anon.must(200, "GET", "/api/room-invites/"+code, nil, &pv)
	if !pv.GetNotBefore().AsTime().Equal(newStart.Add(-15 * time.Minute)) {
		t.Errorf("moved link: %v", pv.GetNotBefore().AsTime())
	}
	c.o.must(200, "PATCH", "/api/events/"+ev.GetId(), &v1.UpdateCalendarEventRequest{SetAttendees: true,
		Attendees: []*v1.CalendarEventAttendeeInput{att(c.bob.id, true)}}, nil)
	cm := waitMail(t, partner, mail.TemplateEventCancel, 1)
	if !strings.Contains(unfoldICS(cm.Calendar), "METHOD:CANCEL") || !strings.Contains(unfoldICS(cm.Calendar), "SEQUENCE:2") || cm.Params["rsvp_accept"] != "" {
		t.Errorf("cancel mail: %v", unfoldICS(cm.Calendar))
	}
	anon.must(404, "GET", "/api/room-invites/"+code, nil, nil)
	anon.must(404, "POST", "/api/event-rsvp", &v1.EventRsvpTokenRequest{Token: tok}, nil) // no longer invited

	// A meeting starting in 10 minutes: the link works now, once.
	soon := time.Now().Add(10 * time.Minute)
	partner2 := uniq("guest") + "@outside.org"
	createEvent(t, c.o, wsID, &v1.CreateCalendarEventRequest{Title: "Сейчас", StartsAt: ts(soon), EndsAt: ts(soon.Add(time.Hour)), Tz: "UTC",
		RoomId: c.voice.GetId(), Attendees: []*v1.CalendarEventAttendeeInput{ext(partner2)}})
	m2 := waitMail(t, partner2, mail.TemplateEventInvite, 1)
	code2 := strings.TrimPrefix(m2.Params["guest_url"], "https://app.example.com/r/")
	var joined v1.JoinRoomInviteResponse
	(&client{t: t, ip: "10.9.1.2"}).must(201, "POST", "/api/room-invites/"+code2+"/join", &v1.JoinRoomInviteRequest{Nickname: "Guest"}, &joined)
	if joined.GetRoomId() != c.voice.GetId() {
		t.Fatalf("joined %v", &joined)
	}
	(&client{t: t, ip: "10.9.1.3"}).must(404, "POST", "/api/room-invites/"+code2+"/join", &v1.JoinRoomInviteRequest{Nickname: "Again"}, nil)

	// A meeting that is over: its answer links are 410 EVENT_OVER.
	partner3 := uniq("late") + "@outside.org"
	past := time.Now().Add(-3 * time.Hour)
	createEvent(t, c.o, wsID, &v1.CreateCalendarEventRequest{Title: "Было", StartsAt: ts(past), EndsAt: ts(past.Add(time.Hour)), Tz: "UTC",
		Attendees: []*v1.CalendarEventAttendeeInput{ext(partner3)}})
	m3 := waitMail(t, partner3, mail.TemplateEventInvite, 1)
	tok3, _ := url.QueryUnescape(strings.SplitN(m3.Params["rsvp_accept"], "?t=", 2)[1])
	if st, e := anon.apiErrBody("POST", "/api/event-rsvp", &v1.EventRsvpTokenRequest{Token: tok3}); st != 410 || e.GetCode() != v1.ErrorCode_ERROR_CODE_EVENT_OVER {
		t.Fatalf("expired answer: %d %v", st, e)
	}

	// bob (no MANAGE_ROOM) invites an external: no guest link, the event says so.
	partner4 := uniq("nolink") + "@outside.org"
	nl := createEvent(t, c.bob, wsID, &v1.CreateCalendarEventRequest{Title: "Без ссылки", StartsAt: ts(start), EndsAt: ts(start.Add(time.Hour)),
		Tz: "UTC", RoomId: c.voice.GetId(), Attendees: []*v1.CalendarEventAttendeeInput{ext(partner4)}})
	if nl.GetGuestLinks() {
		t.Error("guest_links without MANAGE_ROOM")
	}
	if m4 := waitMail(t, partner4, mail.TemplateEventInvite, 1); m4.Params["guest_url"] != "" || m4.Params["rsvp_maybe"] == "" {
		t.Errorf("no-link mail: %v", m4.Params)
	}
}

// Meeting mail has a per-address bucket of its own: a burst of invitations neither drops the
// fourth one nor uses up the colleague's budget for codes (MAIL_PER_ADDRESS_PER_HOUR = 3).
func TestEventMailOwnBucket(t *testing.T) {
	c := calSetup(t)
	start := time.Now().Add(48 * time.Hour).Truncate(time.Minute)
	for i := range 4 {
		createEvent(t, c.o, c.ws.GetId(), &v1.CreateCalendarEventRequest{Title: "Серия " + string(rune('A'+i)), StartsAt: ts(start),
			EndsAt: ts(start.Add(time.Hour)), Tz: "UTC", Attendees: []*v1.CalendarEventAttendeeInput{att(c.carol.id, true)}})
	}
	waitMail(t, c.carol.email, mail.TemplateEventInvite, 4)
	newClient(t).must(200, "POST", "/api/auth/password/forgot", &v1.ForgotPasswordRequest{Email: c.carol.email}, nil)
	nthMail(t, 1, mail.TemplatePasswordReset, c.carol.email)
}

func TestEventRemindersAndRoomBadge(t *testing.T) {
	c := calSetup(t)
	wsID := c.ws.GetId()
	ctx := context.Background()
	// Reminder settings: validation, then 15 and 5 minutes; carol does not want them in DND.
	var me v1.UpdateMeResponse
	c.bob.must(422, "PATCH", "/api/me", &v1.UpdateMeRequest{EventReminders: &v1.EventReminderSettings{Minutes: []uint32{7}}}, nil)
	c.bob.must(422, "PATCH", "/api/me", &v1.UpdateMeRequest{EventReminders: &v1.EventReminderSettings{Minutes: []uint32{5, 10, 15, 30, 60, 120}}}, nil)
	c.bob.must(200, "PATCH", "/api/me", &v1.UpdateMeRequest{EventReminders: &v1.EventReminderSettings{Minutes: []uint32{5, 15, 5}, Dnd: true}}, &me)
	if s := me.GetMe().GetSettings(); len(s.GetEventReminders()) != 2 || s.GetEventReminders()[0] != 15 || !s.GetEventRemindersDnd() {
		t.Fatalf("settings: %v", s)
	}
	// A settings replace keeps them.
	c.bob.must(200, "PATCH", "/api/me", &v1.UpdateMeRequest{Settings: &v1.UserSettings{MicMode: v1.MicMode_MIC_MODE_VAD}}, &me)
	if len(me.GetMe().GetSettings().GetEventReminders()) != 2 {
		t.Fatalf("settings replace dropped reminders: %v", me.GetMe().GetSettings())
	}
	c.carol.must(200, "PATCH", "/api/me", &v1.UpdateMeRequest{EventReminders: &v1.EventReminderSettings{Minutes: []uint32{15}, Dnd: false}}, nil)
	var fresh v1.GetMeResponse
	c.o.must(200, "GET", "/api/me", nil, &fresh)
	if r := fresh.GetMe().GetSettings().GetEventReminders(); len(r) != 2 || r[0] != 60 || r[1] != 5 || !fresh.GetMe().GetSettings().GetEventRemindersDnd() {
		t.Fatalf("defaults: %v", fresh.GetMe().GetSettings())
	}

	start := time.Now().Add(6 * time.Hour).Truncate(time.Minute)
	ev := createEvent(t, c.o, wsID, &v1.CreateCalendarEventRequest{Title: "Ретро", StartsAt: ts(start), EndsAt: ts(start.Add(time.Hour)), Tz: "UTC",
		RoomId: c.voice.GetId(), Attendees: []*v1.CalendarEventAttendeeInput{att(c.bob.id, true), att(c.carol.id, true)}})
	bg := dialGW(t)
	defer func() { _ = bg.ws.CloseNow() }()
	bg.identify(c.bob.token)
	cg := dialGW(t)
	defer func() { _ = cg.ws.CloseNow() }()
	cg.identify(c.carol.token)
	// carol goes DND.
	cg.send(&v1.GatewayFrame{Op: v1.GatewayOpcode_GATEWAY_OPCODE_PRESENCE_UPDATE,
		Payload: &v1.GatewayFrame_SetPresence{SetPresence: &v1.SetPresence{Status: v1.PresenceStatus_PRESENCE_STATUS_DND, Until: &timestamppb.Timestamp{}}}})
	cg.wait("own DND", func(e *v1.DispatchEvent) bool {
		return e.GetUserUpdate().GetPresence().GetStatus() == v1.PresenceStatus_PRESENCE_STATUS_DND
	})

	// 15 minutes before: bob (DND allowed) and the room badge; carol in DND gets nothing.
	at := start.Add(-15*time.Minute + 20*time.Second)
	n, err := testApp.Calendar.Sweep(ctx, at)
	if err != nil || n < 1 {
		t.Fatalf("sweep: %d %v", n, err)
	}
	// The reminder (user channel) and the badge (workspace channel) come in either order.
	var rem *v1.CalendarEventReminder
	var act *v1.RoomEventActive
	for rem == nil || act == nil {
		e := bg.wait("EVENT_REMINDER and ROOM_EVENT_ACTIVE", func(e *v1.DispatchEvent) bool {
			return e.GetEventReminder().GetEvent().GetId() == ev.GetId() || e.GetRoomEventActive().GetEvent().GetId() == ev.GetId()
		})
		if e.GetEventReminder() != nil {
			rem = e.GetEventReminder()
		} else {
			act = e.GetRoomEventActive()
		}
	}
	if rem.GetMinutes() != 15 || !rem.GetOccurrenceAt().AsTime().Equal(start) || rem.GetEvent().GetMyStatus() != v1.AttendeeStatus_ATTENDEE_STATUS_PENDING {
		t.Fatalf("reminder: %v", rem)
	}
	if act.GetRoomId() != c.voice.GetId() {
		t.Fatalf("active: %v", act)
	}
	cg.quiet("reminder in DND", 400*time.Millisecond, func(e *v1.DispatchEvent) bool { return e.GetEventReminder() != nil })
	// Once only (dedup), also from another instance.
	if n, _ := testApp.Calendar.Sweep(ctx, at.Add(30*time.Second)); n != 0 {
		t.Fatalf("second sweep sent %d", n)
	}
	bg.quiet("duplicate", 400*time.Millisecond, func(e *v1.DispatchEvent) bool {
		return e.GetEventReminder() != nil || e.GetRoomEventActive() != nil
	})
	// A declined attendee gets no reminder: bob declines; 5 minutes before only the organizer
	// (default reminders 60 and 5 minutes) is reminded.
	c.bob.must(200, "PUT", "/api/events/"+ev.GetId()+"/rsvp", &v1.RsvpCalendarEventRequest{Status: v1.AttendeeStatus_ATTENDEE_STATUS_DECLINED}, nil)
	if n, _ := testApp.Calendar.Sweep(ctx, start.Add(-5*time.Minute+10*time.Second)); n != 1 {
		t.Fatalf("5 minutes before: %d reminders, want 1 (the organizer)", n)
	}
	bg.quiet("reminder after declining", 400*time.Millisecond, func(e *v1.DispatchEvent) bool { return e.GetEventReminder() != nil })
	// After the end: ROOM_EVENT_ENDED.
	if _, err := testApp.Calendar.Sweep(ctx, start.Add(time.Hour+time.Minute)); err != nil {
		t.Fatal(err)
	}
	bg.wait("ROOM_EVENT_ENDED", func(e *v1.DispatchEvent) bool {
		return e.GetRoomEventEnded().GetEventId() == ev.GetId() && e.GetRoomEventEnded().GetOccurrenceAt().AsTime().Equal(start)
	})

	// A meeting starting in 10 minutes is active at once: ROOM_EVENT_ACTIVE on create, in the
	// snapshot of a new connection, and the organizer's recording started now links to it.
	soon := time.Now().Add(10 * time.Minute)
	now := createEvent(t, c.o, wsID, &v1.CreateCalendarEventRequest{Title: "Сейчас", StartsAt: ts(soon), EndsAt: ts(soon.Add(time.Hour)),
		Tz: "UTC", RoomId: c.voice.GetId()})
	bg.wait("ROOM_EVENT_ACTIVE on create", func(e *v1.DispatchEvent) bool { return e.GetRoomEventActive().GetEvent().GetId() == now.GetId() })
	ng := dialGW(t)
	defer func() { _ = ng.ws.CloseNow() }()
	ready := ng.identify(c.bob.token)
	found := false
	for _, s := range ready.GetWorkspaces() {
		for _, e := range s.GetActiveEvents() {
			found = found || e.GetId() == now.GetId()
		}
	}
	if !found {
		t.Fatal("snapshot active_events")
	}
	gg := dialGW(t)
	defer func() { _ = gg.ws.CloseNow() }()
	for _, s := range gg.identify(c.gus.token).GetWorkspaces() {
		if len(s.GetActiveEvents()) > 0 {
			t.Fatal("a guest's snapshot has meetings")
		}
	}
	wid, rid, oid := uuid.MustParse(wsID), uuid.MustParse(c.voice.GetId()), uuid.MustParse(c.o.id)
	rec, err := testDB.Q.InsertRecording(ctx, sqlc.InsertRecordingParams{ID: uuid.Must(uuid.NewV7()), WorkspaceID: wid, RoomID: rid, StartedBy: &oid, File: "x/y.ogg"})
	if err != nil {
		t.Fatal(err)
	}
	testApp.Calendar.RecordingStarted(ctx, rec)
	ng.wait("ROOM_EVENT_ACTIVE with the recording", func(e *v1.DispatchEvent) bool {
		return e.GetRoomEventActive().GetEvent().GetRecordingId() == rec.ID.String()
	})
	l := listEvents(t, c.bob, wsID, soon.Add(-time.Minute), soon.Add(time.Minute))
	if len(l) != 1 || l[0].GetRecordingId() != rec.ID.String() {
		t.Fatalf("recording in the list: %v", l)
	}
	// Another member's recording does not link.
	bid := uuid.MustParse(c.bob.id)
	other, err := testDB.Q.InsertRecording(ctx, sqlc.InsertRecordingParams{ID: uuid.Must(uuid.NewV7()), WorkspaceID: wid, RoomID: rid, StartedBy: &bid, File: "x/z.ogg"})
	if err == nil {
		testApp.Calendar.RecordingStarted(ctx, other)
		if l := listEvents(t, c.bob, wsID, soon.Add(-time.Minute), soon.Add(time.Minute)); l[0].GetRecordingId() != rec.ID.String() {
			t.Fatal("a non-organizer's recording linked")
		}
	}
	// Cancelling an active meeting ends the badge.
	c.o.must(204, "DELETE", "/api/events/"+now.GetId(), nil, nil)
	ng.wait("ROOM_EVENT_ENDED on cancel", func(e *v1.DispatchEvent) bool { return e.GetRoomEventEnded().GetEventId() == now.GetId() })
}

// A bot without MANAGE_EVENTS reads others' meetings without external addresses and cannot
// change them; answers and "today" are for people (ADR-0051; creating: bot_api_v2 tests).
func TestEventBotsReadOthers(t *testing.T) {
	c := calSetup(t)
	wsID := c.ws.GetId()
	b := createBot(t, c.o, wsID, "calbot")
	start := time.Now().Add(96 * time.Hour).Truncate(time.Minute)
	ev := createEvent(t, c.o, wsID, &v1.CreateCalendarEventRequest{Title: "Bots", StartsAt: ts(start), EndsAt: ts(start.Add(time.Hour)), Tz: "UTC",
		RoomId: c.voice.GetId(), Attendees: []*v1.CalendarEventAttendeeInput{ext(uniq("x") + "@outside.org")}})
	var got v1.CalendarEventResponse
	b.must(200, "GET", "/api/events/"+ev.GetId(), nil, &got)
	for _, a := range got.GetEvent().GetAttendees() {
		if a.GetUserId() == "" && a.GetEmail() != "" {
			t.Fatalf("a bot reads an external address: %v", a)
		}
	}
	var list v1.ListCalendarEventsResponse
	b.must(200, "GET", "/api/workspaces/"+wsID+"/events?from="+url.QueryEscape(start.Format(time.RFC3339))+"&to="+url.QueryEscape(start.Add(time.Hour).Format(time.RFC3339)), nil, &list)
	if len(list.GetEvents()) != 1 || list.GetEvents()[0].GetCanEdit() {
		t.Fatalf("bot list: %v", list.GetEvents())
	}
	for _, email := range []string{list.GetEvents()[0].GetAttendees()[1].GetEmail()} {
		if email != "" {
			t.Fatalf("bot list email %q", email)
		}
	}
	for _, call := range []struct{ method, path string }{
		{"PATCH", "/api/events/" + ev.GetId()}, {"DELETE", "/api/events/" + ev.GetId()},
		{"PUT", "/api/events/" + ev.GetId() + "/rsvp"}, {"GET", "/api/me/events/today"},
	} {
		if st := b.do(call.method, call.path, &v1.RsvpCalendarEventRequest{}, nil); st != 403 {
			t.Errorf("bot %s %s: %d", call.method, call.path, st)
		}
	}
}

// Deep links for invited people (ADR-0038 «Диплинки для приглашённых»): the external attendee's
// mail links the meeting with a view token; a guest who joined the room sees the active meeting.
func TestEventDeepLinks(t *testing.T) {
	c := calSetup(t)
	wsID := c.ws.GetId()
	partner := uniq("deep") + "@outside.org"
	start := time.Now().Add(10 * time.Minute).Truncate(time.Second)
	ev := createEvent(t, c.o, wsID, &v1.CreateCalendarEventRequest{Title: "Демо", Description: "**Повестка**", StartsAt: ts(start),
		EndsAt: ts(start.Add(time.Hour)), Tz: "UTC", RoomId: c.voice.GetId(),
		Attendees: []*v1.CalendarEventAttendeeInput{att(c.bob.id, true), ext(partner)}})
	base := "https://app.example.com/e/" + ev.GetId()

	// The external mail: main link and invite.ics URL carry the view token; the member's do not.
	m := waitMail(t, partner, mail.TemplateEventInvite, 1)
	if !strings.HasPrefix(m.Params["url"], base+"?t=") || !strings.Contains(unfoldICS(m.Calendar), "URL:"+m.Params["url"]) {
		t.Fatalf("external meeting link: %q\n%s", m.Params["url"], unfoldICS(m.Calendar))
	}
	bm := waitMail(t, c.bob.email, mail.TemplateEventInvite, 1)
	if bm.Params["url"] != base || !strings.Contains(unfoldICS(bm.Calendar), "URL:"+base+"\r\n") {
		t.Fatalf("member meeting link: %q", bm.Params["url"])
	}
	view, _ := url.QueryUnescape(strings.SplitN(m.Params["url"], "?t=", 2)[1])

	// GET with the view token: the page, the answer tokens and the guest window.
	anon := &client{t: t, ip: "10.9.2.1"}
	var pg v1.EventRsvpTokenResponse
	anon.must(200, "GET", "/api/event-rsvp?t="+url.QueryEscape(view), nil, &pg)
	if pg.GetStatus() != v1.AttendeeStatus_ATTENDEE_STATUS_UNSPECIFIED || pg.GetMyStatus() != v1.AttendeeStatus_ATTENDEE_STATUS_PENDING ||
		pg.GetDescription() != "**Повестка**" || pg.GetRoomName() != c.voice.GetName() || pg.GetEmail() != partner ||
		pg.GetOrganizerEmail() != c.o.email || pg.GetRepeat() != v1.EventRepeat_EVENT_REPEAT_UNSPECIFIED || pg.GetRepeatUntil() != nil {
		t.Fatalf("view page: %v", &pg)
	}
	if pg.GetAcceptToken() == "" || pg.GetMaybeToken() == "" || pg.GetDeclineToken() == "" || pg.GetAcceptToken() == view {
		t.Fatalf("answer tokens: %v", &pg)
	}
	if pg.GetGuestUrl() != m.Params["guest_url"] || !pg.GetGuestFrom().AsTime().Equal(start.Add(-15*time.Minute)) ||
		!pg.GetGuestUntil().AsTime().Equal(start.Add(2*time.Hour)) {
		t.Fatalf("guest window: %q %v %v", pg.GetGuestUrl(), pg.GetGuestFrom().AsTime(), pg.GetGuestUntil().AsTime())
	}
	// POST with the view token → 400; the answer token of the page answers.
	anon.must(400, "POST", "/api/event-rsvp", &v1.EventRsvpTokenRequest{Token: view}, nil)
	var ans v1.EventRsvpTokenResponse
	anon.must(200, "POST", "/api/event-rsvp", &v1.EventRsvpTokenRequest{Token: pg.GetAcceptToken()}, &ans)
	if ans.GetStatus() != v1.AttendeeStatus_ATTENDEE_STATUS_ACCEPTED || ans.GetMyStatus() != v1.AttendeeStatus_ATTENDEE_STATUS_ACCEPTED {
		t.Fatalf("answer: %v", &ans)
	}
	// An answer token of the mail: status = its answer, my_status = the stored one.
	decline, _ := url.QueryUnescape(strings.SplitN(m.Params["rsvp_decline"], "?t=", 2)[1])
	anon.must(200, "GET", "/api/event-rsvp?t="+url.QueryEscape(decline), nil, &pg)
	if pg.GetStatus() != v1.AttendeeStatus_ATTENDEE_STATUS_DECLINED || pg.GetMyStatus() != v1.AttendeeStatus_ATTENDEE_STATUS_ACCEPTED || pg.GetMaybeToken() == "" {
		t.Fatalf("answer-token page: %v", &pg)
	}

	// The partner joins the room with the guest link: a guest of the workspace.
	var joined v1.JoinRoomInviteResponse
	code := strings.TrimPrefix(m.Params["guest_url"], "https://app.example.com/r/")
	(&client{t: t, ip: "10.9.2.2"}).must(201, "POST", "/api/room-invites/"+code+"/join", &v1.JoinRoomInviteRequest{Nickname: "Partner"}, &joined)
	guest := &user{client: &client{t: t, token: joined.GetTokens().GetAccessToken(), ip: "10.9.2.3"}, id: joined.GetMe().GetUser().GetId()}
	if guest.token == "" {
		t.Fatalf("no guest account: %v", &joined)
	}
	gg := dialGW(t)
	defer func() { _ = gg.ws.CloseNow() }()
	var active *v1.CalendarEvent
	for _, s := range gg.identify(guest.token).GetWorkspaces() {
		for _, e := range s.GetActiveEvents() {
			if e.GetId() == ev.GetId() {
				active = e
			}
		}
	}
	if active == nil || len(active.GetAttendees()) != 0 || active.GetDescription() != "**Повестка**" || active.GetCounts().GetAccepted() != 2 {
		t.Fatalf("guest snapshot: %v", active)
	}
	var card v1.CalendarEventResponse
	guest.must(200, "GET", "/api/events/"+ev.GetId(), nil, &card)
	if e := card.GetEvent(); len(e.GetAttendees()) != 0 || e.GetCanEdit() || !e.GetOccurrenceAt().AsTime().Equal(start) || e.GetCounts() == nil {
		t.Fatalf("guest card: %v", e)
	}
	guest.must(403, "GET", "/api/workspaces/"+wsID+"/events?from="+url.QueryEscape(start.Format(time.RFC3339))+"&to="+url.QueryEscape(start.Add(time.Hour).Format(time.RFC3339)), nil, nil)
	guest.must(403, "PUT", "/api/events/"+ev.GetId()+"/rsvp", &v1.RsvpCalendarEventRequest{Status: v1.AttendeeStatus_ATTENDEE_STATUS_MAYBE}, nil)
	guest.must(403, "PATCH", "/api/events/"+ev.GetId(), &v1.UpdateCalendarEventRequest{}, nil)

	// A meeting of the room outside its window, and one without a room: 404 for the guest.
	later := createEvent(t, c.o, wsID, &v1.CreateCalendarEventRequest{Title: "Потом", StartsAt: ts(start.Add(48 * time.Hour)),
		EndsAt: ts(start.Add(49 * time.Hour)), Tz: "UTC", RoomId: c.voice.GetId()})
	guest.must(404, "GET", "/api/events/"+later.GetId(), nil, nil)
	noRoom := createEvent(t, c.o, wsID, &v1.CreateCalendarEventRequest{Title: "Без комнаты", StartsAt: ts(start), EndsAt: ts(start.Add(time.Hour)), Tz: "UTC"})
	guest.must(404, "GET", "/api/events/"+noRoom.GetId(), nil, nil)
	gg.quiet("EVENT_CREATE for a guest", 300*time.Millisecond, func(e *v1.DispatchEvent) bool { return e.GetEventCreate() != nil })

	// A change of the active meeting reaches the guest as ROOM_EVENT_ACTIVE without attendees;
	// the cancel as ROOM_EVENT_ENDED, then the card is gone.
	title := "Демо v2"
	c.o.must(200, "PATCH", "/api/events/"+ev.GetId(), &v1.UpdateCalendarEventRequest{Title: &title}, nil)
	up := gg.wait("ROOM_EVENT_ACTIVE for a guest", func(e *v1.DispatchEvent) bool {
		return e.GetRoomEventActive().GetEvent().GetTitle() == title
	})
	if len(up.GetRoomEventActive().GetEvent().GetAttendees()) != 0 {
		t.Fatalf("guest ROOM_EVENT_ACTIVE with attendees: %v", up)
	}
	c.o.must(204, "DELETE", "/api/events/"+ev.GetId(), nil, nil)
	gg.wait("ROOM_EVENT_ENDED for a guest", func(e *v1.DispatchEvent) bool { return e.GetRoomEventEnded().GetEventId() == ev.GetId() })
	guest.must(404, "GET", "/api/events/"+ev.GetId(), nil, nil)
}

// «В рабочие дни» (ADR-0136): the holiday calendar is fixed when the repeat is chosen, from the
// workspace's billing market or else its owner's language; a Saturday start moves to the first
// working day; holidays are no occurrences.
func TestEventWorkdays(t *testing.T) {
	c := calSetup(t)
	wsID := c.ws.GetId()
	msk, _ := time.LoadLocation("Europe/Moscow")
	sat := time.Date(2026, 5, 9, 10, 0, 0, 0, msk) // Saturday; Monday May 11 is a holiday in Russia
	from, to := sat.Add(-time.Hour), time.Date(2026, 5, 16, 0, 0, 0, 0, msk)
	listed := func() (string, map[string]string) {
		t.Helper()
		var resp v1.ListCalendarEventsResponse
		c.o.must(200, "GET", "/api/workspaces/"+wsID+"/events?from="+url.QueryEscape(from.Format(time.RFC3339))+"&to="+url.QueryEscape(to.Format(time.RFC3339)), nil, &resp)
		days := map[string]string{}
		for _, e := range resp.GetEvents() {
			days[e.GetId()] += e.GetOccurrenceAt().AsTime().In(msk).Format("02 ")
		}
		return resp.GetHolidayCalendar(), days
	}
	mk := func(title string) *v1.CalendarEvent {
		t.Helper()
		return createEvent(t, c.o, wsID, &v1.CreateCalendarEventRequest{Title: title, StartsAt: ts(sat), EndsAt: ts(sat.Add(30 * time.Minute)),
			Tz: "Europe/Moscow", Repeat: v1.EventRepeat_EVENT_REPEAT_WORKDAYS})
	}

	// No billing account, owner's language unset: Mon–Fri.
	if hol, _ := listed(); hol != "" {
		t.Fatalf("workspace calendar %q", hol)
	}
	plain := mk("Plain")
	if plain.GetRepeat() != v1.EventRepeat_EVENT_REPEAT_WORKDAYS || plain.GetHolidayCalendar() != "" ||
		plain.GetStartsAt().AsTime().In(msk).Format("01-02 15:04") != "05-11 10:00" {
		t.Fatalf("plain series %v", plain)
	}

	// The owner's language is Russian: new series follow the Russian calendar, the old one stays.
	ru := "ru"
	c.o.must(200, "PATCH", "/api/me", &v1.UpdateMeRequest{Locale: &ru}, nil)
	ev := mk("Russian")
	if ev.GetHolidayCalendar() != "ru" || ev.GetStartsAt().AsTime().In(msk).Format("01-02") != "05-12" {
		t.Fatalf("ru series %v", ev)
	}
	hol, days := listed()
	if hol != "ru" || days[plain.GetId()] != "11 12 13 14 15 " || days[ev.GetId()] != "12 13 14 15 " {
		t.Fatalf("list %q %v", hol, days)
	}
	// An edit that keeps the repeat keeps the calendar; choosing it again takes today's.
	title := "Plain 2"
	var resp v1.CalendarEventResponse
	c.o.must(200, "PATCH", "/api/events/"+plain.GetId(), &v1.UpdateCalendarEventRequest{Title: &title}, &resp)
	if resp.GetEvent().GetHolidayCalendar() != "" {
		t.Fatalf("title edit changed the calendar: %v", resp.GetEvent())
	}
	weekly, workdays := v1.EventRepeat_EVENT_REPEAT_WEEKLY, v1.EventRepeat_EVENT_REPEAT_WORKDAYS
	c.o.must(200, "PATCH", "/api/events/"+plain.GetId(), &v1.UpdateCalendarEventRequest{Repeat: &weekly}, &resp)
	c.o.must(200, "PATCH", "/api/events/"+plain.GetId(), &v1.UpdateCalendarEventRequest{Repeat: &workdays}, &resp)
	if resp.GetEvent().GetHolidayCalendar() != "ru" {
		t.Fatalf("repeat chosen again: %v", resp.GetEvent())
	}
	// A holiday is not an occurrence: no exception there.
	occ := func(d int) string {
		return url.QueryEscape(time.Date(2026, 5, d, 10, 0, 0, 0, msk).UTC().Format(time.RFC3339))
	}
	c.o.must(422, "DELETE", "/api/events/"+ev.GetId()+"?occurrence="+occ(11), nil, nil)
	c.o.must(204, "DELETE", "/api/events/"+ev.GetId()+"?occurrence="+occ(13), nil, nil)
	if _, days = listed(); days[ev.GetId()] != "12 14 15 " {
		t.Fatalf("after the exception %v", days)
	}

	// A billing account decides over the language: the Global market is Mon–Fri.
	billingAccount(t, wsID, "inactive", false)
	if hol, _ = listed(); hol != "" {
		t.Fatalf("global market: %q", hol)
	}
	if mk("Global").GetHolidayCalendar() != "" {
		t.Fatal("global market series follows the Russian calendar")
	}
}

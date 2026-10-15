//go:build integration

package app_test

import (
	"strings"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// Comments on a meeting (ADR-0104): whoever sees the event reads and writes them (organizer,
// attendees, viewers of its room); a member who does not see it gets 404, a guest 403; the
// author edits, the author or the organizer deletes; EVENT_COMMENT_* reach only the event's
// audience, without the routing fields; the count rides in CalendarEvent.counts.
func TestEventComments(t *testing.T) {
	c := calSetup(t)
	wsID := c.ws.GetId()
	cg := dialGW(t) // carol: a member who is not invited to the meeting without a room
	defer func() { _ = cg.ws.CloseNow() }()
	cg.identify(c.carol.token)
	bg := dialGW(t)
	defer func() { _ = bg.ws.CloseNow() }()
	bg.identify(c.bob.token)

	start := time.Now().Add(48 * time.Hour).Truncate(time.Minute)
	ev := createEvent(t, c.o, wsID, &v1.CreateCalendarEventRequest{Title: "Ретро", StartsAt: ts(start), EndsAt: ts(start.Add(time.Hour)),
		Tz: "Europe/Moscow", Attendees: []*v1.CalendarEventAttendeeInput{att(c.bob.id, true)}})
	base := "/api/events/" + ev.GetId() + "/comments"

	// Who may read and write.
	var mine v1.CalendarEventCommentResponse
	c.bob.must(201, "POST", base, &v1.CalendarEventCommentRequest{Body: "  Повестка: итоги спринта  "}, &mine)
	if mine.GetComment().GetBody() != "Повестка: итоги спринта" || mine.GetComment().GetAuthorId() != c.bob.id {
		t.Fatalf("comment: %v", mine.GetComment())
	}
	up := bg.wait("EVENT_COMMENT_UPSERT", func(e *v1.DispatchEvent) bool {
		return e.GetEventCommentUpsert().GetComment().GetId() == mine.GetComment().GetId()
	}).GetEventCommentUpsert()
	if up.GetComments() != 1 || up.GetEventId() != ev.GetId() || up.GetOrganizerId() != "" || len(up.GetAttendeeIds()) != 0 {
		t.Errorf("upsert as delivered: %v", up)
	}
	c.carol.must(404, "GET", base, nil, nil)
	c.carol.must(404, "POST", base, &v1.CalendarEventCommentRequest{Body: "я тут"}, nil)
	c.gus.must(404, "GET", base, nil, nil) // a guest: the calendar is closed (403 with the room in sight)
	c.bob.must(422, "POST", base, &v1.CalendarEventCommentRequest{Body: "   "}, nil)
	c.bob.must(422, "POST", base, &v1.CalendarEventCommentRequest{Body: strings.Repeat("я", 4001)}, nil)
	var org v1.CalendarEventCommentResponse
	c.o.must(201, "POST", base, &v1.CalendarEventCommentRequest{Body: "Добавлю пункт"}, &org)

	// Edit: the author only. Delete: the author or the organizer.
	c.o.must(403, "PATCH", base+"/"+mine.GetComment().GetId(), &v1.CalendarEventCommentRequest{Body: "чужое"}, nil)
	var edited v1.CalendarEventCommentResponse
	c.bob.must(200, "PATCH", base+"/"+mine.GetComment().GetId(), &v1.CalendarEventCommentRequest{Body: "Повестка: итоги"}, &edited)
	if edited.GetComment().GetEditedAt() == nil || edited.GetComment().GetBody() != "Повестка: итоги" {
		t.Errorf("edited: %v", edited.GetComment())
	}
	c.bob.must(403, "DELETE", base+"/"+org.GetComment().GetId(), nil, nil)

	var list v1.ListCalendarEventCommentsResponse
	c.bob.must(200, "GET", base+"?limit=1", nil, &list)
	if len(list.GetComments()) != 1 || !list.GetHasMore() || list.GetComments()[0].GetId() != org.GetComment().GetId() {
		t.Fatalf("newest page: %v", &list)
	}
	c.bob.must(200, "GET", base+"?before="+org.GetComment().GetId(), nil, &list)
	if len(list.GetComments()) != 1 || list.GetHasMore() || list.GetComments()[0].GetId() != mine.GetComment().GetId() {
		t.Fatalf("older page: %v", &list)
	}
	var got v1.CalendarEventResponse
	c.bob.must(200, "GET", "/api/events/"+ev.GetId(), nil, &got)
	if got.GetEvent().GetCounts().GetComments() != 2 {
		t.Errorf("counts: %v", got.GetEvent().GetCounts())
	}

	c.o.must(204, "DELETE", base+"/"+mine.GetComment().GetId(), nil, nil)
	del := bg.wait("EVENT_COMMENT_DELETE", func(e *v1.DispatchEvent) bool {
		return e.GetEventCommentDelete().GetCommentId() == mine.GetComment().GetId()
	}).GetEventCommentDelete()
	if del.GetComments() != 1 {
		t.Errorf("delete as delivered: %v", del)
	}
	c.o.must(404, "DELETE", base+"/"+mine.GetComment().GetId(), nil, nil)

	// A meeting in the voice room carol sees: she comments, and the first comment event she
	// gets is this one — none of the hidden meeting's reached her.
	inRoom := createEvent(t, c.o, wsID, &v1.CreateCalendarEventRequest{Title: "Планёрка", StartsAt: ts(start), EndsAt: ts(start.Add(time.Hour)),
		Tz: "Europe/Moscow", RoomId: c.voice.GetId()})
	var hers v1.CalendarEventCommentResponse
	c.carol.must(201, "POST", "/api/events/"+inRoom.GetId()+"/comments", &v1.CalendarEventCommentRequest{Body: "Буду"}, &hers)
	first := cg.wait("EVENT_COMMENT_*", func(e *v1.DispatchEvent) bool {
		return e.GetEventCommentUpsert() != nil || e.GetEventCommentDelete() != nil
	})
	if first.GetEventCommentUpsert().GetComment().GetId() != hers.GetComment().GetId() {
		t.Errorf("carol got a comment event of a meeting she does not see: %v", first)
	}
	// The organizer moderates, carol cannot touch the organizer's comment.
	var o2 v1.CalendarEventCommentResponse
	c.o.must(201, "POST", "/api/events/"+inRoom.GetId()+"/comments", &v1.CalendarEventCommentRequest{Body: "Ок"}, &o2)
	c.carol.must(403, "DELETE", "/api/events/"+inRoom.GetId()+"/comments/"+o2.GetComment().GetId(), nil, nil)
	c.o.must(204, "DELETE", "/api/events/"+inRoom.GetId()+"/comments/"+hers.GetComment().GetId(), nil, nil)

	// A cancelled meeting keeps its comments readable; no new ones. Bob organizes it: the
	// CANCEL mail goes to the organizer too, and the shared owner's mailbox must stay clean
	// (TestEventInviteAudience counts it).
	own := createEvent(t, c.bob, wsID, &v1.CreateCalendarEventRequest{Title: "Разбор", StartsAt: ts(start), EndsAt: ts(start.Add(time.Hour)), Tz: "Europe/Moscow"})
	ownBase := "/api/events/" + own.GetId() + "/comments"
	c.bob.must(201, "POST", ownBase, &v1.CalendarEventCommentRequest{Body: "Итоги"}, nil)
	c.bob.must(204, "DELETE", "/api/events/"+own.GetId(), nil, nil)
	c.bob.must(200, "GET", ownBase, nil, &list)
	if len(list.GetComments()) != 1 {
		t.Errorf("comments of a cancelled meeting: %v", &list)
	}
	c.bob.must(404, "POST", ownBase, &v1.CalendarEventCommentRequest{Body: "поздно"}, nil)
}

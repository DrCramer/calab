//go:build integration

// A meeting's own temporary room (ADR-0112).
package app_test

import (
	"context"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
)

func roomExpiry(t *testing.T, roomID string) (expires, archived *time.Time, name, createdBy string, membersOnly bool) {
	t.Helper()
	if err := testDB.Pool.QueryRow(context.Background(),
		`SELECT r.expires_at, r.archived_at, r.name, r.created_by::text, i.members_only
		   FROM rooms r JOIN room_invites i ON i.room_id = r.id AND i.event_id IS NULL
		  WHERE r.id = $1 ORDER BY i.created_at LIMIT 1`, roomID).
		Scan(&expires, &archived, &name, &createdBy, &membersOnly); err != nil {
		t.Fatal(err)
	}
	return
}

func getEvent(t *testing.T, u *user, id string) *v1.CalendarEvent {
	t.Helper()
	var r v1.CalendarEventResponse
	u.must(200, "GET", "/api/events/"+id, nil, &r)
	return r.GetEvent()
}

func TestMeetingOwnTempRoom(t *testing.T) {
	c := calSetup(t)
	wsID := c.ws.GetId()
	ctx := context.Background()
	start := time.Now().Add(3 * time.Hour).Truncate(time.Minute)
	req := func(title string, at time.Time) *v1.CreateCalendarEventRequest {
		return &v1.CreateCalendarEventRequest{Title: title, StartsAt: ts(at), EndsAt: ts(at.Add(time.Hour)), Tz: "Europe/Moscow",
			TempRoom: true, Attendees: []*v1.CalendarEventAttendeeInput{att(c.carol.id, true)}}
	}

	// Validation: not with a room, not for a series; guests have no calendar.
	both := req("x", start)
	both.RoomId = c.voice.GetId()
	c.bob.must(422, "POST", "/api/workspaces/"+wsID+"/events", both, nil)
	series := req("x", start)
	series.Repeat = v1.EventRepeat_EVENT_REPEAT_WEEKLY
	c.bob.must(422, "POST", "/api/workspaces/"+wsID+"/events", series, nil)
	c.gus.must(403, "POST", "/api/workspaces/"+wsID+"/events", req("x", start), nil)

	// Far ahead: saved as a request, no room yet; the sweep waits for 1 h before the start.
	ev := createEvent(t, c.bob, wsID, req("Демо клиенту", start))
	if !ev.GetTempRoom() || ev.GetRoomId() != "" {
		t.Fatalf("request: %v", ev)
	}
	if n, err := testApp.Calendar.MakeTempRooms(ctx, time.Now()); err != nil || n != 0 {
		t.Fatalf("early sweep: %d %v", n, err)
	}

	// The organizer's right is read at creation: without CREATE_TEMP_ROOMS nothing is made.
	sqlExec(t, "UPDATE workspace_roles SET permissions = permissions & ~$2::bigint WHERE workspace_id = $1 AND builtin = 'member'", wsID, int64(perm.CreateTempRooms))
	if n, err := testApp.Calendar.MakeTempRooms(ctx, start.Add(-30*time.Minute)); err != nil || n != 0 {
		t.Fatalf("sweep without the right: %d %v", n, err)
	}
	sqlExec(t, "UPDATE workspace_roles SET permissions = permissions | $2::bigint WHERE workspace_id = $1 AND builtin = 'member'", wsID, int64(perm.CreateTempRooms))
	if n, err := testApp.Calendar.MakeTempRooms(ctx, start.Add(-30*time.Minute)); err != nil || n != 1 {
		t.Fatalf("due sweep: %d %v", n, err)
	}
	got := getEvent(t, c.carol, ev.GetId())
	if got.GetRoomId() == "" || !got.GetTempRoom() || got.GetSequence() != ev.GetSequence() {
		t.Fatalf("room made: %v", got)
	}
	exp, arch, name, by, membersOnly := roomExpiry(t, got.GetRoomId())
	if exp == nil || !exp.Equal(start.Add(2*time.Hour)) || arch != nil || name != "Демо клиенту" || by != c.bob.id || !membersOnly {
		t.Fatalf("room: %v %v %q %s %v", exp, arch, name, by, membersOnly)
	}
	if _, ok := visibleRooms(t, c.carol, wsID)[got.GetRoomId()]; !ok {
		t.Fatal("an attendee sees the meeting's room")
	}
	if n, _ := testApp.Calendar.MakeTempRooms(ctx, start.Add(-29*time.Minute)); n != 0 {
		t.Fatal("made twice")
	}

	// Moving the meeting moves the room's end.
	later := start.Add(2 * time.Hour)
	c.bob.must(200, "PATCH", "/api/events/"+ev.GetId(), &v1.UpdateCalendarEventRequest{StartsAt: ts(later), EndsAt: ts(later.Add(time.Hour))}, nil)
	if exp, _, _, _, _ = roomExpiry(t, got.GetRoomId()); !exp.Equal(later.Add(2 * time.Hour)) {
		t.Fatalf("moved room end: %v", exp)
	}

	// Cancelling the meeting archives its room.
	c.bob.must(204, "DELETE", "/api/events/"+ev.GetId(), nil, nil)
	if _, arch, _, _, _ = roomExpiry(t, got.GetRoomId()); arch == nil {
		t.Fatal("the meeting's room is archived with it")
	}

	// Close to the start: the room comes at once, in the answer.
	soon := createEvent(t, c.bob, wsID, req("Срочно", time.Now().Add(20*time.Minute)))
	if soon.GetRoomId() == "" || !soon.GetTempRoom() {
		t.Fatalf("immediate room: %v", soon)
	}

	// A room chosen by hand ends a pending request; a request cancelled first makes nothing.
	far := createEvent(t, c.bob, wsID, req("Потом", start.Add(24*time.Hour)))
	var upd v1.CalendarEventResponse
	room := c.voice.GetId()
	c.bob.must(200, "PATCH", "/api/events/"+far.GetId(), &v1.UpdateCalendarEventRequest{RoomId: &room}, &upd)
	if upd.GetEvent().GetTempRoom() || upd.GetEvent().GetRoomId() != room {
		t.Fatalf("hand-picked room: %v", upd.GetEvent())
	}
	gone := createEvent(t, c.bob, wsID, req("Отменим", start.Add(48*time.Hour)))
	c.bob.must(204, "DELETE", "/api/events/"+gone.GetId(), nil, nil)
	if n, _ := testApp.Calendar.MakeTempRooms(ctx, start.Add(48*time.Hour-30*time.Minute)); n != 0 {
		t.Fatal("a cancelled meeting gets no room")
	}

	// Only the organizer asks for it.
	yes := true
	none := ""
	other := createEvent(t, c.bob, wsID, &v1.CreateCalendarEventRequest{Title: "y", StartsAt: ts(start), EndsAt: ts(start.Add(time.Hour)), Tz: "UTC", RoomId: room})
	c.o.must(403, "PATCH", "/api/events/"+other.GetId(), &v1.UpdateCalendarEventRequest{TempRoom: &yes, RoomId: &none}, nil) // a room manager edits, but not in bob's name
	c.bob.must(422, "PATCH", "/api/events/"+other.GetId(), &v1.UpdateCalendarEventRequest{TempRoom: &yes}, nil)              // still with a room
	c.bob.must(200, "PATCH", "/api/events/"+other.GetId(), &v1.UpdateCalendarEventRequest{TempRoom: &yes, RoomId: &none}, &upd)
	if !upd.GetEvent().GetTempRoom() || upd.GetEvent().GetRoomId() != "" {
		t.Fatal("organizer asks later")
	}
}

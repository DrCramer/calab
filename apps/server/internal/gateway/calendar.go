package gateway

import (
	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
)

// routeCalendar delivers the calendar events of a workspace (ADR-0038) as each recipient
// should see them (st.mu held). EVENT_* go to the organizer, the attendees and the viewers of
// the meeting's room, never to guests; ROOM_EVENT_* to the room's viewers, guests included
// (without attendees, ADR-0038 «Диплинки для приглашённых»). External attendees'
// addresses are in full for those involved and those who may edit the meeting, masked for other
// viewers and removed for other bots (a bot that organizes or may edit sees them, ADR-0051).
func (h *Hub) routeCalendar(st *wsState, sessions []*Session, view func(rid, uid uuid.UUID) bool, id uuid.UUID, ev *v1.DispatchEvent) {
	wid := parseID(st.ws.GetId())
	var e *v1.CalendarEvent
	roomOnly := false
	wrap := func(*v1.CalendarEvent, pbconv.EmailView) *v1.DispatchEvent { return ev }
	switch x := ev.GetEvent().(type) {
	case *v1.DispatchEvent_EventCreate:
		e = x.EventCreate.GetEvent()
		wrap = func(c *v1.CalendarEvent, _ pbconv.EmailView) *v1.DispatchEvent {
			return &v1.DispatchEvent{Event: &v1.DispatchEvent_EventCreate{EventCreate: &v1.CalendarEventCreate{Event: c}}}
		}
	case *v1.DispatchEvent_EventUpdate:
		e = x.EventUpdate.GetEvent()
		wrap = func(c *v1.CalendarEvent, _ pbconv.EmailView) *v1.DispatchEvent {
			return &v1.DispatchEvent{Event: &v1.DispatchEvent_EventUpdate{EventUpdate: &v1.CalendarEventUpdate{Event: c}}}
		}
	case *v1.DispatchEvent_EventDelete:
		e = x.EventDelete.GetEvent()
		wrap = func(c *v1.CalendarEvent, _ pbconv.EmailView) *v1.DispatchEvent {
			return &v1.DispatchEvent{Event: &v1.DispatchEvent_EventDelete{EventDelete: &v1.CalendarEventDelete{Event: c}}}
		}
	case *v1.DispatchEvent_EventRsvp:
		e = x.EventRsvp.GetEvent()
		wrap = func(c *v1.CalendarEvent, v pbconv.EmailView) *v1.DispatchEvent {
			r := x.EventRsvp
			a := pbconv.EventForViewer(&v1.CalendarEvent{Attendees: []*v1.CalendarEventAttendee{r.GetAttendee()}}, v).GetAttendees()[0]
			return &v1.DispatchEvent{Event: &v1.DispatchEvent_EventRsvp{EventRsvp: &v1.CalendarEventRsvp{
				WorkspaceId: r.GetWorkspaceId(), EventId: r.GetEventId(), Attendee: a, Counts: r.GetCounts(), Event: c}}}
		}
	case *v1.DispatchEvent_RoomEventActive:
		e, roomOnly = x.RoomEventActive.GetEvent(), true
		wrap = func(c *v1.CalendarEvent, _ pbconv.EmailView) *v1.DispatchEvent {
			return &v1.DispatchEvent{Event: &v1.DispatchEvent_RoomEventActive{RoomEventActive: &v1.RoomEventActive{
				WorkspaceId: x.RoomEventActive.GetWorkspaceId(), RoomId: x.RoomEventActive.GetRoomId(), Event: c}}}
		}
	case *v1.DispatchEvent_RoomEventEnded:
		rid := parseID(x.RoomEventEnded.GetRoomId())
		shared := newScopedEnc(wid, ev)
		for _, s := range sessions {
			if view(rid, s.user) {
				s.dispatchEnc(id, shared)
			}
		}
		return
	}
	var guestEnc *encEvent // ROOM_EVENT_ACTIVE for guests: without attendees
	guest := func() *encEvent {
		if guestEnc == nil {
			guestEnc = newScopedEnc(wid, wrap(pbconv.EventForGuest(e), pbconv.EmailsNone))
		}
		return guestEnc
	}
	rid := parseID(e.GetRoomId())
	organizer := parseID(e.GetOrganizerId())
	involved := map[uuid.UUID]bool{organizer: true}
	for _, a := range e.GetAttendees() {
		if a.GetUserId() != "" {
			involved[parseID(a.GetUserId())] = true
		}
	}
	encs := map[pbconv.EmailView]*encEvent{}
	enc := func(v pbconv.EmailView) *encEvent {
		if encs[v] == nil {
			if v == pbconv.EmailsFull {
				encs[v] = newScopedEnc(wid, ev)
			} else {
				encs[v] = newScopedEnc(wid, wrap(pbconv.EventForViewer(e, v), v))
			}
		}
		return encs[v]
	}
	for _, s := range sessions {
		if st.role(s.user) == perm.RoleGuest {
			if roomOnly && rid != uuid.Nil && view(rid, s.user) {
				s.dispatchEnc(id, guest())
			}
			continue
		}
		// A bot is never an attendee; it is involved in the meetings it organizes (ADR-0051).
		inv := involved[s.user] && (!s.bot || s.user == organizer)
		sees := rid != uuid.Nil && view(rid, s.user)
		if !sees && (roomOnly || !inv) {
			continue
		}
		// calendar.viewer.canEdit (ADR-0048): the organizer, MANAGE_ROOM in the room, or
		// MANAGE_EVENTS where the room is visible.
		edit := s.user == organizer || (rid != uuid.Nil && st.bits(rid, s.user).Has(perm.ManageRoom)) ||
			((rid == uuid.Nil || sees) && st.members[s.user].Workspace().Has(perm.ManageEvents))
		v := pbconv.EmailsMasked
		switch {
		case inv || edit:
			v = pbconv.EmailsFull
		case s.bot:
			v = pbconv.EmailsNone
		}
		s.dispatchEnc(id, enc(v))
	}
}

// routeEventComment delivers EVENT_COMMENT_UPSERT / DELETE (ADR-0104) to those who see the
// event — its organizer, its attendees and the viewers of its room, as EVENT_UPDATE — never to
// guests or bots (comments are people-only, the calendar is closed to guests). The routing
// fields are cleared before delivery.
func (h *Hub) routeEventComment(st *wsState, sessions []*Session, view func(rid, uid uuid.UUID) bool, id uuid.UUID, ev *v1.DispatchEvent) {
	var room, organizer string
	var attendees []string
	var out *v1.DispatchEvent
	switch x := ev.GetEvent().(type) {
	case *v1.DispatchEvent_EventCommentUpsert:
		c := proto.CloneOf(x.EventCommentUpsert)
		room, organizer, attendees = c.GetRoomId(), c.GetOrganizerId(), c.GetAttendeeIds()
		c.RoomId, c.OrganizerId, c.AttendeeIds = "", "", nil
		out = &v1.DispatchEvent{Event: &v1.DispatchEvent_EventCommentUpsert{EventCommentUpsert: c}}
	case *v1.DispatchEvent_EventCommentDelete:
		c := proto.CloneOf(x.EventCommentDelete)
		room, organizer, attendees = c.GetRoomId(), c.GetOrganizerId(), c.GetAttendeeIds()
		c.RoomId, c.OrganizerId, c.AttendeeIds = "", "", nil
		out = &v1.DispatchEvent{Event: &v1.DispatchEvent_EventCommentDelete{EventCommentDelete: c}}
	default:
		return
	}
	rid := parseID(room)
	involved := map[uuid.UUID]bool{parseID(organizer): true}
	for _, a := range attendees {
		involved[parseID(a)] = true
	}
	delete(involved, uuid.Nil)
	var enc *encEvent
	for _, s := range sessions {
		if s.bot || st.role(s.user) == perm.RoleGuest {
			continue
		}
		if !involved[s.user] && (rid == uuid.Nil || !view(rid, s.user)) {
			continue
		}
		if enc == nil {
			enc = newScopedEnc(parseID(st.ws.GetId()), out)
		}
		s.dispatchEnc(id, enc)
	}
}

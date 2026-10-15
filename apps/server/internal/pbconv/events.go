package pbconv

import (
	"strings"

	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// EmailView says how a viewer sees the addresses of a meeting's external attendees (ADR-0038
// «Дополнение»).
type EmailView int

// Email views.
const (
	EmailsFull   EmailView = iota // organizer, attendees, those who may edit the meeting
	EmailsMasked                  // other viewers: "a***@example.com"
	EmailsNone                    // bots: no addresses at all
)

// MaskEmail hides the local part of an address but its first character.
func MaskEmail(e string) string {
	local, domain, ok := strings.Cut(e, "@")
	if !ok || local == "" {
		return "***"
	}
	r := []rune(local)
	return string(r[0]) + "***@" + domain
}

// EventForViewer returns ev as seen with view: ev itself when nothing changes, else a copy
// with the external attendees' addresses masked or removed.
func EventForViewer(ev *v1.CalendarEvent, view EmailView) *v1.CalendarEvent {
	if view == EmailsFull || ev == nil {
		return ev
	}
	has := false
	for _, a := range ev.GetAttendees() {
		if a.GetEmail() != "" {
			has = true
			break
		}
	}
	if !has {
		return ev
	}
	out := proto.CloneOf(ev)
	for _, a := range out.GetAttendees() {
		if a.GetEmail() == "" {
			continue
		}
		if view == EmailsNone {
			a.Email = ""
		} else {
			a.Email = MaskEmail(a.GetEmail())
		}
	}
	return out
}

// EventForGuest returns a copy of ev as a guest of the workspace (ADR-0016) sees the meeting
// active in a room they can view (ADR-0038 «Диплинки для приглашённых»): no attendees (counts
// only), no recording, no rights and no guest-link state.
func EventForGuest(ev *v1.CalendarEvent) *v1.CalendarEvent {
	if ev == nil {
		return nil
	}
	out := proto.CloneOf(ev)
	out.Attendees = nil
	out.RecordingId = ""
	out.MyStatus = v1.AttendeeStatus_ATTENDEE_STATUS_UNSPECIFIED
	out.CanEdit = false
	out.GuestLinks = false
	if out.Counts != nil {
		out.Counts.Comments = 0 // comments are part of the calendar, closed to guests (ADR-0103)
	}
	return out
}

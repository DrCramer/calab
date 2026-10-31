package calendar

import (
	"context"
	"errors"
	"net/mail"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/perm"
)

// fields are an event's editable values after validation.
type fields struct {
	room        *uuid.UUID
	title, desc string
	start, end  time.Time
	allDay      bool
	tz          string
	record      bool
	rule        Rule
}

func (f fields) series() Series {
	return Series{Start: f.start, End: f.end, AllDay: f.allDay, Loc: loadZone(f.tz), Rule: f.rule}
}

// wantAttendee is one attendee of a request: a user or an address (lower case).
type wantAttendee struct {
	user     *uuid.UUID
	email    string
	required bool
}

func (a wantAttendee) key() string {
	if a.user != nil {
		return "u:" + a.user.String()
	}
	return "e:" + a.email
}

func attendeeKey(a sqlc.EventAttendee) string {
	if a.UserID != nil {
		return "u:" + a.UserID.String()
	}
	return "e:" + strings.ToLower(deref(a.Email))
}

func fromFields(ev sqlc.Event) fields {
	rule, _ := ParseRule(deref(ev.Rrule))
	return fields{room: ev.RoomID, title: ev.Title, desc: ev.Description, start: ev.StartsAt, end: ev.EndsAt,
		allDay: ev.AllDay, tz: ev.Tz, record: ev.Record, rule: rule}
}

// normalize validates the timing and text of f (tz already set) and rounds an all-day event to
// midnights of its zone.
func (f *fields) normalize() error {
	f.title = strings.TrimSpace(f.title)
	if n := utf8.RuneCountInString(f.title); n < 1 || n > MaxTitle {
		return httpx.Validation("title", "title must be 1..120 characters")
	}
	if utf8.RuneCountInString(f.desc) > MaxDescription {
		return httpx.Validation("description", "description must be at most 4000 characters")
	}
	loc, err := time.LoadLocation(f.tz)
	if err != nil || f.tz == "" || f.tz == "Local" {
		return httpx.Validation("tz", "unknown time zone")
	}
	if f.start.IsZero() || f.end.IsZero() {
		return httpx.Validation("startsAt", "startsAt and endsAt are required")
	}
	if f.allDay {
		y, m, d := f.start.In(loc).Date()
		f.start = time.Date(y, m, d, 0, 0, 0, 0, loc).UTC()
		ly, lm, ld := f.end.In(loc).Date()
		end := time.Date(ly, lm, ld, 0, 0, 0, 0, loc)
		if end.Before(f.end) {
			end = time.Date(ly, lm, ld+1, 0, 0, 0, 0, loc)
		}
		f.end = end.UTC()
	}
	if !f.end.After(f.start) {
		return httpx.Validation("endsAt", "endsAt must be after startsAt")
	}
	if f.end.Sub(f.start) > MaxDuration+time.Hour {
		return httpx.Validation("endsAt", "a meeting lasts at most 7 days")
	}
	if f.start.Year() < 2000 || f.start.Year() > 2200 {
		return httpx.Validation("startsAt", "startsAt is out of range")
	}
	switch f.rule.Repeat {
	case v1.EventRepeat_EVENT_REPEAT_UNSPECIFIED:
		f.rule.Until, f.rule.Holidays = nil, ""
	case v1.EventRepeat_EVENT_REPEAT_DAILY, v1.EventRepeat_EVENT_REPEAT_WEEKLY,
		v1.EventRepeat_EVENT_REPEAT_BIWEEKLY, v1.EventRepeat_EVENT_REPEAT_MONTHLY,
		v1.EventRepeat_EVENT_REPEAT_WORKDAYS:
		if f.rule.Repeat != v1.EventRepeat_EVENT_REPEAT_WORKDAYS {
			f.rule.Holidays = ""
		}
		// A working-days series starts on a working day (ADR-0136): its start is its first
		// occurrence, so a Saturday start moves to Monday.
		f.start, f.end = Series{Start: f.start, End: f.end, Loc: loc, Rule: f.rule}.ShiftToWorkday()
		if u := f.rule.Until; u != nil {
			t := u.UTC().Truncate(time.Second)
			if t.Before(f.start) {
				return httpx.Validation("repeatUntil", "repeatUntil must not be before startsAt")
			}
			f.rule.Until = &t
		}
	default:
		return httpx.Validation("repeat", "unknown repeat")
	}
	f.start, f.end = f.start.Truncate(time.Second), f.end.Truncate(time.Second)
	return nil
}

func tsTime(t *timestamppb.Timestamp) time.Time {
	if t == nil {
		return time.Time{}
	}
	return t.AsTime().UTC()
}

// parseAttendees validates a request's attendee list (duplicates merged; the organizer is added
// by the caller).
func parseAttendees(in []*v1.CalendarEventAttendeeInput) ([]wantAttendee, error) {
	seen := map[string]int{}
	var out []wantAttendee
	externals := 0
	for _, a := range in {
		var w wantAttendee
		switch {
		case a.GetUserId() != "" && a.GetEmail() != "":
			return nil, httpx.Validation("attendees", "an attendee is a user or an email, not both")
		case a.GetUserId() != "":
			id, err := uuid.Parse(a.GetUserId())
			if err != nil {
				return nil, httpx.Validation("attendees", "invalid user id")
			}
			w.user = &id
		case a.GetEmail() != "":
			e, err := normalizeEmail(a.GetEmail())
			if err != nil {
				return nil, err
			}
			w.email = e
		default:
			return nil, httpx.Validation("attendees", "an attendee needs a user id or an email")
		}
		w.required = a.GetRequired()
		if i, ok := seen[w.key()]; ok {
			out[i].required = out[i].required || w.required
			continue
		}
		if w.user == nil {
			externals++
		}
		seen[w.key()] = len(out)
		out = append(out, w)
	}
	if externals > MaxExternals {
		return nil, httpx.Validation("attendees", "at most 20 external email addresses")
	}
	if len(out) > MaxAttendees {
		return nil, httpx.Validation("attendees", "at most 100 attendees")
	}
	return out, nil
}

func normalizeEmail(s string) (string, error) {
	s = strings.TrimSpace(s)
	a, err := mail.ParseAddress(s)
	if err != nil || a.Address != s || len(s) > 254 || !strings.Contains(s[strings.LastIndexByte(s, '@')+1:], ".") {
		return "", httpx.Validation("attendees", "invalid email address")
	}
	return strings.ToLower(s), nil
}

// checkAttendees: users must be members of the workspace, not guests or bots; with the
// organizer the list holds at most MaxAttendees. A bot organizer (ADR-0051) is not an
// attendee: it may not list itself and takes no place.
func checkAttendees(ctx context.Context, q *sqlc.Queries, wsID, organizer uuid.UUID, orgBot bool, want []wantAttendee) error {
	var ids []uuid.UUID
	for _, a := range want {
		if a.user != nil && (*a.user != organizer || orgBot) {
			ids = append(ids, *a.user)
		}
	}
	total := len(want)
	if !hasUser(want, organizer) && !orgBot {
		total++
	}
	if total > MaxAttendees {
		return httpx.Validation("attendees", "at most 100 attendees")
	}
	if len(ids) == 0 {
		return nil
	}
	users, err := q.ListEventUsers(ctx, ids)
	if err != nil {
		return err
	}
	byID := map[uuid.UUID]sqlc.ListEventUsersRow{}
	for _, u := range users {
		byID[u.ID] = u
	}
	res := perm.NewResolver(q)
	for _, id := range ids {
		u, ok := byID[id]
		if !ok || u.IsBot || u.IsGuest {
			return httpx.Validation("attendees", "attendees must be members of the workspace (not bots or guests)")
		}
		m, err := res.Member(ctx, wsID, id)
		if errors.Is(err, perm.ErrNotMember) || (err == nil && m.Role == perm.RoleGuest) {
			return httpx.Validation("attendees", "attendees must be members of the workspace (not bots or guests)")
		}
		if err != nil {
			return err
		}
	}
	return nil
}

func hasUser(want []wantAttendee, id uuid.UUID) bool {
	for _, a := range want {
		if a.user != nil && *a.user == id {
			return true
		}
	}
	return false
}

func hasExternals(want []wantAttendee) bool {
	for _, a := range want {
		if a.user == nil {
			return true
		}
	}
	return false
}

// checkRoom: a live voice room of the workspace that the caller can see.
func checkRoom(ctx context.Context, q *sqlc.Queries, wsID, caller, roomID uuid.UUID) error {
	room, err := q.GetRoom(ctx, roomID)
	if err != nil || room.WorkspaceID == nil || *room.WorkspaceID != wsID {
		return httpx.Validation("roomId", "no such room in this workspace")
	}
	acc, err := perm.FromContext(ctx).Room(ctx, roomID, caller)
	if errors.Is(err, perm.ErrNoRoom) || (err == nil && !acc.Bits.Has(perm.ViewRoom)) {
		return httpx.Validation("roomId", "no such room in this workspace")
	}
	if err != nil {
		return err
	}
	if room.Type != "voice" {
		return httpx.Validation("roomId", "a meeting room must be a voice room")
	}
	return nil
}

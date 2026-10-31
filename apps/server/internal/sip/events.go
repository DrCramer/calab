package sip

import (
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

// The call journal's events (ADR-0137 §1), the pure part: what a step of a call records, how the
// inbound state machine numbers them, the employees they make parties of the call, and the
// steps of a call from before the journal parsed from its route string.

// EventKind is sip_call_events.kind (SipCallEventKind).
type EventKind string

// Event kinds.
const (
	EvStarted         EventKind = "started"
	EvMenu            EventKind = "menu"
	EvKey             EventKind = "key"
	EvDialed          EventKind = "dialed"
	EvNoInput         EventKind = "no_input"
	EvNotice          EventKind = "notice"
	EvGroup           EventKind = "group"
	EvRing            EventKind = "ring"
	EvRingEnd         EventKind = "ring_end"
	EvFallback        EventKind = "fallback"
	EvAnswered        EventKind = "answered"
	EvTransfer        EventKind = "transfer"
	EvTransferEnd     EventKind = "transfer_end"
	EvDialing         EventKind = "dialing"
	EvProviderRinging EventKind = "provider_ringing"
	EvRecording       EventKind = "recording"
	EvEnded           EventKind = "ended"
	EvSchedule        EventKind = "schedule"
)

// TargetKind is sip_call_events.target_kind (SipCallTargetKind); "" = none.
type TargetKind string

// Target kinds of an event.
const (
	TkMenu      TargetKind = "menu"
	TkGroup     TargetKind = "group"
	TkExtension TargetKind = "extension"
	TkUser      TargetKind = "user"
	TkRoom      TargetKind = "room"
)

// Reasons of RING_END (besides the call's own reasons).
const (
	EndNoAnswer          = "no_answer"
	EndDeclined          = "declined"
	EndAnsweredElsewhere = "answered_elsewhere"
	EndFallback          = "fallback"
	EndCallerLeft        = "caller_left"
	EndCancelled         = "cancelled"
	EndCallEnded         = "ended"
)

// Event is one step of a call. The JSON shape is the column shape of sip_call_events
// (InsertSipCallEvents takes the events as a JSON array).
type Event struct {
	Seq        int        `json:"seq"`
	At         time.Time  `json:"at"`
	Kind       EventKind  `json:"kind"`
	User       *uuid.UUID `json:"user_id"`
	Peer       *uuid.UUID `json:"peer_user_id"`
	TargetKind TargetKind `json:"target_kind"`
	TargetID   *uuid.UUID `json:"target_id"`
	TargetName string     `json:"target_name"`
	Digits     string     `json:"digits"`
	Reason     string     `json:"reason"`
}

// seqOutside: events written from outside the inbound state machine (the recording, a call
// whose state is lost) take numbers from here on for inbound calls, so they never take a number
// the machine will use (its events are 1, 2, …).
const seqOutside = 1_000_000

// clean bounds an event's texts to the column limits.
func (ev Event) clean() Event {
	ev.TargetName, ev.Digits, ev.Reason = clip(ev.TargetName, 64), clip(ev.Digits, 16), clip(ev.Reason, 64)
	return ev
}

// log records ev as the call's next step (Seq, At = now) in the transition's effects.
func (c *InCall) log(e Env, ev Event, fx *Effects) {
	c.Seq++
	ev.Seq, ev.At = c.Seq, e.Now
	fx.Events = append(fx.Events, ev.clean())
}

// target describes route t for an event: its kind, id and name now (a menu's or group's name,
// a number's digits).
func target(p *PBX, t Target) (TargetKind, *uuid.UUID, string) {
	if t.ID == nil {
		return "", nil, ""
	}
	id := *t.ID
	switch t.Kind {
	case RouteMenu:
		if p != nil {
			return TkMenu, &id, p.Menus[id].Name
		}
		return TkMenu, &id, ""
	case RouteGroup:
		if p != nil {
			return TkGroup, &id, p.Groups[id].Name
		}
		return TkGroup, &id, ""
	case RouteExtension:
		if p != nil {
			x := p.Extensions[id]
			if x.Group != nil {
				return TkGroup, x.Group, p.Groups[*x.Group].Name
			}
			return TkExtension, &id, x.Number
		}
		return TkExtension, &id, ""
	}
	return "", nil, ""
}

// withTarget fills ev's target from route t.
func withTarget(p *PBX, t Target, ev Event) Event {
	ev.TargetKind, ev.TargetID, ev.TargetName = target(p, t)
	return ev
}

// Party is an employee's part in a call (sip_call_parties). The JSON shape is the shape
// UpsertSipCallParties takes.
type Party struct {
	User        uuid.UUID `json:"user_id"`
	Placed      bool      `json:"placed"`
	Rang        bool      `json:"rang"`
	Answered    bool      `json:"answered"`
	Transferred bool      `json:"transferred"`
}

// Parties are the employees evs make parties of the call, in the order they first appear.
func Parties(evs []Event) []Party {
	var out []Party
	at := map[uuid.UUID]int{}
	for _, ev := range evs {
		if ev.User == nil {
			continue
		}
		i, ok := at[*ev.User]
		if !ok {
			i = len(out)
			at[*ev.User] = i
			out = append(out, Party{User: *ev.User})
		}
		p := &out[i]
		switch ev.Kind {
		case EvStarted:
			p.Placed = true
		case EvRing:
			p.Rang = true
		case EvAnswered:
			p.Answered = true
		case EvTransferEnd:
			p.Answered = p.Answered || ev.Reason == "answered"
		case EvTransfer:
			p.Transferred = true
		}
	}
	// Somebody only named by an event (who hung up) is no party.
	return slicesDeleteEmpty(out)
}

func slicesDeleteEmpty(ps []Party) []Party {
	out := ps[:0]
	for _, p := range ps {
		if p.Placed || p.Rang || p.Answered || p.Transferred {
			out = append(out, p)
		}
	}
	return out
}

// ParseLegacyRoute turns the route string of a call from before the journal («menu:<id> →
// key:2 → group:<id> → transfer:user:<id> → transfer:answered») into its steps, in order and
// without times (At zero, Seq from 1). A label cut short by the 500-character limit, or one this
// parser does not know, is left out.
func ParseLegacyRoute(route string) []Event {
	var out []Event
	if strings.TrimSpace(route) == "" {
		return out
	}
	add := func(ev Event) {
		ev.Seq = len(out) + 1
		out = append(out, ev.clean())
	}
	ref := func(kind TargetKind, raw string) (TargetKind, *uuid.UUID) {
		id, err := uuid.Parse(raw)
		if err != nil {
			return kind, nil
		}
		return kind, &id
	}
	for _, label := range strings.Split(route, " → ") {
		label = strings.TrimSpace(label)
		head, rest, _ := strings.Cut(label, ":")
		switch head {
		case "menu":
			k, id := ref(TkMenu, rest)
			add(Event{Kind: EvMenu, TargetKind: k, TargetID: id})
		case "group":
			k, id := ref(TkGroup, rest)
			add(Event{Kind: EvGroup, TargetKind: k, TargetID: id})
		case "ext":
			k, id := ref(TkExtension, rest)
			add(Event{Kind: EvRing, TargetKind: k, TargetID: id})
		case "key":
			if rest != "" {
				add(Event{Kind: EvKey, Digits: rest})
			}
		case "dial":
			if rest != "" {
				add(Event{Kind: EvDialed, Digits: rest})
			}
		case "notice":
			add(Event{Kind: EvNotice})
		case "transfer":
			kind, id, _ := strings.Cut(rest, ":")
			switch kind {
			case "user":
				if u, err := uuid.Parse(id); err == nil {
					add(Event{Kind: EvTransfer, Peer: &u, TargetKind: TkUser, TargetID: &u})
				}
			case "ext":
				k, tid := ref(TkExtension, id)
				add(Event{Kind: EvTransfer, TargetKind: k, TargetID: tid})
			case "group":
				k, tid := ref(TkGroup, id)
				add(Event{Kind: EvTransfer, TargetKind: k, TargetID: tid})
			case "menu", "hangup", "repeat":
				add(Event{Kind: EvTransfer})
			case "answered", "no_answer", "declined", "cancelled", "not_connected", ReasonNoMembers, ReasonBusy, ReasonLoop:
				add(Event{Kind: EvTransferEnd, Reason: kind})
			}
		}
	}
	return out
}

// LegacyEvents are the steps of a call from before the journal: its start, the parsed route,
// the answer (before the first transfer; by answeredBy unless a transfer took the call, whose
// first answer is not known) and its end.
func LegacyEvents(route, reason string, answered bool, answeredBy, endedBy *uuid.UUID, ended bool) []Event {
	steps := ParseLegacyRoute(route)
	by := answeredBy
	for _, ev := range steps {
		if ev.Kind == EvTransferEnd && ev.Reason == "answered" {
			by = nil
		}
	}
	out := []Event{{Kind: EvStarted}}
	pending := answered
	for _, ev := range steps {
		if pending && ev.Kind == EvTransfer {
			out = append(out, Event{Kind: EvAnswered, User: by})
			pending = false
		}
		if ev.Kind == EvTransferEnd && ev.Reason == "answered" {
			ev.User = answeredBy
		}
		out = append(out, ev)
	}
	if pending {
		out = append(out, Event{Kind: EvAnswered, User: by})
	}
	if ended {
		out = append(out, Event{Kind: EvEnded, Reason: reason, User: endedBy})
	}
	for i := range out {
		out[i].Seq = i + 1
	}
	return out
}

// attemptDigits is a menu play's count as the MENU event's digits.
func attemptDigits(n int) string { return strconv.Itoa(n) }

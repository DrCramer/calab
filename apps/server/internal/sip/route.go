package sip

import (
	"sort"

	"github.com/google/uuid"
)

// Routing of inbound calls (ADR-0117 §4), step 1: given the exchange of a workspace (numbers,
// groups, menus) and who can take a call right now, where does a route lead? The answer is a
// Decision — play a menu, ring somebody, or hang up — that the call state machine of step 2
// carries out. Pure: no I/O, so every branch is a unit test.

// RouteKind is what a route does (SipRouteKind).
type RouteKind uint8

// Route kinds.
const (
	RouteHangup RouteKind = iota
	RouteRepeat
	RouteMenu
	RouteExtension
	RouteGroup
)

// Target is a route: a kind and, for menu / extension / group, the object; ID nil = the object
// was deleted (the route stays, ON DELETE SET NULL) and the route hangs up.
type Target struct {
	Kind RouteKind
	ID   *uuid.UUID
}

// Ext is an internal number. User is the member behind a person / bot number (nil = nobody:
// the member left, or a guest — guests never ring); Group is the group of a group number.
type Ext struct {
	ID    uuid.UUID
	User  *uuid.UUID
	Group *uuid.UUID
}

// GroupMember is a member of a group in its round-robin order.
type GroupMember struct {
	Extension uuid.UUID
	Position  int
}

// Group is a call group.
type Group struct {
	ID            uuid.UUID
	Name          string
	RoundRobin    bool
	RingSec       int
	MemberRingSec int
	NextPosition  int
	OnFail        Target
	Members       []GroupMember // any order; sorted by Position when routed
}

// Menu is a voice menu.
type Menu struct {
	ID              uuid.UUID
	Name            string
	HasPrompt       bool
	Prompt          uuid.UUID // the prompt file (HasPrompt)
	PromptMs        int       // its duration
	InputTimeoutSec int
	Repeats         int
	OnNoInput       Target
	Items           map[byte]Target // '0'..'9', '*', '#'
}

// PBX is the exchange of one workspace.
type PBX struct {
	Extensions map[uuid.UUID]Ext
	Groups     map[uuid.UUID]Group
	Menus      map[uuid.UUID]Menu
}

// Availability says who can take a call now: Online = has a live presence session (a device),
// Busy = already in a call (a DM call of ADR-0034 or another inbound call).
type Availability interface {
	Online(user uuid.UUID) bool
	Busy(user uuid.UUID) bool
}

// Action is what to do with the call.
type Action uint8

// Actions of a Decision.
const (
	ActHangup Action = iota // put the phone down (Reason says why)
	ActMenu                 // play Menu and wait for a key
	ActRing                 // ring Ring (all at once, or Sequential one after another)
)

// Hang-up reasons of a Decision (sip_calls.reason of step 2).
const (
	ReasonHangup    = "hangup_menu" // a route to «hang up» (also a deleted target)
	ReasonNoMembers = "no_members"  // nobody to ring: an empty group, all busy, a number without a member
	ReasonBusy      = "busy"        // the one person of a number is in another call
	ReasonLoop      = "loop"        // MaxHops routes without reaching a menu or a person
)

// MaxHops bounds the routes followed for one decision (menu → group → menu … without anybody).
const MaxHops = 10

// Ring is one person to ring and how long (seconds).
type Ring struct {
	Extension uuid.UUID
	User      uuid.UUID
	Sec       int
}

// Decision is where a route leads.
type Decision struct {
	Action Action
	Reason string // ActHangup
	Menu   *Menu  // ActMenu
	// ActRing: who rings. Sequential = round-robin, in this order, each for its Sec; else all
	// at once for Ring[0].Sec.
	Ring       []Ring
	Sequential bool
	Group      *uuid.UUID // the group that rings (ActRing from a group)
	// OnFail: where the call goes when nobody answers (ActRing); the group's fallback, or
	// hang up for a number.
	OnFail Target
	Hops   int // routes followed
}

// Route resolves t: menus without a prompt go on to their «no input» route, groups with nobody
// to ring go on to their fallback, a group's number is its group. Ringing a single number
// rings directSec seconds and falls back to hang up (the menu / entry point decides further
// in step 2).
func Route(p *PBX, t Target, a Availability, directSec int) Decision {
	for hops := 0; ; hops++ {
		if hops >= MaxHops {
			return Decision{Action: ActHangup, Reason: ReasonLoop, Hops: hops}
		}
		if t.ID == nil && t.Kind != RouteHangup && t.Kind != RouteRepeat {
			return Decision{Action: ActHangup, Reason: ReasonHangup, Hops: hops}
		}
		switch t.Kind {
		case RouteMenu:
			m, ok := p.Menus[*t.ID]
			if !ok {
				return Decision{Action: ActHangup, Reason: ReasonHangup, Hops: hops}
			}
			if !m.HasPrompt { // nothing to play: as if nobody pressed a key
				t = m.OnNoInput
				continue
			}
			return Decision{Action: ActMenu, Menu: &m, Hops: hops}
		case RouteExtension:
			e, ok := p.Extensions[*t.ID]
			if !ok {
				return Decision{Action: ActHangup, Reason: ReasonHangup, Hops: hops}
			}
			if e.Group != nil {
				t = Target{Kind: RouteGroup, ID: e.Group}
				continue
			}
			if e.User == nil {
				return Decision{Action: ActHangup, Reason: ReasonNoMembers, Hops: hops}
			}
			if a.Busy(*e.User) {
				return Decision{Action: ActHangup, Reason: ReasonBusy, Hops: hops}
			}
			return Decision{Action: ActRing, Ring: []Ring{{Extension: e.ID, User: *e.User, Sec: directSec}},
				OnFail: Target{Kind: RouteHangup}, Hops: hops}
		case RouteGroup:
			g, ok := p.Groups[*t.ID]
			if !ok {
				return Decision{Action: ActHangup, Reason: ReasonHangup, Hops: hops}
			}
			ring := groupRing(p, g, a)
			if len(ring) == 0 {
				t = g.OnFail
				continue
			}
			id := g.ID
			return Decision{Action: ActRing, Ring: ring, Sequential: g.RoundRobin, Group: &id, OnFail: g.OnFail, Hops: hops}
		default: // hangup; repeat outside a menu key means nothing to repeat
			return Decision{Action: ActHangup, Reason: ReasonHangup, Hops: hops}
		}
	}
}

// groupRing is who a group rings now. ring_all: every member with a person behind the number
// who is not busy — offline ones too (a push may still reach a phone); round_robin: the members
// from next_position on around the circle, once each, skipping the offline and the busy.
func groupRing(p *PBX, g Group, a Availability) []Ring {
	members := append([]GroupMember(nil), g.Members...)
	sort.SliceStable(members, func(i, j int) bool { return members[i].Position < members[j].Position })
	start := 0
	if g.RoundRobin {
		start = len(members) // wraps to 0 when every position is below the pointer
		for i, m := range members {
			if m.Position >= g.NextPosition {
				start = i
				break
			}
		}
	}
	var out []Ring
	seen := map[uuid.UUID]bool{}
	for k := range members {
		m := members[(start+k)%len(members)]
		e, ok := p.Extensions[m.Extension]
		if !ok || e.User == nil || seen[*e.User] || a.Busy(*e.User) {
			continue
		}
		if g.RoundRobin && !a.Online(*e.User) {
			continue
		}
		seen[*e.User] = true
		sec := g.RingSec
		if g.RoundRobin {
			sec = g.MemberRingSec
		}
		out = append(out, Ring{Extension: e.ID, User: *e.User, Sec: sec})
	}
	return out
}

// NextPosition is the round-robin pointer after a call of g: the position after the member
// whose number answered, or — nobody answered — after the first member that rang. ok=false:
// the pointer stays (nobody rang, or answered is not a member).
func NextPosition(g Group, answered *uuid.UUID, rang []Ring) (int, bool) {
	ext := answered
	if ext == nil {
		if len(rang) == 0 {
			return 0, false
		}
		ext = &rang[0].Extension
	}
	for _, m := range g.Members {
		if m.Extension == *ext {
			return m.Position + 1, true
		}
	}
	return 0, false
}

// Press is the route of a key of menu m: the item's action, or ok=false — no item for the
// key, which counts as no input (the menu plays again).
func Press(m *Menu, digit byte) (Target, bool) {
	t, ok := m.Items[digit]
	return t, ok
}

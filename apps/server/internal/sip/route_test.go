package sip

import (
	"slices"
	"testing"

	"github.com/google/uuid"
)

type avail struct{ offline, busy map[uuid.UUID]bool }

func (a avail) Online(u uuid.UUID) bool { return !a.offline[u] }
func (a avail) Busy(u uuid.UUID) bool   { return a.busy[u] }

func set(ids ...uuid.UUID) map[uuid.UUID]bool {
	m := map[uuid.UUID]bool{}
	for _, id := range ids {
		m[id] = true
	}
	return m
}

func ptr(id uuid.UUID) *uuid.UUID { return &id }

// fixture: numbers 101..103 of people u1..u3, 104 without a member (the member left), a group
// «Продажи» (1001) of 101, 102, 103, 104 in that order, a menu «Главное» with 1 → group,
// 2 → 101, 0 → hang up, 9 → a deleted menu.
type fixture struct {
	p                      *PBX
	u1, u2, u3             uuid.UUID
	e1, e2, e3, e4, eGroup uuid.UUID
	group, menu            uuid.UUID
}

func newFixture(roundRobin bool, next int) fixture {
	f := fixture{u1: uuid.New(), u2: uuid.New(), u3: uuid.New(), e1: uuid.New(), e2: uuid.New(), e3: uuid.New(),
		e4: uuid.New(), eGroup: uuid.New(), group: uuid.New(), menu: uuid.New()}
	f.p = &PBX{
		Extensions: map[uuid.UUID]Ext{
			f.e1:     {ID: f.e1, User: ptr(f.u1)},
			f.e2:     {ID: f.e2, User: ptr(f.u2)},
			f.e3:     {ID: f.e3, User: ptr(f.u3)},
			f.e4:     {ID: f.e4},
			f.eGroup: {ID: f.eGroup, Group: ptr(f.group)},
		},
		Groups: map[uuid.UUID]Group{f.group: {
			ID: f.group, RoundRobin: roundRobin, RingSec: 30, MemberRingSec: 15, NextPosition: next,
			OnFail:  Target{Kind: RouteExtension, ID: ptr(f.e1)},
			Members: []GroupMember{{Extension: f.e3, Position: 2}, {Extension: f.e1, Position: 0}, {Extension: f.e4, Position: 3}, {Extension: f.e2, Position: 1}},
		}},
		Menus: map[uuid.UUID]Menu{f.menu: {
			ID: f.menu, HasPrompt: true, InputTimeoutSec: 5, Repeats: 3, OnNoInput: Target{Kind: RouteHangup},
			Items: map[byte]Target{'1': {Kind: RouteGroup, ID: ptr(f.group)}, '2': {Kind: RouteExtension, ID: ptr(f.e1)},
				'0': {Kind: RouteHangup}, '9': {Kind: RouteMenu}},
		}},
	}
	return f
}

func users(rs []Ring) []uuid.UUID {
	out := make([]uuid.UUID, len(rs))
	for i, r := range rs {
		out[i] = r.User
	}
	return out
}

func sameOrder(t *testing.T, got []Ring, want ...uuid.UUID) {
	t.Helper()
	if g := users(got); !slices.Equal(g, want) {
		t.Fatalf("ring %v, want %v", g, want)
	}
}

func TestRouteRingAll(t *testing.T) {
	f := newFixture(false, 0)
	// Offline members ring too (push); the number without a member is skipped.
	d := Route(f.p, Target{Kind: RouteGroup, ID: ptr(f.group)}, avail{offline: set(f.u2)}, 30)
	if d.Action != ActRing || d.Sequential || d.Group == nil || *d.Group != f.group {
		t.Fatalf("%+v", d)
	}
	sameOrder(t, d.Ring, f.u1, f.u2, f.u3)
	for _, r := range d.Ring {
		if r.Sec != 30 {
			t.Fatalf("ring_all rings ring_sec: %+v", r)
		}
	}
	if d.OnFail.Kind != RouteExtension || *d.OnFail.ID != f.e1 {
		t.Fatalf("on_fail %+v", d.OnFail)
	}
	// Busy members are left out.
	d = Route(f.p, Target{Kind: RouteGroup, ID: ptr(f.group)}, avail{busy: set(f.u1, f.u3)}, 30)
	sameOrder(t, d.Ring, f.u2)
}

func TestRouteRoundRobin(t *testing.T) {
	// The pointer at position 1: 102, 103, (104 has nobody), then around to 101.
	f := newFixture(true, 1)
	d := Route(f.p, Target{Kind: RouteGroup, ID: ptr(f.group)}, avail{}, 30)
	if d.Action != ActRing || !d.Sequential {
		t.Fatalf("%+v", d)
	}
	sameOrder(t, d.Ring, f.u2, f.u3, f.u1)
	if d.Ring[0].Sec != 15 {
		t.Fatalf("round_robin rings member_ring_sec: %+v", d.Ring[0])
	}
	// Offline and busy members are skipped.
	d = Route(f.p, Target{Kind: RouteGroup, ID: ptr(f.group)}, avail{offline: set(f.u3), busy: set(f.u2)}, 30)
	sameOrder(t, d.Ring, f.u1)
	// A pointer past the last position wraps to the first member.
	f = newFixture(true, 9)
	sameOrder(t, Route(f.p, Target{Kind: RouteGroup, ID: ptr(f.group)}, avail{}, 30).Ring, f.u1, f.u2, f.u3)
}

func TestNextPosition(t *testing.T) {
	f := newFixture(true, 1)
	g := f.p.Groups[f.group]
	d := Route(f.p, Target{Kind: RouteGroup, ID: ptr(f.group)}, avail{}, 30)
	if n, ok := NextPosition(g, ptr(f.e3), d.Ring); !ok || n != 3 {
		t.Fatalf("after 103 answered: %d %v", n, ok)
	}
	if n, ok := NextPosition(g, nil, d.Ring); !ok || n != 2 {
		t.Fatalf("nobody answered: %d %v", n, ok)
	}
	if _, ok := NextPosition(g, nil, nil); ok {
		t.Fatal("nobody rang: the pointer stays")
	}
	// The next call starts after the one who answered: 104 has nobody, so 101 then 102, 103.
	g.NextPosition = 3
	f.p.Groups[f.group] = g
	sameOrder(t, Route(f.p, Target{Kind: RouteGroup, ID: ptr(f.group)}, avail{}, 30).Ring, f.u1, f.u2, f.u3)
}

func TestRouteNobodyToRing(t *testing.T) {
	f := newFixture(true, 0)
	// Everyone offline in a round-robin group → the group's fallback (101 directly; ringing a
	// number does not need presence: a push may reach the phone).
	d := Route(f.p, Target{Kind: RouteGroup, ID: ptr(f.group)}, avail{offline: set(f.u1, f.u2, f.u3)}, 30)
	if d.Action != ActRing || d.Sequential || d.Group != nil || len(d.Ring) != 1 || d.Ring[0].User != f.u1 || d.Ring[0].Sec != 30 || d.Hops != 1 {
		t.Fatalf("%+v", d)
	}
	// An empty group with no fallback hangs up.
	g := f.p.Groups[f.group]
	g.Members, g.OnFail = nil, Target{Kind: RouteHangup}
	f.p.Groups[f.group] = g
	if d := Route(f.p, Target{Kind: RouteGroup, ID: ptr(f.group)}, avail{}, 30); d.Action != ActHangup || d.Reason != ReasonHangup {
		t.Fatalf("empty group: %+v", d)
	}
}

func TestRouteDeleted(t *testing.T) {
	f := newFixture(false, 0)
	// A number whose member left: nobody to ring.
	if d := Route(f.p, Target{Kind: RouteExtension, ID: ptr(f.e4)}, avail{}, 30); d.Action != ActHangup || d.Reason != ReasonNoMembers {
		t.Fatalf("unassigned number: %+v", d)
	}
	// A route whose target was deleted (ID set NULL) and an id that is not in the exchange.
	for _, tg := range []Target{{Kind: RouteGroup}, {Kind: RouteMenu, ID: ptr(uuid.New())}, {Kind: RouteExtension, ID: ptr(uuid.New())}} {
		if d := Route(f.p, tg, avail{}, 30); d.Action != ActHangup || d.Reason != ReasonHangup {
			t.Fatalf("%+v: %+v", tg, d)
		}
	}
	// A deleted member of a group is skipped (its row went with the number): only u2, u3 ring.
	delete(f.p.Extensions, f.e1)
	sameOrder(t, Route(f.p, Target{Kind: RouteGroup, ID: ptr(f.group)}, avail{}, 30).Ring, f.u2, f.u3)
}

func TestRouteExtension(t *testing.T) {
	f := newFixture(false, 0)
	d := Route(f.p, Target{Kind: RouteExtension, ID: ptr(f.e2)}, avail{offline: set(f.u2)}, 25)
	if d.Action != ActRing || len(d.Ring) != 1 || d.Ring[0].User != f.u2 || d.Ring[0].Sec != 25 || d.OnFail.Kind != RouteHangup {
		t.Fatalf("%+v", d)
	}
	if d := Route(f.p, Target{Kind: RouteExtension, ID: ptr(f.e2)}, avail{busy: set(f.u2)}, 25); d.Action != ActHangup || d.Reason != ReasonBusy {
		t.Fatalf("busy: %+v", d)
	}
	// A group's number is its group.
	if d := Route(f.p, Target{Kind: RouteExtension, ID: ptr(f.eGroup)}, avail{}, 25); d.Action != ActRing || d.Group == nil || *d.Group != f.group {
		t.Fatalf("group number: %+v", d)
	}
}

func TestRouteMenu(t *testing.T) {
	f := newFixture(false, 0)
	d := Route(f.p, Target{Kind: RouteMenu, ID: ptr(f.menu)}, avail{}, 30)
	if d.Action != ActMenu || d.Menu == nil || d.Menu.ID != f.menu {
		t.Fatalf("%+v", d)
	}
	for digit, want := range map[byte]Action{'1': ActRing, '2': ActRing, '0': ActHangup, '9': ActHangup} {
		tg, ok := Press(d.Menu, digit)
		if !ok {
			t.Fatalf("%c: no item", digit)
		}
		if got := Route(f.p, tg, avail{}, 30); got.Action != want {
			t.Fatalf("%c: %+v", digit, got)
		}
	}
	if _, ok := Press(d.Menu, '5'); ok {
		t.Fatal("5 has no item")
	}
	// A menu without a prompt goes on to «no input» at once.
	m := f.p.Menus[f.menu]
	m.HasPrompt, m.OnNoInput = false, Target{Kind: RouteExtension, ID: ptr(f.e3)}
	f.p.Menus[f.menu] = m
	if d := Route(f.p, Target{Kind: RouteMenu, ID: ptr(f.menu)}, avail{}, 30); d.Action != ActRing || d.Ring[0].User != f.u3 {
		t.Fatalf("no prompt: %+v", d)
	}
}

func TestRouteLoop(t *testing.T) {
	f := newFixture(false, 0)
	// A menu without a prompt whose «no input» is itself, and a group falling back to itself.
	m := f.p.Menus[f.menu]
	m.HasPrompt, m.OnNoInput = false, Target{Kind: RouteMenu, ID: ptr(f.menu)}
	f.p.Menus[f.menu] = m
	if d := Route(f.p, Target{Kind: RouteMenu, ID: ptr(f.menu)}, avail{}, 30); d.Action != ActHangup || d.Reason != ReasonLoop || d.Hops != MaxHops {
		t.Fatalf("menu loop: %+v", d)
	}
	g := f.p.Groups[f.group]
	g.Members, g.OnFail = nil, Target{Kind: RouteGroup, ID: ptr(f.group)}
	f.p.Groups[f.group] = g
	if d := Route(f.p, Target{Kind: RouteGroup, ID: ptr(f.group)}, avail{}, 30); d.Reason != ReasonLoop {
		t.Fatalf("group loop: %+v", d)
	}
	// Repeat outside a key of a menu has nothing to repeat.
	if d := Route(f.p, Target{Kind: RouteRepeat}, avail{}, 30); d.Action != ActHangup {
		t.Fatalf("repeat: %+v", d)
	}
}

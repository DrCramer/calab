package sip

import (
	"encoding/json"
	"slices"
	"testing"
	"time"

	"github.com/google/uuid"
)

// journal collects the events of a call's transitions and checks the numbering on the way.
type journal struct {
	t   *testing.T
	evs []Event
}

func (j *journal) take(fx *Effects) []Event {
	j.t.Helper()
	for _, ev := range fx.Events {
		if n := len(j.evs); n > 0 && (ev.Seq != j.evs[n-1].Seq+1 || ev.At.Before(j.evs[n-1].At)) {
			j.t.Fatalf("event %+v after %+v", ev, j.evs[n-1])
		}
		if len(j.evs) == 0 && ev.Seq != 1 {
			j.t.Fatalf("first seq %d", ev.Seq)
		}
		j.evs = append(j.evs, ev)
	}
	got := fx.Events
	*fx = Effects{}
	return got
}

func kinds(evs []Event) []EventKind {
	out := make([]EventKind, len(evs))
	for i, ev := range evs {
		out[i] = ev.Kind
	}
	return out
}

func (j *journal) want(t *testing.T, want ...EventKind) {
	t.Helper()
	if got := kinds(j.evs); !slices.Equal(got, want) {
		t.Fatalf("events %v, want %v", got, want)
	}
}

func is(ev Event, kind EventKind, user *uuid.UUID, reason string) bool {
	return ev.Kind == kind && ev.Reason == reason && ((user == nil && ev.User == nil) || (user != nil && ev.User != nil && *ev.User == *user))
}

// A menu, a key, a round-robin group (the first member does not answer, the second does), a
// transfer to a member who answers, the caller hangs up.
func TestJournalMenuRoundRobinTransfer(t *testing.T) {
	f := newFixture(true, 0).withPrompt()
	a := avail{}
	j := &journal{t: t}
	var c InCall
	var fx Effects
	e := envAt(f, a, 0)
	c.log(e, Event{Kind: EvStarted, Digits: "+74951234567", Reason: "direct"}, &fx)
	c.Enter(e, Target{Kind: RouteMenu, ID: ptr(f.menu)}, &fx)
	j.take(&fx)
	c.PromptDone(envAt(f, a, 4*time.Second))
	c.Digit(envAt(f, a, 5*time.Second), '1', &fx)
	evs := j.take(&fx)
	if !is(evs[0], EvKey, nil, "") || evs[0].Digits != "1" || evs[1].Kind != EvGroup || evs[1].Reason != "round_robin" ||
		evs[1].TargetName != "Продажи" || *evs[1].TargetID != f.group || !is(evs[2], EvRing, &f.u1, "") || *evs[2].TargetID != f.group {
		t.Fatalf("key → group: %+v", evs)
	}
	c.Expire(envAt(f, a, 20*time.Second), &fx)
	evs = j.take(&fx)
	if len(evs) != 2 || !is(evs[0], EvRingEnd, &f.u1, EndNoAnswer) || !is(evs[1], EvRing, &f.u2, "") {
		t.Fatalf("next member: %+v", evs)
	}
	if err := c.Answer(envAt(f, a, 25*time.Second), f.u2, &fx); err != nil {
		t.Fatal(err)
	}
	j.take(&fx)
	if err := c.Transfer(envAt(f, a, 30*time.Second), TransferTo{User: &f.u3}, &fx); err != nil {
		t.Fatal(err)
	}
	evs = j.take(&fx)
	if !is(evs[0], EvTransfer, &f.u2, "") || *evs[0].Peer != f.u3 || evs[0].TargetKind != TkUser || !is(evs[1], EvRing, &f.u3, "") {
		t.Fatalf("transfer: %+v", evs)
	}
	if err := c.Answer(envAt(f, a, 35*time.Second), f.u3, &fx); err != nil {
		t.Fatal(err)
	}
	j.take(&fx)
	c.Hangup(envAt(f, a, 60*time.Second), reasonRemote, &fx)
	j.take(&fx)
	j.want(t, EvStarted, EvMenu, EvKey, EvGroup, EvRing, EvRingEnd, EvRing, EvAnswered, EvTransfer, EvRing, EvTransferEnd, EvEnded)
	if last := j.evs[len(j.evs)-1]; last.Reason != reasonRemote || !last.At.Equal(t0.Add(time.Minute)) {
		t.Fatalf("end: %+v", last)
	}
	if !is(j.evs[10], EvTransferEnd, &f.u3, "answered") {
		t.Fatalf("transfer taken: %+v", j.evs[10])
	}
	ps := Parties(j.evs)
	want := []Party{{User: f.u1, Rang: true}, {User: f.u2, Rang: true, Answered: true, Transferred: true}, {User: f.u3, Rang: true, Answered: true}}
	if !slices.Equal(ps, want) {
		t.Fatalf("parties: %+v", ps)
	}
	// The numbering survives the state's trip through Valkey.
	raw, _ := json.Marshal(c)
	var back InCall
	if err := json.Unmarshal(raw, &back); err != nil || back.Seq != 12 {
		t.Fatalf("seq in the state: %s %v", raw, err)
	}
}

// All at once, everybody declines: each declines once, the call ends «declined».
func TestJournalRingAllDeclined(t *testing.T) {
	f := newFixture(false, 0).withPrompt().noFallback()
	a := avail{}
	j := &journal{t: t}
	var c InCall
	var fx Effects
	c.Enter(envAt(f, a, 0), Target{Kind: RouteGroup, ID: ptr(f.group)}, &fx)
	evs := j.take(&fx)
	if evs[0].Kind != EvGroup || evs[0].Reason != "ring_all" || len(evs) != 4 {
		t.Fatalf("ring all: %+v", evs)
	}
	for i, u := range []uuid.UUID{f.u1, f.u2, f.u3} {
		if err := c.Decline(envAt(f, a, time.Duration(i+1)*time.Second), u, &fx); err != nil {
			t.Fatal(err)
		}
		j.take(&fx)
	}
	j.want(t, EvGroup, EvRing, EvRing, EvRing, EvRingEnd, EvRingEnd, EvRingEnd, EvEnded)
	for i, u := range []uuid.UUID{f.u1, f.u2, f.u3} {
		if !is(j.evs[4+i], EvRingEnd, &u, EndDeclined) {
			t.Fatalf("decline %d: %+v", i, j.evs[4+i])
		}
	}
	if j.evs[7].Reason != ReasonDeclined {
		t.Fatalf("end: %+v", j.evs[7])
	}
}

// A group's fallback (ADR-0124): everybody stops ringing «fallback», FALLBACK names the target,
// the target rings.
func TestJournalGroupFallback(t *testing.T) {
	f := newFixture(false, 0).withPrompt()
	x := f.p.Extensions[f.e1]
	x.Number = "101"
	f.p.Extensions[f.e1] = x
	a := avail{}
	j := &journal{t: t}
	var c InCall
	var fx Effects
	c.Enter(envAt(f, a, 0), Target{Kind: RouteGroup, ID: ptr(f.group)}, &fx)
	j.take(&fx)
	c.Expire(envAt(f, a, 15*time.Second), &fx) // a look for free members: nobody new
	if evs := j.take(&fx); len(evs) != 0 {
		t.Fatalf("recheck: %+v", evs)
	}
	c.Expire(envAt(f, a, 30*time.Second), &fx)
	evs := j.take(&fx)
	j.want(t, EvGroup, EvRing, EvRing, EvRing, EvRingEnd, EvRingEnd, EvRingEnd, EvFallback, EvRing)
	if evs[0].Reason != EndFallback || evs[3].Reason != "timeout" || evs[3].TargetKind != TkExtension || *evs[3].TargetID != f.e1 ||
		evs[3].TargetName != "101" || !is(evs[4], EvRing, &f.u1, "") || evs[4].TargetName != "101" {
		t.Fatalf("fallback: %+v", evs)
	}
}

// Dialing a number nobody has: DIALED not_found, the menu plays again — no NO_INPUT; a timeout
// with nothing pressed is NO_INPUT.
func TestJournalDialNotFoundAndNoInput(t *testing.T) {
	f := newFixture(false, 0).withPrompt()
	m := f.p.Menus[f.menu]
	m.DialExtensions = true
	f.p.Menus[f.menu] = m
	x := f.p.Extensions[f.e1]
	x.Number = "101"
	f.p.Extensions[f.e1] = x
	a := avail{}
	j := &journal{t: t}
	var c InCall
	var fx Effects
	c.Enter(envAt(f, a, 0), Target{Kind: RouteMenu, ID: ptr(f.menu)}, &fx)
	j.take(&fx)
	c.Digit(envAt(f, a, time.Second), '5', &fx)
	evs := j.take(&fx)
	if len(evs) != 2 || evs[0].Kind != EvDialed || evs[0].Digits != "5" || evs[0].Reason != "not_found" || evs[1].Kind != EvMenu || evs[1].Digits != "2" {
		t.Fatalf("not found: %+v", evs)
	}
	c.Expire(envAt(f, a, time.Minute), &fx)
	j.take(&fx)
	j.want(t, EvMenu, EvDialed, EvMenu, EvNoInput, EvMenu)
}

// The recording notice (ADR-0131) before a key rings somebody.
func TestJournalNotice(t *testing.T) {
	f := newFixture(false, 0).withPrompt()
	m := f.p.Menus[f.menu]
	m.Notice, m.NoticeMs = uuid.New(), 2000
	f.p.Menus[f.menu] = m
	a := avail{}
	j := &journal{t: t}
	var c InCall
	var fx Effects
	c.Enter(envAt(f, a, 0), Target{Kind: RouteMenu, ID: ptr(f.menu)}, &fx)
	c.Digit(envAt(f, a, time.Second), '2', &fx)
	j.take(&fx)
	c.WorkerPlayed(envAt(f, a, 3*time.Second), &fx)
	j.take(&fx)
	j.want(t, EvMenu, EvKey, EvNotice, EvRing)
	if j.evs[2].TargetName != "Главное" || !is(j.evs[3], EvRing, &f.u1, "") {
		t.Fatalf("notice: %+v", j.evs)
	}
}

// ADR-0124: a group without a fallback whose members are all busy waits — its rechecks that
// find nobody log nothing.
func TestJournalEmptyRecheckLogsNothing(t *testing.T) {
	f := newFixture(false, 0).withPrompt().noFallback()
	a := avail{busy: set(f.u1, f.u2, f.u3)}
	var c InCall
	var fx Effects
	c.Enter(envAt(f, a, 0), Target{Kind: RouteGroup, ID: ptr(f.group)}, &fx)
	if !slices.Equal(kinds(fx.Events), []EventKind{EvGroup}) {
		t.Fatalf("waiting group: %+v", fx.Events)
	}
	for i := 1; i <= 3; i++ {
		fx = Effects{}
		c.Expire(envAt(f, a, time.Duration(i)*15*time.Second), &fx)
		if len(fx.Events) != 0 || c.Phase != PhaseRing {
			t.Fatalf("recheck %d: %+v %+v", i, c, fx.Events)
		}
	}
	if c.Seq != 1 {
		t.Fatalf("seq: %d", c.Seq)
	}
}

func TestParseLegacyRoute(t *testing.T) {
	menu, group, user, ext := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	route := "menu:" + menu.String() + " → key:1 → notice → group:" + group.String() + " → transfer:user:" + user.String() +
		" → transfer:no_answer → transfer:ext:" + ext.String() + " → transfer:answered → dial:123 → hangup"
	evs := ParseLegacyRoute(route)
	want := []EventKind{EvMenu, EvKey, EvNotice, EvGroup, EvTransfer, EvTransferEnd, EvTransfer, EvTransferEnd, EvDialed}
	if !slices.Equal(kinds(evs), want) {
		t.Fatalf("route: %v", kinds(evs))
	}
	if *evs[0].TargetID != menu || *evs[3].TargetID != group || *evs[4].Peer != user || *evs[6].TargetID != ext ||
		evs[5].Reason != "no_answer" || evs[7].Reason != "answered" || evs[8].Digits != "123" || evs[8].Seq != 9 || !evs[0].At.IsZero() {
		t.Fatalf("details: %+v", evs)
	}
	// Cut by the 500-character limit: a label with half an id keeps its kind without the id.
	cut := ParseLegacyRoute("ext:" + ext.String() + " → group:" + group.String()[:10])
	if len(cut) != 2 || cut[0].Kind != EvRing || *cut[0].TargetID != ext || cut[1].TargetID != nil {
		t.Fatalf("cut: %+v", cut)
	}
	if len(ParseLegacyRoute("")) != 0 {
		t.Fatal("empty route")
	}
	// The whole legacy call: start, steps, the answer before the first transfer, the end.
	bob := uuid.New()
	all := LegacyEvents("ext:"+ext.String()+" → transfer:user:"+user.String()+" → transfer:no_answer", ReasonHangup, true, &bob, &bob, true)
	if !slices.Equal(kinds(all), []EventKind{EvStarted, EvRing, EvAnswered, EvTransfer, EvTransferEnd, EvEnded}) ||
		*all[2].User != bob || *all[5].User != bob || all[5].Seq != 6 {
		t.Fatalf("legacy: %+v", all)
	}
	missed := LegacyEvents("menu:"+menu.String(), ReasonNoInput, false, nil, nil, true)
	if !slices.Equal(kinds(missed), []EventKind{EvStarted, EvMenu, EvEnded}) {
		t.Fatalf("legacy missed: %+v", missed)
	}
}

func TestEventClean(t *testing.T) {
	ev := Event{TargetName: string(make([]rune, 100)), Digits: "12345678901234567890", Reason: string(make([]byte, 100))}.clean()
	if len([]rune(ev.TargetName)) != 64 || len(ev.Digits) != 16 || len(ev.Reason) != 64 {
		t.Fatalf("clean: %d %d %d", len([]rune(ev.TargetName)), len(ev.Digits), len(ev.Reason))
	}
}

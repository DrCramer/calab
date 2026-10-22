package sip

import (
	"encoding/json"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/google/uuid"
)

var t0 = time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC)

func envAt(f fixture, a Availability, at time.Duration) Env {
	return Env{PBX: f.p, Avail: a, Now: t0.Add(at)}
}

func (f fixture) withPrompt() fixture {
	m := f.p.Menus[f.menu]
	m.Name, m.Prompt, m.PromptMs = "Главное", uuid.New(), 4000
	f.p.Menus[f.menu] = m
	g := f.p.Groups[f.group]
	g.Name = "Продажи"
	f.p.Groups[f.group] = g
	return f
}

func TestInboundMenuKeyToGroupRingAll(t *testing.T) {
	f := newFixture(false, 0).withPrompt()
	a := avail{}
	var c InCall
	var fx Effects
	c.Enter(envAt(f, a, 0), Target{Kind: RouteMenu, ID: ptr(f.menu)}, &fx)
	if c.Phase != PhaseMenu || fx.Play == nil || fx.Play.File != f.p.Menus[f.menu].Prompt || c.Via != "Главное" {
		t.Fatalf("menu: %+v %+v", c, fx)
	}
	// A key while the prompt plays does not count (no barge-in, owner's default 6).
	fx = Effects{}
	c.Digit(envAt(f, a, time.Second), '1', &fx)
	if c.Phase != PhaseMenu || fx.Play != nil {
		t.Fatalf("barge-in: %+v", c)
	}
	c.PromptDone(envAt(f, a, 4*time.Second))
	if !c.Played || c.Deadline != t0.Add(9*time.Second).UnixMilli() {
		t.Fatalf("played: %+v", c)
	}
	fx = Effects{}
	c.Digit(envAt(f, a, 5*time.Second), '1', &fx)
	if c.Phase != PhaseRing || c.Sequential || c.Via != "Продажи" || fx.Play == nil || !fx.Play.Ringback {
		t.Fatalf("group: %+v %+v", c, fx)
	}
	if !slices.Equal(fx.Rings, []uuid.UUID{f.u1, f.u2, f.u3}) || !slices.Equal(c.Ringing, fx.Rings) {
		t.Fatalf("ring all: %v", fx.Rings)
	}
	if c.Deadline != t0.Add(35*time.Second).UnixMilli() {
		t.Fatalf("deadline: %d", c.Deadline)
	}
	// u2 answers: the others stop ringing; no pointer for ring_all.
	fx = Effects{}
	if err := c.Answer(envAt(f, a, 10*time.Second), f.u2, &fx); err != nil {
		t.Fatal(err)
	}
	if c.Phase != PhaseActive || *c.Answered != f.u2 || !fx.Answered || fx.Advance != nil || !slices.Equal(fx.Stopped, []uuid.UUID{f.u1, f.u3}) {
		t.Fatalf("answer: %+v %+v", c, fx)
	}
	// A second accept loses.
	if err := c.Answer(envAt(f, a, 11*time.Second), f.u1, &Effects{}); !errors.Is(err, ErrNotRinging) {
		t.Fatalf("second answer: %v", err)
	}
}

func TestInboundRoundRobinSkipsOfflineAndMovesPointer(t *testing.T) {
	f := newFixture(true, 1).withPrompt() // starts at position 1 = 102 (u2)
	a := avail{offline: set(f.u3)}
	var c InCall
	var fx Effects
	c.Enter(envAt(f, a, 0), Target{Kind: RouteGroup, ID: ptr(f.group)}, &fx)
	if !c.Sequential || !slices.Equal(fx.Rings, []uuid.UUID{f.u2}) || c.Deadline != t0.Add(15*time.Second).UnixMilli() {
		t.Fatalf("first: %+v %+v", c, fx)
	}
	// No answer in 15 s: u3 is offline → u1 (104 has nobody).
	fx = Effects{}
	c.Expire(envAt(f, a, 15*time.Second), &fx)
	if !slices.Equal(c.Ringing, []uuid.UUID{f.u1}) || !slices.Equal(fx.Stopped, []uuid.UUID{f.u2}) || !slices.Equal(fx.Rings, []uuid.UUID{f.u1}) {
		t.Fatalf("next: %+v %+v", c, fx)
	}
	// u1 answers: the pointer moves past u1's number (position 0 → 1).
	fx = Effects{}
	if err := c.Answer(envAt(f, a, 20*time.Second), f.u1, &fx); err != nil {
		t.Fatal(err)
	}
	if fx.Advance == nil || fx.Advance.Group != f.group || fx.Advance.Position != 1 {
		t.Fatalf("pointer: %+v", fx.Advance)
	}
}

func TestInboundRoundRobinNobodyAnswersGoesToFallback(t *testing.T) {
	f := newFixture(true, 0).withPrompt()
	g := f.p.Groups[f.group]
	g.OnFail = Target{Kind: RouteHangup}
	f.p.Groups[f.group] = g
	a := avail{}
	var c InCall
	var fx Effects
	c.Enter(envAt(f, a, 0), Target{Kind: RouteGroup, ID: ptr(f.group)}, &fx)
	for i, want := range []uuid.UUID{f.u2, f.u3} {
		fx = Effects{}
		c.Expire(envAt(f, a, time.Duration(i+1)*15*time.Second), &fx)
		if !slices.Equal(c.Ringing, []uuid.UUID{want}) {
			t.Fatalf("step %d: %v", i, c.Ringing)
		}
	}
	// u2 took another call meanwhile: skipped at its turn would be too late — it already rang.
	fx = Effects{}
	c.Expire(envAt(f, a, 45*time.Second), &fx)
	if c.Phase != PhaseEnded || fx.Hangup != ReasonNoAnswer || fx.Advance == nil || fx.Advance.Position != 1 {
		t.Fatalf("end: %+v %+v", c, fx)
	}
	if !slices.Equal(fx.Stopped, []uuid.UUID{f.u3}) {
		t.Fatalf("stopped: %v", fx.Stopped)
	}
}

func TestInboundRoundRobinRechecksBusyAtTurn(t *testing.T) {
	f := newFixture(true, 0)
	busy := map[uuid.UUID]bool{}
	a := avail{busy: busy}
	var c InCall
	var fx Effects
	c.Enter(envAt(f, a, 0), Target{Kind: RouteGroup, ID: ptr(f.group)}, &fx)
	busy[f.u2] = true // took a call while u1 rang
	fx = Effects{}
	c.Expire(envAt(f, a, 15*time.Second), &fx)
	if !slices.Equal(c.Ringing, []uuid.UUID{f.u3}) {
		t.Fatalf("busy not skipped: %v", c.Ringing)
	}
}

func TestInboundEmptyGroupFallsBack(t *testing.T) {
	f := newFixture(false, 0)
	g := f.p.Groups[f.group]
	g.Members = nil // empty: the fallback (101) rings at once
	f.p.Groups[f.group] = g
	var c InCall
	var fx Effects
	c.Enter(envAt(f, avail{}, 0), Target{Kind: RouteGroup, ID: ptr(f.group)}, &fx)
	if c.Phase != PhaseRing || !slices.Equal(c.Ringing, []uuid.UUID{f.u1}) {
		t.Fatalf("fallback: %+v", c)
	}
	// Nobody to ring at all: hang up «no members».
	g.OnFail = Target{Kind: RouteHangup}
	f.p.Groups[f.group] = g
	c, fx = InCall{}, Effects{}
	c.Enter(envAt(f, avail{}, 0), Target{Kind: RouteGroup, ID: ptr(f.group)}, &fx)
	if c.Phase != PhaseEnded || fx.Hangup != ReasonHangup {
		t.Fatalf("empty: %+v %+v", c, fx)
	}
}

func TestInboundDirectNumberBusyAndNoAnswer(t *testing.T) {
	f := newFixture(false, 0)
	var c InCall
	var fx Effects
	c.Enter(envAt(f, avail{busy: set(f.u1)}, 0), Target{Kind: RouteExtension, ID: ptr(f.e1)}, &fx)
	if fx.Hangup != ReasonBusy {
		t.Fatalf("busy: %+v", fx)
	}
	c, fx = InCall{}, Effects{}
	c.Enter(envAt(f, avail{}, 0), Target{Kind: RouteExtension, ID: ptr(f.e1)}, &fx)
	if c.Deadline != t0.Add(DirectRingSec*time.Second).UnixMilli() {
		t.Fatalf("direct: %+v", c)
	}
	fx = Effects{}
	c.Expire(envAt(f, avail{}, DirectRingSec*time.Second), &fx)
	if fx.Hangup != ReasonNoAnswer || !slices.Equal(fx.Stopped, []uuid.UUID{f.u1}) {
		t.Fatalf("no answer: %+v", fx)
	}
}

func TestInboundMenuTimeoutRepeatsThenNoInput(t *testing.T) {
	f := newFixture(false, 0).withPrompt()
	m := f.p.Menus[f.menu]
	m.Repeats = 2
	m.OnNoInput = Target{Kind: RouteExtension, ID: ptr(f.e2)}
	f.p.Menus[f.menu] = m
	a := avail{}
	var c InCall
	var fx Effects
	c.Enter(envAt(f, a, 0), Target{Kind: RouteMenu, ID: ptr(f.menu)}, &fx)
	// The worker's «played» is lost: the deadline from the duration still fires.
	want := t0.Add(4*time.Second + 5*time.Second + promptSlack).UnixMilli()
	if c.Deadline != want {
		t.Fatalf("deadline %d, want %d", c.Deadline, want)
	}
	fx = Effects{}
	c.Expire(envAt(f, a, 2*time.Second), &fx) // early: nothing
	if fx.Play != nil || c.Attempts != 1 {
		t.Fatal("expired early")
	}
	fx = Effects{}
	c.Expire(envAt(f, a, 13*time.Second), &fx)
	if c.Attempts != 2 || fx.Play == nil {
		t.Fatalf("repeat: %+v", c)
	}
	// A key without an item counts as no input: after 2 plays → «no input» (102).
	c.PromptDone(envAt(f, a, 17*time.Second))
	fx = Effects{}
	c.Digit(envAt(f, a, 18*time.Second), '7', &fx)
	if c.Phase != PhaseRing || !slices.Equal(c.Ringing, []uuid.UUID{f.u2}) {
		t.Fatalf("no input route: %+v", c)
	}
}

func TestInboundMenuRepeatHangupAndLoop(t *testing.T) {
	f := newFixture(false, 0).withPrompt()
	m := f.p.Menus[f.menu]
	m.Items['*'] = Target{Kind: RouteRepeat}
	m.Items['5'] = Target{Kind: RouteMenu, ID: ptr(f.menu)} // the menu itself: a loop
	f.p.Menus[f.menu] = m
	a := avail{}
	var c InCall
	var fx Effects
	c.Enter(envAt(f, a, 0), Target{Kind: RouteMenu, ID: ptr(f.menu)}, &fx)
	c.PromptDone(envAt(f, a, 4*time.Second))
	fx = Effects{}
	c.Digit(envAt(f, a, 5*time.Second), '*', &fx)
	if c.Phase != PhaseMenu || c.Attempts != 1 || fx.Play == nil || c.Played {
		t.Fatalf("repeat: %+v", c)
	}
	for i := 0; c.Live() && i < 20; i++ {
		c.PromptDone(envAt(f, a, 10*time.Second))
		fx = Effects{}
		c.Digit(envAt(f, a, 11*time.Second), '5', &fx)
	}
	if c.Phase != PhaseEnded || c.Reason != ReasonLoop {
		t.Fatalf("loop: %+v", c)
	}
	c, fx = InCall{}, Effects{}
	c.Enter(envAt(f, a, 0), Target{Kind: RouteMenu, ID: ptr(f.menu)}, &fx)
	c.PromptDone(envAt(f, a, 4*time.Second))
	fx = Effects{}
	c.Digit(envAt(f, a, 5*time.Second), '0', &fx)
	if fx.Hangup != ReasonHangup {
		t.Fatalf("hang up key: %+v", fx)
	}
}

func TestInboundDeclineRingAllAndRoundRobin(t *testing.T) {
	f := newFixture(false, 0)
	g := f.p.Groups[f.group]
	g.OnFail = Target{Kind: RouteHangup}
	f.p.Groups[f.group] = g
	a := avail{}
	var c InCall
	var fx Effects
	c.Enter(envAt(f, a, 0), Target{Kind: RouteGroup, ID: ptr(f.group)}, &fx)
	for i, u := range []uuid.UUID{f.u1, f.u2, f.u3} {
		fx = Effects{}
		if err := c.Decline(envAt(f, a, time.Second), u, &fx); err != nil {
			t.Fatal(err)
		}
		if i < 2 && c.Phase != PhaseRing {
			t.Fatal("ended early")
		}
	}
	if fx.Hangup != ReasonDeclined {
		t.Fatalf("all declined: %+v", fx)
	}
	if err := c.Decline(envAt(f, a, time.Second), f.u1, &Effects{}); !errors.Is(err, ErrNotRinging) {
		t.Fatal("decline after the end")
	}

	f = newFixture(true, 0)
	c, fx = InCall{}, Effects{}
	c.Enter(envAt(f, a, 0), Target{Kind: RouteGroup, ID: ptr(f.group)}, &fx)
	fx = Effects{}
	_ = c.Decline(envAt(f, a, time.Second), f.u1, &fx)
	if !slices.Equal(c.Ringing, []uuid.UUID{f.u2}) {
		t.Fatalf("round-robin decline: %v", c.Ringing)
	}
}

func TestInboundHangupAndState(t *testing.T) {
	f := newFixture(false, 0)
	var c InCall
	var fx Effects
	c.Enter(envAt(f, avail{}, 0), Target{Kind: RouteGroup, ID: ptr(f.group)}, &fx)
	fx = Effects{}
	c.Hangup(reasonRemote, &fx)
	if c.Live() || fx.Hangup != reasonRemote || len(fx.Stopped) != 3 {
		t.Fatalf("hangup: %+v", fx)
	}
	// The state survives a round trip through Valkey JSON.
	c, fx = InCall{}, Effects{}
	c.Enter(envAt(f, avail{}, 0), Target{Kind: RouteGroup, ID: ptr(f.group)}, &fx)
	b, err := json.Marshal(inRec{ID: uuid.New(), InCall: c})
	if err != nil {
		t.Fatal(err)
	}
	var back inRec
	if err := json.Unmarshal(b, &back); err != nil || back.Phase != PhaseRing || !slices.Equal(back.Ringing, c.Ringing) || back.Group == nil || *back.Group != f.group {
		t.Fatalf("json: %v %+v", err, back)
	}
	if back.Route[0] != "group:"+f.group.String() {
		t.Fatalf("route: %v", back.Route)
	}
}

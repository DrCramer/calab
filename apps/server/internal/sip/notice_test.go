package sip

import (
	"slices"
	"testing"
	"time"

	"github.com/google/uuid"
)

// withNotice gives the fixture's menu a 2 s recording notice (ADR-0131) and a key to itself.
func (f fixture) withNotice() fixture {
	m := f.p.Menus[f.menu]
	m.Notice, m.NoticeMs = uuid.New(), 2000
	m.Items['8'] = Target{Kind: RouteMenu, ID: ptr(f.menu)}
	f.p.Menus[f.menu] = m
	return f
}

// The notice plays after a key that rings somebody, then the ringing starts — on the worker's
// «played» or, when that is lost, on the notice's deadline.
func TestInboundNoticeBeforeRing(t *testing.T) {
	f := newFixture(false, 0).withPrompt().withNotice()
	notice := f.p.Menus[f.menu].Notice
	a := avail{}
	var c InCall
	var fx Effects
	c.Enter(envAt(f, a, 0), Target{Kind: RouteMenu, ID: ptr(f.menu)}, &fx)
	fx = Effects{}
	c.Digit(envAt(f, a, time.Second), '2', &fx) // barge-in on the prompt
	if c.Phase != PhaseMenu || c.Notice == nil || fx.Play == nil || fx.Play.File != notice || fx.Stop || len(fx.Rings) != 0 {
		t.Fatalf("notice: %+v %+v", c, fx)
	}
	if c.Deadline != t0.Add(time.Second+2*time.Second+promptSlack).UnixMilli() || !slices.Contains(c.Route, "notice") {
		t.Fatalf("notice deadline / route: %d %v", c.Deadline, c.Route)
	}
	// Keys while the notice plays are not taken.
	fx = Effects{}
	c.Digit(envAt(f, a, 1500*time.Millisecond), '0', &fx)
	if c.Phase != PhaseMenu || fx.Hangup != "" || fx.Play != nil {
		t.Fatalf("key during the notice: %+v %+v", c, fx)
	}
	// A «played» right after the notice began is the prompt's: ignored.
	fx = Effects{}
	c.WorkerPlayed(envAt(f, a, 1100*time.Millisecond), &fx)
	if c.Notice == nil || len(fx.Rings) != 0 {
		t.Fatalf("stale played: %+v", c)
	}
	b := c
	b.Route = slices.Clone(c.Route)
	fx = Effects{}
	c.WorkerPlayed(envAt(f, a, 3*time.Second), &fx)
	if c.Phase != PhaseRing || c.Notice != nil || !slices.Equal(fx.Rings, []uuid.UUID{f.u1}) || fx.Play == nil || !fx.Play.Ringback {
		t.Fatalf("after the notice: %+v %+v", c, fx)
	}
	// The worker's «played» is lost: the deadline rings.
	fx = Effects{}
	b.Expire(envAt(f, a, 6*time.Second), &fx)
	if b.Phase != PhaseRing || !slices.Equal(fx.Rings, []uuid.UUID{f.u1}) {
		t.Fatalf("notice deadline: %+v %+v", b, fx)
	}
	// A hang-up while the notice plays ends the call.
	var h InCall
	h.Enter(envAt(f, a, 0), Target{Kind: RouteMenu, ID: ptr(f.menu)}, &Effects{})
	h.Digit(envAt(f, a, time.Second), '1', &Effects{})
	fx = Effects{}
	h.Hangup(reasonRemote, &fx)
	if h.Phase != PhaseEnded || fx.Hangup != reasonRemote {
		t.Fatalf("hang-up during the notice: %+v", h)
	}
}

// No notice before another menu or a hang-up, nor without a file; a dialed number gets it.
func TestInboundNoticeOnlyBeforeRinging(t *testing.T) {
	f := newFixture(false, 0).withPrompt().withNotice()
	a := avail{}
	start := func(f fixture) InCall {
		var c InCall
		c.Enter(envAt(f, a, 0), Target{Kind: RouteMenu, ID: ptr(f.menu)}, &Effects{})
		c.PromptDone(envAt(f, a, 4*time.Second))
		return c
	}
	c := start(f)
	var fx Effects
	c.Digit(envAt(f, a, 5*time.Second), '8', &fx) // another menu (here: itself)
	if c.Notice != nil || fx.Play == nil || fx.Play.File != f.p.Menus[f.menu].Prompt {
		t.Fatalf("to a menu: %+v %+v", c, fx)
	}
	c = start(f)
	fx = Effects{}
	c.Digit(envAt(f, a, 5*time.Second), '0', &fx)
	if c.Phase != PhaseEnded || c.Notice != nil {
		t.Fatalf("hang-up key: %+v", c)
	}
	plain := newFixture(false, 0).withPrompt()
	c = start(plain)
	fx = Effects{}
	c.Digit(envAt(plain, a, 5*time.Second), '2', &fx)
	if c.Phase != PhaseRing || c.Notice != nil {
		t.Fatalf("no notice file: %+v", c)
	}
	// Dialing a number (ADR-0129): the notice, then that number rings.
	m := f.p.Menus[f.menu]
	m.DialExtensions = true
	f.p.Menus[f.menu] = m
	x := f.p.Extensions[f.e2]
	x.Number = "102"
	f.p.Extensions[f.e2] = x
	c = start(f)
	for i, d := range []byte("102") {
		fx = Effects{}
		c.Digit(envAt(f, a, 5*time.Second+time.Duration(i)*100*time.Millisecond), d, &fx)
	}
	if c.Notice == nil || c.Notice.Kind != RouteExtension || *c.Notice.ID != f.e2 {
		t.Fatalf("dialed: %+v %+v", c, fx)
	}
	fx = Effects{}
	c.WorkerPlayed(envAt(f, a, 8*time.Second), &fx)
	if !slices.Equal(fx.Rings, []uuid.UUID{f.u2}) {
		t.Fatalf("dialed number rings: %+v", fx)
	}
}

package sip

import (
	"slices"
	"testing"
	"time"

	"github.com/google/uuid"
)

// withNumbers: the fixture's numbers 101..104 and the group's 1001, 103 closed to external
// callers, and dialing on in the menu (keys 1 → group, 2 → 101, 0 → hang up, 9 → deleted).
func (f fixture) withNumbers() fixture {
	for id, n := range map[uuid.UUID]string{f.e1: "101", f.e2: "102", f.e3: "103", f.e4: "104", f.eGroup: "1001"} {
		x := f.p.Extensions[id]
		x.Number = n
		x.NoExternal = id == f.e3
		f.p.Extensions[id] = x
	}
	m := f.p.Menus[f.menu]
	m.DialExtensions = true
	f.p.Menus[f.menu] = m
	return f
}

func TestCollect(t *testing.T) {
	f := newFixture(false, 0).withNumbers()
	m := f.p.Menus[f.menu]
	// 1010 next to 101: a full number that a longer one starts with waits.
	long := newFixture(false, 0).withNumbers()
	e5 := uuid.New()
	long.p.Extensions[e5] = Ext{ID: e5, User: ptr(uuid.New()), Number: "1010"}
	e1 := long.e1
	for _, tc := range []struct {
		name string
		p    *PBX
		buf  string
		end  bool
		want Dial
	}{
		{"empty", f.p, "", true, Dial{Result: DialInvalid}},
		{"key no number starts with: at once", f.p, "2", false, Dial{Result: DialKey, Key: '2'}},
		{"hang-up key: at once", f.p, "0", false, Dial{Result: DialKey, Key: '0'}},
		{"key numbers start with: wait", f.p, "1", false, Dial{Result: DialWait}},
		{"key numbers start with: the pause ran out", f.p, "1", true, Dial{Result: DialKey, Key: '1'}},
		{"neither a key nor a prefix: at once", f.p, "5", false, Dial{Result: DialInvalid}},
		{"prefix", f.p, "10", false, Dial{Result: DialWait}},
		{"prefix, ended", f.p, "10", true, Dial{Result: DialInvalid}},
		{"full number", f.p, "101", false, Dial{Result: DialNumber, Ext: f.e1}},
		{"group number", f.p, "1001", false, Dial{Result: DialNumber, Ext: f.eGroup}},
		{"group prefix", f.p, "100", false, Dial{Result: DialWait}},
		{"group prefix, ended", f.p, "100", true, Dial{Result: DialInvalid}},
		{"unassigned number", f.p, "104", false, Dial{Result: DialInvalid}},
		{"closed to external callers", f.p, "103", false, Dial{Result: DialInvalid}},
		{"closed, ended", f.p, "103", true, Dial{Result: DialInvalid}},
		{"unknown number", f.p, "105", false, Dial{Result: DialInvalid}},
		{"the longest number ends the input", f.p, "100100", false, Dial{Result: DialInvalid}},
		{"a longer number follows: wait", long.p, "101", false, Dial{Result: DialWait}},
		{"a longer number follows, ended", long.p, "101", true, Dial{Result: DialNumber, Ext: e1}},
		{"the longer number", long.p, "1010", false, Dial{Result: DialNumber, Ext: e5}},
	} {
		if got := Collect(&m, tc.p, tc.buf, tc.end); got != tc.want {
			t.Errorf("%s: Collect(%q, %v) = %+v, want %+v", tc.name, tc.buf, tc.end, got, tc.want)
		}
	}
}

func dialMenu(t *testing.T, f fixture) (InCall, avail) {
	t.Helper()
	var c InCall
	var fx Effects
	c.Enter(envAt(f, avail{}, 0), Target{Kind: RouteMenu, ID: ptr(f.menu)}, &fx)
	if c.Phase != PhaseMenu || fx.Play == nil {
		t.Fatalf("menu: %+v", c)
	}
	return c, avail{}
}

func TestDialExtensionDuringPrompt(t *testing.T) {
	f := newFixture(false, 0).withPrompt().withNumbers()
	c, a := dialMenu(t, f)
	// The first digit stops the prompt; a number may follow — wait.
	var fx Effects
	c.Digit(envAt(f, a, time.Second), '1', &fx)
	if !fx.Stop || fx.Play != nil || c.Phase != PhaseMenu || c.Digits != "1" || !c.Played || c.Deadline != t0.Add(4*time.Second).UnixMilli() {
		t.Fatalf("first digit: %+v %+v", c, fx)
	}
	// The worker's late «played» does not move the pause.
	c.PromptDone(envAt(f, a, 1500*time.Millisecond))
	if c.Deadline != t0.Add(4*time.Second).UnixMilli() {
		t.Fatalf("played moved the pause: %+v", c)
	}
	fx = Effects{}
	c.Digit(envAt(f, a, 2*time.Second), '0', &fx)
	if fx.Stop || c.Digits != "10" || c.Deadline != t0.Add(5*time.Second).UnixMilli() {
		t.Fatalf("second digit: %+v %+v", c, fx)
	}
	fx = Effects{}
	c.Digit(envAt(f, a, 3*time.Second), '2', &fx)
	if c.Phase != PhaseRing || !slices.Equal(c.Ringing, []uuid.UUID{f.u2}) || fx.Play == nil || !fx.Play.Ringback || c.Digits != "" {
		t.Fatalf("102: %+v %+v", c, fx)
	}
	if !slices.Contains(c.Route, "dial:102") {
		t.Fatalf("route: %v", c.Route)
	}
}

func TestDialKeyAfterPauseAndAtOnce(t *testing.T) {
	f := newFixture(false, 0).withPrompt().withNumbers()
	// «1» — numbers start with it: the key after the pause (the tick's Expire).
	c, a := dialMenu(t, f)
	var fx Effects
	c.Digit(envAt(f, a, time.Second), '1', &fx)
	fx = Effects{}
	c.Expire(envAt(f, a, 3*time.Second), &fx) // early
	if c.Phase != PhaseMenu || c.Digits != "1" {
		t.Fatalf("early: %+v", c)
	}
	c.Expire(envAt(f, a, 4*time.Second), &fx)
	if c.Phase != PhaseRing || c.Group == nil || len(fx.Rings) != 3 {
		t.Fatalf("key 1 after the pause: %+v %+v", c, fx)
	}
	// «2» — no number starts with it: at once, mid-prompt.
	c, a = dialMenu(t, f)
	fx = Effects{}
	c.Digit(envAt(f, a, time.Second), '2', &fx)
	if c.Phase != PhaseRing || !slices.Equal(c.Ringing, []uuid.UUID{f.u1}) {
		t.Fatalf("key 2: %+v", c)
	}
	// «1 #» — «#» ends the input: the key 1.
	c, a = dialMenu(t, f)
	fx = Effects{}
	c.Digit(envAt(f, a, time.Second), '1', &fx)
	c.Digit(envAt(f, a, 2*time.Second), '#', &fx)
	if c.Phase != PhaseRing || c.Group == nil {
		t.Fatalf("1#: %+v", c)
	}
}

func TestDialNotFoundRepeatsMenu(t *testing.T) {
	f := newFixture(false, 0).withPrompt().withNumbers()
	for _, digits := range []string{"103", "104", "105", "100#", "5"} {
		c, a := dialMenu(t, f)
		var fx Effects
		for i := range len(digits) {
			fx = Effects{}
			c.Digit(envAt(f, a, time.Duration(i+1)*time.Second), digits[i], &fx)
		}
		if c.Phase != PhaseMenu || c.Attempts != 2 || fx.Play == nil || fx.Play.File != f.p.Menus[f.menu].Prompt || c.Digits != "" || c.Played {
			t.Fatalf("%s: %+v %+v", digits, c, fx)
		}
	}
}

func TestDialOffKeyAtOnce(t *testing.T) {
	f := newFixture(false, 0).withPrompt()
	c, a := dialMenu(t, f)
	var fx Effects
	c.Digit(envAt(f, a, time.Second), '1', &fx)
	if c.Phase != PhaseRing || c.Digits != "" {
		t.Fatalf("key without dialing: %+v", c)
	}
	// A key without an item mid-prompt: the menu plays again from the start.
	c, a = dialMenu(t, f)
	fx = Effects{}
	c.Digit(envAt(f, a, time.Second), '7', &fx)
	if c.Phase != PhaseMenu || c.Attempts != 2 || fx.Play == nil {
		t.Fatalf("no item: %+v %+v", c, fx)
	}
}

func TestDigitsBeforeTheEntryPoint(t *testing.T) {
	f := newFixture(false, 0).withPrompt().withNumbers()
	a := avail{}
	c := InCall{Phase: PhaseMenu} // as inboundJoined saves it before Enter
	var fx Effects
	c.Digit(envAt(f, a, 0), '1', &fx)
	c.Digit(envAt(f, a, 0), '0', &fx)
	if c.Phase != PhaseMenu || c.Early != "10" || fx.Hangup != "" {
		t.Fatalf("early: %+v %+v", c, fx)
	}
	fx = Effects{}
	c.Enter(envAt(f, a, time.Second), Target{Kind: RouteMenu, ID: ptr(f.menu)}, &fx)
	if c.Early != "" || c.Digits != "10" || !fx.Stop || fx.Play != nil {
		t.Fatalf("taken by the menu: %+v %+v", c, fx)
	}
	fx = Effects{}
	c.Digit(envAt(f, a, 2*time.Second), '1', &fx)
	if c.Phase != PhaseRing || !slices.Equal(c.Ringing, []uuid.UUID{f.u1}) {
		t.Fatalf("101: %+v", c)
	}
}

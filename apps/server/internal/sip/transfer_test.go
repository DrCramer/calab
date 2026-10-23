package sip

import (
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// answeredBy: a call to 101 that u1 answered at 0 s.
func answeredBy(t *testing.T, f fixture, a Availability) InCall {
	t.Helper()
	var c InCall
	var fx Effects
	c.Enter(envAt(f, a, 0), Target{Kind: RouteExtension, ID: ptr(f.e1)}, &fx)
	if err := c.Answer(envAt(f, a, 0), f.u1, &fx); err != nil {
		t.Fatal(err)
	}
	return c
}

func toExt(id uuid.UUID) TransferTo { return TransferTo{Target: Target{Kind: RouteExtension, ID: &id}} }

func TestTransferAnswered(t *testing.T) {
	f := newFixture(false, 0)
	a := avail{}
	c := answeredBy(t, f, a)
	var fx Effects
	if err := c.Transfer(envAt(f, a, 10*time.Second), toExt(f.e2), &fx); err != nil {
		t.Fatal(err)
	}
	// u2 rings; u1 stays on the call and the caller hears u1, not the ringback.
	if c.Phase != PhaseRing || !c.Transferring() || c.Xfer.From != f.u1 || *c.Answered != f.u1 || fx.Play != nil || fx.Hangup != "" ||
		!slices.Equal(fx.Rings, []uuid.UUID{f.u2}) || !fx.Xfer || !fx.Changed || c.Deadline != t0.Add(40*time.Second).UnixMilli() {
		t.Fatalf("transfer: %+v %+v", c, fx)
	}
	if c.Route[len(c.Route)-1] != "transfer:ext:"+f.e2.String() {
		t.Fatalf("route: %v", c.Route)
	}
	// A second transfer while this one rings is refused.
	if err := c.Transfer(envAt(f, a, 11*time.Second), toExt(f.e3), &Effects{}); !errors.Is(err, ErrTransferring) {
		t.Fatalf("second transfer: %v", err)
	}
	fx = Effects{}
	if err := c.Answer(envAt(f, a, 15*time.Second), f.u2, &fx); err != nil {
		t.Fatal(err)
	}
	if c.Phase != PhaseActive || *c.Answered != f.u2 || c.Transferring() || fx.Released == nil || *fx.Released != f.u1 || !fx.Answered || c.Deadline != 0 {
		t.Fatalf("answered: %+v %+v", c, fx)
	}
	// The call can be handed on again by its new owner.
	fx = Effects{}
	if err := c.Transfer(envAt(f, a, 20*time.Second), toExt(f.e1), &fx); err != nil || !slices.Equal(fx.Rings, []uuid.UUID{f.u1}) {
		t.Fatalf("transfer back: %v %+v", err, fx)
	}
}

func TestTransferNoAnswerReturns(t *testing.T) {
	f := newFixture(false, 0)
	a := avail{}
	c := answeredBy(t, f, a)
	var fx Effects
	if err := c.Transfer(envAt(f, a, 10*time.Second), toExt(f.e2), &fx); err != nil {
		t.Fatal(err)
	}
	fx = Effects{}
	c.Expire(envAt(f, a, 39*time.Second), &fx)
	if c.Phase != PhaseRing || len(fx.Stopped) != 0 {
		t.Fatalf("before 30 s: %+v %+v", c, fx)
	}
	c.Expire(envAt(f, a, 40*time.Second), &fx)
	if c.Phase != PhaseActive || *c.Answered != f.u1 || c.Transferring() || fx.Hangup != "" || !fx.Xfer || fx.Released != nil ||
		!slices.Equal(fx.Stopped, []uuid.UUID{f.u2}) || c.Deadline != 0 || len(c.Ringing) != 0 {
		t.Fatalf("returned: %+v %+v", c, fx)
	}
	if c.Route[len(c.Route)-1] != "transfer:no_answer" {
		t.Fatalf("route: %v", c.Route)
	}
	// The target declining returns the call at once.
	fx = Effects{}
	if err := c.Transfer(envAt(f, a, 50*time.Second), toExt(f.e2), &fx); err != nil {
		t.Fatal(err)
	}
	fx = Effects{}
	if err := c.Decline(envAt(f, a, 52*time.Second), f.u2, &fx); err != nil {
		t.Fatal(err)
	}
	if c.Phase != PhaseActive || *c.Answered != f.u1 || fx.Hangup != "" || c.Route[len(c.Route)-1] != "transfer:declined" {
		t.Fatalf("declined: %+v %+v", c, fx)
	}
}

func TestTransferCancel(t *testing.T) {
	f := newFixture(false, 0)
	a := avail{}
	c := answeredBy(t, f, a)
	if err := c.CancelTransfer(envAt(f, a, time.Second), &Effects{}); !errors.Is(err, ErrNoTransfer) {
		t.Fatalf("cancel without a transfer: %v", err)
	}
	var fx Effects
	if err := c.Transfer(envAt(f, a, 10*time.Second), toExt(f.e2), &fx); err != nil {
		t.Fatal(err)
	}
	fx = Effects{}
	if err := c.CancelTransfer(envAt(f, a, 12*time.Second), &fx); err != nil {
		t.Fatal(err)
	}
	if c.Phase != PhaseActive || *c.Answered != f.u1 || !slices.Equal(fx.Stopped, []uuid.UUID{f.u2}) || c.Route[len(c.Route)-1] != "transfer:cancelled" {
		t.Fatalf("cancelled: %+v %+v", c, fx)
	}
	// The target is too late.
	if err := c.Answer(envAt(f, a, 13*time.Second), f.u2, &Effects{}); !errors.Is(err, ErrNotRinging) {
		t.Fatalf("late answer: %v", err)
	}
}

func TestTransferRefused(t *testing.T) {
	f := newFixture(false, 0)
	a := avail{busy: set(f.u2)}
	// Not answered yet.
	var ringing InCall
	ringing.Enter(envAt(f, a, 0), Target{Kind: RouteExtension, ID: ptr(f.e1)}, &Effects{})
	if err := ringing.Transfer(envAt(f, a, 0), toExt(f.e3), &Effects{}); !errors.Is(err, ErrNotAnswered) {
		t.Fatalf("ringing: %v", err)
	}
	c := answeredBy(t, f, a)
	before, _ := json.Marshal(c)
	var te *TransferError
	cases := []struct {
		name   string
		to     TransferTo
		reason string
		err    error
	}{
		{"busy", toExt(f.e2), ReasonBusy, nil},
		{"busy without a number", TransferTo{User: ptr(f.u2)}, ReasonBusy, nil},
		{"nobody behind the number", toExt(f.e4), ReasonNoMembers, nil},
		{"deleted", TransferTo{Target: Target{Kind: RouteExtension}}, ReasonHangup, nil},
		{"self", toExt(f.e1), "", ErrTransferSelf},
		{"self without a number", TransferTo{User: ptr(f.u1)}, "", ErrTransferSelf},
	}
	for _, tc := range cases {
		var fx Effects
		err := c.Transfer(envAt(f, a, time.Second), tc.to, &fx)
		switch {
		case tc.err != nil && !errors.Is(err, tc.err):
			t.Fatalf("%s: %v", tc.name, err)
		case tc.err == nil && (!errors.As(err, &te) || te.Reason != tc.reason):
			t.Fatalf("%s: %v", tc.name, err)
		}
		if after, _ := json.Marshal(c); string(after) != string(before) || len(fx.Rings) != 0 || fx.Changed {
			t.Fatalf("%s changed the call: %s %+v", tc.name, after, fx)
		}
	}
	// A group whose only free member is the one on the call: nobody to ring.
	b := avail{busy: set(f.u2, f.u3)}
	if err := c.Transfer(envAt(f, b, time.Second), toExt(f.eGroup), &Effects{}); !errors.As(err, &te) || te.Reason != ReasonBusy {
		t.Fatalf("group of one: %v", err)
	}
	// The hop limit (a call routed MaxHops times).
	c.Hops = MaxHops
	if err := c.Transfer(envAt(f, avail{}, time.Second), toExt(f.e3), &Effects{}); !errors.As(err, &te) || te.Reason != ReasonLoop {
		t.Fatalf("hops: %v", err)
	}
}

func TestTransferToGroup(t *testing.T) {
	f := newFixture(false, 0) // the group's fallback: 30 s to 101
	g := f.p.Groups[f.group]
	g.FallbackSec = 20
	f.p.Groups[f.group] = g
	a := avail{}
	c := answeredBy(t, f, a)
	var fx Effects
	if err := c.Transfer(envAt(f, a, 10*time.Second), toExt(f.eGroup), &fx); err != nil {
		t.Fatal(err)
	}
	// Every member but the one on the call rings; the transfer gives up after the group's 20 s.
	if !slices.Equal(fx.Rings, []uuid.UUID{f.u2, f.u3}) || c.FallbackAt != t0.Add(30*time.Second).UnixMilli() || c.Group == nil {
		t.Fatalf("group: %+v %+v", c, fx)
	}
	// Both decline: back with u1, the group's fallback (to 101) is not followed.
	fx = Effects{}
	if err := c.Decline(envAt(f, a, 12*time.Second), f.u2, &fx); err != nil {
		t.Fatal(err)
	}
	if err := c.Decline(envAt(f, a, 13*time.Second), f.u3, &fx); err != nil {
		t.Fatal(err)
	}
	if c.Phase != PhaseActive || *c.Answered != f.u1 || fx.Hangup != "" || len(fx.Rings) != 0 || !strings.HasPrefix(c.Route[len(c.Route)-1], "transfer:") {
		t.Fatalf("declined: %+v %+v", c, fx)
	}
	// Round-robin: one member at a time, never the one on the call.
	f = newFixture(true, 0)
	c = answeredBy(t, f, a)
	fx = Effects{}
	if err := c.Transfer(envAt(f, a, 10*time.Second), toExt(f.eGroup), &fx); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(fx.Rings, []uuid.UUID{f.u2}) {
		t.Fatalf("round-robin: %+v", fx)
	}
	for i, want := range []uuid.UUID{f.u3, f.u2} {
		fx = Effects{}
		c.Expire(envAt(f, a, 10*time.Second+time.Duration(i+1)*15*time.Second), &fx)
		if i == 1 {
			// 40 s: the transfer's 30 s are over before u2's second turn.
			if c.Phase != PhaseActive || *c.Answered != f.u1 {
				t.Fatalf("round-robin over: %+v", c)
			}
			continue
		}
		if !slices.Equal(c.Ringing, []uuid.UUID{want}) {
			t.Fatalf("round-robin step %d: %v", i, c.Ringing)
		}
	}
}

func TestTransferMemberWithoutNumberAndHangup(t *testing.T) {
	f := newFixture(false, 0)
	a := avail{}
	c := answeredBy(t, f, a)
	u4 := uuid.New()
	var fx Effects
	if err := c.Transfer(envAt(f, a, 10*time.Second), TransferTo{User: &u4}, &fx); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(fx.Rings, []uuid.UUID{u4}) || c.Route[len(c.Route)-1] != "transfer:user:"+u4.String() {
		t.Fatalf("member: %+v %+v", c, fx)
	}
	// The state survives Valkey.
	raw, _ := json.Marshal(c)
	var back InCall
	if err := json.Unmarshal(raw, &back); err != nil || back.Xfer == nil || back.Xfer.From != f.u1 {
		t.Fatalf("json: %s %v", raw, err)
	}
	// The caller hangs up while it rings: the target stops ringing, the call ends.
	fx = Effects{}
	c.Hangup(reasonForTest, &fx)
	if c.Phase != PhaseEnded || c.Transferring() || !slices.Equal(fx.Stopped, []uuid.UUID{u4}) || fx.Hangup != reasonForTest {
		t.Fatalf("hangup: %+v %+v", c, fx)
	}
}

const reasonForTest = "remote"

// A group with nobody free whose fallback leads to somebody else: a transfer does not follow it
// (ADR-0132 §1) — the target chosen is busy.
func TestTransferGroupFallbackNotFollowed(t *testing.T) {
	f := newFixture(false, 0)
	u5, e5 := uuid.New(), uuid.New()
	f.p.Extensions[e5] = Ext{ID: e5, User: &u5}
	g := f.p.Groups[f.group]
	g.OnFail = Target{Kind: RouteExtension, ID: &e5}
	f.p.Groups[f.group] = g
	c := answeredBy(t, f, avail{})
	var fx Effects
	var te *TransferError
	err := c.Transfer(envAt(f, avail{busy: set(f.u1, f.u2, f.u3)}, time.Second), toExt(f.eGroup), &fx)
	if !errors.As(err, &te) || te.Reason != ReasonBusy || len(fx.Rings) != 0 || c.Transferring() {
		t.Fatalf("fallback followed: %v %+v", err, fx)
	}
}

// A transfer nobody took gives its hops back: cancelling and trying again never reaches MaxHops.
func TestTransferHopsGivenBack(t *testing.T) {
	f := newFixture(false, 0)
	a := avail{}
	c := answeredBy(t, f, a)
	hops := c.Hops
	for i := range 2 * MaxHops {
		at := time.Duration(i) * time.Second
		if err := c.Transfer(envAt(f, a, at), toExt(f.e2), &Effects{}); err != nil {
			t.Fatalf("transfer %d: %v", i, err)
		}
		if err := c.CancelTransfer(envAt(f, a, at), &Effects{}); err != nil {
			t.Fatal(err)
		}
	}
	if c.Hops != hops {
		t.Fatalf("hops %d, want %d", c.Hops, hops)
	}
	// An answered transfer keeps them.
	if err := c.Transfer(envAt(f, a, time.Minute), toExt(f.e2), &Effects{}); err != nil {
		t.Fatal(err)
	}
	if err := c.Answer(envAt(f, a, time.Minute), f.u2, &Effects{}); err != nil || c.Hops != hops+1 {
		t.Fatalf("answered: %v %d", err, c.Hops)
	}
}

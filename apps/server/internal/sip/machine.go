package sip

import (
	"errors"
	"slices"
	"time"

	"github.com/google/uuid"
)

// The inbound call state machine (ADR-0117 §4), step 2: what happens to a call on each event —
// the entry point, a key, the worker's «prompt played», a deadline, a decline, an accept. Pure:
// the state (InCall, kept in Valkey between events) and the exchange go in, the new state and
// the Effects to carry out (play, ring, stop ringing, hang up, move the round-robin pointer)
// come out; inbound.go does the I/O. So every branch is a unit test.

// Phase of an inbound call.
type Phase string

// Phases.
const (
	PhaseMenu   Phase = "menu"   // a menu plays / waits for a key
	PhaseRing   Phase = "ring"   // people's devices ring (the caller hears the ringback)
	PhaseActive Phase = "active" // answered
	PhaseEnded  Phase = "ended"
)

// More hang-up reasons of the machine (SipCall.reason).
const (
	ReasonNoInput  = "no_input"  // nobody pressed a key: the menu's «no input» is «hang up»
	ReasonNoAnswer = "no_answer" // nobody answered: the fallback is «hang up»
	ReasonDeclined = "declined"  // everybody who rang declined
)

// promptSlack: how long past the prompt's end a menu still waits when the worker's «played» is
// lost (a deadline from the prompt's duration alone).
const promptSlack = 3 * time.Second

// InCall is the state of one inbound call between events.
type InCall struct {
	Phase Phase `json:"phase"`
	Hops  int   `json:"hops"` // routes followed (MaxHops: a loop hangs up)
	// Menu: the menu, its play count, whether the prompt finished (keys count only then: no
	// barge-in, the owner's default 6) and when it ends by its duration (ms).
	Menu       *uuid.UUID `json:"menu,omitempty"`
	Attempts   int        `json:"attempts,omitempty"`
	Played     bool       `json:"played,omitempty"`
	PromptEnds int64      `json:"prompt_ends,omitempty"`
	// Ring: who may ring in order (round-robin: one after another from Pos; else all at once),
	// the group, where to go when nobody answers, who rings now and who rang so far.
	Ring       []Ring      `json:"ring,omitempty"`
	Pos        int         `json:"pos,omitempty"`
	Sequential bool        `json:"seq,omitempty"`
	Group      *uuid.UUID  `json:"group,omitempty"`
	OnFail     Target      `json:"on_fail"`
	Ringing    []uuid.UUID `json:"ringing,omitempty"`
	Rang       []Ring      `json:"rang,omitempty"`
	Deadline   int64       `json:"deadline,omitempty"` // ms; 0 = none
	Route      []string    `json:"route,omitempty"`
	Via        string      `json:"via,omitempty"`
	Answered   *uuid.UUID  `json:"answered,omitempty"`
	Reason     string      `json:"reason,omitempty"`
}

// Effects of one transition.
type Effects struct {
	Play     *Play       // start playing (replaces what plays)
	Stop     bool        // stop playing (answered)
	Rings    []uuid.UUID // started ringing: SIP_INBOUND_RING
	Stopped  []uuid.UUID // stopped ringing
	Hangup   string      // the call ends with this reason
	Answered bool        // the call was answered (InCall.Answered)
	Advance  *Advance    // move a round-robin pointer
	Changed  bool        // ringing / route / via changed: update the journal row
}

// Play is what the worker plays: a prompt file, or the ringback in a loop.
type Play struct {
	File     uuid.UUID
	Ringback bool
}

// Advance is a group's new round-robin pointer.
type Advance struct {
	Group    uuid.UUID
	Position int
}

// Env is what a transition sees: the exchange now, who can take a call, the time.
type Env struct {
	PBX   *PBX
	Avail Availability
	Now   time.Time
}

func (e Env) ms(d time.Duration) int64 { return e.Now.Add(d).UnixMilli() }

// ErrNotRinging means the user is not among those the call rings now.
var ErrNotRinging = errors.New("sip: the call does not ring this user")

// Live reports a call that is not over.
func (c *InCall) Live() bool { return c.Phase != PhaseEnded && c.Phase != "" }

// Enter follows route t (the entry point, a key, a fallback).
func (c *InCall) Enter(e Env, t Target, fx *Effects) {
	c.stopRinging(fx)
	d := Route(e.PBX, t, e.Avail, DirectRingSec)
	c.Hops += d.Hops + 1
	c.step(routeLabel(t))
	if c.Hops > MaxHops {
		c.hangup(ReasonLoop, fx)
		return
	}
	switch d.Action {
	case ActMenu:
		c.playMenu(e, d.Menu, 1, fx)
	case ActRing:
		c.ring(e, d, fx)
	default:
		c.hangup(d.Reason, fx)
	}
}

func routeLabel(t Target) string {
	id := ""
	if t.ID != nil {
		id = ":" + t.ID.String()
	}
	switch t.Kind {
	case RouteMenu:
		return "menu" + id
	case RouteExtension:
		return "ext" + id
	case RouteGroup:
		return "group" + id
	case RouteRepeat:
		return "repeat"
	default:
		return "hangup"
	}
}

func (c *InCall) step(label string) {
	c.Route = append(c.Route, label)
}

func (c *InCall) playMenu(e Env, m *Menu, attempt int, fx *Effects) {
	id := m.ID
	c.Phase, c.Menu, c.Attempts, c.Played = PhaseMenu, &id, attempt, false
	c.Ring, c.Pos, c.Sequential, c.Group, c.Rang = nil, 0, false, nil, nil
	c.PromptEnds = e.ms(time.Duration(m.PromptMs) * time.Millisecond)
	c.Deadline = c.PromptEnds + (time.Duration(m.InputTimeoutSec)*time.Second + promptSlack).Milliseconds()
	if m.Name != "" && c.Via != m.Name {
		c.Via, fx.Changed = m.Name, true
	}
	fx.Play = &Play{File: m.Prompt}
	fx.Changed = true
}

func (c *InCall) ring(e Env, d Decision, fx *Effects) {
	c.Phase, c.Menu, c.Attempts, c.Played, c.PromptEnds = PhaseRing, nil, 0, false, 0
	c.Ring, c.Sequential, c.Group, c.OnFail, c.Pos, c.Rang = d.Ring, d.Sequential, d.Group, d.OnFail, 0, nil
	if d.Group != nil {
		if g, ok := e.PBX.Groups[*d.Group]; ok && g.Name != "" {
			c.Via = g.Name
		}
	}
	fx.Play = &Play{Ringback: true}
	fx.Changed = true
	if c.Sequential {
		c.ringAt(e, 0, fx)
		return
	}
	for _, r := range c.Ring {
		c.Ringing = append(c.Ringing, r.User)
		fx.Rings = append(fx.Rings, r.User)
	}
	c.Rang = append(c.Rang, c.Ring...)
	c.Deadline = e.ms(time.Duration(c.Ring[0].Sec) * time.Second)
}

// ringAt rings the round-robin member at position i or the next one still available (Route
// checked them when the call came; somebody may have taken another call since).
func (c *InCall) ringAt(e Env, i int, fx *Effects) {
	c.stopRinging(fx)
	for ; i < len(c.Ring); i++ {
		r := c.Ring[i]
		if i > 0 && (e.Avail.Busy(r.User) || !e.Avail.Online(r.User)) {
			continue
		}
		c.Pos = i
		c.Ringing = []uuid.UUID{r.User}
		c.Rang = append(c.Rang, r)
		c.Deadline = e.ms(time.Duration(r.Sec) * time.Second)
		fx.Rings = append(fx.Rings, r.User)
		fx.Changed = true
		return
	}
	c.failRing(e, ReasonNoAnswer, fx)
}

// failRing: nobody answered — the round-robin pointer moves on by one, then the fallback.
func (c *InCall) failRing(e Env, reason string, fx *Effects) {
	c.stopRinging(fx)
	if c.Sequential && c.Group != nil {
		if g, ok := e.PBX.Groups[*c.Group]; ok {
			if pos, ok := NextPosition(g, nil, c.Rang); ok {
				fx.Advance = &Advance{Group: g.ID, Position: pos}
			}
		}
	}
	if c.OnFail.Kind == RouteHangup || c.OnFail.Kind == RouteRepeat {
		c.hangup(reason, fx)
		return
	}
	c.Enter(e, c.OnFail, fx)
}

func (c *InCall) stopRinging(fx *Effects) {
	if len(c.Ringing) > 0 {
		fx.Stopped = append(fx.Stopped, c.Ringing...)
		fx.Changed = true
	}
	c.Ringing = nil
}

func (c *InCall) hangup(reason string, fx *Effects) {
	c.stopRinging(fx)
	c.Phase, c.Reason, c.Deadline = PhaseEnded, reason, 0
	fx.Hangup = reason
	fx.Play = nil
}

// Hangup ends the call from outside (the caller hung up, a member hung up, a sweep).
func (c *InCall) Hangup(reason string, fx *Effects) {
	if c.Live() {
		c.hangup(reason, fx)
	}
}

// Expire runs when the deadline passed: the menu got no key in time, or the ringing ran out (the deadline passed).
func (c *InCall) Expire(e Env, fx *Effects) {
	if c.Deadline == 0 || e.Now.UnixMilli() < c.Deadline {
		return
	}
	switch c.Phase {
	case PhaseMenu:
		c.noInput(e, fx)
	case PhaseRing:
		if c.Sequential {
			c.ringAt(e, c.Pos+1, fx)
		} else {
			c.failRing(e, ReasonNoAnswer, fx)
		}
	}
}

func (c *InCall) menu(e Env) (*Menu, bool) {
	if c.Menu == nil {
		return nil, false
	}
	m, ok := e.PBX.Menus[*c.Menu]
	if !ok || !m.HasPrompt {
		return nil, false
	}
	return &m, true
}

// noInput: no key (or a key without an item) — the menu plays again, after `repeats` plays
// its «no input» route follows.
func (c *InCall) noInput(e Env, fx *Effects) {
	m, ok := c.menu(e)
	if !ok { // the menu was deleted (or lost its prompt) meanwhile
		c.hangup(ReasonHangup, fx)
		return
	}
	if c.Attempts < m.Repeats {
		c.playMenu(e, m, c.Attempts+1, fx)
		return
	}
	if m.OnNoInput.Kind == RouteHangup || m.OnNoInput.Kind == RouteRepeat {
		c.hangup(ReasonNoInput, fx)
		return
	}
	c.Enter(e, m.OnNoInput, fx)
}

// promptDone: the worker finished the prompt; the wait for a key starts.
func (c *InCall) promptDone(e Env, m *Menu) {
	if c.Phase != PhaseMenu || c.Played {
		return
	}
	c.Played = true
	timeout := 5
	if m != nil {
		timeout = m.InputTimeoutSec
	}
	c.Deadline = e.ms(time.Duration(timeout) * time.Second)
}

// PromptDone records that the worker reports the prompt of the current menu played to its end.
func (c *InCall) PromptDone(e Env) {
	m, _ := c.menu(e)
	c.promptDone(e, m)
}

// Digit is a key the caller pressed. While the prompt plays it does not count (no barge-in).
func (c *InCall) Digit(e Env, digit byte, fx *Effects) {
	if c.Phase != PhaseMenu {
		return
	}
	if !c.Played && e.Now.UnixMilli() < c.PromptEnds {
		return
	}
	m, ok := c.menu(e)
	if !ok {
		c.hangup(ReasonHangup, fx)
		return
	}
	t, ok := Press(m, digit)
	if !ok {
		c.noInput(e, fx) // a key without an item counts as no input
		return
	}
	c.Route = append(c.Route, "key:"+string(digit))
	if t.Kind == RouteRepeat {
		c.Hops++
		if c.Hops > MaxHops {
			c.hangup(ReasonLoop, fx)
			return
		}
		c.playMenu(e, m, c.Attempts, fx)
		return
	}
	c.Enter(e, t, fx)
}

// Decline records that user refuses on one of their devices. All at once: when nobody is left ringing the
// call goes on as if nobody answered; round-robin: the next member rings.
func (c *InCall) Decline(e Env, user uuid.UUID, fx *Effects) error {
	if c.Phase != PhaseRing || !slices.Contains(c.Ringing, user) {
		return ErrNotRinging
	}
	if c.Sequential {
		c.ringAt(e, c.Pos+1, fx)
		return nil
	}
	c.Ringing = slices.DeleteFunc(c.Ringing, func(u uuid.UUID) bool { return u == user })
	fx.Stopped = append(fx.Stopped, user)
	fx.Changed = true
	if len(c.Ringing) == 0 {
		c.failRing(e, ReasonDeclined, fx)
	}
	return nil
}

// Answer gives the call to user. The others stop ringing; a round-robin group's pointer moves
// past the member who answered.
func (c *InCall) Answer(e Env, user uuid.UUID, fx *Effects) error {
	if c.Phase != PhaseRing || !slices.Contains(c.Ringing, user) {
		return ErrNotRinging
	}
	for _, u := range c.Ringing {
		if u != user {
			fx.Stopped = append(fx.Stopped, u)
		}
	}
	c.Ringing = nil
	if c.Sequential && c.Group != nil {
		if g, ok := e.PBX.Groups[*c.Group]; ok {
			for _, r := range c.Ring {
				if r.User == user {
					ext := r.Extension
					if pos, ok := NextPosition(g, &ext, c.Rang); ok {
						fx.Advance = &Advance{Group: g.ID, Position: pos}
					}
					break
				}
			}
		}
	}
	u := user
	c.Phase, c.Answered, c.Deadline = PhaseActive, &u, 0
	fx.Stop, fx.Answered, fx.Changed = true, true, true
	return nil
}

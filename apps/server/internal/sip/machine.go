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

// ringRecheck: how often a group that rings all at once (or waits for somebody free) looks
// for members who became free (ADR-0124: a group rings until somebody answers).
const ringRecheck = 15 * time.Second

// InCall is the state of one inbound call between events.
type InCall struct {
	Phase Phase `json:"phase"`
	Hops  int   `json:"hops"` // routes followed (MaxHops: a loop hangs up)
	// Menu: the menu, its play count, whether the prompt finished (or a key cut it short:
	// barge-in, ADR-0129) and when it ends by its duration (ms). Digits: a number being dialed
	// (Menu.DialExtensions), waiting InterDigit for the next digit; Early: digits pressed before
	// the entry point was entered (a menu takes them as pressed in it).
	Menu       *uuid.UUID `json:"menu,omitempty"`
	Attempts   int        `json:"attempts,omitempty"`
	Played     bool       `json:"played,omitempty"`
	PromptEnds int64      `json:"prompt_ends,omitempty"`
	Digits     string     `json:"digits,omitempty"`
	Early      string     `json:"early,omitempty"`
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
	// The group's fallback (ADR-0124): when it follows (ms; 0 = never — the group rings until
	// an answer), the group fallbacks this call followed (MaxFallbacks), and who declined the
	// group's call (not rung again).
	FallbackAt int64       `json:"fallback_at,omitempty"`
	Fallbacks  int         `json:"fallbacks,omitempty"`
	Declined   []uuid.UUID `json:"declined,omitempty"`
	// The recording notice of the menu (ADR-0131) plays: Notice is where the call goes once it
	// ends (the phase stays «menu»; keys are not taken meanwhile), NoticeAt when it began (ms).
	Notice   *Target `json:"notice,omitempty"`
	NoticeAt int64   `json:"notice_at,omitempty"`
	// A transfer of the answered call rings (ADR-0132, transfer.go): Phase is ring, Answered the
	// member still on the call.
	Xfer *Xfer `json:"xfer,omitempty"`
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
	// A transfer (ADR-0132) started or ended; Released: its target answered, the member who
	// handed the call over leaves it.
	Xfer     bool
	Released *uuid.UUID
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
	c.Fallbacks += d.Fallbacks
	c.step(routeLabel(t))
	if c.Hops > MaxHops || c.Fallbacks > MaxFallbacks {
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
	if early := c.Early; early != "" {
		c.Early = ""
		for i := 0; i < len(early) && c.Phase == PhaseMenu; i++ {
			c.Digit(e, early[i], fx)
		}
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
	c.Notice, c.NoticeAt = nil, 0
	c.Phase, c.Menu, c.Attempts, c.Played, c.Digits = PhaseMenu, &id, attempt, false, ""
	c.Ring, c.Pos, c.Sequential, c.Group, c.Rang = nil, 0, false, nil, nil
	c.FallbackAt, c.Declined = 0, nil
	c.PromptEnds = e.ms(time.Duration(m.PromptMs) * time.Millisecond)
	c.Deadline = c.PromptEnds + (time.Duration(m.InputTimeoutSec)*time.Second + promptSlack).Milliseconds()
	if m.Name != "" && c.Via != m.Name {
		c.Via, fx.Changed = m.Name, true
	}
	fx.Play = &Play{File: m.Prompt}
	fx.Changed = true
}

func (c *InCall) ring(e Env, d Decision, fx *Effects) {
	c.Phase, c.Menu, c.Attempts, c.Played, c.PromptEnds, c.Digits = PhaseRing, nil, 0, false, 0, ""
	c.Ring, c.Sequential, c.Group, c.OnFail, c.Pos, c.Rang = d.Ring, d.Sequential, d.Group, d.OnFail, 0, nil
	c.FallbackAt, c.Declined = 0, nil
	if d.FallbackSec > 0 {
		c.FallbackAt = e.ms(time.Duration(d.FallbackSec) * time.Second)
	}
	if d.Group != nil {
		if g, ok := e.PBX.Groups[*d.Group]; ok && g.Name != "" {
			c.Via = g.Name
		}
	}
	fx.Play = &Play{Ringback: true}
	fx.Changed = true
	switch {
	case c.Sequential:
		c.ringAt(e, 0, fx)
	case c.Group != nil:
		c.ringAll(e, fx)
	default: // a single number
		r := c.Ring[0]
		c.Ringing = append(c.Ringing, r.User)
		fx.Rings = append(fx.Rings, r.User)
		c.addRang(r)
		c.Deadline = e.ms(time.Duration(r.Sec) * time.Second)
	}
}

// until is the deadline d from now, not past the group's fallback.
func (c *InCall) until(e Env, d time.Duration) int64 {
	t := e.ms(d)
	if c.FallbackAt > 0 && c.FallbackAt < t {
		return c.FallbackAt
	}
	return t
}

// addRang records that r rang (once per person: a group rings round after round).
func (c *InCall) addRang(r Ring) {
	if !slices.ContainsFunc(c.Rang, func(x Ring) bool { return x.User == r.User }) {
		c.Rang = append(c.Rang, r)
	}
}

func (c *InCall) group(e Env) (Group, bool) {
	if c.Group == nil {
		return Group{}, false
	}
	g, ok := e.PBX.Groups[*c.Group]
	return g, ok
}

// fresh is who the group may ring now: available, and not among those who declined.
func (c *InCall) fresh(e Env, g Group) []Ring {
	return slices.DeleteFunc(groupRing(e.PBX, g, e.Avail), func(r Ring) bool { return slices.Contains(c.Declined, r.User) })
}

// ringAll rings every member of the group (all at once) who is free now and not ringing yet.
func (c *InCall) ringAll(e Env, fx *Effects) {
	g, ok := c.group(e)
	if !ok { // the group was deleted meanwhile
		c.failRing(e, ReasonNoAnswer, fx)
		return
	}
	for _, r := range c.fresh(e, g) {
		if slices.Contains(c.Ringing, r.User) {
			continue
		}
		c.Ringing = append(c.Ringing, r.User)
		fx.Rings = append(fx.Rings, r.User)
		fx.Changed = true
		c.addRang(r)
	}
	if len(c.Ringing) == 0 {
		c.nobody(e, g, fx)
		return
	}
	c.Deadline = c.until(e, ringRecheck)
}

// ringAt rings the round-robin member at position i or the next one still available (Route
// checked them when the call came; somebody may have taken another call since). Past the end
// of the circle the group starts the next round with who is available then.
func (c *InCall) ringAt(e Env, i int, fx *Effects) {
	c.stopRinging(fx)
	for round := 0; round < 2; round++ {
		for ; i < len(c.Ring); i++ {
			r := c.Ring[i]
			if slices.Contains(c.Declined, r.User) || (i > 0 && round == 0 && (e.Avail.Busy(r.User) || !e.Avail.Online(r.User))) {
				continue
			}
			c.Pos = i
			c.Ringing = []uuid.UUID{r.User}
			c.addRang(r)
			c.Deadline = c.until(e, time.Duration(r.Sec)*time.Second)
			fx.Rings = append(fx.Rings, r.User)
			fx.Changed = true
			return
		}
		if round > 0 {
			break
		}
		g, ok := c.group(e)
		if !ok {
			c.failRing(e, ReasonNoAnswer, fx)
			return
		}
		c.Ring, i = c.fresh(e, g), 0 // the next round (fresh checked who is available)
	}
	c.Pos = 0
	g, _ := c.group(e)
	c.nobody(e, g, fx)
}

// nobody: the group has nobody to ring right now. With a fallback it follows at once; without
// one the caller hears the ringback while somebody may still become free, else the call ends.
func (c *InCall) nobody(e Env, g Group, fx *Effects) {
	may := false
	for _, m := range g.Members {
		if x, ok := e.PBX.Extensions[m.Extension]; ok && x.User != nil && !slices.Contains(c.Declined, *x.User) {
			may = true
			break
		}
	}
	reason := ReasonNoAnswer
	switch {
	case !may && len(c.Declined) > 0:
		reason = ReasonDeclined
	case !may:
		reason = ReasonNoMembers
	}
	if c.FallbackAt > 0 || !may {
		c.failRing(e, reason, fx)
		return
	}
	c.Deadline = c.until(e, ringRecheck)
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
	if c.Xfer != nil { // a transfer nobody took: the call stays with the member (ADR-0132)
		c.transferBack(e, reason, fx)
		return
	}
	if c.OnFail.Kind == RouteHangup || c.OnFail.Kind == RouteRepeat {
		c.hangup(reason, fx)
		return
	}
	if c.Group != nil { // a group's fallback (ADR-0124): A → B → A … ends after MaxFallbacks
		c.Fallbacks++
		if c.Fallbacks > MaxFallbacks {
			c.step(routeLabel(c.OnFail))
			c.hangup(ReasonLoop, fx)
			return
		}
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
	c.Phase, c.Reason, c.Deadline, c.Xfer = PhaseEnded, reason, 0, nil
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
		if c.Notice != nil { // the notice's «played» was lost: its duration is over
			c.afterNotice(e, fx)
			return
		}
		if c.Digits != "" { // the pause after a digit of a number ran out
			if m, ok := c.menu(e); ok {
				c.dial(e, m, c.Digits, Collect(m, e.PBX, c.Digits, true), fx)
				return
			}
		}
		c.noInput(e, fx)
	case PhaseRing:
		switch {
		case c.FallbackAt > 0 && e.Now.UnixMilli() >= c.FallbackAt:
			c.failRing(e, ReasonNoAnswer, fx)
		case c.Sequential:
			c.ringAt(e, c.Pos+1, fx)
		case c.Group != nil:
			c.ringAll(e, fx)
		default:
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

// noticeStale: a «played» this soon after the notice began is the menu prompt's, which ended
// just as the notice replaced it.
const noticeStale = 300 * time.Millisecond

// WorkerPlayed is the worker's «played»: the menu's prompt (the wait for a key starts) or the
// recording notice (the call goes where the key led).
func (c *InCall) WorkerPlayed(e Env, fx *Effects) {
	if c.Phase == PhaseMenu && c.Notice != nil {
		if e.Now.UnixMilli()-c.NoticeAt >= noticeStale.Milliseconds() {
			c.afterNotice(e, fx)
		}
		return
	}
	c.PromptDone(e)
}

// noticeFirst plays the menu's recording notice (ADR-0131) before t when t rings somebody (a
// person, a bot, a group — not another menu or a hang-up); false = no notice, enter t now.
func (c *InCall) noticeFirst(e Env, m *Menu, t Target, fx *Effects) bool {
	if m.Notice == uuid.Nil || Route(e.PBX, t, e.Avail, DirectRingSec).Action != ActRing {
		return false
	}
	pending := t
	c.Notice, c.NoticeAt, c.Digits, c.Played = &pending, e.Now.UnixMilli(), "", true
	c.Deadline = e.ms(time.Duration(m.NoticeMs)*time.Millisecond + promptSlack)
	c.step("notice")
	fx.Play, fx.Stop, fx.Changed = &Play{File: m.Notice}, false, true
	return true
}

// afterNotice: the notice played — the call goes where the key led.
func (c *InCall) afterNotice(e Env, fx *Effects) {
	t := *c.Notice
	c.Notice, c.NoticeAt = nil, 0
	c.Enter(e, t, fx)
}

// Digit is a key the caller pressed (ADR-0129). It counts at any time in a menu — also while
// the prompt plays or before it started: the first key of an input stops the prompt (barge-in).
// Without DialExtensions it is the menu's key at once; with it the digits collect into a
// number until Collect resolves them (a full number, a key no number starts with) or the
// InterDigit pause, «#» or «*» ends the input.
func (c *InCall) Digit(e Env, digit byte, fx *Effects) {
	if c.Phase != PhaseMenu || c.Notice != nil { // the notice plays: the key is already chosen
		return
	}
	if c.Menu == nil { // the entry point is not entered yet: Enter takes these
		if len(c.Early) < maxDial {
			c.Early += string(digit)
		}
		return
	}
	m, ok := c.menu(e)
	if !ok {
		c.hangup(ReasonHangup, fx)
		return
	}
	if c.Digits == "" && !c.Played { // barge-in: whatever follows, the prompt stops now
		c.Played = true
		fx.Play, fx.Stop = nil, true
	}
	if !m.DialExtensions {
		c.press(e, m, digit, fx)
		return
	}
	if digit < '0' || digit > '9' { // «#» / «*»: a key, or the end of a number
		if c.Digits == "" {
			c.press(e, m, digit, fx)
			return
		}
		c.dial(e, m, c.Digits, Collect(m, e.PBX, c.Digits, true), fx)
		return
	}
	buf := c.Digits + string(digit)
	c.dial(e, m, buf, Collect(m, e.PBX, buf, false), fx)
}

// dial carries out what Collect made of the digits buf.
func (c *InCall) dial(e Env, m *Menu, buf string, d Dial, fx *Effects) {
	c.Digits = ""
	switch d.Result {
	case DialWait:
		c.Digits = buf
		c.Deadline = e.ms(InterDigit)
	case DialKey:
		c.press(e, m, d.Key, fx)
	case DialNumber:
		c.step("dial:" + buf)
		id := d.Ext
		t := Target{Kind: RouteExtension, ID: &id}
		if !c.noticeFirst(e, m, t, fx) {
			c.Enter(e, t, fx)
		}
	default: // not a number anybody may dial: as a key without an item
		c.step("dial:" + buf)
		c.noInput(e, fx)
	}
}

// press follows the menu's key digit.
func (c *InCall) press(e Env, m *Menu, digit byte, fx *Effects) {
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
	if !c.noticeFirst(e, m, t, fx) {
		c.Enter(e, t, fx)
	}
}

// Decline records that user refuses on one of their devices; a group does not ring them again.
// All at once: when nobody is left ringing the group rings who became free meanwhile, else the
// call goes on as if nobody answered (everybody declined: the fallback, or hang up);
// round-robin: the next member rings.
func (c *InCall) Decline(e Env, user uuid.UUID, fx *Effects) error {
	if c.Phase != PhaseRing || !slices.Contains(c.Ringing, user) {
		return ErrNotRinging
	}
	if c.Group != nil {
		c.Declined = append(c.Declined, user)
	}
	if c.Sequential {
		c.ringAt(e, c.Pos+1, fx)
		return nil
	}
	c.Ringing = slices.DeleteFunc(c.Ringing, func(u uuid.UUID) bool { return u == user })
	fx.Stopped = append(fx.Stopped, user)
	fx.Changed = true
	if len(c.Ringing) == 0 {
		if c.Group != nil {
			c.ringAll(e, fx)
		} else {
			c.failRing(e, ReasonDeclined, fx)
		}
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
	if c.Xfer != nil {
		c.transferTaken(fx)
	}
	u := user
	c.Phase, c.Answered, c.Deadline, c.FallbackAt = PhaseActive, &u, 0, 0
	fx.Stop, fx.Answered, fx.Changed = true, true, true
	return nil
}

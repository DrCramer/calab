package sip

import (
	"errors"
	"slices"
	"time"

	"github.com/google/uuid"
)

// Transfer of an answered inbound call to another employee (ADR-0132), the pure part. The
// member on the call (InCall.Answered) stays connected to the caller while the target rings —
// the same ringing as a number or a group of the exchange (ringAll / ringAt, SIP_INBOUND_RING,
// busy keys) but without the worker's ringback: the caller keeps talking to the member. The
// target answers → the call is theirs and the member is released (Effects.Released); nobody
// answers within TransferRingSec (a group with a fallback: its fallback_sec), everybody
// declines, or the transfer is cancelled → the call stays with the member. A transfer never
// hangs the caller up: a group's fallback is not followed.

// TransferRingSec is how long a transfer rings its target unless a group's fallback time is set.
const TransferRingSec = 30

// Xfer is a transfer in progress: who hands the call over (the member on the call).
type Xfer struct {
	From uuid.UUID `json:"from"`
}

// TransferTo is where a transfer goes: a route of the exchange (a number, a group), or a member
// without a number (User).
type TransferTo struct {
	Target Target
	User   *uuid.UUID
}

// Transfer errors. A TransferError carries why the target cannot ring now.
var (
	ErrNotAnswered  = errors.New("sip: the call is not answered")
	ErrTransferring = errors.New("sip: a transfer of the call already rings")
	ErrNoTransfer   = errors.New("sip: no transfer of the call rings")
	ErrTransferSelf = errors.New("sip: the member on the call is the target")
)

// TransferError means the target cannot ring now (Reason: ReasonBusy, ReasonNoMembers, ReasonHangup
// for a deleted target, ReasonLoop).
type TransferError struct{ Reason string }

func (e *TransferError) Error() string { return "sip: the transfer cannot ring: " + e.Reason }

// Transferring reports a transfer in progress.
func (c *InCall) Transferring() bool { return c.Xfer != nil }

// Transfer starts ringing to while the member on the call stays with the caller. Nothing
// changes when it fails.
func (c *InCall) Transfer(e Env, to TransferTo, fx *Effects) error {
	if c.Xfer != nil {
		return ErrTransferring
	}
	if c.Phase != PhaseActive || c.Answered == nil {
		return ErrNotAnswered
	}
	from := *c.Answered
	var d Decision
	label := "user:"
	if to.User != nil {
		if *to.User == from {
			return ErrTransferSelf
		}
		if e.Avail.Busy(*to.User) {
			return &TransferError{Reason: ReasonBusy}
		}
		label += to.User.String()
		d = Decision{Action: ActRing, Ring: []Ring{{User: *to.User, Sec: TransferRingSec}}}
	} else {
		label = routeLabel(to.Target)
		d = Route(e.PBX, to.Target, e.Avail, TransferRingSec)
	}
	if d.Action == ActRing && d.Group == nil && len(d.Ring) == 1 && d.Ring[0].User == from {
		return ErrTransferSelf
	}
	if d.Action != ActRing { // a menu (a group's fallback with nobody free) is no person either
		reason := d.Reason
		if d.Action == ActMenu {
			reason = ReasonNoMembers
		}
		return &TransferError{Reason: reason}
	}
	ring := slices.DeleteFunc(slices.Clone(d.Ring), func(r Ring) bool { return r.User == from })
	if len(ring) == 0 { // a group whose members are busy, or the member on the call alone
		return &TransferError{Reason: ReasonBusy}
	}
	if c.Hops+d.Hops+1 > MaxHops {
		return &TransferError{Reason: ReasonLoop}
	}
	c.Hops += d.Hops + 1
	c.step("transfer:" + label)
	c.Xfer = &Xfer{From: from}
	c.Phase, c.Ring, c.Sequential, c.Group, c.Pos, c.Rang = PhaseRing, ring, d.Sequential, d.Group, 0, nil
	c.OnFail, c.Declined = Target{Kind: RouteHangup}, nil
	if d.Group != nil {
		c.Declined = []uuid.UUID{from} // the group does not ring the member who hands the call over
	}
	sec := TransferRingSec
	if d.FallbackSec > 0 {
		sec = d.FallbackSec
	}
	c.FallbackAt = e.ms(time.Duration(sec) * time.Second)
	fx.Changed, fx.Xfer = true, true
	switch {
	case c.Sequential:
		c.ringAt(e, 0, fx)
	case c.Group != nil:
		c.ringAll(e, fx)
	default:
		r := c.Ring[0]
		c.Ringing = append(c.Ringing, r.User)
		fx.Rings = append(fx.Rings, r.User)
		c.addRang(r)
		c.Deadline = c.until(e, time.Duration(r.Sec)*time.Second)
	}
	return nil
}

// CancelTransfer stops the transfer's ringing: the call stays with the member.
func (c *InCall) CancelTransfer(e Env, fx *Effects) error {
	if c.Xfer == nil || c.Phase != PhaseRing {
		return ErrNoTransfer
	}
	c.transferBack(e, "cancelled", fx)
	return nil
}

// transferBack ends a transfer that nobody took (reason: why — no_answer, declined, cancelled…):
// the call is the member's again, as before the transfer.
func (c *InCall) transferBack(_ Env, reason string, fx *Effects) {
	c.stopRinging(fx)
	c.step("transfer:" + reason)
	from := c.Xfer.From
	c.Xfer = nil
	c.Phase, c.Answered, c.Deadline, c.FallbackAt = PhaseActive, &from, 0, 0
	// Rang stays: a target who answers too late hears «somebody else has it» (409), not 404.
	c.Ring, c.Pos, c.Sequential, c.Group, c.Declined = nil, 0, false, nil, nil
	c.OnFail = Target{Kind: RouteHangup}
	fx.Play, fx.Changed, fx.Xfer = nil, true, true
}

// transferTaken: the target answered — the member who handed the call over is released.
func (c *InCall) transferTaken(fx *Effects) {
	from := c.Xfer.From
	c.Xfer = nil
	c.step("transfer:answered")
	fx.Released = &from
	fx.Xfer = true
}

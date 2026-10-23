package sip

import (
	"strings"
	"time"

	"github.com/google/uuid"
)

// Collecting the digits a caller presses in a voice menu (ADR-0129): a key of the menu, or —
// with Menu.DialExtensions — an internal number of 2..6 digits. Pure, so every case is a table
// test; the state machine (machine.go) keeps the digits between presses.

// InterDigit is how long a menu waits for the next digit of a number before it resolves what
// it has.
const InterDigit = 3 * time.Second

// maxDial is the longest internal number (extNumber: 2..6 digits).
const maxDial = 6

// DialResult is what the digits so far mean.
type DialResult uint8

// Dial results.
const (
	DialWait    DialResult = iota // a longer number may follow: wait InterDigit for the next digit
	DialKey                       // the menu's key Key
	DialNumber                    // the internal number Ext
	DialInvalid                   // neither: counts as a key without an item (the menu plays again)
)

// Dial is the outcome of Collect.
type Dial struct {
	Result DialResult
	Key    byte      // DialKey
	Ext    uuid.UUID // DialNumber
}

// dialable reports whether an external caller may dial x: a group's number, or a person's /
// bot's number with somebody behind it that is not closed to external callers. Anything else
// is «not found» — an unassigned number would only hang up, a closed one must not be told apart.
func dialable(x Ext) bool {
	return x.Number != "" && (x.Group != nil || (x.User != nil && !x.NoExternal))
}

// Collect resolves buf, the digits 0-9 pressed so far in menu m (with DialExtensions), against
// the dialable numbers of p. end: no more digits will come (the pause ran out, «#» or «*»,
// the longest number reached). Without end: a full number nobody's longer number starts with
// connects at once, so does a single digit that is a key no number starts with; a string no
// number starts with is invalid at once; else wait.
func Collect(m *Menu, p *PBX, buf string, end bool) Dial {
	if buf == "" {
		return Dial{Result: DialInvalid}
	}
	end = end || len(buf) >= maxDial
	var exact *uuid.UUID
	longer := false
	for id, x := range p.Extensions {
		if !dialable(x) || !strings.HasPrefix(x.Number, buf) {
			continue
		}
		if len(x.Number) == len(buf) {
			exact = &id
		} else {
			longer = true
		}
	}
	key := false
	if len(buf) == 1 {
		_, key = m.Items[buf[0]]
	}
	switch {
	case !end && longer:
		return Dial{Result: DialWait}
	case exact != nil:
		return Dial{Result: DialNumber, Ext: *exact}
	case key:
		return Dial{Result: DialKey, Key: buf[0]}
	default:
		return Dial{Result: DialInvalid}
	}
}

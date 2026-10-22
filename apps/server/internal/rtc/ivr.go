package rtc

import (
	"context"
	"strings"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/ivrwire"
)

// Inbound calls (ADR-0117): LiveKit SIP puts the caller's line into a room of its own, made by
// the workspace's dispatch rule; the IVR worker (cmd/ivr) joins it to play the menus and read
// the keys, and the member who answers joins it to talk. None of these is a Calaba voice room:
// webhooks of such a room go to SIPHook.Inbound, never to the voice state.

// InboundRoomPrefix is the dispatch rule's room prefix of workspace wid: LiveKit names the room
// of a call "sipin_<wid>_<caller number>_<random>".
func InboundRoomPrefix(wid uuid.UUID) string { return inboundRoomTag + wid.String() }

const inboundRoomTag = "sipin_"

// IsInboundRoom reports the room of an inbound call (whatever follows the tag).
func IsInboundRoom(name string) bool { return strings.HasPrefix(name, inboundRoomTag) }

// ParseInboundRoom returns the workspace of an inbound call's room.
func ParseInboundRoom(name string) (uuid.UUID, bool) {
	rest, ok := strings.CutPrefix(name, inboundRoomTag)
	if !ok || len(rest) < 37 || rest[36] != '_' {
		return uuid.Nil, false
	}
	wid, err := uuid.Parse(rest[:36])
	return wid, err == nil
}

// Identities in an inbound call's room. LiveKit SIP names the caller's line "sip_<number>"
// (livekit/protocol sip.EvaluateDispatchRule); the worker and the member who answered get
// identities from the server.
const (
	InboundLinePrefix    = "sip_"
	IVRIdentityPrefix    = "ivr:"
	AnswerIdentityPrefix = "sipin-answer:"
)

// IVRIdentity is the worker's identity in the room of call id.
func IVRIdentity(callID uuid.UUID) string { return IVRIdentityPrefix + callID.String() }

// AnswerIdentity is the identity of the member who answered.
func AnswerIdentity(user uuid.UUID) string { return AnswerIdentityPrefix + user.String() }

// ParseAnswerIdentity returns the member of an AnswerIdentity.
func ParseAnswerIdentity(identity string) (uuid.UUID, bool) {
	rest, ok := strings.CutPrefix(identity, AnswerIdentityPrefix)
	if !ok {
		return uuid.Nil, false
	}
	id, err := uuid.Parse(rest)
	return id, err == nil
}

// More attributes LiveKit SIP sets on an inbound line (livekit.AttrSIPPhoneNumber and friends;
// livekit/protocol v1.52 sip.EvaluateDispatchRule sets the caller's number and the called number
// of the trunk unless hide_phone_number, which we never set).
const (
	AttrSIPPhoneNumber = "sip.phoneNumber"
	AttrSIPTrunkNumber = "sip.trunkPhoneNumber"
	AttrSIPRuleID      = "sip.ruleID"
	AttrSIPTrunkID     = "sip.trunkID"
)

// IVRPlay is what the worker plays into the call: a prompt file (Ogg/Opus, ADR-0117 §6) or a
// built-in sound (IVRBuiltinRingback), once or in a loop.
type IVRPlay = ivrwire.Play

// IVRBuiltinRingback is the ringing tone the caller hears while a member's devices ring.
const IVRBuiltinRingback = ivrwire.BuiltinRingback

// IVRAgent is the API's side of the IVR worker (ADR-0117 §2): the worker holds an outgoing
// WebSocket to the API, commands reach it through whichever replica holds that socket, and its
// events come back to the telephony service. No logic of routes here. Mockable in tests.
type IVRAgent interface {
	// Available reports a connected worker (none: inbound calls are refused).
	Available(ctx context.Context) bool
	// Join connects to the call's room with token (its identity is IVRIdentity).
	Join(ctx context.Context, call uuid.UUID, room, token string) error
	// Play starts p, replacing what plays; Stop plays silence.
	Play(ctx context.Context, call uuid.UUID, p IVRPlay) error
	Stop(ctx context.Context, call uuid.UUID) error
	// Leave disconnects from the call's room.
	Leave(ctx context.Context, call uuid.UUID) error
}

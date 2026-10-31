package rtc

import (
	"strings"

	"github.com/google/uuid"
)

// Personal outbound calls (ADR-0137 §3): a member calls a number from the telephony section.
// The call has a LiveKit room of its own («sipout_<workspace>_<call id>») with the member and
// the phone line, like the room of an inbound call; webhooks of such a room go to
// SIPHook.Outbound, never to the voice state.

const outboundRoomTag = "sipout_"

// OutboundRoomName is the LiveKit room of personal call id of workspace wid.
func OutboundRoomName(wid, id uuid.UUID) string {
	return outboundRoomTag + wid.String() + "_" + id.String()
}

// IsOutboundRoom reports the room of a personal call.
func IsOutboundRoom(name string) bool { return strings.HasPrefix(name, outboundRoomTag) }

// ParseOutboundRoom returns the workspace and the call of a personal call's room.
func ParseOutboundRoom(name string) (wid, id uuid.UUID, ok bool) {
	rest, ok := strings.CutPrefix(name, outboundRoomTag)
	if !ok || len(rest) != 73 || rest[36] != '_' {
		return uuid.Nil, uuid.Nil, false
	}
	w, err1 := uuid.Parse(rest[:36])
	c, err2 := uuid.Parse(rest[37:])
	if err1 != nil || err2 != nil {
		return uuid.Nil, uuid.Nil, false
	}
	return w, c, true
}

// CallerIdentityPrefix starts the identity of the member in their personal call's room.
const CallerIdentityPrefix = "sipout-caller:"

// CallerIdentity is the identity of the member who placed a personal call.
func CallerIdentity(user uuid.UUID) string { return CallerIdentityPrefix + user.String() }

// ParseCallerIdentity returns the member of a CallerIdentity.
func ParseCallerIdentity(identity string) (uuid.UUID, bool) {
	rest, ok := strings.CutPrefix(identity, CallerIdentityPrefix)
	if !ok {
		return uuid.Nil, false
	}
	id, err := uuid.Parse(rest)
	return id, err == nil
}

package pbconv

import (
	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// SIP call statuses as stored in sip_calls.status (ADR-0046).
const (
	SipDialing = "dialing"
	SipRinging = "ringing"
	SipActive  = "active"
	SipEnded   = "ended"
	SipFailed  = "failed"
)

var sipStatus = map[string]v1.SipCallStatus{
	SipDialing: v1.SipCallStatus_SIP_CALL_STATUS_DIALING,
	SipRinging: v1.SipCallStatus_SIP_CALL_STATUS_RINGING,
	SipActive:  v1.SipCallStatus_SIP_CALL_STATUS_ACTIVE,
	SipEnded:   v1.SipCallStatus_SIP_CALL_STATUS_ENDED,
	SipFailed:  v1.SipCallStatus_SIP_CALL_STATUS_FAILED,
}

// SipCallLive reports a call that is dialing, ringing or active.
func SipCallLive(status string) bool {
	return status == SipDialing || status == SipRinging || status == SipActive
}

// SipCall converts a sip_calls row.
func SipCall(c sqlc.SipCall) *v1.SipCall {
	dir := v1.SipCallDirection_SIP_CALL_DIRECTION_OUT
	if c.Direction == "in" {
		dir = v1.SipCallDirection_SIP_CALL_DIRECTION_IN
	}
	out := &v1.SipCall{
		Id: c.ID.String(), WorkspaceId: c.WorkspaceID.String(), RoomId: idp(c.RoomID), Number: c.Number,
		Direction: dir, StartedBy: idp(c.StartedBy), Status: sipStatus[c.Status], Reason: c.Reason,
		StartedAt: ts(c.StartedAt), AnsweredAt: tsp(c.AnsweredAt), EndedAt: tsp(c.EndedAt),
		ParticipantIdentity: c.ParticipantIdentity, EndedBy: idp(c.EndedBy),
		AnsweredBy: idp(c.AnsweredBy), Route: c.Route, Via: c.Via, RingingUserIds: make([]string, 0, len(c.RingingUserIds)),
	}
	for _, u := range c.RingingUserIds {
		out.RingingUserIds = append(out.RingingUserIds, u.String())
	}
	return out
}

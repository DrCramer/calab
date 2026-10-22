package rtc

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

// LiveKit SIP API (ADR-0046): the twirp service livekit.SIP of livekit-server, which forwards
// to the livekit/sip service over Valkey. Like the RoomService client, a few JSON types stand
// in for github.com/livekit/protocol (checked against it in sip_test.go).

// SIPIdentityPrefix starts the LiveKit identity of a phone line in a room: "sip:<call id>".
// voice.ParseIdentity never accepts it, so voice state, reconcile and grants skip the line.
const SIPIdentityPrefix = "sip:"

// SIPIdentity is the LiveKit identity of the phone line of call id.
func SIPIdentity(callID uuid.UUID) string { return SIPIdentityPrefix + callID.String() }

// ParseSIPIdentity returns the call id of a phone line's identity.
func ParseSIPIdentity(identity string) (uuid.UUID, bool) {
	rest, ok := strings.CutPrefix(identity, SIPIdentityPrefix)
	if !ok {
		return uuid.Nil, false
	}
	id, err := uuid.Parse(rest)
	return id, err == nil
}

// SIP participant attributes set by LiveKit (livekit.AttrSIPCallStatus and friends).
const (
	AttrSIPCallStatus = "sip.callStatus" // "dialing" | "ringing" | "active" | "hangup" | …
	AttrSIPCallID     = "sip.callID"
)

// SIPTransport values as they appear in JSON (livekit.SIPTransport).
const (
	SIPTransportUDP = "SIP_TRANSPORT_UDP"
	SIPTransportTCP = "SIP_TRANSPORT_TCP"
	SIPTransportTLS = "SIP_TRANSPORT_TLS"
)

// SIPTrunk is livekit.SIPOutboundTrunkInfo (the fields we set). The password is write-only.
type SIPTrunk struct {
	ID           string   `json:"sip_trunk_id,omitempty"`
	Name         string   `json:"name"`
	Metadata     string   `json:"metadata,omitempty"`
	Address      string   `json:"address"`
	Transport    string   `json:"transport"`
	Numbers      []string `json:"numbers"`
	AuthUsername string   `json:"auth_username"`
	AuthPassword string   `json:"auth_password"`
}

// SIPCall is livekit.CreateSIPParticipantRequest (the fields we set).
type SIPCall struct {
	TrunkID    string
	CallTo     string // dialed as the INVITE user part
	Room       string
	Identity   string
	Name       string
	Attributes map[string]string
	// WaitUntilAnswered: the request returns once the callee answered (or the call failed).
	WaitUntilAnswered bool
	RingingTimeout    time.Duration
	MaxCallDuration   time.Duration
}

// SIPParticipant is livekit.SIPParticipantInfo.
type SIPParticipant struct {
	ParticipantID string `json:"participant_id"`
	Identity      string `json:"participant_identity"`
	Room          string `json:"room_name"`
	SIPCallID     string `json:"sip_call_id"`
}

// SIPInboundTrunk is livekit.SIPInboundTrunkInfo (the fields we set, ADR-0117): calls to
// Numbers from AllowedAddresses (IP / CIDR; LiveKit takes no host names) are accepted.
type SIPInboundTrunk struct {
	ID               string   `json:"sip_trunk_id,omitempty"`
	Name             string   `json:"name"`
	Metadata         string   `json:"metadata,omitempty"`
	Numbers          []string `json:"numbers"`
	AllowedAddresses []string `json:"allowed_addresses"`
	MaxCallDuration  string   `json:"max_call_duration,omitempty"` // protojson Duration, "7200s"
	// REGISTER mode (ADR-0121): LiveKit SIP challenges the agent's INVITE (407) and takes only
	// these credentials; HeadersToAttributes copies SIP headers into the line's attributes.
	AuthUsername        string            `json:"auth_username,omitempty"`
	AuthPassword        string            `json:"auth_password,omitempty"`
	HeadersToAttributes map[string]string `json:"headers_to_attributes,omitempty"`
}

// AttrProviderCallID is the line's attribute with the provider's Call-ID of an inbound call that
// came over the registration agent (its X-Calab-Provider-Call-ID header, ADR-0121).
const AttrProviderCallID = "calab.providerCallId"

// SIPDispatchRule is a livekit.SIPDispatchRuleInfo with SIPDispatchRuleIndividual: every call of
// TrunkIDs gets a room of its own named RoomPrefix + "_" + the caller's number + "_" + a random
// suffix (livekit/protocol sip.EvaluateDispatchRule).
type SIPDispatchRule struct {
	Name            string
	Metadata        string
	TrunkIDs        []string
	RoomPrefix      string
	EmptyTimeout    uint32 // s: the room closes this long after the last participant left
	MaxParticipants uint32
}

// SIP is the subset of the LiveKit SIP API the server uses (mockable in tests).
type SIP interface {
	CreateSIPOutboundTrunk(ctx context.Context, t SIPTrunk) (SIPTrunk, error)
	// UpdateSIPOutboundTrunk replaces the trunk id with t.
	UpdateSIPOutboundTrunk(ctx context.Context, id string, t SIPTrunk) (SIPTrunk, error)
	// DeleteSIPTrunk deletes an outbound or an inbound trunk.
	DeleteSIPTrunk(ctx context.Context, id string) error
	CreateSIPParticipant(ctx context.Context, c SIPCall) (SIPParticipant, error)
	// Inbound calls (ADR-0117).
	CreateSIPInboundTrunk(ctx context.Context, t SIPInboundTrunk) (SIPInboundTrunk, error)
	CreateSIPDispatchRule(ctx context.Context, r SIPDispatchRule) (string, error)
	DeleteSIPDispatchRule(ctx context.Context, id string) error
}

// SIPStatus returns the SIP response code LiveKit attached to a CreateSIPParticipant error
// (twirp meta sip_status_code) with its text, or 0.
func SIPStatus(err error) (int, string) {
	var e *Error
	if !errors.As(err, &e) {
		return 0, ""
	}
	if code, err := strconv.Atoi(e.Meta["sip_status_code"]); err == nil && code > 0 {
		return code, e.Meta["sip_status"]
	}
	// Older servers: only the message, "sip status 486: Busy Here".
	if m := sipStatusMsg.FindStringSubmatch(e.Msg); m != nil {
		code, _ := strconv.Atoi(m[1])
		return code, strings.TrimSpace(m[2])
	}
	return 0, ""
}

var sipStatusMsg = regexp.MustCompile(`sip status (\d{3}):?\s*(.*)`)

type sipGrant struct {
	Admin bool `json:"admin,omitempty"`
	Call  bool `json:"call,omitempty"`
}

type sipClient struct {
	*client
	// long serves CreateSIPParticipant with WaitUntilAnswered (up to LiveKit's 80 s).
	long *http.Client
}

// NewSIP creates a LiveKit SIP API client for the internal LiveKit URL.
func NewSIP(internalURL, key, secret string) SIP {
	c := &client{base: strings.TrimRight(internalURL, "/"), key: key, secret: secret, hc: &http.Client{Timeout: 15 * time.Second}}
	return &sipClient{client: c, long: &http.Client{Timeout: 100 * time.Second}}
}

func (c *sipClient) do(ctx context.Context, hc *http.Client, method string, g sipGrant, in, out any) error {
	cc := *c.client
	cc.hc = hc
	return cc.callClaims(ctx, "livekit.SIP", method, lkClaims{SIP: &g}, in, out)
}

func (c *sipClient) CreateSIPOutboundTrunk(ctx context.Context, t SIPTrunk) (SIPTrunk, error) {
	t.ID = ""
	var out SIPTrunk
	err := c.do(ctx, c.hc, "CreateSIPOutboundTrunk", sipGrant{Admin: true}, map[string]any{"trunk": t}, &out)
	return out, err
}

func (c *sipClient) UpdateSIPOutboundTrunk(ctx context.Context, id string, t SIPTrunk) (SIPTrunk, error) {
	t.ID = id
	var out SIPTrunk
	err := c.do(ctx, c.hc, "UpdateSIPOutboundTrunk", sipGrant{Admin: true}, map[string]any{"sip_trunk_id": id, "replace": t}, &out)
	return out, err
}

func (c *sipClient) DeleteSIPTrunk(ctx context.Context, id string) error {
	return c.do(ctx, c.hc, "DeleteSIPTrunk", sipGrant{Admin: true}, map[string]any{"sip_trunk_id": id}, nil)
}

func (c *sipClient) CreateSIPInboundTrunk(ctx context.Context, t SIPInboundTrunk) (SIPInboundTrunk, error) {
	t.ID = ""
	var out SIPInboundTrunk
	err := c.do(ctx, c.hc, "CreateSIPInboundTrunk", sipGrant{Admin: true}, map[string]any{"trunk": t}, &out)
	return out, err
}

// dispatchRuleBody is the JSON of livekit.CreateSIPDispatchRuleRequest in its legacy flat form
// (rule, trunk_ids… at the top level): livekit-server v1.13 reads it, newer servers too.
func dispatchRuleBody(r SIPDispatchRule) map[string]any {
	in := map[string]any{
		"rule":      map[string]any{"dispatch_rule_individual": map[string]any{"room_prefix": r.RoomPrefix}},
		"trunk_ids": r.TrunkIDs,
		"name":      r.Name,
		"metadata":  r.Metadata,
	}
	if r.EmptyTimeout > 0 || r.MaxParticipants > 0 {
		in["room_config"] = map[string]any{"empty_timeout": r.EmptyTimeout, "max_participants": r.MaxParticipants}
	}
	return in
}

func (c *sipClient) CreateSIPDispatchRule(ctx context.Context, r SIPDispatchRule) (string, error) {
	var out struct {
		ID string `json:"sip_dispatch_rule_id"`
	}
	err := c.do(ctx, c.hc, "CreateSIPDispatchRule", sipGrant{Admin: true}, dispatchRuleBody(r), &out)
	return out.ID, err
}

func (c *sipClient) DeleteSIPDispatchRule(ctx context.Context, id string) error {
	return c.do(ctx, c.hc, "DeleteSIPDispatchRule", sipGrant{Admin: true}, map[string]any{"sip_dispatch_rule_id": id}, nil)
}

// sipCallBody is the JSON of livekit.CreateSIPParticipantRequest.
func sipCallBody(r SIPCall) map[string]any {
	in := map[string]any{
		"sip_trunk_id":         r.TrunkID,
		"sip_call_to":          r.CallTo,
		"room_name":            r.Room,
		"participant_identity": r.Identity,
		"participant_name":     r.Name,
		"wait_until_answered":  r.WaitUntilAnswered,
	}
	if len(r.Attributes) > 0 {
		in["participant_attributes"] = r.Attributes
	}
	if r.RingingTimeout > 0 {
		in["ringing_timeout"] = durationJSON(r.RingingTimeout)
	}
	if r.MaxCallDuration > 0 {
		in["max_call_duration"] = durationJSON(r.MaxCallDuration)
	}
	return in
}

func (c *sipClient) CreateSIPParticipant(ctx context.Context, r SIPCall) (SIPParticipant, error) {
	hc := c.hc
	if r.WaitUntilAnswered {
		hc = c.long
	}
	var out SIPParticipant
	err := c.do(ctx, hc, "CreateSIPParticipant", sipGrant{Call: true}, sipCallBody(r), &out)
	return out, err
}

// durationJSON is google.protobuf.Duration in protojson: "45s".
func durationJSON(d time.Duration) string {
	return fmt.Sprintf("%ds", int64(d/time.Second))
}

// SIPHook receives LiveKit webhook events about phone lines (ADR-0046). The rtc service calls
// it; the telephony service implements it.
type SIPHook interface {
	// SIPParticipant: an event of a participant with a "sip:" identity in workspace room rid.
	// An error makes LiveKit redeliver the event.
	SIPParticipant(ctx context.Context, event string, wid, rid uuid.UUID, p *Participant) error
	// PersonLeft: a person's (or bot's) device left rid's call; the hook hangs up the room's
	// phone call when nobody is left.
	PersonLeft(ctx context.Context, wid, rid uuid.UUID)
	// SIPRoomFinished: LiveKit closed rid's room; its phone call is over.
	SIPRoomFinished(ctx context.Context, rid uuid.UUID)
	// Inbound: an event of the LiveKit room of an inbound call («sipin_…», ADR-0117) —
	// participant_joined / _left of the line, the IVR worker or the member who answered, and
	// room_finished (p nil). An error makes LiveKit redeliver the event.
	Inbound(ctx context.Context, event, room string, p *Participant) error
}

package rtc

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// A minimal LiveKit client. LiveKit's server API is twirp (JSON over HTTP) and its tokens
// and webhook signatures are HS256 JWTs, so a few types replace github.com/livekit/protocol,
// whose generated protobuf registry alone costs ~13 MB of RSS at startup (the server's
// memory budget is 50 MB). Compatibility is checked in the integration tests against the
// official library and a real LiveKit.

// TrackSource is LiveKit's TrackSource enum as it appears in JSON.
type TrackSource string

// Track sources used by Calaba.
const (
	SourceMicrophone       TrackSource = "MICROPHONE"
	SourceScreenShare      TrackSource = "SCREEN_SHARE"
	SourceScreenShareAudio TrackSource = "SCREEN_SHARE_AUDIO"
	SourceCamera           TrackSource = "CAMERA"
)

// Permission is livekit.ParticipantPermission (only the fields we set).
type Permission struct {
	CanSubscribe      bool          `json:"canSubscribe"`
	CanPublish        bool          `json:"canPublish"`
	CanPublishData    bool          `json:"canPublishData"`
	CanPublishSources []TrackSource `json:"canPublishSources"`
}

// Track is livekit.TrackInfo (subset).
type Track struct {
	Sid    string      `json:"sid"`
	Source TrackSource `json:"source"`
	Muted  bool        `json:"muted"`
}

// Participant is livekit.ParticipantInfo (subset).
type Participant struct {
	Sid      string  `json:"sid"` // one LiveKit connection; a reconnect with the same identity gets a new one
	Identity string  `json:"identity"`
	Tracks   []Track `json:"tracks"`
	// Attributes: set on phone lines by LiveKit SIP (sip.callStatus, sip.callID; ADR-0046).
	Attributes map[string]string `json:"attributes,omitempty"`
	// DisconnectReason: why LiveKit closed the connection, in participant_left (ADR-0150).
	DisconnectReason DisconnectReason `json:"disconnectReason,omitempty"`
}

// Room is livekit.Room (subset).
type Room struct {
	Name string `json:"name"`
}

// WebhookEvent is livekit.WebhookEvent (subset).
type WebhookEvent struct {
	Event       string       `json:"event"`
	ID          string       `json:"id"`
	Room        *Room        `json:"room"`
	Participant *Participant `json:"participant"`
	Track       *Track       `json:"track"`
	// Egress events (egress_started / _updated / _ended). LiveKit serializes webhooks with
	// lowerCamelCase names; the proto name is accepted too.
	EgressInfo      *EgressInfo `json:"egressInfo"`
	EgressInfoProto *EgressInfo `json:"egress_info"`
}

// Egress returns the event's egress info, if any.
func (e *WebhookEvent) Egress() *EgressInfo {
	if e.EgressInfo != nil {
		return e.EgressInfo
	}
	return e.EgressInfoProto
}

// Webhook event names.
const (
	EventRoomFinished       = "room_finished"
	EventParticipantJoined  = "participant_joined"
	EventParticipantLeft    = "participant_left"
	EventParticipantAborted = "participant_connection_aborted"
	EventTrackPublished     = "track_published"
	EventTrackUnpublished   = "track_unpublished"
)

// LiveKit is the subset of the LiveKit RoomService the server uses (mockable in tests).
type LiveKit interface {
	CreateRoom(ctx context.Context, name string, emptyTimeout, maxParticipants uint32) error
	DeleteRoom(ctx context.Context, name string) error
	ListRooms(ctx context.Context) ([]Room, error)
	ListParticipants(ctx context.Context, room string) ([]Participant, error)
	GetParticipant(ctx context.Context, room, identity string) (*Participant, error)
	UpdatePermission(ctx context.Context, room, identity string, p Permission) error
	MuteTrack(ctx context.Context, room, identity, trackSID string, muted bool) error
	RemoveParticipant(ctx context.Context, room, identity string) error
	// MoveParticipant moves a participant with its tracks to another (existing) room.
	MoveParticipant(ctx context.Context, room, identity, destination string) error
}

// Error is a twirp error returned by LiveKit.
type Error struct {
	Status int
	Code   string `json:"code"`
	Msg    string `json:"msg"`
	// Meta: twirp error metadata, e.g. sip_status_code / sip_status of a failed SIP call.
	Meta map[string]string `json:"meta,omitempty"`
}

func (e *Error) Error() string { return fmt.Sprintf("livekit: %d %s: %s", e.Status, e.Code, e.Msg) }

// IsNotImplemented reports an API the LiveKit server does not implement (e.g. MoveParticipant
// in open-source LiveKit, ADR-0019): twirp "unimplemented", or "not implemented" in the message.
func IsNotImplemented(err error) bool {
	var e *Error
	return errors.As(err, &e) && (e.Code == "unimplemented" || strings.Contains(strings.ToLower(e.Msg), "not implemented"))
}

// IsNotFound reports a twirp "not_found" (participant/room gone): callers treat it as done.
func IsNotFound(err error) bool {
	var e *Error
	return errors.As(err, &e) && e.Code == "not_found"
}

// ---- tokens ----

type videoGrant struct {
	RoomCreate        bool     `json:"roomCreate,omitempty"`
	RoomList          bool     `json:"roomList,omitempty"`
	RoomAdmin         bool     `json:"roomAdmin,omitempty"`
	RoomJoin          bool     `json:"roomJoin,omitempty"`
	Room              string   `json:"room,omitempty"`
	CanPublish        *bool    `json:"canPublish,omitempty"`
	CanSubscribe      *bool    `json:"canSubscribe,omitempty"`
	CanPublishData    *bool    `json:"canPublishData,omitempty"`
	CanPublishSources []string `json:"canPublishSources,omitempty"`
	DestinationRoom   string   `json:"destinationRoom,omitempty"` // MoveParticipant target
	RoomRecord        bool     `json:"roomRecord,omitempty"`      // Egress service
}

type lkClaims struct {
	jwt.RegisteredClaims
	Name   string      `json:"name,omitempty"`
	Video  *videoGrant `json:"video,omitempty"`
	SIP    *sipGrant   `json:"sip,omitempty"` // SIP API (ADR-0046)
	Sha256 string      `json:"sha256,omitempty"`
}

// sourceName maps a source to the lowercase name used in token grants.
func sourceName(s TrackSource) string { return strings.ToLower(string(s)) }

func sign(key, secret string, c lkClaims, ttl time.Duration) (string, error) {
	now := time.Now()
	c.Issuer = key
	c.NotBefore = jwt.NewNumericDate(now.Add(-time.Minute)) // tolerate small clock skew
	c.ExpiresAt = jwt.NewNumericDate(now.Add(ttl))
	return jwt.NewWithClaims(jwt.SigningMethodHS256, c).SignedString([]byte(secret))
}

// JoinToken issues a participant token for one room with the given permission.
func JoinToken(key, secret, room, identity, name string, p Permission, ttl time.Duration) (string, error) {
	sub, pub, data := p.CanSubscribe, p.CanPublish, p.CanPublishData
	srcs := make([]string, 0, len(p.CanPublishSources))
	for _, s := range p.CanPublishSources {
		srcs = append(srcs, sourceName(s))
	}
	c := lkClaims{Name: name, Video: &videoGrant{
		RoomJoin: true, Room: room, CanSubscribe: &sub, CanPublish: &pub, CanPublishData: &data, CanPublishSources: srcs,
	}}
	c.Subject = identity
	return sign(key, secret, c, ttl)
}

// VerifyWebhook checks LiveKit's webhook signature (JWT signed with our key/secret whose
// sha256 claim is the base64 sha256 of the body) and decodes the event.
func VerifyWebhook(key, secret string, authHeader string, body []byte) (*WebhookEvent, error) {
	tok := strings.TrimSpace(strings.TrimPrefix(authHeader, "Bearer "))
	if tok == "" {
		return nil, errors.New("livekit webhook: no authorization")
	}
	var c lkClaims
	_, err := jwt.ParseWithClaims(tok, &c, func(*jwt.Token) (any, error) { return []byte(secret), nil },
		jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}), jwt.WithIssuer(key),
		jwt.WithExpirationRequired(), jwt.WithLeeway(5*time.Minute)) // exp/nbf set by LiveKit; 5 min clock skew
	if err != nil {
		return nil, fmt.Errorf("livekit webhook: %w", err)
	}
	sum := sha256.Sum256(body)
	if subtle.ConstantTimeCompare([]byte(c.Sha256), []byte(base64.StdEncoding.EncodeToString(sum[:]))) != 1 {
		return nil, errors.New("livekit webhook: body checksum mismatch")
	}
	var ev WebhookEvent
	if err := json.Unmarshal(body, &ev); err != nil {
		return nil, fmt.Errorf("livekit webhook: %w", err)
	}
	return &ev, nil
}

// ---- RoomService client (twirp JSON) ----

type client struct {
	base, key, secret string
	hc                *http.Client
}

// NewLiveKit creates a client for the internal LiveKit URL (http://127.0.0.1:7880).
func NewLiveKit(internalURL, key, secret string) LiveKit {
	return &client{base: strings.TrimRight(internalURL, "/"), key: key, secret: secret, hc: &http.Client{Timeout: 10 * time.Second}}
}

func (c *client) call(ctx context.Context, method, room string, in, out any) error {
	return c.callGrant(ctx, method, &videoGrant{RoomCreate: true, RoomList: true, RoomAdmin: room != "", Room: room}, in, out)
}

func (c *client) callGrant(ctx context.Context, method string, g *videoGrant, in, out any) error {
	return c.callService(ctx, "livekit.RoomService", method, g, in, out)
}

func (c *client) callService(ctx context.Context, service, method string, g *videoGrant, in, out any) error {
	return c.callClaims(ctx, service, method, lkClaims{Video: g}, in, out)
}

func (c *client) callClaims(ctx context.Context, service, method string, claims lkClaims, in, out any) error {
	tok, err := sign(c.key, c.secret, claims, time.Minute)
	if err != nil {
		return err
	}
	body, err := json.Marshal(in)
	if err != nil {
		return err
	}
	// URL = LIVEKIT_INTERNAL_URL from config + constant service / method names: not user-controlled.
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+"/twirp/"+service+"/"+method, bytes.NewReader(body)) //nolint:gosec // G704, see above
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+tok)
	resp, err := c.hc.Do(req) //nolint:gosec // G704: fixed internal URL
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusOK {
		e := &Error{Status: resp.StatusCode}
		_ = json.Unmarshal(raw, e)
		return e
	}
	if out != nil {
		return json.Unmarshal(raw, out)
	}
	return nil
}

func (c *client) CreateRoom(ctx context.Context, name string, emptyTimeout, maxParticipants uint32) error {
	return c.call(ctx, "CreateRoom", "", map[string]any{"name": name, "emptyTimeout": emptyTimeout, "maxParticipants": maxParticipants}, nil)
}

func (c *client) DeleteRoom(ctx context.Context, name string) error {
	return c.call(ctx, "DeleteRoom", name, map[string]any{"room": name}, nil)
}

func (c *client) ListRooms(ctx context.Context) ([]Room, error) {
	var out struct {
		Rooms []Room `json:"rooms"`
	}
	err := c.call(ctx, "ListRooms", "", map[string]any{}, &out)
	return out.Rooms, err
}

func (c *client) ListParticipants(ctx context.Context, room string) ([]Participant, error) {
	var out struct {
		Participants []Participant `json:"participants"`
	}
	err := c.call(ctx, "ListParticipants", room, map[string]any{"room": room}, &out)
	return out.Participants, err
}

func (c *client) GetParticipant(ctx context.Context, room, identity string) (*Participant, error) {
	var out Participant
	if err := c.call(ctx, "GetParticipant", room, map[string]any{"room": room, "identity": identity}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *client) UpdatePermission(ctx context.Context, room, identity string, p Permission) error {
	if p.CanPublishSources == nil {
		p.CanPublishSources = []TrackSource{}
	}
	return c.call(ctx, "UpdateParticipant", room, map[string]any{"room": room, "identity": identity, "permission": p}, nil)
}

func (c *client) MuteTrack(ctx context.Context, room, identity, trackSID string, muted bool) error {
	return c.call(ctx, "MutePublishedTrack", room, map[string]any{"room": room, "identity": identity, "trackSid": trackSID, "muted": muted}, nil)
}

func (c *client) RemoveParticipant(ctx context.Context, room, identity string) error {
	return c.call(ctx, "RemoveParticipant", room, map[string]any{"room": room, "identity": identity}, nil)
}

func (c *client) MoveParticipant(ctx context.Context, room, identity, destination string) error {
	g := &videoGrant{RoomAdmin: true, Room: room, DestinationRoom: destination}
	return c.callGrant(ctx, "MoveParticipant", g, map[string]any{"room": room, "identity": identity, "destinationRoom": destination}, nil)
}

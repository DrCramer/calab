package rtc

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/livekit/protocol/livekit"
	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
)

func TestGrant(t *testing.T) {
	member := perm.ViewRoom | perm.SendMessages | perm.AttachFiles | perm.Connect | perm.Speak | perm.Stream
	g := Grant(member, true, false)
	if !g.CanSubscribe || !g.CanPublish || len(g.CanPublishSources) != 3 {
		t.Fatalf("member with slot: %+v", g)
	}
	if g := Grant(member, false, false); len(g.CanPublishSources) != 1 || g.CanPublishSources[0] != SourceMicrophone {
		t.Fatalf("no stream slot: %+v", g)
	}
	if g := Grant(member&^perm.Speak, true, false); len(g.CanPublishSources) != 2 || g.CanPublishSources[0] != SourceScreenShare {
		t.Fatalf("listen + stream: %+v", g)
	}
	if g := Grant(perm.ViewRoom|perm.Connect, true, false); g.CanPublish || !g.CanSubscribe || g.CanPublishSources == nil {
		t.Fatalf("listener: %+v", g)
	}
	if g := Grant(perm.Connect|perm.Speak|perm.Stream, true, false); g.CanSubscribe || g.CanPublish {
		t.Fatalf("without VIEW_ROOM nothing is granted: %+v", g)
	}
	// Camera: VIDEO and a held camera (reservation / webcam on).
	video := member | perm.Video
	if g := Grant(video, false, true); len(g.CanPublishSources) != 2 || g.CanPublishSources[1] != SourceCamera {
		t.Fatalf("camera held: %+v", g)
	}
	if g := Grant(video, false, false); len(g.CanPublishSources) != 1 {
		t.Fatalf("camera not requested: %+v", g)
	}
	if g := Grant(member, false, true); len(g.CanPublishSources) != 1 {
		t.Fatalf("camera without VIDEO: %+v", g)
	}
}

func TestClampPreset(t *testing.T) {
	u, eco, h720, h1080, orig := v1.ScreenSharePreset_SCREEN_SHARE_PRESET_UNSPECIFIED, v1.ScreenSharePreset_SCREEN_SHARE_PRESET_ECONOMY,
		v1.ScreenSharePreset_SCREEN_SHARE_PRESET_H720, v1.ScreenSharePreset_SCREEN_SHARE_PRESET_H1080, v1.ScreenSharePreset_SCREEN_SHARE_PRESET_ORIGINAL
	for _, c := range [][3]v1.ScreenSharePreset{{orig, h720, h720}, {eco, h1080, eco}, {u, h720, h720}, {orig, u, h1080}, {h1080, orig, h1080}} {
		if got := ClampPreset(c[0], c[1]); got != c[2] {
			t.Errorf("clamp(%v, %v) = %v, want %v", c[0], c[1], got, c[2])
		}
	}
	h2160_60 := v1.ScreenSharePreset_SCREEN_SHARE_PRESET_H2160_60
	if got := ClampPreset(h2160_60, orig); got != orig {
		t.Errorf("legacy ORIGINAL ceiling admitted a new mode: %v", got)
	}
}

func TestJoinToken(t *testing.T) {
	tok, err := JoinToken("key", "secret", "room1", "u:s", "Ann", Grant(perm.ViewRoom|perm.Connect|perm.Speak, false, false), time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	var c lkClaims
	if _, err := jwt.ParseWithClaims(tok, &c, func(*jwt.Token) (any, error) { return []byte("secret"), nil }); err != nil {
		t.Fatal(err)
	}
	v := c.Video
	if c.Issuer != "key" || c.Subject != "u:s" || c.Name != "Ann" || !v.RoomJoin || v.Room != "room1" || v.RoomAdmin ||
		!*v.CanSubscribe || !*v.CanPublish || len(v.CanPublishSources) != 1 || v.CanPublishSources[0] != "microphone" {
		t.Fatalf("claims: %+v video %+v", c, v)
	}
}

func signedWebhook(t *testing.T, secret string, body []byte, tamper bool) string {
	sum := sha256.Sum256(body)
	c := lkClaims{Sha256: base64.StdEncoding.EncodeToString(sum[:])}
	if tamper {
		c.Sha256 = "x"
	}
	tok, err := sign("key", secret, c, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	return tok
}

func TestVerifyWebhook(t *testing.T) {
	body := []byte(`{"event":"track_published","id":"EV_1","room":{"name":"r"},"participant":{"identity":"a:b"},"track":{"sid":"TR","source":"SCREEN_SHARE"},"createdAt":"1"}`)
	ev, err := VerifyWebhook("key", "secret", signedWebhook(t, "secret", body, false), body)
	if err != nil || ev.Event != EventTrackPublished || ev.Track.Source != SourceScreenShare || ev.Participant.Identity != "a:b" {
		t.Fatalf("%+v %v", ev, err)
	}
	for name, hdr := range map[string]string{
		"wrong secret": signedWebhook(t, "other", body, false),
		"bad checksum": signedWebhook(t, "secret", body, true),
		"empty":        "",
	} {
		if _, err := VerifyWebhook("key", "secret", hdr, body); err == nil {
			t.Errorf("%s accepted", name)
		}
	}
	if _, err := VerifyWebhook("key", "secret", signedWebhook(t, "secret", body, false), append(body, ' ')); err == nil {
		t.Error("modified body accepted")
	}
}

// Our twirp JSON bodies must decode into LiveKit's own request messages (field names, enum
// names). The official library is a test-only dependency (ADR-0013).
func TestTwirpBodiesMatchLiveKit(t *testing.T) {
	var mv livekit.MoveParticipantRequest
	b, _ := json.Marshal(map[string]any{"room": "a", "identity": "u:s", "destinationRoom": "b"})
	if err := protojson.Unmarshal(b, &mv); err != nil || mv.GetRoom() != "a" || mv.GetIdentity() != "u:s" || mv.GetDestinationRoom() != "b" {
		t.Fatalf("MoveParticipant body: %v %v", &mv, err)
	}
	var up livekit.UpdateParticipantRequest
	b, _ = json.Marshal(map[string]any{"room": "a", "identity": "u:s", "permission": Grant(perm.ViewRoom|perm.Connect|perm.Speak|perm.Stream, true, false)})
	if err := protojson.Unmarshal(b, &up); err != nil {
		t.Fatal(err)
	}
	p := up.GetPermission()
	if !p.GetCanSubscribe() || !p.GetCanPublish() || len(p.GetCanPublishSources()) != 3 ||
		p.GetCanPublishSources()[0] != livekit.TrackSource_MICROPHONE || p.GetCanPublishSources()[1] != livekit.TrackSource_SCREEN_SHARE {
		t.Fatalf("UpdateParticipant permission: %v", p)
	}
}

func TestWebhookRequiresExpiry(t *testing.T) {
	body := []byte(`{"event":"room_started","id":"EV_2","room":{"name":"r"}}`)
	sum := sha256.Sum256(body)
	mk := func(exp *jwt.NumericDate) string {
		c := lkClaims{Sha256: base64.StdEncoding.EncodeToString(sum[:])}
		c.Issuer, c.ExpiresAt = "key", exp
		tok, _ := jwt.NewWithClaims(jwt.SigningMethodHS256, c).SignedString([]byte("secret"))
		return tok
	}
	if _, err := VerifyWebhook("key", "secret", mk(nil), body); err == nil {
		t.Error("token without exp accepted")
	}
	if _, err := VerifyWebhook("key", "secret", mk(jwt.NewNumericDate(time.Now().Add(-10*time.Minute))), body); err == nil {
		t.Error("expired token accepted")
	}
	if _, err := VerifyWebhook("key", "secret", mk(jwt.NewNumericDate(time.Now().Add(-2*time.Minute))), body); err != nil {
		t.Errorf("token within 5 min skew rejected: %v", err)
	}
}

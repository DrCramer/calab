package rtc

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/livekit/protocol/livekit"
	lkjson "github.com/livekit/protocol/utils/protojson"

	"github.com/calaba/calaba/server/internal/voice"
)

// The official library encodes participant_left as LiveKit 1.13 sends it: the reason reaches
// our subset type.
func TestDisconnectReasonOfficialEncoding(t *testing.T) {
	for reason, explicit := range map[livekit.DisconnectReason]bool{
		livekit.DisconnectReason_CONNECTION_TIMEOUT:  false,
		livekit.DisconnectReason_SIGNAL_CLOSE:        false,
		livekit.DisconnectReason_UNKNOWN_REASON:      false, // omitted by protojson
		livekit.DisconnectReason_CLIENT_INITIATED:    true,
		livekit.DisconnectReason_PARTICIPANT_REMOVED: true,
	} {
		body, err := lkjson.Marshal(&livekit.WebhookEvent{
			Event: EventParticipantLeft, Id: "EV_1", Room: &livekit.Room{Name: "ws_x_room_y"},
			Participant: &livekit.ParticipantInfo{Sid: "PA_1", Identity: "u:s", DisconnectReason: reason},
		})
		if err != nil {
			t.Fatal(err)
		}
		var ev WebhookEvent
		if err := json.Unmarshal(body, &ev); err != nil {
			t.Fatal(err)
		}
		if got := explicitRelease(ev.Participant.DisconnectReason); got != explicit {
			t.Fatalf("%v: explicit = %v (decoded %q from %s)", reason, got, ev.Participant.DisconnectReason, body)
		}
	}
}

func TestHoldsSeats(t *testing.T) {
	ws, room := uuid.New(), uuid.New()
	on := &Service{cfg: Config{LostGrace: time.Minute}}
	if !on.holdsSeats(ws, room) {
		t.Fatal("a workspace room holds seats")
	}
	if on.holdsSeats(room, room) {
		t.Fatal("a DM call has its own lost rule (ADR-0034)")
	}
	if (&Service{}).holdsSeats(ws, room) {
		t.Fatal("VOICE_LOST_GRACE=0 holds nothing")
	}
}

func TestDisconnectReasonJSON(t *testing.T) {
	// LiveKit 1.13 (protojson): participant_left carries ParticipantInfo.disconnect_reason by name.
	body := `{"event":"participant_left","participant":{"sid":"PA_1","identity":"u:s","disconnectReason":"CONNECTION_TIMEOUT"}}`
	var ev WebhookEvent
	if err := json.Unmarshal([]byte(body), &ev); err != nil {
		t.Fatal(err)
	}
	if ev.Participant.DisconnectReason != "CONNECTION_TIMEOUT" {
		t.Fatalf("reason = %q", ev.Participant.DisconnectReason)
	}
	for raw, want := range map[string]DisconnectReason{`1`: "CLIENT_INITIATED", `4`: "PARTICIPANT_REMOVED", `14`: "CONNECTION_TIMEOUT", `99`: "", `null`: ""} {
		var p Participant
		if err := json.Unmarshal([]byte(`{"disconnectReason":`+raw+`}`), &p); err != nil {
			t.Fatalf("%s: %v", raw, err)
		}
		if p.DisconnectReason != want {
			t.Fatalf("%s: reason = %q, want %q", raw, p.DisconnectReason, want)
		}
	}
	var p Participant
	if err := json.Unmarshal([]byte(`{"identity":"u:s"}`), &p); err != nil || p.DisconnectReason != "" {
		t.Fatalf("no reason: %q %v", p.DisconnectReason, err)
	}
}

func TestExplicitRelease(t *testing.T) {
	for _, r := range []DisconnectReason{"CLIENT_INITIATED", "PARTICIPANT_REMOVED", "DUPLICATE_IDENTITY", "ROOM_DELETED", "ROOM_CLOSED", "MIGRATION"} {
		if !explicitRelease(r) {
			t.Errorf("%s must end the seat at once", r)
		}
	}
	// A frozen phone page is CONNECTION_TIMEOUT (LiveKit logs PEER_CONNECTION_DISCONNECTED).
	for _, r := range []DisconnectReason{"", "UNKNOWN_REASON", "CONNECTION_TIMEOUT", "SIGNAL_CLOSE", "STATE_MISMATCH", "JOIN_FAILURE", "MEDIA_FAILURE", "SERVER_SHUTDOWN"} {
		if explicitRelease(r) {
			t.Errorf("%q is a drop: the seat must be held", r)
		}
	}
}

func TestSeatAfterDrop(t *testing.T) {
	rid, other := uuid.New(), uuid.New()
	now := time.UnixMilli(1_000_000)
	grace := time.Minute
	connected := &voice.SessionState{RoomID: rid, Muted: true, Streaming: true, Camera: true, JoinedAt: 500}

	if got := seatAfterDrop(nil, rid, true, grace, now); got != nil {
		t.Fatalf("no seat: %v", got)
	}
	elsewhere := &voice.SessionState{RoomID: other, JoinedAt: 900}
	if got := seatAfterDrop(elsewhere, rid, true, grace, now); got != elsewhere {
		t.Fatalf("a device that moved on keeps its seat: %v", got)
	}
	if got := seatAfterDrop(connected, rid, false, grace, now); got != nil {
		t.Fatalf("an explicit release removes the seat: %v", got)
	}
	if got := seatAfterDrop(connected, rid, true, 0, now); got != nil {
		t.Fatalf("VOICE_LOST_GRACE=0 is the old behaviour: %v", got)
	}
	if got := seatAfterDrop(&voice.SessionState{RoomID: rid, Pending: true, JoinedAt: 900}, rid, true, grace, now); got != nil {
		t.Fatalf("a pending device was never in the call: %v", got)
	}

	got := seatAfterDrop(connected, rid, true, grace, now)
	if got == nil || !got.Lost || got.Hold != now.Add(grace).UnixMilli() {
		t.Fatalf("an involuntary drop holds the seat until now+grace: %+v", got)
	}
	if got.Streaming || got.Camera || !got.Muted || got.JoinedAt != 500 || got.RoomID != rid {
		t.Fatalf("streams and webcam go with the connection, the rest stays: %+v", got)
	}
	if connected.Lost || connected.Hold != 0 {
		t.Fatal("the current state was modified in place")
	}

	// Another drop (a /join took the seat back, the new connection was aborted): same deadline.
	retaken := *got
	retaken.Lost = false
	again := seatAfterDrop(&retaken, rid, true, grace, now.Add(20*time.Second))
	if again == nil || !again.Lost || again.Hold != got.Hold {
		t.Fatalf("a second drop keeps the first deadline: %+v", again)
	}
	if late := seatAfterDrop(&retaken, rid, true, grace, time.UnixMilli(got.Hold)); late != nil {
		t.Fatalf("a drop past the deadline removes the seat: %+v", late)
	}
}

func TestSeatOnRejoin(t *testing.T) {
	rid := uuid.New()
	now := time.UnixMilli(2_000_000)
	if _, ok := seatOnRejoin(voice.SessionState{RoomID: rid, JoinedAt: 1}, now); ok {
		t.Fatal("a connected seat: a repeated /join changes nothing")
	}
	if _, ok := seatOnRejoin(voice.SessionState{RoomID: rid, Pending: true, JoinedAt: 1}, now); ok {
		t.Fatal("a pending seat: a repeated /join changes nothing")
	}
	// Taken back already (not reconnected yet): a /join loop does not stretch the hold.
	if _, ok := seatOnRejoin(voice.SessionState{RoomID: rid, Hold: now.UnixMilli() + 1000, JoinedAt: 1}, now); ok {
		t.Fatal("a seat taken back already: no new hold")
	}
	far := now.Add(40 * time.Second).UnixMilli()
	n, ok := seatOnRejoin(voice.SessionState{RoomID: rid, Lost: true, Hold: far, Muted: true, JoinedAt: 7}, now)
	if !ok || n.Lost || n.Hold != far || !n.Muted || n.JoinedAt != 7 {
		t.Fatalf("back in time: the mark goes, the deadline and the rest stay: %+v", n)
	}
	n, ok = seatOnRejoin(voice.SessionState{RoomID: rid, Lost: true, Hold: now.UnixMilli() + 1000, JoinedAt: 7}, now)
	if !ok || n.Hold != now.Add(connectConfirm).UnixMilli() {
		t.Fatalf("back at the last moment: the hold covers the LiveKit connect: %+v", n)
	}
	if !held(voice.SessionState{Hold: 1}) || !held(voice.SessionState{Lost: true}) || held(voice.SessionState{Pending: true}) {
		t.Fatal("held()")
	}
}

func TestSeatBack(t *testing.T) {
	seen := voice.SessionState{Lost: true, Hold: 1000}
	same := seen
	seatBack(seen)(&same)
	if same.Pending || same.Lost || same.Hold != 0 {
		t.Fatalf("the device is back: %+v", same)
	}
	pending := voice.SessionState{Pending: true}
	seatBack(pending)(&pending)
	if pending.Pending {
		t.Fatalf("participant_joined was lost, the listing has the device: %+v", pending)
	}
	newer := voice.SessionState{Lost: true, Hold: 2000}
	seatBack(seen)(&newer)
	if !newer.Lost || newer.Hold != 2000 {
		t.Fatalf("dropped again since the snapshot, the new hold stays: %+v", newer)
	}
}

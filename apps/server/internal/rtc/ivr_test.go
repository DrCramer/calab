package rtc

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/livekit/protocol/livekit"
	"google.golang.org/protobuf/encoding/protojson"
)

// Inbound (ADR-0117): the inbound trunk and the dispatch rule as livekit-server reads them, and
// the room / identity naming of an inbound call.
func TestSIPInboundWireFormats(t *testing.T) {
	trunk := SIPInboundTrunk{Name: "calab-in-ws", Metadata: "ws", Numbers: []string{"+74951234567", "74951234567"},
		AllowedAddresses: []string{"203.0.113.10", "198.51.100.0/24"}, MaxCallDuration: "7200s"}
	b, _ := json.Marshal(map[string]any{"trunk": trunk})
	var tr livekit.CreateSIPInboundTrunkRequest
	if err := protojson.Unmarshal(b, &tr); err != nil {
		t.Fatalf("trunk: %v %s", err, b)
	}
	if info := tr.GetTrunk(); info.GetName() != "calab-in-ws" || len(info.GetNumbers()) != 2 || len(info.GetAllowedAddresses()) != 2 ||
		info.GetMaxCallDuration().AsDuration() != 2*time.Hour || info.GetKrispEnabled() {
		t.Fatalf("trunk: %v", info)
	}
	if err := tr.Validate(); err != nil {
		t.Fatalf("trunk validate: %v", err)
	}
	wid := uuid.New()
	b, _ = json.Marshal(dispatchRuleBody(SIPDispatchRule{Name: "calab-in", Metadata: wid.String(), TrunkIDs: []string{"ST_1"},
		RoomPrefix: InboundRoomPrefix(wid), EmptyTimeout: 30, MaxParticipants: 4}))
	var rr livekit.CreateSIPDispatchRuleRequest
	if err := protojson.Unmarshal(b, &rr); err != nil {
		t.Fatalf("rule: %v %s", err, b)
	}
	info := rr.DispatchRuleInfo()
	if info.GetRule().GetDispatchRuleIndividual().GetRoomPrefix() != "sipin_"+wid.String() || info.GetTrunkIds()[0] != "ST_1" ||
		info.GetRoomConfig().GetEmptyTimeout() != 30 || info.GetRoomConfig().GetMaxParticipants() != 4 || info.GetMetadata() != wid.String() {
		t.Fatalf("rule: %v", info)
	}
	if err := rr.Validate(); err != nil {
		t.Fatalf("rule validate: %v", err)
	}
	// LiveKit names the room prefix + "_" + caller + "_" + random (sip.EvaluateDispatchRule).
	room := InboundRoomPrefix(wid) + "_+79161234567_SCL_abc"
	if got, ok := ParseInboundRoom(room); !ok || got != wid || !IsInboundRoom(room) {
		t.Fatal("parse inbound room")
	}
	if _, ok := ParseInboundRoom("sipin_" + wid.String()); ok {
		t.Fatal("a bare prefix parsed")
	}
	if IsInboundRoom("ws_" + wid.String() + "_room_" + wid.String()) {
		t.Fatal("a voice room taken as inbound")
	}
	u := uuid.New()
	if got, ok := ParseAnswerIdentity(AnswerIdentity(u)); !ok || got != u {
		t.Fatal("answer identity")
	}
}

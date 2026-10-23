package pbconv

import (
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

func TestEventForGuest(t *testing.T) {
	ev := &v1.CalendarEvent{Id: "e", Title: "Демо", Description: "Повестка", RoomId: "r", RecordingId: "rec", CanEdit: true, GuestLinks: true,
		MyStatus: v1.AttendeeStatus_ATTENDEE_STATUS_ACCEPTED, Counts: &v1.CalendarEventCounts{Accepted: 1, Pending: 1},
		Attendees: []*v1.CalendarEventAttendee{{UserId: "u"}, {Email: "partner@outside.org"}}}
	g := EventForGuest(ev)
	if len(g.GetAttendees()) != 0 || g.GetRecordingId() != "" || g.GetCanEdit() || g.GetGuestLinks() ||
		g.GetMyStatus() != v1.AttendeeStatus_ATTENDEE_STATUS_UNSPECIFIED {
		t.Fatalf("guest view leaks: %v", g)
	}
	if g.GetTitle() != "Демо" || g.GetDescription() != "Повестка" || g.GetCounts().GetAccepted() != 1 || g.GetRoomId() != "r" {
		t.Fatalf("guest view lost the card: %v", g)
	}
	if len(ev.GetAttendees()) != 2 || ev.GetRecordingId() != "rec" {
		t.Fatal("the original changed")
	}
	if EventForGuest(nil) != nil {
		t.Fatal("nil")
	}
}

func TestSettingsDefaults(t *testing.T) {
	for name, c := range map[string]struct {
		raw   string
		noise bool
		mode  v1.MicMode
	}{
		"empty row":           {`{}`, false, v1.MicMode_MIC_MODE_VAD},
		"nil":                 {``, false, v1.MicMode_MIC_MODE_VAD},
		"explicit false":      {`{"noiseSuppression":false,"micMode":"MIC_MODE_PUSH_TO_TALK"}`, false, v1.MicMode_MIC_MODE_PUSH_TO_TALK},
		"legacy push to talk": {`{"pushToTalk":true}`, false, v1.MicMode_MIC_MODE_PUSH_TO_TALK},
		"corrupt":             {`not json`, false, v1.MicMode_MIC_MODE_VAD},
	} {
		s := Settings([]byte(c.raw))
		if s.GetNoiseSuppression() != c.noise || s.GetMicMode() != c.mode || s.GetPushToTalk() != (c.mode == v1.MicMode_MIC_MODE_PUSH_TO_TALK) || s.AudioBitrateKbps != nil { //nolint:staticcheck // legacy field
			t.Errorf("%s: %v", name, s)
		}
	}
	// Encode keeps false explicit, so it survives a round trip.
	b, err := EncodeSettings(&v1.UserSettings{NoiseSuppression: false})
	if err != nil {
		t.Fatal(err)
	}
	if s := Settings(b); s.GetNoiseSuppression() || s.GetMicMode() != v1.MicMode_MIC_MODE_VAD {
		t.Fatalf("round trip: %s -> %v", b, s)
	}
	br := uint32(48)
	b, _ = EncodeSettings(&v1.UserSettings{AudioBitrateKbps: &br})
	if Settings(b).GetAudioBitrateKbps() != 48 {
		t.Fatal("bitrate lost")
	}
}

func TestPresetToDBRoundTrip(t *testing.T) {
	for _, preset := range []v1.ScreenSharePreset{
		v1.ScreenSharePreset_SCREEN_SHARE_PRESET_H720_30,
		v1.ScreenSharePreset_SCREEN_SHARE_PRESET_H1080_60,
		v1.ScreenSharePreset_SCREEN_SHARE_PRESET_H1440_60,
		v1.ScreenSharePreset_SCREEN_SHARE_PRESET_H2160_60,
		v1.ScreenSharePreset_SCREEN_SHARE_PRESET_ORIGINAL_60,
	} {
		value, ok := PresetToDB(preset)
		if !ok || PresetFromDB(value) != preset {
			t.Errorf("preset round trip %v: %q, ok=%v", preset, value, ok)
		}
	}
}

//go:build integration

package rtc

import (
	"context"
	"testing"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/voice"
)

// A full LiveKit reconnect (flaky network) gives the device a new connection that publishes its
// mic again; the old connection's track_unpublished may arrive after that. It must not mark the
// device muted while its live mic is on air (ADR-0134): the others would see «mic off» while
// hearing the user. The current connection's own unpublish still mutes.
func TestStaleMicUnpublishKeepsNewerConnection(t *testing.T) {
	lk := presenceLK{&fakeLK{rooms: map[string][]Participant{}}}
	s, _ := testService(t, lk)
	ctx := context.Background()
	wid, rid, u, sid := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	identity := voice.Identity(u, sid)
	lkRoom := voice.RoomName(wid, rid)
	setState(t, s, wid, u, sid, rid, 0)

	mic := func(event, pSid, tSid string, muted bool) {
		t.Helper()
		ev := &WebhookEvent{Event: event, Room: &Room{Name: lkRoom},
			Participant: &Participant{Identity: identity, Sid: pSid},
			Track:       &Track{Sid: tSid, Source: SourceMicrophone, Muted: muted}}
		if err := s.HandleEvent(ctx, ev); err != nil {
			t.Fatal(err)
		}
	}

	// The new connection is live with an unmuted mic; its track_published came first.
	lk.rooms[lkRoom] = []Participant{{Identity: identity, Sid: "PA_new", Tracks: []Track{{Sid: "TR_new", Source: SourceMicrophone}}}}
	mic(EventTrackPublished, "PA_new", "TR_new", false)
	if st := stateOf(t, s, wid, sid); st == nil || st.Muted {
		t.Fatalf("after the new mic published: %+v", st)
	}
	// The old connection's late unpublish.
	mic(EventTrackUnpublished, "PA_old", "TR_old", false)
	if st := stateOf(t, s, wid, sid); st == nil || st.Muted {
		t.Fatalf("a stale track_unpublished of the old connection muted the live device: %+v", st)
	}
	// The live connection unpublishing its own mic is a real mute.
	mic(EventTrackUnpublished, "PA_new", "TR_new", false)
	if st := stateOf(t, s, wid, sid); st == nil || !st.Muted {
		t.Fatalf("the current connection's unpublish did not mute: %+v", st)
	}
}

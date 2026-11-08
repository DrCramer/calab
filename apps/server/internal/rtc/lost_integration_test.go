//go:build integration

package rtc

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/redis/rueidis"

	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/redisx"
	"github.com/calaba/calaba/server/internal/voice"
)

// lostFixture: a workspace room with one connected device, the grace on (ADR-0150).
type lostFixture struct {
	s             *Service
	rc            rueidis.Client
	lk            presenceLK
	pub           *voicePub
	wid, rid      uuid.UUID
	uid, sid      uuid.UUID
	room          wsRoom
	lkRoom, ident string
}

func newLostFixture(t *testing.T) *lostFixture {
	t.Helper()
	lk := presenceLK{&fakeLK{rooms: map[string][]Participant{}}}
	s, rc := testService(t, lk)
	s.cfg.LostGrace = time.Minute
	pub := &voicePub{}
	s.events = pub
	f := &lostFixture{s: s, rc: rc, lk: lk, pub: pub, wid: uuid.New(), rid: uuid.New(), uid: uuid.New(), sid: uuid.New()}
	f.room = wsRoom{Room: sqlc.Room{ID: f.rid}, WorkspaceID: f.wid}
	f.lkRoom, f.ident = voice.RoomName(f.wid, f.rid), voice.Identity(f.uid, f.sid)
	ctx := context.Background()
	// Joined two minutes ago (older than reconcile's joinGrace) and connected.
	if _, _, err := recordFixturePending(ctx, t, s, f.room, f.uid, f.sid, admission{}); err != nil {
		t.Fatal(err)
	}
	if err := s.setFlag(ctx, f.wid, f.rid, f.uid, f.sid, func(n *voice.SessionState) {
		n.Pending, n.Streaming, n.JoinedAt = false, true, time.Now().Add(-2*time.Minute).UnixMilli()
	}); err != nil {
		t.Fatal(err)
	}
	f.pub.mu.Lock()
	f.pub.got = nil // only what happens after the device is in the call
	f.pub.mu.Unlock()
	return f
}

// drop delivers participant_left of the device's connection PA_1 with a LiveKit reason.
func (f *lostFixture) drop(t *testing.T, reason DisconnectReason) {
	t.Helper()
	if err := f.s.HandleEvent(context.Background(), &WebhookEvent{
		Event: EventParticipantLeft, Room: &Room{Name: f.lkRoom},
		Participant: &Participant{Sid: "PA_1", Identity: f.ident, DisconnectReason: reason},
	}); err != nil {
		t.Fatal(err)
	}
}

func (f *lostFixture) reconcile(t *testing.T) {
	t.Helper()
	ctx := context.Background()
	// One pass per call: the 25 s instance lock of the previous pass goes.
	if err := f.rc.Do(ctx, f.rc.B().Del().Key(redisx.Key("rtc:reconcile")).Build()).Error(); err != nil {
		t.Fatal(err)
	}
	if err := f.s.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
}

// noLeave fails if any VOICE_STATE_UPDATE took the user out of the room.
func (f *lostFixture) noLeave(t *testing.T) {
	t.Helper()
	f.pub.mu.Lock()
	defer f.pub.mu.Unlock()
	for _, vs := range f.pub.got {
		if vs.GetRoomId() != f.rid.String() {
			t.Fatalf("others saw a leave: %v", vs)
		}
	}
}

// A drop holds the seat, marked lost, through reconcile; the device's /join takes it back and
// its connection clears the hold: others never see a leave or a join.
func TestLostSeatHeldAndTakenBack(t *testing.T) {
	f := newLostFixture(t)
	ctx := context.Background()
	f.drop(t, "CONNECTION_TIMEOUT")
	st := stateOf(t, f.s, f.wid, f.sid)
	if st == nil || !st.Lost || st.Streaming || st.Hold < time.Now().Add(50*time.Second).UnixMilli() {
		t.Fatalf("seat after the drop: %+v", st)
	}
	if last := f.pub.last(t); !last.GetConnectionLost() || last.GetRoomId() != f.rid.String() {
		t.Fatalf("others were not told the connection is lost: %v", last)
	}
	// Absent from LiveKit and joined long ago: reconcile keeps it while the grace runs.
	f.reconcile(t)
	if st := stateOf(t, f.s, f.wid, f.sid); st == nil || !st.Lost {
		t.Fatalf("reconcile took a held seat: %+v", st)
	}
	// Back within the grace: /join takes the seat back, not as a new pending join.
	pending, _, err := recordFixturePending(ctx, t, f.s, f.room, f.uid, f.sid, admission{})
	if err != nil {
		t.Fatal(err)
	}
	st = stateOf(t, f.s, f.wid, f.sid)
	if pending || st == nil || st.Lost || st.Pending || st.Hold == 0 {
		t.Fatalf("seat after /join (pending=%v): %+v", pending, st)
	}
	if last := f.pub.last(t); last.GetConnectionLost() || last.GetPending() {
		t.Fatalf("others still see the seat lost or connecting: %v", last)
	}
	// Not connected yet: still kept.
	f.reconcile(t)
	if st := stateOf(t, f.s, f.wid, f.sid); st == nil || st.Hold == 0 {
		t.Fatalf("reconcile took a seat taken back by /join: %+v", st)
	}
	// Connected (participant_joined lost or not here yet): reconcile clears the hold.
	f.lk.mu.Lock()
	f.lk.rooms[f.lkRoom] = []Participant{{Sid: "PA_2", Identity: f.ident}}
	f.lk.mu.Unlock()
	f.reconcile(t)
	if st := stateOf(t, f.s, f.wid, f.sid); st == nil || st.Hold != 0 || st.Lost {
		t.Fatalf("connected seat still held: %+v", st)
	}
	f.noLeave(t)
}

// The grace ends: the seat goes as a leave (VOICE_STATE_UPDATE with an empty room). LiveKit
// closing the emptied room (room_finished, departure_timeout) does not end it earlier.
func TestLostSeatExpires(t *testing.T) {
	f := newLostFixture(t)
	ctx := context.Background()
	f.drop(t, "") // no reason (an older LiveKit): a drop
	if err := f.s.HandleEvent(ctx, &WebhookEvent{Event: EventRoomFinished, Room: &Room{Name: f.lkRoom}}); err != nil {
		t.Fatal(err)
	}
	st := stateOf(t, f.s, f.wid, f.sid)
	if st == nil || !st.Lost {
		t.Fatalf("room_finished took a held seat: %+v", st)
	}
	f.noLeave(t)
	if err := f.s.setFlag(ctx, f.wid, f.rid, f.uid, f.sid, func(n *voice.SessionState) {
		n.Hold = time.Now().Add(-time.Second).UnixMilli()
	}); err != nil {
		t.Fatal(err)
	}
	f.reconcile(t)
	if st := stateOf(t, f.s, f.wid, f.sid); st != nil {
		t.Fatalf("seat kept past its grace: %+v", st)
	}
	if last := f.pub.last(t); last.GetRoomId() != "" {
		t.Fatalf("others were not told the user left: %v", last)
	}
	if _, _, ok, _ := f.s.voice.Location(ctx, f.sid); ok {
		t.Fatal("device location kept after the seat went")
	}
}

// An explicit release ends the seat at once: the client's own leave, /voice/leave, a server
// removal, the grace switched off; a pending device is never held.
func TestLostSeatExplicitRelease(t *testing.T) {
	for _, reason := range []DisconnectReason{"CLIENT_INITIATED", "PARTICIPANT_REMOVED", "DUPLICATE_IDENTITY", "ROOM_DELETED"} {
		f := newLostFixture(t)
		f.drop(t, reason)
		if st := stateOf(t, f.s, f.wid, f.sid); st != nil {
			t.Fatalf("%s: seat kept: %+v", reason, st)
		}
		if last := f.pub.last(t); last.GetRoomId() != "" {
			t.Fatalf("%s: no leave published: %v", reason, last)
		}
	}

	f := newLostFixture(t)
	f.s.cfg.LostGrace = 0
	f.drop(t, "CONNECTION_TIMEOUT")
	if st := stateOf(t, f.s, f.wid, f.sid); st != nil {
		t.Fatalf("VOICE_LOST_GRACE=0: seat kept: %+v", st)
	}

	// Held, then «Отключиться» (POST /voice/leave): gone at once.
	f = newLostFixture(t)
	f.drop(t, "CONNECTION_TIMEOUT")
	leaveReq(t, f.s, f.uid, f.sid, f.rid)
	if st := stateOf(t, f.s, f.wid, f.sid); st != nil {
		t.Fatalf("/voice/leave kept a held seat: %+v", st)
	}

	// Held, then the server takes the device out (member removed, session revoked): no
	// participant_left will come, the seat goes with the removal.
	f = newLostFixture(t)
	f.drop(t, "CONNECTION_TIMEOUT")
	f.s.disconnect(context.Background(), f.wid, func(st voice.SessionState) bool { return st.SessionID == f.sid })
	if st := stateOf(t, f.s, f.wid, f.sid); st != nil {
		t.Fatalf("server removal kept a held seat: %+v", st)
	}

	// A pending device (never connected) aborts: removed as before.
	f = newLostFixture(t)
	other := uuid.New()
	if _, _, err := recordFixturePending(context.Background(), t, f.s, f.room, other, other, admission{}); err != nil {
		t.Fatal(err)
	}
	if err := f.s.HandleEvent(context.Background(), &WebhookEvent{
		Event: EventParticipantAborted, Room: &Room{Name: f.lkRoom},
		Participant: &Participant{Sid: "PA_9", Identity: voice.Identity(other, other), DisconnectReason: "JOIN_FAILURE"},
	}); err != nil {
		t.Fatal(err)
	}
	if st := stateOf(t, f.s, f.wid, other); st != nil {
		t.Fatalf("pending device held: %+v", st)
	}
}

// A late participant_left of a connection already replaced by a newer one (full reconnect)
// changes nothing, as before: no mark, no hold.
func TestLostSeatSupersededConnection(t *testing.T) {
	f := newLostFixture(t)
	f.lk.mu.Lock()
	f.lk.rooms[f.lkRoom] = []Participant{{Sid: "PA_2", Identity: f.ident}}
	f.lk.mu.Unlock()
	f.drop(t, "CONNECTION_TIMEOUT")
	st := stateOf(t, f.s, f.wid, f.sid)
	if st == nil || st.Lost || st.Hold != 0 || st.RoomID != f.rid {
		t.Fatalf("superseded connection touched the seat: %+v", st)
	}
	f.pub.mu.Lock()
	n := len(f.pub.got)
	f.pub.mu.Unlock()
	if n != 0 {
		t.Fatalf("published %d VOICE_STATE_UPDATEs for a superseded connection", n)
	}
}

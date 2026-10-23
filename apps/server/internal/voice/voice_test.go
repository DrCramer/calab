package voice

import (
	"testing"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

func TestAggregate(t *testing.T) {
	ws, u, other := uuid.New(), uuid.New(), uuid.New()
	r1, r2 := uuid.New(), uuid.New()
	s1, s2, s3 := uuid.New(), uuid.New(), uuid.New()

	if st := Aggregate(ws, u, nil); st.GetRoomId() != "" || st.GetUserId() != u.String() {
		t.Fatalf("absent user: %v", st)
	}
	sessions := []SessionState{
		{UserID: u, SessionID: s1, RoomID: r1, Muted: true, Deafened: false, JoinedAt: 100},
		{UserID: u, SessionID: s2, RoomID: r1, Muted: false, Streaming: true, JoinedAt: 200},
		{UserID: other, SessionID: s3, RoomID: r2, Muted: true, JoinedAt: 300},
	}
	st := Aggregate(ws, u, sessions)
	if st.GetRoomId() != r1.String() || st.GetMuted() || st.GetDeafened() || !st.GetStreaming() {
		t.Fatalf("two devices in one room: %v", st)
	}
	sessions[1].Muted = true
	if st := Aggregate(ws, u, sessions); !st.GetMuted() {
		t.Fatal("muted must be true when all sessions are muted")
	}
	// A newer session in another room wins; flags come from that room only.
	sessions = append(sessions, SessionState{UserID: u, SessionID: uuid.New(), RoomID: r2, JoinedAt: 500})
	if st := Aggregate(ws, u, sessions); st.GetRoomId() != r2.String() || st.GetStreaming() || st.GetMuted() {
		t.Fatalf("latest room: %v", st)
	}
	all := AggregateAll(ws, sessions)
	if len(all) != 2 {
		t.Fatalf("AggregateAll: %d users", len(all))
	}
}

// A user is pending only while every device in their room is still connecting (optimistic
// join, docs/05): one connected device makes them connected; a change of pending is a change.
func TestAggregatePending(t *testing.T) {
	ws, u, r := uuid.New(), uuid.New(), uuid.New()
	sessions := []SessionState{{UserID: u, SessionID: uuid.New(), RoomID: r, Pending: true, JoinedAt: 100}}
	pending := Aggregate(ws, u, sessions)
	if !pending.GetPending() {
		t.Fatalf("single connecting device: %v", pending)
	}
	sessions = append(sessions, SessionState{UserID: u, SessionID: uuid.New(), RoomID: r, JoinedAt: 50})
	connected := Aggregate(ws, u, sessions)
	if connected.GetPending() {
		t.Fatalf("one connected device: %v", connected)
	}
	sessions[1].Pending = true
	if !Aggregate(ws, u, sessions).GetPending() {
		t.Fatal("all devices connecting: pending")
	}
	if Equal(pending, &v1.VoiceState{WorkspaceId: pending.GetWorkspaceId(), UserId: pending.GetUserId(), RoomId: pending.GetRoomId(),
		Muted: pending.GetMuted(), Deafened: pending.GetDeafened(), JoinedAt: pending.GetJoinedAt()}) {
		t.Fatal("Equal ignores pending: the flip would not be published")
	}
}

// Musician mode (ADR-0052): any device of the user in their room; a flip is a change.
func TestAggregateMusician(t *testing.T) {
	ws, u, r1, r2 := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	sessions := []SessionState{
		{UserID: u, SessionID: uuid.New(), RoomID: r1, JoinedAt: 100},
		{UserID: u, SessionID: uuid.New(), RoomID: r1, Musician: true, JoinedAt: 200},
	}
	on := Aggregate(ws, u, sessions)
	if !on.GetMusician() {
		t.Fatalf("one device in musician mode: %v", on)
	}
	sessions[1].Musician = false
	off := Aggregate(ws, u, sessions)
	if off.GetMusician() || Equal(on, off) {
		t.Fatalf("musician flip must be a change: %v", off)
	}
	// A device in musician mode in another (older) room does not mark the current one.
	sessions = append(sessions, SessionState{UserID: u, SessionID: uuid.New(), RoomID: r2, Musician: true, JoinedAt: 50})
	if Aggregate(ws, u, sessions).GetMusician() {
		t.Fatal("musician from another room")
	}
}

func TestNames(t *testing.T) {
	w, r, u, s := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	gw, gr, ok := ParseRoomName(RoomName(w, r))
	if !ok || gw != w || gr != r {
		t.Fatal("room name round trip")
	}
	gu, gs, ok := ParseIdentity(Identity(u, s))
	if !ok || gu != u || gs != s {
		t.Fatal("identity round trip")
	}
	for _, bad := range []string{"", "ws_x_room_y", "room", "ws_" + w.String()} {
		if _, _, ok := ParseRoomName(bad); ok {
			t.Errorf("%q parsed", bad)
		}
	}
	if _, _, ok := ParseIdentity("abc"); ok {
		t.Error("bad identity parsed")
	}
}

func TestDMRoomName(t *testing.T) {
	ws, room := uuid.New(), uuid.New()
	if n := RoomName(room, room); n != "dm:"+room.String() || !IsDMRoomName(n) {
		t.Fatalf("DM scope room name %q", n)
	}
	if w, r, ok := ParseRoomName("dm:" + room.String()); !ok || w != room || r != room {
		t.Fatalf("parse dm: %v %v %v", w, r, ok)
	}
	if _, _, ok := ParseRoomName("dm:nope"); ok {
		t.Fatal("malformed dm name parsed")
	}
	n := RoomName(ws, room)
	if IsDMRoomName(n) || IsDM(ws, room) {
		t.Fatalf("workspace room taken for a DM: %q", n)
	}
	if w, r, ok := ParseRoomName(n); !ok || w != ws || r != room {
		t.Fatalf("parse ws: %v %v %v", w, r, ok)
	}
}

// Push-to-talk mode (ADR-0130): all devices of the user in their room; a flip is a change.
func TestAggregatePtt(t *testing.T) {
	ws, u, r1 := uuid.New(), uuid.New(), uuid.New()
	sessions := []SessionState{
		{UserID: u, SessionID: uuid.New(), RoomID: r1, Ptt: true, JoinedAt: 100},
		{UserID: u, SessionID: uuid.New(), RoomID: r1, JoinedAt: 200},
	}
	mixed := Aggregate(ws, u, sessions)
	if mixed.GetPtt() {
		t.Fatalf("one device on voice activation keeps the user off push-to-talk: %v", mixed)
	}
	sessions[1].Ptt = true
	on := Aggregate(ws, u, sessions)
	if !on.GetPtt() || Equal(mixed, on) {
		t.Fatalf("all devices in push-to-talk, and the flip must be a change: %v", on)
	}
	if Aggregate(ws, uuid.New(), sessions).GetPtt() {
		t.Fatal("a user without sessions has no ptt")
	}
}

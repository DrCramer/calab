//go:build integration

// Archive of temporary rooms: restore, make permanent, per-workspace retention (ADR-0044 addendum 14.10).
package app_test

import (
	"context"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

func TestTempRoomArchiveActions(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	wid := ws.GetId()
	if ws.GetTempArchiveDays() != 30 {
		t.Fatalf("a new workspace keeps the archive 30 days, got %d", ws.GetTempArchiveDays())
	}
	code := invite(t, o, wid)
	bob, carol := register(t, code), register(t, code)
	archived := func(u *user) map[string]*v1.Room {
		t.Helper()
		var l v1.ListRoomsResponse
		u.must(200, "GET", "/api/workspaces/"+wid+"/rooms?archived=1", nil, &l)
		m := map[string]*v1.Room{}
		for _, r := range l.GetRooms() {
			m[r.GetId()] = r
		}
		return m
	}

	// A public room of 2 h by bob, with history; closed by its creator.
	pub := tempRoom(t, bob, wid, &v1.CreateTempRoomRequest{Name: "Созвон", TtlSeconds: 7200, Guests: noGuests()})
	pid := pub.GetRoom().GetId()
	bob.must(201, "POST", "/api/rooms/"+pid+"/messages", &v1.CreateMessageRequest{Content: "notes"}, nil)
	apiErrOf(t, bob.client, 409, "POST", "/api/rooms/"+pid+"/restore", nil) // live: nothing to restore
	bob.must(204, "DELETE", "/api/rooms/"+pid, nil, nil)
	if _, ok := archived(bob)[pid]; !ok {
		t.Fatal("the creator sees the closed room in the archive")
	}
	if len(archived(carol)) != 0 {
		t.Fatal("a member without rights sees no archive")
	}

	// Restore: the creator only (carol may read it but not manage it).
	apiErrOf(t, carol.client, 403, "POST", "/api/rooms/"+pid+"/restore", nil)
	g := dialGW(t)
	g.identify(carol.token)
	var back v1.RestoreTempRoomResponse
	bob.must(200, "POST", "/api/rooms/"+pid+"/restore", nil, &back)
	if d := time.Until(back.GetRoom().GetExpiresAt().AsTime()); d < 119*time.Minute || d > 2*time.Hour+time.Minute {
		t.Fatalf("restored for the original 2 h, got %v", d)
	}
	if back.GetRoom().GetArchivedAt() != nil {
		t.Fatalf("restored room is live: %v", back.GetRoom())
	}
	g.wait("ROOM_CREATE of the restored room", func(e *v1.DispatchEvent) bool { return e.GetRoomCreate().GetRoom().GetId() == pid })
	if _, ok := visibleRooms(t, carol, wid)[pid]; !ok {
		t.Fatal("the restored room is back in the list")
	}
	var links int
	if err := testDB.Pool.QueryRow(context.Background(), "SELECT count(*) FROM room_invites WHERE room_id = $1 AND revoked_at IS NULL", pid).Scan(&links); err != nil || links != 1 {
		t.Fatalf("a fresh link: %d %v", links, err)
	}
	apiErrOf(t, bob.client, 409, "POST", "/api/rooms/"+pid+"/restore", nil) // not archived any more

	// An unusable original lifetime falls back to one day.
	bob.must(204, "DELETE", "/api/rooms/"+pid, nil, nil)
	sqlExec(t, "UPDATE rooms SET expires_at = created_at + interval '1 second' WHERE id = $1", pid)
	bob.must(200, "POST", "/api/rooms/"+pid+"/restore", nil, &back)
	if d := time.Until(back.GetRoom().GetExpiresAt().AsTime()); d < 23*time.Hour || d > 24*time.Hour+time.Minute {
		t.Fatalf("default lifetime: %v", d)
	}

	// Make permanent needs the right to create regular rooms (MANAGE_ROOM at workspace level).
	bob.must(204, "DELETE", "/api/rooms/"+pid, nil, nil)
	apiErrOf(t, bob.client, 403, "POST", "/api/rooms/"+pid+"/make-permanent", nil)
	var perm v1.MakeRoomPermanentResponse
	o.must(200, "POST", "/api/rooms/"+pid+"/make-permanent", nil, &perm)
	if perm.GetRoom().GetExpiresAt() != nil || perm.GetRoom().GetArchivedAt() != nil || perm.GetRoom().GetName() != "Созвон" {
		t.Fatalf("permanent room: %v", perm.GetRoom())
	}
	if _, ok := visibleRooms(t, carol, wid)[pid]; !ok {
		t.Fatal("the permanent room is in the list")
	}
	var msgs v1.ListMessagesResponse
	carol.must(200, "GET", "/api/rooms/"+pid+"/messages", nil, &msgs)
	if len(msgs.GetMessages()) != 1 {
		t.Fatalf("history stays: %v", msgs.GetMessages())
	}
	if _, ok := archived(o)[pid]; ok {
		t.Fatal("a permanent room leaves the archive")
	}

	// ADR-0078: a private temporary room stays invisible to the owner — no restore, no conversion.
	priv := tempRoom(t, bob, wid, &v1.CreateTempRoomRequest{Name: "Клиент", TtlSeconds: 3600, Private: true, MemberIds: []string{carol.id}, Guests: noGuests()})
	qid := priv.GetRoom().GetId()
	bob.must(204, "DELETE", "/api/rooms/"+qid, nil, nil)
	apiErrOf(t, o.client, 404, "POST", "/api/rooms/"+qid+"/restore", nil)
	apiErrOf(t, o.client, 404, "POST", "/api/rooms/"+qid+"/make-permanent", nil)
	apiErrOf(t, carol.client, 403, "POST", "/api/rooms/"+qid+"/restore", nil) // invited, not the creator
	bob.must(200, "POST", "/api/rooms/"+qid+"/restore", nil, &back)
	if !back.GetRoom().GetIsPrivate() {
		t.Fatal("a restored private room stays private")
	}
	if _, ok := visibleRooms(t, o, wid)[qid]; ok {
		t.Fatal("the owner must not see the restored private room")
	}
}

func TestTempArchiveRetentionSetting(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	wid := ws.GetId()
	bob := register(t, invite(t, o, wid))
	days := func(n uint32) *v1.UpdateWorkspaceRequest { return &v1.UpdateWorkspaceRequest{TempArchiveDays: &n} }
	apiErrOf2 := func(u *user, want int, n uint32) {
		t.Helper()
		if st := u.do("PATCH", "/api/workspaces/"+wid, days(n), nil); st != want {
			t.Fatalf("temp_archive_days=%d by %s: %d, want %d", n, u.email, st, want)
		}
	}
	apiErrOf2(bob, 403, 7)
	apiErrOf2(o, 422, 5)
	apiErrOf2(o, 422, 0)
	var upd v1.UpdateWorkspaceResponse
	o.must(200, "PATCH", "/api/workspaces/"+wid, days(7), &upd)
	if upd.GetWorkspace().GetTempArchiveDays() != 7 {
		t.Fatalf("setting: %v", upd.GetWorkspace())
	}

	old := tempRoom(t, bob, wid, &v1.CreateTempRoomRequest{Name: "old", TtlSeconds: 3600, Guests: noGuests()}).GetRoom().GetId()
	fresh := tempRoom(t, bob, wid, &v1.CreateTempRoomRequest{Name: "fresh", TtlSeconds: 3600, Guests: noGuests()}).GetRoom().GetId()
	bob.must(204, "DELETE", "/api/rooms/"+old, nil, nil)
	bob.must(204, "DELETE", "/api/rooms/"+fresh, nil, nil)
	sqlExec(t, "UPDATE rooms SET archived_at = now() - interval '8 days' WHERE id = $1", old)
	sqlExec(t, "UPDATE rooms SET archived_at = now() - interval '6 days' WHERE id = $1", fresh)
	if _, err := testApp.Rooms.PurgeTempRooms(context.Background()); err != nil {
		t.Fatal(err)
	}
	left := func(id string) int {
		var n int
		if err := testDB.Pool.QueryRow(context.Background(), "SELECT count(*) FROM rooms WHERE id = $1", id).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	if left(old) != 0 || left(fresh) != 1 {
		t.Fatalf("7 days: old=%d fresh=%d", left(old), left(fresh))
	}
	// 30 days keeps the 8-day-old one.
	o.must(200, "PATCH", "/api/workspaces/"+wid, days(30), &upd)
	sqlExec(t, "UPDATE rooms SET archived_at = now() - interval '8 days' WHERE id = $1", fresh)
	if _, err := testApp.Rooms.PurgeTempRooms(context.Background()); err != nil {
		t.Fatal(err)
	}
	if left(fresh) != 1 {
		t.Fatal("30 days keeps an 8-day-old archive")
	}
}

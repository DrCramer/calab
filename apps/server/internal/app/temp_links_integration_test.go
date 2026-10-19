//go:build integration

// Links of a temporary room survive its archive and its conversion; link editing (ADR-0107).
package app_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
)

// linkState reads a link's revoked / expiry state from the database.
func linkState(t *testing.T, code string) (revoked bool, expires *time.Time) {
	t.Helper()
	if err := testDB.Pool.QueryRow(context.Background(),
		"SELECT revoked_at IS NOT NULL, expires_at FROM room_invites WHERE code = $1", code).Scan(&revoked, &expires); err != nil {
		t.Fatal(err)
	}
	return revoked, expires
}

func activeLinks(t *testing.T, roomID string) int {
	t.Helper()
	var n int
	if err := testDB.Pool.QueryRow(context.Background(),
		"SELECT count(*) FROM room_invites WHERE room_id = $1 AND revoked_at IS NULL", roomID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestTempRoomLinksSurviveArchive(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	wid := ws.GetId()
	code := invite(t, o, wid)
	bob, dave := register(t, code), register(t, code)
	// bob may invite guests; dave manages rooms (restore, make permanent) but may not invite guests.
	if st, _ := setMemberRoles(o, wid, bob.id, newRole(t, o, wid, "Inviter", perm.InviteGuests).GetId()); st != 200 {
		t.Fatalf("bob's role: %d", st)
	}
	if st, _ := setMemberRoles(o, wid, dave.id, newRole(t, o, wid, "Rooms", perm.ManageRoom).GetId()); st != 200 {
		t.Fatalf("dave's role: %d", st)
	}
	joinStatus := func(code string) int {
		t.Helper()
		admissionIP++
		c := &client{t: t, ip: fmt.Sprintf("10.141.%d.%d", admissionIP/250, admissionIP%250+1)}
		return c.do("POST", "/api/room-invites/"+code+"/join", &v1.JoinRoomInviteRequest{Nickname: "Гость"}, nil)
	}

	// A guest room of 2 h: its own guest link, a 30-day guest link, a members-only link revoked by hand.
	tr := tempRoom(t, bob, wid, &v1.CreateTempRoomRequest{Name: "Клиент", TtlSeconds: 7200})
	rid, guestCode := tr.GetRoom().GetId(), tr.GetInviteCode()
	month := uint32(30 * 86400)
	long := roomLink(t, bob, rid, &v1.CreateRoomInviteRequest{ExpiresInSeconds: &month})
	gone := roomLink(t, bob, rid, &v1.CreateRoomInviteRequest{MembersOnly: true})
	bob.must(204, "DELETE", "/api/rooms/"+rid+"/invites/"+gone.GetId(), nil, nil)

	bob.must(204, "DELETE", "/api/rooms/"+rid, nil, nil)
	if st := joinStatus(guestCode); st == 201 {
		t.Fatal("an archived room's link does not work")
	}
	var back v1.RestoreTempRoomResponse
	bob.must(200, "POST", "/api/rooms/"+rid+"/restore", nil, &back)
	end := back.GetRoom().GetExpiresAt().AsTime()
	if revoked, exp := linkState(t, guestCode); revoked || exp == nil || !exp.Equal(end) {
		t.Fatalf("the room's guest link is back with the new end %v: revoked=%v %v", end, revoked, exp)
	}
	if revoked, exp := linkState(t, long.GetCode()); revoked || exp == nil || !exp.Equal(long.GetExpiresAt().AsTime().Truncate(time.Microsecond)) {
		t.Fatalf("the 30-day link keeps its own end: revoked=%v %v", revoked, exp)
	}
	if revoked, _ := linkState(t, gone.GetCode()); !revoked {
		t.Fatal("a link revoked by hand stays revoked")
	}
	if n := activeLinks(t, rid); n != 2 {
		t.Fatalf("no fresh link when links came back: %d active", n)
	}
	if st := joinStatus(guestCode); st != 201 {
		t.Fatalf("a guest joins the restored room by its old link: %d", st)
	}

	// dave (no INVITE_GUESTS) restores: guest links stay revoked for good, a fresh members-only link.
	bob.must(204, "DELETE", "/api/rooms/"+rid, nil, nil)
	dave.must(200, "POST", "/api/rooms/"+rid+"/restore", nil, &back)
	if revoked, _ := linkState(t, guestCode); !revoked {
		t.Fatal("a restorer without INVITE_GUESTS does not bring guest links back")
	}
	var members bool
	if err := testDB.Pool.QueryRow(context.Background(),
		"SELECT bool_and(members_only) FROM room_invites WHERE room_id = $1 AND revoked_at IS NULL", rid).Scan(&members); err != nil || !members || activeLinks(t, rid) != 1 {
		t.Fatalf("one fresh members-only link: %v %v", members, err)
	}
	bob.must(204, "DELETE", "/api/rooms/"+rid, nil, nil)
	bob.must(200, "POST", "/api/rooms/"+rid+"/restore", nil, &back)
	if revoked, _ := linkState(t, guestCode); !revoked {
		t.Fatal("guest links left behind by a restore stay revoked")
	}

	// Make permanent, live: the links bound to the room's end never expire; dave's links follow
	// only the members-only ones (no INVITE_GUESTS).
	live := tempRoom(t, bob, wid, &v1.CreateTempRoomRequest{Name: "Живая", TtlSeconds: 3600})
	lid := live.GetRoom().GetId()
	o.must(200, "POST", "/api/rooms/"+lid+"/make-permanent", nil, nil)
	if revoked, exp := linkState(t, live.GetInviteCode()); revoked || exp != nil {
		t.Fatalf("a permanent room's link never expires: revoked=%v %v", revoked, exp)
	}
	live2 := tempRoom(t, bob, wid, &v1.CreateTempRoomRequest{Name: "Живая 2", TtlSeconds: 3600})
	dave.must(200, "POST", "/api/rooms/"+live2.GetRoom().GetId()+"/make-permanent", nil, nil)
	if _, exp := linkState(t, live2.GetInviteCode()); exp == nil {
		t.Fatal("without INVITE_GUESTS a guest link keeps its end")
	}

	// Make permanent, archived: the links come back first, never expiring; a guest joins.
	arch := tempRoom(t, bob, wid, &v1.CreateTempRoomRequest{Name: "Архив", TtlSeconds: 3600})
	aid := arch.GetRoom().GetId()
	bob.must(204, "DELETE", "/api/rooms/"+aid, nil, nil)
	o.must(200, "POST", "/api/rooms/"+aid+"/make-permanent", nil, nil)
	if revoked, exp := linkState(t, arch.GetInviteCode()); revoked || exp != nil {
		t.Fatalf("an archived room made permanent brings its link back for good: revoked=%v %v", revoked, exp)
	}
	if st := joinStatus(arch.GetInviteCode()); st != 201 {
		t.Fatalf("a guest joins by it: %d", st)
	}

	// The sweeper's archive (expired room) marks the bound link too.
	swept := tempRoom(t, bob, wid, &v1.CreateTempRoomRequest{Name: "Истекла", TtlSeconds: 3600})
	sid := swept.GetRoom().GetId()
	sqlExec(t, "UPDATE rooms SET expires_at = now() - interval '1 second' WHERE id = $1", sid)
	sqlExec(t, "UPDATE room_invites SET expires_at = (SELECT expires_at FROM rooms WHERE id = $1) WHERE room_id = $1", sid)
	if _, err := testApp.Rooms.SweepTempRooms(context.Background()); err != nil {
		t.Fatal(err)
	}
	bob.must(200, "POST", "/api/rooms/"+sid+"/restore", nil, &back)
	if revoked, exp := linkState(t, swept.GetInviteCode()); revoked || exp == nil || !exp.After(time.Now()) {
		t.Fatalf("an expired room's link comes back with its new end: revoked=%v %v", revoked, exp)
	}
}

func TestRoomLinkEdit(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	wid := ws.GetId()
	carol := register(t, invite(t, o, wid))
	u32 := func(n uint32) *uint32 { return &n }
	yes, no := true, false

	// carol's temporary room (members only): she manages its members-only links as its creator.
	tr := tempRoom(t, carol, wid, &v1.CreateTempRoomRequest{Name: "Carol", TtlSeconds: 3600, Guests: noGuests()})
	rid := tr.GetRoom().GetId()
	var l v1.ListRoomInvitesResponse
	carol.must(200, "GET", "/api/rooms/"+rid+"/invites", nil, &l)
	if len(l.GetInvites()) != 1 {
		t.Fatalf("the room's link: %v", l.GetInvites())
	}
	own := l.GetInvites()[0]
	path := "/api/rooms/" + rid + "/invites/" + own.GetId()
	var ur v1.UpdateRoomInviteResponse
	carol.must(200, "PATCH", path, &v1.UpdateRoomInviteRequest{ExpiresInSeconds: u32(86400), MaxUses: u32(5), AllowMessages: &no}, &ur)
	inv := ur.GetInvite()
	if d := time.Until(inv.GetExpiresAt().AsTime()); d < 23*time.Hour || d > 24*time.Hour+time.Minute || inv.GetMaxUses() != 5 || inv.GetAllowMessages() || !inv.GetMembersOnly() {
		t.Fatalf("edited link: %v", inv)
	}
	carol.must(200, "PATCH", path, &v1.UpdateRoomInviteRequest{ExpiresInSeconds: u32(0)}, &ur)
	if ur.GetInvite().GetExpiresAt() != nil || ur.GetInvite().GetMaxUses() != 5 {
		t.Fatalf("never expires, uses kept: %v", ur.GetInvite())
	}
	carol.must(422, "PATCH", path, &v1.UpdateRoomInviteRequest{ExpiresInSeconds: u32(366 * 86400)}, nil)
	carol.must(422, "PATCH", path, &v1.UpdateRoomInviteRequest{MaxUses: u32(10001)}, nil)
	carol.must(422, "PATCH", path, &v1.UpdateRoomInviteRequest{}, nil)
	carol.must(403, "PATCH", path, &v1.UpdateRoomInviteRequest{RequireApproval: &yes}, nil) // approval: INVITE_GUESTS

	// A guest link in her room (made by the owner): no INVITE_GUESTS → 403; the owner may.
	guest := roomLink(t, o, rid, &v1.CreateRoomInviteRequest{})
	gpath := "/api/rooms/" + rid + "/invites/" + guest.GetId()
	carol.must(403, "PATCH", gpath, &v1.UpdateRoomInviteRequest{ExpiresInSeconds: u32(3600)}, nil)
	o.must(200, "PATCH", gpath, &v1.UpdateRoomInviteRequest{MaxUses: u32(1), AllowFiles: &yes, ExpiresInSeconds: u32(3600)}, &ur)
	if g := ur.GetInvite(); g.GetMaxUses() != 1 || !g.GetAllowFiles() || !g.GetAllowGuests() || g.GetMembersOnly() {
		t.Fatalf("edited guest link: %v", g)
	}
	// Used up: no longer active, nothing to edit.
	admissionIP++
	c := &client{t: t, ip: fmt.Sprintf("10.142.0.%d", admissionIP%250+1)}
	c.must(201, "POST", "/api/room-invites/"+guest.GetCode()+"/join", &v1.JoinRoomInviteRequest{Nickname: "Гость"}, nil)
	o.must(404, "PATCH", gpath, &v1.UpdateRoomInviteRequest{MaxUses: u32(10)}, nil)

	// max_uses must stay above the uses so far.
	two := roomLink(t, o, rid, &v1.CreateRoomInviteRequest{MaxUses: 3})
	admissionIP++
	c2 := &client{t: t, ip: fmt.Sprintf("10.142.1.%d", admissionIP%250+1)}
	c2.must(201, "POST", "/api/room-invites/"+two.GetCode()+"/join", &v1.JoinRoomInviteRequest{Nickname: "Гость 2"}, nil)
	o.must(422, "PATCH", "/api/rooms/"+rid+"/invites/"+two.GetId(), &v1.UpdateRoomInviteRequest{MaxUses: u32(1)}, nil)

	// Editing the rights keeps the bits a PATCH does not name (VIDEO of a temporary room's link).
	var bits int64
	if err := testDB.Pool.QueryRow(context.Background(), "SELECT allow_bits FROM room_invites WHERE id = $1", own.GetId()).Scan(&bits); err != nil {
		t.Fatal(err)
	}
	if !perm.Bits(uint64(bits)).Has(perm.Video) { //nolint:gosec // bit mask
		t.Fatalf("a temporary room's link keeps VIDEO after a rights edit: %b", bits)
	}

	// No escalation through an edit: erin may invite guests but not stream in this room; she may
	// not extend the owner's streaming link unless she also takes STREAM off it.
	erin := register(t, invite(t, o, wid))
	if st, _ := setMemberRoles(o, wid, erin.id, newRole(t, o, wid, "Inviter", perm.InviteGuests).GetId()); st != 200 {
		t.Fatalf("erin's role: %d", st)
	}
	var cr v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+wid+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_VOICE, Name: "no-stream"}, &cr)
	vid := cr.GetRoom().GetId()
	o.must(200, "PUT", "/api/rooms/"+vid+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: []*v1.RoomPermissionOverride{
		{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER, TargetId: erin.id, Deny: uint64(perm.Stream)},
	}}, nil)
	broad := roomLink(t, o, vid, &v1.CreateRoomInviteRequest{AllowStream: &yes})
	bpath := "/api/rooms/" + vid + "/invites/" + broad.GetId()
	erin.must(403, "PATCH", bpath, &v1.UpdateRoomInviteRequest{ExpiresInSeconds: u32(0)}, nil)
	erin.must(403, "PATCH", bpath, &v1.UpdateRoomInviteRequest{MaxUses: u32(100)}, nil)
	erin.must(200, "PATCH", bpath, &v1.UpdateRoomInviteRequest{RequireApproval: &yes}, nil) // approval only: as before
	erin.must(200, "PATCH", bpath, &v1.UpdateRoomInviteRequest{AllowStream: &no, ExpiresInSeconds: u32(3600)}, &ur)
	if ur.GetInvite().GetAllowStream() {
		t.Fatalf("stream taken off: %v", ur.GetInvite())
	}
}

//go:build integration

package app_test

import (
	"context"
	"testing"

	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
)

// ADR-0078 addendum 2026-10-14: a private permanent room is seen by its creator and the invited
// (people and roles) only — not by admins, not by the workspace owner unless «Владелец видит
// приватное» is on, and then the owner alone has every bit.
func TestPrivateRoomHiddenFromAdminsAndOwner(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	wid := ws.GetId()
	code := invite(t, o, wid)
	creator, admin, invited, roleMember, plain := register(t, code), register(t, code), register(t, code), register(t, code), register(t, code)
	adminR := v1.WorkspaceRole_WORKSPACE_ROLE_ADMIN
	for _, a := range []*user{creator, admin} {
		o.must(200, "PATCH", "/api/workspaces/"+wid+"/members/"+a.id, &v1.UpdateMemberRequest{Role: &adminR}, nil)
	}
	team := newRole(t, o, wid, "team", 0)
	if st, _ := setMemberRoles(o, wid, roleMember.id, team.GetId()); st != 200 {
		t.Fatalf("assign team: %d", st)
	}
	// member_ids / role_ids only on a private room.
	if st := creator.do("POST", "/api/workspaces/"+wid+"/rooms", &v1.CreateRoomRequest{
		Type: v1.RoomType_ROOM_TYPE_TEXT, Name: "pub", MemberIds: []string{invited.id},
	}, nil); st != 422 {
		t.Fatalf("invitees on a public room: %d, want 422", st)
	}
	adminRoleID := builtinRole(t, o, wid, adminR).GetId()
	if st := creator.do("POST", "/api/workspaces/"+wid+"/rooms", &v1.CreateRoomRequest{
		Type: v1.RoomType_ROOM_TYPE_TEXT, Name: "x", IsPrivate: true, RoleIds: []string{adminRoleID},
	}, nil); st != 422 {
		t.Fatalf("inviting the admin role: %d, want 422", st)
	}
	var cr v1.CreateRoomResponse
	creator.must(201, "POST", "/api/workspaces/"+wid+"/rooms", &v1.CreateRoomRequest{
		Type: v1.RoomType_ROOM_TYPE_TEXT, Name: "secret", IsPrivate: true,
		MemberIds: []string{invited.id}, RoleIds: []string{team.GetId()},
	}, &cr)
	rid := cr.GetRoom().GetId()
	if !cr.GetRoom().GetIsPrivate() || !cr.GetRoom().GetRestricted() {
		t.Fatalf("private room flags: is_private %v restricted %v", cr.GetRoom().GetIsPrivate(), cr.GetRoom().GetRestricted())
	}
	member := perm.RoleDefaults[perm.RoleMember]
	for name, c := range map[string]struct {
		u    *user
		st   int
		bits perm.Bits
	}{
		"creator (an admin)": {creator, 200, member | perm.RoomOnly},
		"admin":              {admin, 404, 0},
		"owner":              {o, 404, 0},
		"invited":            {invited, 200, member},
		"invited role":       {roleMember, 200, member},
		"plain member":       {plain, 404, 0},
	} {
		bits, st := roomPerms(t, c.u, rid)
		_, listed := visibleRooms(t, c.u, wid)[rid]
		if st != c.st || perm.Bits(bits) != c.bits || listed != (c.st == 200) {
			t.Errorf("%s: GET %d bits %d listed %v, want %d bits %d", name, st, bits, listed, c.st, c.bits)
		}
	}
	msg := sendRetry(t, creator, rid, "private-room-needle @"+admin.id+" @"+invited.id)
	for u, want := range map[*user]int{admin: 404, o: 404, invited: 200} {
		if st := u.do("GET", "/api/rooms/"+rid+"/messages", nil, nil); st != want {
			t.Errorf("messages as %s: %d, want %d", u.id, st, want)
		}
	}
	for u, want := range map[*user]bool{admin: false, o: false, invited: true} {
		var sr v1.ListMessagesResponse
		u.must(200, "GET", "/api/workspaces/"+wid+"/messages/search?q=private-room-needle", nil, &sr)
		found := false
		for _, m := range sr.GetMessages() {
			found = found || m.GetId() == msg.GetId()
		}
		if found != want {
			t.Errorf("search as %s: %v, want %v", u.id, found, want)
		}
	}
	for u, want := range map[*user]bool{admin: false, invited: true} {
		var mr v1.ListMessagesResponse
		u.must(200, "GET", "/api/me/mentions?workspace_id="+wid, nil, &mr)
		found := false
		for _, m := range mr.GetMessages() {
			found = found || m.GetId() == msg.GetId()
		}
		if found != want {
			t.Errorf("mentions of %s: %v, want %v", u.id, found, want)
		}
	}

	// «Владелец видит приватное»: the owner alone gets everything; admins still nothing.
	setOwnerSeesPrivate(t, wid, true)
	if bits, st := roomPerms(t, o, rid); st != 200 || perm.Bits(bits) != perm.All {
		t.Fatalf("owner with the setting: %d bits %d, want 200 all", st, bits)
	}
	if _, st := roomPerms(t, admin, rid); st != 404 {
		t.Fatalf("admin with the owner's setting on: %d, want 404", st)
	}
	n := "renamed"
	o.must(200, "PATCH", "/api/rooms/"+rid, &v1.UpdateRoomRequest{Name: &n}, nil)
	setOwnerSeesPrivate(t, wid, false)
	if _, st := roomPerms(t, o, rid); st != 404 {
		t.Fatalf("owner after the setting is off: %d, want 404", st)
	}

	// Public again: admins bypass as before; private again: the switcher keeps it.
	off, on := false, true
	if st := creator.do("PATCH", "/api/rooms/"+rid, &v1.UpdateRoomRequest{IsPrivate: &off, Restricted: &on}, nil); st != 422 {
		t.Fatalf("is_private and restricted disagree: %d, want 422", st)
	}
	var res v1.UpdateRoomResponse
	creator.must(200, "PATCH", "/api/rooms/"+rid, &v1.UpdateRoomRequest{IsPrivate: &off}, &res)
	if res.GetRoom().GetIsPrivate() || res.GetRoom().GetRestricted() {
		t.Fatal("public room still flagged private")
	}
	if bits, st := roomPerms(t, admin, rid); st != 200 || perm.Bits(bits) != perm.All {
		t.Fatalf("admin in the public room: %d bits %d", st, bits)
	}
	admin.must(200, "PATCH", "/api/rooms/"+rid, &v1.UpdateRoomRequest{Restricted: &on}, &res)
	if !res.GetRoom().GetIsPrivate() || !res.GetRoom().GetRestricted() {
		t.Fatal("restricted alias did not make the room private")
	}
	if bits, st := roomPerms(t, admin, rid); st != 200 || !perm.Bits(bits).Has(perm.ViewRoom|perm.ManageRoom) || perm.Bits(bits) == perm.All {
		t.Fatalf("admin who made it private: %d bits %d", st, bits)
	}
	if _, st := roomPerms(t, o, rid); st != 404 {
		t.Fatalf("owner after an admin made it private: %d, want 404", st)
	}
}

// «Сделать меня владельцем» (ADR-0078 addendum 2026-10-14): a former member's private room.
func TestPrivateRoomTakeOver(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	wid := ws.GetId()
	code := invite(t, o, wid)
	leaver, admin := register(t, code), register(t, code)
	adminR := v1.WorkspaceRole_WORKSPACE_ROLE_ADMIN
	for _, a := range []*user{leaver, admin} {
		o.must(200, "PATCH", "/api/workspaces/"+wid+"/members/"+a.id, &v1.UpdateMemberRequest{Role: &adminR}, nil)
	}
	var cr v1.CreateRoomResponse
	leaver.must(201, "POST", "/api/workspaces/"+wid+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_VOICE, Name: "leaver's", IsPrivate: true}, &cr)
	rid := cr.GetRoom().GetId()
	takeOver := func(u *user) int { return u.do("POST", "/api/rooms/"+rid+"/take-over", nil, nil) }
	ownerOnly := func(u *user, what string) {
		t.Helper()
		var e v1.ApiError
		if st := takeOver(u); st != 403 || protojson.Unmarshal(u.lastBody, &e) != nil || e.GetReason() != "OWNER_ONLY" {
			t.Fatalf("%s: %d %s, want 403 OWNER_ONLY", what, st, u.lastBody)
		}
	}
	if st := takeOver(o); st != 404 {
		t.Fatalf("owner, setting off: %d, want 404", st)
	}
	ownerOnly(leaver, "the creator (an admin) takes over")
	setOwnerSeesPrivate(t, wid, true)
	if st := takeOver(o); st != 409 {
		t.Fatalf("creator still a member: %d, want 409", st)
	}
	o.must(204, "DELETE", "/api/workspaces/"+wid+"/members/"+leaver.id, nil, nil)
	var res v1.UpdateRoomResponse
	o.must(200, "POST", "/api/rooms/"+rid+"/take-over", nil, &res)
	if res.GetRoom().GetCreatedBy() != o.id {
		t.Fatalf("created_by %q, want the owner", res.GetRoom().GetCreatedBy())
	}
	var n int
	if err := testDB.Pool.QueryRow(context.Background(),
		"SELECT count(*) FROM workspace_audit WHERE workspace_id = $1 AND kind = 'take_over' AND subject_type = 'room' AND subject_id = $2 AND previous_owner_id = $3 AND actor_id = $4",
		wid, rid, leaver.id, o.id).Scan(&n); err != nil || n != 1 {
		t.Fatalf("audit rows %d %v, want 1", n, err)
	}
	if st := takeOver(o); st != 409 {
		t.Fatalf("taking over one's own room: %d, want 409", st)
	}
	// The owner keeps managing it with the setting off.
	setOwnerSeesPrivate(t, wid, false)
	if bits, st := roomPerms(t, o, rid); st != 200 || !perm.Bits(bits).Has(perm.ViewRoom|perm.ManageRoom) {
		t.Fatalf("owner after taking over, setting off: %d bits %d", st, bits)
	}
	if _, st := roomPerms(t, admin, rid); st != 404 {
		t.Fatalf("admin: %d, want 404", st)
	}
	o.must(204, "DELETE", "/api/rooms/"+rid, nil, nil)
	// A public room is not taken over.
	setOwnerSeesPrivate(t, wid, true)
	var pub v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+wid+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_TEXT, Name: "pub"}, &pub)
	if st := o.do("POST", "/api/rooms/"+pub.GetRoom().GetId()+"/take-over", nil, nil); st != 409 {
		t.Fatalf("public room: %d, want 409", st)
	}
}

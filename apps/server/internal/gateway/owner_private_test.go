package gateway

import (
	"testing"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
)

// Addendum 2026-10-14: switching «Владелец видит приватное» makes the private rooms and boards
// appear in (and disappear from) the owner's sessions; an admin's sessions only get the
// WORKSPACE_UPDATE.
func TestOwnerSeesPrivateToggleTransitions(t *testing.T) {
	wid, rid, bid := uuid.New(), uuid.New(), uuid.New()
	h, owner := stateTestHub(t, wid)
	admin := testSession()
	admin.hub, admin.ready, admin.conn = h, true, liveConn(t)
	h.register(admin, []uuid.UUID{wid})
	creator := uuid.New()
	st := &wsState{ws: &v1.Workspace{Id: wid.String()}, rooms: map[uuid.UUID]*v1.Room{}, roleDefs: perm.Roles{
		"member": {ID: "member", Position: perm.PosMember, Permissions: perm.RoleDefaults[perm.RoleMember]},
		"admin":  {ID: "admin", Position: perm.PosAdmin, Permissions: perm.Administrator},
		"owner":  {ID: "owner", Position: perm.PosOwner, Permissions: perm.Administrator},
	}}
	st.setMember(owner.user, perm.RoleOwner, []string{"member", "owner"})
	st.setMember(admin.user, perm.RoleAdmin, []string{"member", "admin"})
	st.setMember(creator, perm.RoleMember, []string{"member"})
	deny := []*v1.RoomPermissionOverride{{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_ROLE, TargetId: "member", Deny: uint64(perm.ViewRoom)}}
	st.setRoom(rid, &v1.Room{Id: rid.String(), WorkspaceId: wid.String(), Type: v1.RoomType_ROOM_TYPE_TEXT, IsPrivate: true, Restricted: true,
		CreatedBy: creator.String(), PermissionOverrides: deny})
	st.setBoard(bid, &v1.Board{Id: bid.String(), WorkspaceId: wid.String(), IsPrivate: true, Restricted: true, CreatedBy: creator.String()})
	h.mu.Lock()
	h.states[wid] = st
	h.mu.Unlock()

	toggle := func(on bool) {
		ev := &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceUpdate{WorkspaceUpdate: &v1.WorkspaceUpdate{
			Workspace: &v1.Workspace{Id: wid.String(), OwnerSeesPrivate: on}}}}
		st.mu.Lock()
		h.routeLocked(st, wid, uuid.New(), ev)
		st.mu.Unlock()
	}
	got := func(s *Session) []string {
		var out []string
		for _, e := range drain(s) {
			switch d := decode(t, e).GetDispatch(); {
			case d.GetRoomCreate() != nil:
				out = append(out, "RoomCreate")
			case d.GetRoomDelete() != nil:
				out = append(out, "RoomDelete")
			case d.GetBoardCreate() != nil:
				out = append(out, "BoardCreate")
			case d.GetBoardDelete() != nil:
				out = append(out, "BoardDelete")
			case d.GetWorkspaceUpdate() != nil:
				out = append(out, "WorkspaceUpdate")
			default:
				out = append(out, "?")
			}
		}
		return out
	}
	drain(owner)
	drain(admin)

	toggle(true)
	if g := got(owner); !same(g, []string{"BoardCreate", "RoomCreate", "WorkspaceUpdate"}) {
		t.Fatalf("on: owner got %v", g)
	}
	if g := got(admin); !same(g, []string{"WorkspaceUpdate"}) {
		t.Fatalf("on: admin got %v", g)
	}
	if !st.bits(rid, owner.user).Has(perm.ViewRoom) || st.boardBits(bid, owner.user) != perm.All {
		t.Fatal("on: the owner's bits")
	}
	toggle(true) // no change: no transitions
	if g := got(owner); !same(g, []string{"WorkspaceUpdate"}) {
		t.Fatalf("same value: owner got %v", g)
	}
	toggle(false)
	if g := got(owner); !same(g, []string{"BoardDelete", "RoomDelete", "WorkspaceUpdate"}) {
		t.Fatalf("off: owner got %v", g)
	}
	if st.bits(rid, owner.user) != 0 || st.boardBits(bid, owner.user) != 0 {
		t.Fatal("off: the owner still sees private")
	}
}

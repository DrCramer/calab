package gateway

import (
	"testing"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/canvasacl"
	"github.com/calaba/calaba/server/internal/perm"
)

// ADR-0114 §6: CANVAS_ITEM_* reach only members who see the item; the access chains are stripped;
// who lost the item with a change gets CANVAS_ITEM_REMOVE.
func TestCanvasEventsPerRecipient(t *testing.T) {
	wid := uuid.New()
	alice, bob, guest, admin, bot := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	const memberCanvas = perm.CanvasView | perm.CanvasWrite
	st := &wsState{rooms: map[uuid.UUID]*v1.Room{}, roleDefs: perm.Roles{
		"member": {ID: "member", Position: perm.PosMember, Permissions: perm.RoleDefaults[perm.RoleMember] | memberCanvas},
		"guest":  {ID: "guest", Position: perm.PosGuest, Permissions: perm.RoleDefaults[perm.RoleGuest]},
		"admin":  {ID: "admin", Position: perm.PosAdmin, Permissions: perm.Administrator},
	}}
	st.setMember(alice, perm.RoleMember, []string{"member"})
	st.setMember(bob, perm.RoleMember, []string{"member"})
	st.setMember(guest, perm.RoleGuest, []string{"guest"})
	st.setMember(admin, perm.RoleAdmin, []string{"admin"})
	st.setMember(bot, perm.RoleMember, []string{"member"})
	st.setBot(bot, true)
	h := &Hub{}
	page := &v1.CanvasItem{Id: uuid.NewString(), WorkspaceId: wid.String(), Name: "Roadmap"}
	open := []perm.TreeNode{{OwnerID: alice.String()}}
	closed := []perm.TreeNode{{Restricted: true, OwnerID: alice.String(), Overrides: []perm.OverrideTarget{
		{TargetType: "user", TargetID: guest.String(), Override: perm.Override{Allow: perm.CanvasView}}}}}

	myBits := map[uuid.UUID]perm.Bits{}
	deliver := func(ev *v1.DispatchEvent) map[uuid.UUID]string {
		sessions := []*Session{{user: alice}, {user: bob}, {user: guest}, {user: admin}, {user: bot}}
		if !h.routeCanvas(st, wid, uuid.New(), sessions, ev) {
			t.Fatal("a canvas event not taken")
		}
		out := map[uuid.UUID]string{}
		for _, s := range sessions {
			for _, p := range s.pending {
				switch x := p.enc.ev.GetEvent().(type) {
				case *v1.DispatchEvent_CanvasItemUpsert:
					if len(x.CanvasItemUpsert.GetAccess()) > 0 || len(x.CanvasItemUpsert.GetAccessBefore()) > 0 {
						t.Fatal("access chain leaked to a client")
					}
					out[s.user] += "U"
					myBits[s.user] = perm.Bits(x.CanvasItemUpsert.GetItem().GetMyBits())
				case *v1.DispatchEvent_CanvasItemRemove:
					if len(x.CanvasItemRemove.GetAccess()) > 0 {
						t.Fatal("access chain leaked to a client")
					}
					out[s.user] += "R"
				}
			}
		}
		return out
	}
	upsert := func(after, before []perm.TreeNode) *v1.DispatchEvent {
		return &v1.DispatchEvent{Event: &v1.DispatchEvent_CanvasItemUpsert{CanvasItemUpsert: &v1.CanvasItemUpsert{
			WorkspaceId: wid.String(), Item: page, Access: canvasacl.Levels(after), AccessBefore: canvasacl.Levels(before)}}}
	}
	names := map[uuid.UUID]string{alice: "alice", bob: "bob", guest: "guest", admin: "admin", bot: "bot"}
	check := func(name string, got, want map[uuid.UUID]string) {
		t.Helper()
		for u, n := range names {
			if got[u] != want[u] {
				t.Errorf("%s: %s got %q, want %q", name, n, got[u], want[u])
			}
		}
	}
	check("open item", deliver(upsert(open, nil)), map[uuid.UUID]string{alice: "U", bob: "U", admin: "U"}) // bots: v2
	// my_bits is the recipient's own: an administrator manages, a member with CANVAS_WRITE does not.
	if myBits[admin]&perm.CanvasManage == 0 || myBits[bob]&perm.CanvasManage != 0 || myBits[bob]&perm.CanvasWrite == 0 || myBits[bob]&perm.CanvasView == 0 {
		t.Errorf("my_bits per recipient: admin %b, bob %b", myBits[admin], myBits[bob])
	}
	// The administrator is not let in either (addendum 2026-10-14): it loses the item like bob.
	check("restricted: bob and the admin lose it, the guest gains it", deliver(upsert(closed, open)),
		map[uuid.UUID]string{alice: "U", bob: "R", guest: "U", admin: "R"})
	check("deleted forever", deliver(&v1.DispatchEvent{Event: &v1.DispatchEvent_CanvasItemRemove{CanvasItemRemove: &v1.CanvasItemRemove{
		WorkspaceId: wid.String(), ItemId: page.GetId(), Access: canvasacl.Levels(closed)}}}),
		map[uuid.UUID]string{alice: "R", guest: "R"})
	if h.routeCanvas(st, wid, uuid.New(), nil, &v1.DispatchEvent{Event: &v1.DispatchEvent_BoardDelete{}}) {
		t.Fatal("a board event taken as a canvas event")
	}
}

// ADR-0115 wave 4: CANVAS_COMMENT_* reach only members who see the canvas (not bots), without
// the chain; a private canvas's comments reach only who was let in.
func TestCanvasCommentEventsPerRecipient(t *testing.T) {
	wid := uuid.New()
	alice, bob, guest, admin, bot := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	const memberCanvas = perm.CanvasView | perm.CanvasWrite
	st := &wsState{rooms: map[uuid.UUID]*v1.Room{}, roleDefs: perm.Roles{
		"member": {ID: "member", Position: perm.PosMember, Permissions: perm.RoleDefaults[perm.RoleMember] | memberCanvas},
		"guest":  {ID: "guest", Position: perm.PosGuest, Permissions: perm.RoleDefaults[perm.RoleGuest]},
		"admin":  {ID: "admin", Position: perm.PosAdmin, Permissions: perm.Administrator},
	}}
	st.setMember(alice, perm.RoleMember, []string{"member"})
	st.setMember(bob, perm.RoleMember, []string{"member"})
	st.setMember(guest, perm.RoleGuest, []string{"guest"})
	st.setMember(admin, perm.RoleAdmin, []string{"admin"})
	st.setMember(bot, perm.RoleMember, []string{"member"})
	st.setBot(bot, true)
	h := &Hub{}
	open := []perm.TreeNode{{OwnerID: alice.String()}}
	closed := []perm.TreeNode{{Restricted: true, OwnerID: alice.String(), Overrides: []perm.OverrideTarget{
		{TargetType: "user", TargetID: guest.String(), Override: perm.Override{Allow: perm.CanvasView}}}}}
	canvas := uuid.NewString()
	comment := &v1.CanvasComment{Id: uuid.NewString(), CanvasId: canvas, Body: "secret plan"}
	deliver := func(ev *v1.DispatchEvent) map[uuid.UUID]string {
		sessions := []*Session{{user: alice}, {user: bob}, {user: guest}, {user: admin}, {user: bot}}
		if !h.routeCanvas(st, wid, uuid.New(), sessions, ev) {
			t.Fatal("a comment event not taken")
		}
		out := map[uuid.UUID]string{}
		for _, s := range sessions {
			for _, p := range s.pending {
				switch x := p.enc.ev.GetEvent().(type) {
				case *v1.DispatchEvent_CanvasCommentUpsert:
					if len(x.CanvasCommentUpsert.GetAccess()) > 0 {
						t.Fatal("access chain leaked to a client")
					}
					if x.CanvasCommentUpsert.GetComment().GetBody() != "secret plan" {
						t.Fatal("comment lost")
					}
					out[s.user] += "U"
				case *v1.DispatchEvent_CanvasCommentDelete:
					if len(x.CanvasCommentDelete.GetAccess()) > 0 {
						t.Fatal("access chain leaked to a client")
					}
					out[s.user] += "D"
				}
			}
		}
		return out
	}
	upsert := func(chain []perm.TreeNode) *v1.DispatchEvent {
		return &v1.DispatchEvent{Event: &v1.DispatchEvent_CanvasCommentUpsert{CanvasCommentUpsert: &v1.CanvasCommentUpsert{
			WorkspaceId: wid.String(), Comment: comment, Access: canvasacl.Levels(chain)}}}
	}
	del := func(chain []perm.TreeNode) *v1.DispatchEvent {
		return &v1.DispatchEvent{Event: &v1.DispatchEvent_CanvasCommentDelete{CanvasCommentDelete: &v1.CanvasCommentDelete{
			WorkspaceId: wid.String(), CanvasId: canvas, CommentId: comment.GetId(), Access: canvasacl.Levels(chain)}}}
	}
	names := map[uuid.UUID]string{alice: "alice", bob: "bob", guest: "guest", admin: "admin", bot: "bot"}
	check := func(name string, got, want map[uuid.UUID]string) {
		t.Helper()
		for u, n := range names {
			if got[u] != want[u] {
				t.Errorf("%s: %s got %q, want %q", name, n, got[u], want[u])
			}
		}
	}
	check("open canvas", deliver(upsert(open)), map[uuid.UUID]string{alice: "U", bob: "U", admin: "U"})
	check("private canvas", deliver(upsert(closed)), map[uuid.UUID]string{alice: "U", guest: "U"})
	check("delete on a private canvas", deliver(del(closed)), map[uuid.UUID]string{alice: "D", guest: "D"})
	check("no chain reaches nobody", deliver(upsert(nil)), map[uuid.UUID]string{})
}

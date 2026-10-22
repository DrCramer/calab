package pbconv

import (
	"testing"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/perm"
)

// ADR-0117: a guest viewer never gets a member's internal number, every other member does.
func TestMemberForHidesExtensionFromGuests(t *testing.T) {
	m := sqlc.WorkspaceMember{WorkspaceID: uuid.New(), UserID: uuid.New(), Role: string(perm.RoleMember), SipExtension: "101"}
	u := sqlc.User{ID: m.UserID}
	for _, c := range []struct {
		viewer perm.Role
		bot    bool
		want   string
	}{
		{perm.RoleMember, false, "101"},
		{perm.RoleOwner, false, "101"},
		{perm.RoleMember, true, "101"}, // bots by the same rule
		{perm.RoleGuest, false, ""},
		{"", false, ""},
	} {
		if got := MemberFor(m, u, nil, c.viewer, c.bot).GetExtension(); got != c.want {
			t.Errorf("viewer %q bot %v: extension %q, want %q", c.viewer, c.bot, got, c.want)
		}
	}
	m.Role = string(perm.RoleGuest) // a guest never has one, whoever looks
	if got := MemberFor(m, u, nil, perm.RoleOwner, false).GetExtension(); got != "" {
		t.Errorf("guest member: extension %q", got)
	}
}

func TestStripForGuest(t *testing.T) {
	full := &v1.User{Id: "u", Email: "a@example.com", Phone: "+1"}
	for _, ev := range []*v1.DispatchEvent{
		{Event: &v1.DispatchEvent_WorkspaceMemberAdd{WorkspaceMemberAdd: &v1.WorkspaceMemberAdd{Member: &v1.WorkspaceMember{WorkspaceId: "w", User: full, Extension: "101"}}}},
		{Event: &v1.DispatchEvent_WorkspaceMemberUpdate{WorkspaceMemberUpdate: &v1.WorkspaceMemberUpdate{Member: &v1.WorkspaceMember{WorkspaceId: "w", User: full, Extension: "101"}}}},
	} {
		if !HasExtension(ev) {
			t.Fatalf("HasExtension: %v", ev)
		}
		out := StripForGuest(ev)
		m := out.GetWorkspaceMemberAdd().GetMember()
		if m == nil {
			m = out.GetWorkspaceMemberUpdate().GetMember()
		}
		if m.GetExtension() != "" || HasContactFields(m.GetUser()) || HasExtension(out) {
			t.Fatalf("not stripped: %v", out)
		}
		if !HasExtension(ev) || full.GetEmail() == "" {
			t.Fatal("the original was changed")
		}
	}
	plain := &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceMemberUpdate{WorkspaceMemberUpdate: &v1.WorkspaceMemberUpdate{Member: &v1.WorkspaceMember{WorkspaceId: "w", User: &v1.User{Id: "u"}}}}}
	if HasExtension(plain) || StripForGuest(plain) != plain {
		t.Fatal("an event without a number or contacts must pass unchanged")
	}
}

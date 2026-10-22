package pbconv

import (
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
)

// Internal numbers (ADR-0117 §3): WorkspaceMember.extension is shown to the members of the
// workspace who are not guests (bots included). A path that shows a member to a viewer drops it
// for a guest or non-member viewer: MemberFor does, the gateway strips workspace events per
// recipient (StripForGuest).

// ExtensionVisible reports whether a viewer of this role sees members' internal numbers.
func ExtensionVisible(viewerRole perm.Role) bool { return memberRole(viewerRole) }

// HasExtension reports whether ev is WORKSPACE_MEMBER_ADD / _UPDATE carrying a number.
func HasExtension(ev *v1.DispatchEvent) bool {
	switch e := ev.GetEvent().(type) {
	case *v1.DispatchEvent_WorkspaceMemberAdd:
		return e.WorkspaceMemberAdd.GetMember().GetExtension() != ""
	case *v1.DispatchEvent_WorkspaceMemberUpdate:
		return e.WorkspaceMemberUpdate.GetMember().GetExtension() != ""
	}
	return false
}

// StripForGuest returns ev as a guest recipient may see it: without contacts (StripEvent) and
// without the member's internal number — a copy when anything was removed.
func StripForGuest(ev *v1.DispatchEvent) *v1.DispatchEvent {
	ev = StripEvent(ev)
	if !HasExtension(ev) {
		return ev
	}
	switch e := ev.GetEvent().(type) {
	case *v1.DispatchEvent_WorkspaceMemberAdd:
		c := proto.CloneOf(e.WorkspaceMemberAdd)
		c.Member.Extension = ""
		return &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceMemberAdd{WorkspaceMemberAdd: c}}
	case *v1.DispatchEvent_WorkspaceMemberUpdate:
		c := proto.CloneOf(e.WorkspaceMemberUpdate)
		c.Member.Extension = ""
		return &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceMemberUpdate{WorkspaceMemberUpdate: c}}
	}
	return ev
}

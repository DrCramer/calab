//go:build integration

// «Владелец видит приватное» (addenda 2026-10-14 to ADR-0058 / ADR-0078 / ADR-0094 / ADR-0096):
// only the workspace owner switches it, every change goes to the workspace journal, and the
// journal is read by the owner and VIEW_JOURNALS holders.
package app_test

import (
	"testing"

	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

func TestOwnerSeesPrivateSetting(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	wid := ws.GetId()
	if ws.GetOwnerSeesPrivate() {
		t.Fatal("off by default")
	}
	code := invite(t, o, wid)
	adm, bob := register(t, code), register(t, code)
	adminRole := v1.WorkspaceRole_WORKSPACE_ROLE_ADMIN
	o.must(200, "PATCH", "/api/workspaces/"+wid+"/members/"+adm.id, &v1.UpdateMemberRequest{Role: &adminRole}, nil)
	path := "/api/workspaces/" + wid
	on := &v1.UpdateWorkspaceRequest{OwnerSeesPrivate: proto.Bool(true)}

	// Not delegable: the admin (ADMINISTRATOR, MANAGE_WORKSPACE) gets 403 OWNER_ONLY, a member 403.
	if _, reason := apiErrOf(t, adm.client, 403, "PATCH", path, on); reason != "OWNER_ONLY" {
		t.Fatalf("admin: reason %q", reason)
	}
	apiErrOf(t, bob.client, 403, "PATCH", path, on)

	g := dialGW(t)
	g.identify(adm.token)
	var got v1.UpdateWorkspaceResponse
	o.must(200, "PATCH", path, on, &got)
	if !got.GetWorkspace().GetOwnerSeesPrivate() {
		t.Fatalf("on: %v", got.GetWorkspace())
	}
	g.wait("WORKSPACE_UPDATE with the setting", func(e *v1.DispatchEvent) bool {
		return e.GetWorkspaceUpdate().GetWorkspace().GetOwnerSeesPrivate()
	})
	o.must(200, "PATCH", path, on, nil) // the same value: no second entry
	o.must(200, "PATCH", path, &v1.UpdateWorkspaceRequest{OwnerSeesPrivate: proto.Bool(false)}, &got)
	if got.GetWorkspace().GetOwnerSeesPrivate() {
		t.Fatal("off again")
	}

	// The journal: newest first, the owner and VIEW_JOURNALS (the admin) read it, a member does not.
	var j v1.ListWorkspaceAuditResponse
	o.must(200, "GET", path+"/audit", nil, &j)
	if len(j.GetEntries()) != 2 || j.GetEntries()[0].GetKind() != v1.WorkspaceAuditKind_WORKSPACE_AUDIT_KIND_OWNER_SEES_PRIVATE_OFF ||
		j.GetEntries()[1].GetKind() != v1.WorkspaceAuditKind_WORKSPACE_AUDIT_KIND_OWNER_SEES_PRIVATE_ON ||
		j.GetEntries()[1].GetActorId() != o.id {
		t.Fatalf("journal: %v", &j)
	}
	adm.must(200, "GET", path+"/audit?limit=1", nil, &j)
	if len(j.GetEntries()) != 1 {
		t.Fatalf("limit: %v", &j)
	}
	adm.must(200, "GET", path+"/audit?before="+j.GetEntries()[0].GetId(), nil, &j)
	if len(j.GetEntries()) != 1 || j.GetEntries()[0].GetKind() != v1.WorkspaceAuditKind_WORKSPACE_AUDIT_KIND_OWNER_SEES_PRIVATE_ON {
		t.Fatalf("before: %v", &j)
	}
	apiErrOf(t, bob.client, 403, "GET", path+"/audit", nil)
}

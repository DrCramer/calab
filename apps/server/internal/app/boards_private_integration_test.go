//go:build integration

package app_test

import (
	"context"
	"net/url"
	"slices"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
)

// setOwnerSeesPrivate flips «Владелец видит приватное» in the database (the REST switch belongs
// to the workspace settings; the resolver reads the column on every request).
func setOwnerSeesPrivate(t *testing.T, wid string, on bool) {
	t.Helper()
	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE workspaces SET owner_sees_private = $2 WHERE id = $1", wid, on); err != nil {
		t.Fatal(err)
	}
}

// globalSearchFinds reports whether GET /api/search finds a task titled title in the workspace.
func globalSearchFinds(t *testing.T, c *user, wid, title string) bool {
	t.Helper()
	var sr v1.SearchResponse
	c.must(200, "GET", "/api/search?q="+url.QueryEscape(title)+"&scope="+wid+"&types=tasks", nil, &sr)
	for _, s := range sr.GetSections() {
		for _, h := range s.GetItems() {
			if h.GetTitle() == title {
				return true
			}
		}
	}
	return false
}

// TestBoardsPrivateHiddenFromAdmins (ADR-0058 addendum 2026-10-14): a private board is seen by
// its creator and those let in by an override (a person, a role) only. Administrators and the
// workspace owner get 404 on it and its tasks and do not find it in the list, the task search,
// the global search or its journal; its events do not reach them. An assignee of a task sees
// that task only (ADR-0059). The owner sees and manages it while «Владелец видит приватное» is
// on. Chosen members and roles at creation get VIEW_BOARD | CREATE_TASKS.
func TestBoardsPrivateHiddenFromAdmins(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	wid := ws.GetId()
	code := invite(t, o, wid)
	base := "/api/workspaces/" + wid
	adminR := v1.WorkspaceRole_WORKSPACE_ROLE_ADMIN
	admin, creator, granted, seller, assignee, plain := register(t, code), register(t, code), register(t, code), register(t, code), register(t, code), register(t, code)
	o.must(200, "PATCH", base+"/members/"+admin.id, &v1.UpdateMemberRequest{Role: &adminR}, nil)
	sales := newRole(t, o, wid, "sales", 0)
	if st, _ := setMemberRoles(o, wid, seller.id, sales.GetId()); st != 200 {
		t.Fatalf("assign sales: %d", st)
	}
	pm := newRole(t, o, wid, "pm", perm.CreateBoards)
	if st, _ := setMemberRoles(o, wid, creator.id, pm.GetId()); st != 200 {
		t.Fatalf("assign pm: %d", st)
	}

	// Chosen people and roles only on a private board; built-in admin / owner roles refused.
	createBoard(t, creator, wid, &v1.CreateBoardRequest{Name: "Pub", MemberIds: []string{granted.id}}, 422)
	var roles v1.ListRolesResponse
	o.must(200, "GET", base+"/roles", nil, &roles)
	for _, r := range roles.GetRoles() {
		if r.GetBuiltin() == v1.WorkspaceRole_WORKSPACE_ROLE_ADMIN {
			createBoard(t, creator, wid, &v1.CreateBoardRequest{Name: "Bad", IsPrivate: true, RoleIds: []string{r.GetId()}}, 422)
		}
	}
	b := createBoard(t, creator, wid, &v1.CreateBoardRequest{Name: "Secret", Key: "SEC", IsPrivate: true,
		MemberIds: []string{granted.id}, RoleIds: []string{sales.GetId()}}, 201)
	bid := b.GetId()
	if !b.GetIsPrivate() || !b.GetRestricted() {
		t.Fatalf("a private board is restricted too: %v", b)
	}
	secret := createTask(t, creator, bid, &v1.CreateTaskRequest{Title: "private-needle"}, 201)
	mine := createTask(t, creator, bid, &v1.CreateTaskRequest{Title: "assigned-needle"}, 201)
	creator.must(200, "PUT", "/api/tasks/"+mine.GetId()+"/assignees", &v1.SetAssigneesRequest{Assignees: []*v1.TaskAssigneeInput{{UserId: assignee.id}}}, nil)

	ga := dialGW(t)
	ga.identify(admin.token)

	sees := func(c *user, want bool) {
		t.Helper()
		code := 404
		if want {
			code = 200
		}
		for _, p := range []string{"/api/boards/" + bid, "/api/tasks/" + secret.GetId(), "/api/t/" + secret.GetKey(), "/api/boards/" + bid + "/tasks"} {
			if got := c.do("GET", p, nil, nil); got != code {
				t.Errorf("%s GET %s: %d, want %d", c.id, p, got, code)
			}
		}
		if listed := listBoards(t, c, wid)[bid] != nil; listed != want {
			t.Errorf("%s: listed=%v, want %v", c.id, listed, want)
		}
		var sr v1.SearchTasksResponse
		c.must(200, "GET", base+"/tasks/search?q=private-needle", nil, &sr)
		if found := slices.ContainsFunc(sr.GetTasks(), func(x *v1.Task) bool { return x.GetId() == secret.GetId() }); found != want {
			t.Errorf("%s: task search found=%v, want %v", c.id, found, want)
		}
		if found := globalSearchFinds(t, c, wid, "private-needle"); found != want {
			t.Errorf("%s: global search found=%v, want %v", c.id, found, want)
		}
	}
	sees(admin, false)
	sees(o, false)
	sees(plain, false)
	sees(creator, true)
	sees(granted, true)
	sees(seller, true)
	// The journal: VIEW_JOURNALS of the admin and the owner does not reach a private board.
	admin.must(404, "GET", "/api/boards/"+bid+"/activity", nil, nil)
	o.must(404, "GET", "/api/boards/"+bid+"/activity", nil, nil)
	creator.must(200, "GET", "/api/boards/"+bid+"/activity", nil, nil)
	// Chosen at creation: VIEW_BOARD | CREATE_TASKS.
	createTask(t, granted, bid, &v1.CreateTaskRequest{Title: "by granted"}, 201)
	// The admin cannot change the board, its access or take it over.
	admin.must(404, "PATCH", "/api/boards/"+bid, &v1.UpdateBoardRequest{Name: ptrTo("x")}, nil)
	admin.must(404, "PUT", "/api/boards/"+bid+"/permissions", &v1.SetBoardPermissionsRequest{}, nil)

	// An assignee sees the assigned task only (task-scoped).
	var gb v1.BoardResponse
	assignee.must(200, "GET", "/api/boards/"+bid, nil, &gb)
	if !gb.GetBoard().GetTaskScoped() || gb.GetBoard().GetPermissions() != 0 {
		t.Fatalf("assignee: %v", gb.GetBoard())
	}
	assignee.must(200, "GET", "/api/tasks/"+mine.GetId(), nil, nil)
	assignee.must(404, "GET", "/api/tasks/"+secret.GetId(), nil, nil)

	// Events of the board do not reach the admin.
	patchTask(t, creator, secret.GetId(), &v1.UpdateTaskRequest{Title: ptrTo("private-needle 2")}, 200)
	ga.quiet("events of a private board", 700*time.Millisecond, func(e *v1.DispatchEvent) bool {
		return e.GetBoardUpdate().GetBoard().GetId() == bid || e.GetTaskUpdate().GetTask().GetBoardId() == bid ||
			e.GetTaskCreate().GetTask().GetBoardId() == bid || e.GetBoardCreate().GetBoard().GetId() == bid
	})

	// «Владелец видит приватное»: the owner — and only the owner — sees and manages it.
	setOwnerSeesPrivate(t, wid, true)
	var ob v1.BoardResponse
	o.must(200, "GET", "/api/boards/"+bid, nil, &ob)
	if perm.Bits(ob.GetBoard().GetPermissions()) != perm.All {
		t.Fatalf("owner with the setting: %d", ob.GetBoard().GetPermissions())
	}
	o.must(200, "PATCH", "/api/boards/"+bid, &v1.UpdateBoardRequest{Name: ptrTo("Secret 2")}, nil)
	o.must(200, "GET", "/api/boards/"+bid+"/activity", nil, nil)
	admin.must(404, "GET", "/api/boards/"+bid, nil, nil)
	setOwnerSeesPrivate(t, wid, false)
	o.must(404, "GET", "/api/boards/"+bid, nil, nil)

	// Making it public opens it to admins; private again hides it, the switcher keeps it.
	off, on := false, true
	creator.must(200, "PATCH", "/api/boards/"+bid, &v1.UpdateBoardRequest{IsPrivate: &off}, nil)
	admin.must(200, "GET", "/api/boards/"+bid, nil, nil)
	var ab v1.BoardResponse
	admin.must(200, "PATCH", "/api/boards/"+bid, &v1.UpdateBoardRequest{IsPrivate: &on}, &ab)
	if !ab.GetBoard().GetRestricted() || ab.GetBoard().GetPermissions()&uint64(perm.ManageBoard) == 0 || perm.Bits(ab.GetBoard().GetPermissions()) == perm.All {
		t.Fatalf("the admin who made it private: %v", ab.GetBoard())
	}
	plain.must(404, "GET", "/api/boards/"+bid, nil, nil)
}

// TestBoardsPrivateTakeOver: a member's private board stays after they leave the workspace;
// the owner takes it over («Сделать меня владельцем») only with «Владелец видит приватное» on
// and only once its creator is gone; the journal records it.
func TestBoardsPrivateTakeOver(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	wid := ws.GetId()
	code := invite(t, o, wid)
	base := "/api/workspaces/" + wid
	adminR := v1.WorkspaceRole_WORKSPACE_ROLE_ADMIN
	leaver, admin := register(t, code), register(t, code)
	o.must(200, "PATCH", base+"/members/"+admin.id, &v1.UpdateMemberRequest{Role: &adminR}, nil)
	pm := newRole(t, o, wid, "pm", perm.CreateBoards)
	if st, _ := setMemberRoles(o, wid, leaver.id, pm.GetId()); st != 200 {
		t.Fatalf("assign pm: %d", st)
	}
	b := createBoard(t, leaver, wid, &v1.CreateBoardRequest{Name: "Mine", Key: "MIN", IsPrivate: true}, 201)
	bid := b.GetId()
	createTask(t, leaver, bid, &v1.CreateTaskRequest{Title: "left behind"}, 201)
	take := "/api/boards/" + bid + "/take-over"

	// While the creator is a member: 409 (setting on), 403 (setting off).
	o.must(403, "POST", take, nil, nil)
	setOwnerSeesPrivate(t, wid, true)
	o.must(409, "POST", take, nil, nil)
	setOwnerSeesPrivate(t, wid, false)

	o.must(204, "DELETE", base+"/members/"+leaver.id, nil, nil)
	// The board stays, hidden from the owner and the admin.
	o.must(404, "GET", "/api/boards/"+bid, nil, nil)
	admin.must(404, "GET", "/api/boards/"+bid, nil, nil)
	o.must(403, "POST", take, nil, nil)
	admin.must(404, "POST", take, nil, nil)

	setOwnerSeesPrivate(t, wid, true)
	o.must(200, "GET", "/api/boards/"+bid, nil, nil)
	var br v1.BoardResponse
	o.must(200, "POST", take, nil, &br)
	if br.GetBoard().GetCreatedBy() != o.id {
		t.Fatalf("created_by after the take-over: %q", br.GetBoard().GetCreatedBy())
	}
	var n int
	if err := testDB.Pool.QueryRow(context.Background(),
		"SELECT count(*) FROM workspace_audit WHERE workspace_id = $1 AND kind = 'take_over' AND subject_type = 'board' AND subject_id = $2 AND previous_owner_id = $3 AND actor_id = $4",
		wid, bid, leaver.id, o.id).Scan(&n); err != nil || n != 1 {
		t.Fatalf("audit rows: %d %v", n, err)
	}
	o.must(409, "POST", take, nil, nil) // already the owner's
	// Taken over: the owner keeps it with the setting off (creator + personal override).
	setOwnerSeesPrivate(t, wid, false)
	o.must(200, "GET", "/api/boards/"+bid, nil, nil)
	admin.must(404, "GET", "/api/boards/"+bid, nil, nil)
	// And deletes it.
	o.must(204, "DELETE", "/api/boards/"+bid+"?purge=1", nil, nil)
	o.must(404, "GET", "/api/boards/"+bid, nil, nil)
}

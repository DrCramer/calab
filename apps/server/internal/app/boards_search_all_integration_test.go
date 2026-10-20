//go:build integration

package app_test

import (
	"sort"
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
)

// TestTasksSearchAllBoardsState (CBF-35): «Мои задачи → Все задачи» searches every board of the
// workspace the caller sees, by state: open (not completed / cancelled), done or all. A closed
// task of a private board the caller does not see never comes back, whatever the state.
func TestTasksSearchAllBoardsState(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	wid := ws.GetId()
	code := invite(t, o, wid)
	alice, bob := register(t, code), register(t, code)
	pm := newRole(t, o, wid, "pm", perm.CreateBoards)
	if st, _ := setMemberRoles(o, wid, alice.id, pm.GetId()); st != 200 {
		t.Fatalf("assign pm: %d", st)
	}
	dev := v1.BoardTemplate_BOARD_TEMPLATE_DEVELOPMENT
	pub := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Pub", Key: "PUB", Template: dev}, 201)
	alt := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Alt", Key: "ALT", Template: dev}, 201)
	priv := createBoard(t, alice, wid, &v1.CreateBoardRequest{Name: "Mine", Key: "MIN", IsPrivate: true, Template: dev}, 201)
	done, cancelled := statusOf(pub, v1.BoardStatusType_BOARD_STATUS_TYPE_COMPLETED), statusOf(alt, v1.BoardStatusType_BOARD_STATUS_TYPE_CANCELLED)
	if done == "" || cancelled == "" {
		t.Fatalf("template statuses: %q %q", done, cancelled)
	}
	open := createTask(t, o, pub.GetId(), &v1.CreateTaskRequest{Title: "allsearch open"}, 201)
	closed := createTask(t, o, pub.GetId(), &v1.CreateTaskRequest{Title: "allsearch closed", StatusId: done}, 201)
	gone := createTask(t, o, alt.GetId(), &v1.CreateTaskRequest{Title: "other", Description: "allsearch in the description", StatusId: cancelled}, 201)
	hidden := createTask(t, alice, priv.GetId(), &v1.CreateTaskRequest{Title: "allsearch hidden", StatusId: statusOf(priv, v1.BoardStatusType_BOARD_STATUS_TYPE_COMPLETED)}, 201)
	hiddenOpen := createTask(t, alice, priv.GetId(), &v1.CreateTaskRequest{Title: "allsearch hidden open"}, 201)

	found := func(c *user, state string) []string {
		t.Helper()
		var sr v1.SearchTasksResponse
		c.must(200, "GET", "/api/workspaces/"+wid+"/tasks/search?q=allsearch&limit=50&state="+state, nil, &sr)
		out := []string{}
		for _, x := range sr.GetTasks() {
			out = append(out, x.GetId())
		}
		sort.Strings(out)
		return out
	}
	want := func(ids ...string) []string {
		sort.Strings(ids)
		return ids
	}
	eq := func(name string, got, want []string) {
		t.Helper()
		if len(got) != len(want) {
			t.Errorf("%s: %v, want %v", name, got, want)
			return
		}
		for i := range got {
			if got[i] != want[i] {
				t.Errorf("%s: %v, want %v", name, got, want)
				return
			}
		}
	}
	// bob: no right on alice's private board — its tasks never come back.
	eq("bob open", found(bob, "open"), want(open.GetId()))
	eq("bob done", found(bob, "done"), want(closed.GetId(), gone.GetId()))
	eq("bob all", found(bob, "all"), want(open.GetId(), closed.GetId(), gone.GetId()))
	eq("bob default", found(bob, ""), want(open.GetId(), closed.GetId(), gone.GetId()))
	// The owner does not see a private board either (ADR-0058 addendum 2026-10-14).
	eq("owner done", found(o, "done"), want(closed.GetId(), gone.GetId()))
	// alice, its creator, finds them.
	eq("alice done", found(alice, "done"), want(closed.GetId(), gone.GetId(), hidden.GetId()))
	eq("alice open", found(alice, "open"), want(open.GetId(), hiddenOpen.GetId()))
	bob.must(400, "GET", "/api/workspaces/"+wid+"/tasks/search?q=allsearch&state=closed", nil, nil)
}

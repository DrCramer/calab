//go:build integration

package app_test

import (
	"net/url"
	"sort"
	"testing"

	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// TestTaskSearchFiltersArchiveKey (ADR-0139): the task search reads comments, includes the
// archive on request (archived=1 / only), narrows by board_id and a TaskFilter (BOARD, ASSIGNEE
// me), sorts and pages by an offset cursor, and answers key_task for a typed key whatever the
// filters — also for a task reachable only by card access; never a task of a board not seen.
func TestTaskSearchFiltersArchiveKey(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	dev := v1.BoardTemplate_BOARD_TEMPLATE_DEVELOPMENT
	doc := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Docs", Key: "DOC", Template: dev}, 201)
	inv := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Inventory", Key: "INV", Template: dev}, 201)
	priv := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Closed", Key: "CLS", IsPrivate: true, Template: dev}, 201)

	itms := createTask(t, o, doc.GetId(), &v1.CreateTaskRequest{Title: "itms export"}, 201)
	o.must(200, "PUT", "/api/tasks/"+itms.GetId()+"/assignees", &v1.SetAssigneesRequest{Assignees: []*v1.TaskAssigneeInput{{UserId: bob.id}}}, nil)
	other := createTask(t, o, inv.GetId(), &v1.CreateTaskRequest{Title: "itms count"}, 201)
	talk := createTask(t, o, inv.GetId(), &v1.CreateTaskRequest{Title: "plain title"}, 201)
	send(t, o, talk.GetRoomId(), "the zephyrine spec is attached", uniq("s"))
	gone := createTask(t, o, doc.GetId(), &v1.CreateTaskRequest{Title: "archword cleanup"}, 201)
	o.must(200, "POST", "/api/tasks/"+gone.GetId()+"/archive", nil, nil)
	card := createTask(t, o, priv.GetId(), &v1.CreateTaskRequest{Title: "cardonly itms"}, 201)
	hidden := createTask(t, o, priv.GetId(), &v1.CreateTaskRequest{Title: "hidden itms"}, 201)
	o.must(200, "PUT", "/api/tasks/"+card.GetId()+"/assignees", &v1.SetAssigneesRequest{Assignees: []*v1.TaskAssigneeInput{{UserId: bob.id}}}, nil)

	search := func(c *user, params url.Values) *v1.SearchTasksResponse {
		t.Helper()
		var sr v1.SearchTasksResponse
		c.must(200, "GET", "/api/workspaces/"+wid+"/tasks/search?"+params.Encode(), nil, &sr)
		return &sr
	}
	ids := func(sr *v1.SearchTasksResponse) []string {
		out := []string{}
		for _, x := range sr.GetTasks() {
			out = append(out, x.GetId())
		}
		sort.Strings(out)
		return out
	}
	want := func(name string, got []string, ids ...string) {
		t.Helper()
		sort.Strings(ids)
		if len(got) != len(ids) {
			t.Fatalf("%s: %v, want %v", name, got, ids)
		}
		for i := range got {
			if got[i] != ids[i] {
				t.Fatalf("%s: %v, want %v", name, got, ids)
			}
		}
	}
	filter := func(f *v1.TaskFilter) string {
		b, err := protojson.Marshal(f)
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}

	// Words: bob sees DOC / INV fully and CLS only by his card; the closed task stays hidden.
	want("bob itms", ids(search(bob, url.Values{"q": {"itms"}})), itms.GetId(), other.GetId(), card.GetId())
	// Comments match, with a snippet from the comment.
	sr := search(bob, url.Values{"q": {"zephyrine"}})
	want("comment", ids(sr), talk.GetId())
	if len(sr.GetSnippets()) != 1 || !sr.GetSnippets()[0].GetComment() || sr.GetSnippets()[0].GetTaskId() != talk.GetId() {
		t.Fatalf("comment snippet: %v", sr.GetSnippets())
	}
	// The archive: absent by default, found with archived=1 and only.
	want("archive default", ids(search(bob, url.Values{"q": {"archword"}})))
	sr = search(bob, url.Values{"q": {"archword"}, "archived": {"1"}})
	want("archive 1", ids(sr), gone.GetId())
	if sr.GetTasks()[0].GetArchivedAt() == nil {
		t.Fatal("archived task without archived_at")
	}
	want("archive only", ids(search(bob, url.Values{"archived": {"only"}})), gone.GetId())
	// The key finds the archived task whatever the filters and the board.
	sr = search(bob, url.Values{"q": {gone.GetKey()}, "board_id": {inv.GetId()}, "state": {"open"}})
	if sr.GetKeyTask().GetId() != gone.GetId() {
		t.Fatalf("key_task: %v", sr.GetKeyTask())
	}
	// By card access too; a closed task's key answers nothing.
	if sr = search(bob, url.Values{"q": {card.GetKey()}}); sr.GetKeyTask().GetId() != card.GetId() {
		t.Fatalf("card key_task: %v", sr.GetKeyTask())
	}
	if sr = search(bob, url.Values{"q": {hidden.GetKey()}}); sr.GetKeyTask() != nil {
		t.Fatalf("hidden key_task: %v", sr.GetKeyTask())
	}
	// board_id narrows; a board not seen is 404.
	want("board", ids(search(bob, url.Values{"q": {"itms"}, "board_id": {doc.GetId()}})), itms.GetId())
	bob.must(404, "GET", "/api/workspaces/"+wid+"/tasks/search?board_id="+o.id, nil, nil)
	// Filters: BOARD and ASSIGNEE me, without text.
	f := filter(&v1.TaskFilter{Conditions: []*v1.TaskCondition{{Field: v1.TaskField_TASK_FIELD_BOARD, Op: v1.TaskOp_TASK_OP_IS, Values: []string{inv.GetId()}}}})
	want("board filter", ids(search(bob, url.Values{"filter": {f}})), other.GetId(), talk.GetId())
	f = filter(&v1.TaskFilter{Conditions: []*v1.TaskCondition{{Field: v1.TaskField_TASK_FIELD_ASSIGNEE, Op: v1.TaskOp_TASK_OP_IS, Values: []string{"me"}}}})
	want("mine", ids(search(bob, url.Values{"filter": {f}})), itms.GetId(), card.GetId())
	// Sort and the offset cursor: by key ascending, one per page.
	sr = search(bob, url.Values{"q": {"itms"}, "sort": {"key"}, "limit": {"1"}})
	if len(sr.GetTasks()) != 1 || sr.GetTasks()[0].GetId() != card.GetId() || sr.GetNextCursor() != "1" {
		t.Fatalf("page 1: %v %q", ids(sr), sr.GetNextCursor())
	}
	sr = search(bob, url.Values{"q": {"itms"}, "sort": {"key"}, "limit": {"1"}, "cursor": {"1"}})
	if len(sr.GetTasks()) != 1 || sr.GetTasks()[0].GetId() != itms.GetId() {
		t.Fatalf("page 2: %v", ids(sr))
	}
	bob.must(400, "GET", "/api/workspaces/"+wid+"/tasks/search?sort=color", nil, nil)
	bob.must(400, "GET", "/api/workspaces/"+wid+"/tasks/search?archived=yes", nil, nil)
}

// TestSavedTaskSearches (ADR-0139): a person's named searches — create, list, rename, delete;
// someone else's are 404; a bad filter is 422.
func TestSavedTaskSearches(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	base := "/api/workspaces/" + wid + "/task-searches"
	var cr v1.SavedTaskSearchResponse
	q := &v1.TaskSearchQuery{Q: "itms", State: "open", Sort: "-updated", Filter: &v1.TaskFilter{Conditions: []*v1.TaskCondition{
		{Field: v1.TaskField_TASK_FIELD_ASSIGNEE, Op: v1.TaskOp_TASK_OP_IS, Values: []string{"me"}}}}}
	bob.must(201, "POST", base, &v1.CreateSavedTaskSearchRequest{Name: "Мои незакрытые DOC", Query: q}, &cr)
	id := cr.GetSearch().GetId()
	if cr.GetSearch().GetQuery().GetQ() != "itms" || len(cr.GetSearch().GetQuery().GetFilter().GetConditions()) != 1 {
		t.Fatalf("created: %v", cr.GetSearch())
	}
	var list v1.ListSavedTaskSearchesResponse
	bob.must(200, "GET", base, nil, &list)
	if len(list.GetSearches()) != 1 || list.GetSearches()[0].GetName() != "Мои незакрытые DOC" {
		t.Fatalf("list: %v", list.GetSearches())
	}
	o.must(200, "GET", base, nil, &list)
	if len(list.GetSearches()) != 0 {
		t.Fatalf("owner sees bob's: %v", list.GetSearches())
	}
	name := "Переименован"
	o.must(404, "PATCH", base+"/"+id, &v1.UpdateSavedTaskSearchRequest{Name: &name}, nil)
	bob.must(200, "PATCH", base+"/"+id, &v1.UpdateSavedTaskSearchRequest{Name: &name}, &cr)
	if cr.GetSearch().GetName() != name || cr.GetSearch().GetQuery().GetQ() != "itms" {
		t.Fatalf("renamed: %v", cr.GetSearch())
	}
	bad := &v1.TaskSearchQuery{Filter: &v1.TaskFilter{Conditions: []*v1.TaskCondition{{Field: v1.TaskField_TASK_FIELD_BOARD, Op: v1.TaskOp_TASK_OP_IS, Values: []string{"nope"}}}}}
	bob.must(422, "POST", base, &v1.CreateSavedTaskSearchRequest{Name: "x", Query: bad}, nil)
	bob.must(422, "POST", base, &v1.CreateSavedTaskSearchRequest{Name: ""}, nil)
	o.must(404, "DELETE", base+"/"+id, nil, nil)
	bob.must(204, "DELETE", base+"/"+id, nil, nil)
	bob.must(404, "DELETE", base+"/"+id, nil, nil)
}

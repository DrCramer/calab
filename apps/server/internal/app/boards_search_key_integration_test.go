//go:build integration

package app_test

import (
	"net/url"
	"slices"
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
)

// TestTasksSearchKeySpellings (docs/09 #88): a task key is found in any spelling — doc3, doc 3,
// DOC_3, Doc-3, the Russian layout (вщс3 = doc typed on ЙЦУКЕН, док-3 by sound) — and always
// first; a bare number 3 lists the cards numbered 3 on every board first, then the text matches.
// A task of a board the caller does not see never comes back.
func TestTasksSearchKeySpellings(t *testing.T) {
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
	doc := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Docs", Key: "DOC", Template: dev}, 201)
	inv := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Invoices", Key: "INV", Template: dev}, 201)
	priv := createBoard(t, alice, wid, &v1.CreateBoardRequest{Name: "Mine", Key: "SEC", IsPrivate: true, Template: dev}, 201)
	ids := map[string]string{}
	for _, b := range []struct {
		board  *v1.Board
		key    string
		author *user
		titles []string
	}{
		{doc, "DOC", o, []string{"first doc", "second doc", "third doc"}},
		{inv, "INV", o, []string{"first inv", "second inv", "third inv"}},
		{priv, "SEC", alice, []string{"s one", "s two", "s three"}},
	} {
		for i, title := range b.titles {
			ids[b.key+"-"+string(rune('1'+i))] = createTask(t, b.author, b.board.GetId(), &v1.CreateTaskRequest{Title: title}, 201).GetId()
		}
	}
	// DOC-4: its text mentions 3, its number is another — after the keys of a bare number.
	text := createTask(t, o, doc.GetId(), &v1.CreateTaskRequest{Title: "needs 3 reviewers"}, 201).GetId()

	search := func(c *user, q string) []string {
		t.Helper()
		var sr v1.SearchTasksResponse
		c.must(200, "GET", "/api/workspaces/"+wid+"/tasks/search?limit=50&q="+url.QueryEscape(q), nil, &sr)
		out := []string{}
		for _, x := range sr.GetTasks() {
			out = append(out, x.GetId())
		}
		return out
	}
	for _, q := range []string{"DOC-3", "doc-3", "doc3", "DOC3", "doc 3", "doc_3", "Doc - 3", "док-3", "ДОК3", "вщс 3"} {
		if got := search(bob, q); len(got) == 0 || got[0] != ids["DOC-3"] {
			t.Errorf("%q: %v, want DOC-3 first", q, got)
		}
	}
	for _, q := range []string{"штм-2", "inv2", "INV 2"} {
		if got := search(bob, q); len(got) == 0 || got[0] != ids["INV-2"] {
			t.Errorf("%q: %v, want INV-2 first", q, got)
		}
	}
	got := search(bob, "3")
	if len(got) < 3 || !slices.Contains(got[:2], ids["DOC-3"]) || !slices.Contains(got[:2], ids["INV-3"]) {
		t.Errorf("bare 3: %v, want DOC-3 and INV-3 first", got)
	}
	if !slices.Contains(got, text) || slices.Contains(got, ids["SEC-3"]) {
		t.Errorf("bare 3: %v: text match missing or a private card leaked", got)
	}
	if got := search(alice, "3"); !slices.Contains(got, ids["SEC-3"]) {
		t.Errorf("alice bare 3: %v, want her SEC-3", got)
	}
	for _, q := range []string{"sec3", "sec 3", "ыуы3"} {
		if got := search(bob, q); slices.Contains(got, ids["SEC-3"]) {
			t.Errorf("%q leaked a private card: %v", q, got)
		}
	}
}

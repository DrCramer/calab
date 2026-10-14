//go:build integration

package wiki

import (
	"context"
	"slices"
	"testing"

	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/wikiacl"
)

// A restricted page («Только выбранные») is not seen by the administrator nor the workspace
// owner (ADR-0096 §2, addendum 2026-10-14): 404 on it and its subpages, not in listings, paths,
// search, versions, the workspace journal or the events they get; their «empty the trash» skips
// it; the people let in see it; its public link keeps working.
func TestWikiPrivatePageHiddenFromAdmins(t *testing.T) {
	e := newEnv(t, SyncConfig{})
	ctx := context.Background()
	ws := "/api/workspaces/" + e.ws.String()
	design := uuid.New()
	if _, err := e.d.Pool.Exec(ctx, `INSERT INTO workspace_roles (id, workspace_id, name, position, permissions) VALUES ($1, $2, 'Design', 5, 0)`, design, e.ws); err != nil {
		t.Fatal(err)
	}
	if _, err := e.d.Pool.Exec(ctx, `INSERT INTO member_roles (workspace_id, user_id, role_id) VALUES ($1, $2, $3)`, e.ws, e.bob, design); err != nil {
		t.Fatal(err)
	}
	m, err := perm.NewResolver(e.d.Q).Member(ctx, e.ws, e.admin)
	if err != nil {
		t.Fatal(err)
	}
	adminSees := func(levels []*v1.WikiAccessLevel) bool {
		return len(levels) > 0 && perm.ComputeWikiPageIn(m, wikiacl.FromLevels(levels)).Has(perm.WikiView)
	}
	e.create(e.alice, "", "Open")
	salaries := e.create(e.alice, "", "Salaries")
	if _, err := e.d.Pool.Exec(ctx, `UPDATE wiki_pages SET plain_text = 'budget salaries' WHERE id = $1`, salaries.GetId()); err != nil {
		t.Fatal(err)
	}
	e.ev.take()
	e.must(200, e.alice, "PUT", page(salaries.GetId())+"/permissions", &v1.UpdateWikiPermissionsRequest{Restricted: proto.Bool(true),
		Entries: []*v1.WikiPermissionEntry{
			{TargetType: role, TargetId: design.String(), Allow: uint64(perm.WikiView | perm.WikiWrite)},
			{TargetType: user, TargetId: e.guest.String(), Allow: uint64(perm.WikiView)},
		}}, nil)
	// The admin saw the page before and not after: the gateway sends it WIKI_PAGE_REMOVE.
	var restrict *v1.WikiPageUpsert
	for _, ev := range e.ev.take() {
		if u := ev.GetWikiPageUpsert(); u != nil && u.GetPage().GetId() == salaries.GetId() {
			restrict = u
		}
	}
	if restrict == nil || !adminSees(restrict.GetAccessBefore()) || adminSees(restrict.GetAccess()) {
		t.Fatalf("restrict event: %v", restrict)
	}
	sub := e.create(e.alice, salaries.GetId(), "2026")
	var link v1.WikiLinkResponse
	e.must(201, e.alice, "POST", page(salaries.GetId())+"/link", &v1.CreateWikiLinkRequest{}, &link)
	evs := e.ev.take()
	if len(evs) == 0 {
		t.Fatal("no events inside")
	}
	for _, ev := range evs {
		if u := ev.GetWikiPageUpsert(); u != nil && adminSees(u.GetAccess()) {
			t.Fatalf("an event of a private page would reach the admin: %v", ev)
		}
	}

	for _, u := range []uuid.UUID{e.admin, e.owner} {
		for _, id := range []string{salaries.GetId(), sub.GetId()} {
			e.must(404, u, "GET", page(id), nil, nil)
			e.must(404, u, "GET", page(id)+"/path", nil, nil)
			e.must(404, u, "GET", page(id)+"/activity", nil, nil)
			e.must(404, u, "GET", page(id)+"/versions", nil, nil)
			e.must(404, u, "GET", page(id)+"/permissions", nil, nil)
			e.must(404, u, "PATCH", page(id), &v1.UpdateWikiPageRequest{Title: proto.String("x")}, nil)
			e.must(404, u, "POST", page(id)+"/trash", nil, nil)
		}
		e.must(404, u, "DELETE", page(salaries.GetId())+"/link", nil, nil)
		e.must(404, u, "GET", ws+"/wiki/pages?parent="+salaries.GetId(), nil, nil)
		if got := e.titles(u, ""); !slices.Equal(got, []string{"Open"}) {
			t.Fatalf("%v lists %v", u, got)
		}
		var found v1.SearchResponse
		e.must(200, u, "GET", "/api/search?scope="+e.ws.String()+"&type=wiki&q=salaries", nil, &found)
		if hits := found.GetSections()[0].GetItems(); len(hits) != 0 {
			t.Fatalf("%v found the private page: %v", u, hits)
		}
	}
	// Let in by role (bob, editing) and by name (the guest, view only).
	e.must(200, e.bob, "GET", page(sub.GetId()), nil, nil)
	e.create(e.bob, salaries.GetId(), "Bob's")
	e.must(200, e.guest, "GET", page(sub.GetId()), nil, nil)
	if got := e.titles(e.bob, ""); len(got) != 2 {
		t.Fatalf("bob lists %v", got)
	}
	// The public link keeps working.
	if w := e.call(uuid.Nil, "GET", "/api/public/wiki/"+link.GetLink().GetCode(), nil, nil); w.Code != 200 {
		t.Fatalf("public link of a private page: %d", w.Code)
	}
	// The workspace journal of the admin names nothing of the private page.
	journal := func(u uuid.UUID) []string {
		t.Helper()
		var act v1.WikiActivityPage
		e.must(200, u, "GET", ws+"/wiki/activity?limit=2", nil, &act)
		var titles []string
		for {
			for _, a := range act.GetActivities() {
				titles = append(titles, a.GetPageTitle())
				if a.GetBefore().GetFields()["parent_title"].GetStringValue() == "Salaries" || a.GetAfter().GetFields()["parent_title"].GetStringValue() == "Salaries" {
					titles = append(titles, "parent:Salaries")
				}
			}
			if act.GetNextCursor() == "" {
				return titles
			}
			cur := act.GetNextCursor()
			act.Reset()
			e.must(200, u, "GET", ws+"/wiki/activity?limit=2&cursor="+cur, nil, &act)
		}
	}
	private := []string{"Salaries", "2026", "Bob's", "parent:Salaries"}
	if got := journal(e.admin); !slices.Contains(got, "Open") || slices.ContainsFunc(got, func(n string) bool { return slices.Contains(private, n) }) {
		t.Fatalf("the admin's journal: %v", got)
	}
	// Trash: the admin neither lists nor empties the private page; its owner does.
	gone := e.create(e.bob, "", "Old")
	e.must(200, e.bob, "POST", page(gone.GetId())+"/trash", nil, nil)
	e.must(200, e.alice, "POST", page(salaries.GetId())+"/trash", nil, nil)
	if got := e.titles(e.admin, "trashed=1"); !slices.Equal(got, []string{"Old"}) {
		t.Fatalf("the admin's trash: %v", got)
	}
	var emptied v1.EmptyWikiTrashResponse
	e.must(200, e.admin, "POST", ws+"/wiki/trash/empty", nil, &emptied)
	if emptied.GetDeleted() != 1 {
		t.Fatalf("the admin emptied %v", &emptied)
	}
	if got := e.titles(e.alice, "trashed=1"); !slices.Equal(got, []string{"Salaries"}) {
		t.Fatalf("alice's trash after the admin's: %v", got)
	}
	e.must(204, e.alice, "DELETE", page(salaries.GetId()), nil, nil)
	// Deleted forever: its entries stay out of the admin's journal (private), the open one shows.
	got := journal(e.admin)
	if slices.ContainsFunc(got, func(n string) bool { return slices.Contains(private, n) }) || !slices.Contains(got, "Old") {
		t.Fatalf("the admin's journal after the delete: %v", got)
	}
}

// An administrator let in by name with editing changes the structure of the private page (the
// access dialog); the workspace owner, not let in, still gets 404.
func TestWikiPrivatePageAdminLetIn(t *testing.T) {
	e := newEnv(t, SyncConfig{})
	p := e.create(e.alice, "", "Board notes")
	e.must(200, e.alice, "PUT", page(p.GetId())+"/permissions", &v1.UpdateWikiPermissionsRequest{Restricted: proto.Bool(true),
		Entries: []*v1.WikiPermissionEntry{{TargetType: user, TargetId: e.admin.String(), Allow: uint64(perm.WikiView)}}}, nil)
	var seen v1.WikiPageResponse
	e.must(200, e.admin, "GET", page(p.GetId()), nil, &seen)
	if seen.GetPage().GetMyBits() != uint64(perm.WikiView) {
		t.Fatalf("the admin with VIEW: %b", seen.GetPage().GetMyBits())
	}
	e.must(403, e.admin, "GET", page(p.GetId())+"/permissions", nil, nil)
	e.must(200, e.alice, "PUT", page(p.GetId())+"/permissions", &v1.UpdateWikiPermissionsRequest{
		Entries: []*v1.WikiPermissionEntry{{TargetType: user, TargetId: e.admin.String(), Allow: uint64(perm.WikiView | perm.WikiWrite)}}}, nil)
	seen.Reset()
	e.must(200, e.admin, "GET", page(p.GetId()), nil, &seen)
	if seen.GetPage().GetMyBits() != uint64(perm.Wiki) {
		t.Fatalf("the admin with WRITE: %b", seen.GetPage().GetMyBits())
	}
	e.must(200, e.admin, "GET", page(p.GetId())+"/permissions", nil, nil)
	e.must(404, e.owner, "GET", page(p.GetId()), nil, nil)
}

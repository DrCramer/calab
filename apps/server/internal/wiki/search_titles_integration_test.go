//go:build integration

package wiki

import (
	"context"
	"net/url"
	"strings"
	"testing"

	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/perm"
)

// The search section finds a page by its exact title (owner, 18.10: «по точному названию
// страницы ничего не находит»): one word, emoji, short titles, punctuation, stop words, a deep
// page, a page of another workspace with scope=all, a page created or renamed a moment ago —
// in the summary (no type) as in the feed.
func TestSearchWikiTitles(t *testing.T) {
	e := newEnv(t, SyncConfig{})
	ctx := context.Background()
	ws := e.ws.String()

	top := e.create(e.alice, "", "Engineering")
	mid := e.create(e.alice, top.GetId(), "Backend")
	deep := e.create(e.alice, mid.GetId(), "Deploy runbook")

	// Another workspace of Bob's.
	other := uuid.New()
	if _, err := e.d.Pool.Exec(ctx, `INSERT INTO workspaces (id, slug, name, owner_id) VALUES ($1, $2, 'Other', $3)`, other, "wo-"+other.String()[:12], e.owner); err != nil {
		t.Fatal(err)
	}
	if _, err := e.d.Q.AddMember(ctx, sqlc.AddMemberParams{WorkspaceID: other, UserID: e.bob, Role: "member"}); err != nil {
		t.Fatal(err)
	}
	var far v1.WikiPageResponse
	e.must(201, e.bob, "POST", "/api/workspaces/"+other.String()+"/wiki/pages", &v1.CreateWikiPageRequest{Title: "Квартальный отчёт"}, &far)

	// find returns the page ids of the wiki hits of q in the summary and in the feed (both must
	// agree).
	find := func(u uuid.UUID, scope, q string) map[string]bool {
		t.Helper()
		out := map[string]bool{}
		for i, extra := range []string{"", "&type=wiki"} {
			var r v1.SearchResponse
			e.must(200, u, "GET", "/api/search?scope="+scope+"&q="+url.QueryEscape(q)+extra, nil, &r)
			got := map[string]bool{}
			for _, s := range r.GetSections() {
				if s.GetType() == v1.SearchType_SEARCH_TYPE_WIKI {
					for _, h := range s.GetItems() {
						got[h.GetWiki().GetPageId()] = true
					}
				}
			}
			if i == 0 {
				out = got
			} else if len(got) != len(out) {
				t.Fatalf("%q: summary %v, feed %v", q, out, got)
			}
		}
		return out
	}
	expect := func(u uuid.UUID, scope, q, id string) {
		t.Helper()
		if !find(u, scope, q)[id] {
			t.Fatalf("%q not found (scope %s)", q, scope)
		}
	}

	for _, c := range []struct{ title, q string }{
		{"Онбординг", "Онбординг"},
		{"Glossary", "glossary"},
		{"🚀 Roadmap", "🚀 Roadmap"},
		{"🚀 Roadmap 2", "Roadmap 2"},
		{"📚", ""}, // emoji only: no word to search by (422), listed for the record
		{"HR", "HR"},
		{"Q3", "Q3"},
		{"ИТ", "ИТ"},
		{"FAQ", "faq"},
		{"О компании", "О компании"},
		{"The Team", "The Team"},
		{"Пост-мортем", "Пост-мортем"},
		{"Release 3.6.0", "Release 3.6.0"},
		{"v2.0 plan", "v2.0 plan"},
		{"Q&A сессии", "Q&A сессии"},
		{"Планы на 2027", "Планы на 2027"},
		{"Как настроить VPN?", "Как настроить VPN?"},
		{"Политика отпусков", "политика отпусков"},
		{"e-mail шаблоны", "e-mail шаблоны"},
	} {
		p := e.create(e.alice, "", c.title)
		if c.q == "" {
			continue
		}
		expect(e.bob, ws, c.q, p.GetId())
		expect(e.bob, "all", c.q, p.GetId())
	}

	expect(e.bob, ws, "Deploy runbook", deep.GetId())
	expect(e.bob, ws, "Backend", mid.GetId())
	var r v1.SearchResponse
	e.must(200, e.bob, "GET", "/api/search?type=wiki&scope="+ws+"&q="+url.QueryEscape("Deploy runbook"), nil, &r)
	if h := r.GetSections()[0].GetItems(); len(h) != 1 || strings.Join(h[0].GetWiki().GetPath(), "/") != "Engineering/Backend" {
		t.Fatalf("deep page path: %v", h)
	}
	// A restricted middle page hides its title from the path of a page Bob was given.
	e.must(200, e.alice, "PATCH", page(mid.GetId()), &v1.UpdateWikiPageRequest{Restricted: proto.Bool(true)}, nil)
	e.must(200, e.alice, "PUT", page(deep.GetId())+"/permissions", &v1.UpdateWikiPermissionsRequest{Entries: []*v1.WikiPermissionEntry{
		{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER, TargetId: e.bob.String(), Allow: uint64(perm.WikiView)}}}, nil)
	e.must(404, e.bob, "GET", page(mid.GetId()), nil, nil)
	var crumbs v1.WikiPathResponse
	e.must(200, e.bob, "GET", page(deep.GetId())+"/path", nil, &crumbs)
	// The breadcrumbs name only what Bob sees (wikiacl gives the ancestors their own chains).
	if ps := crumbs.GetPages(); len(ps) != 1 || ps[0].GetId() != deep.GetId() {
		t.Fatalf("crumbs under a hidden page: %v", ps)
	}
	e.must(200, e.bob, "GET", "/api/search?type=wiki&scope="+ws+"&q="+url.QueryEscape("Deploy runbook"), nil, &r)
	if h := r.GetSections()[0].GetItems(); len(h) != 1 || len(h[0].GetWiki().GetPath()) != 0 {
		t.Fatalf("path under a hidden page: %v", h)
	}
	if find(e.bob, ws, "Backend")[mid.GetId()] {
		t.Fatal("bob found the restricted page")
	}
	expect(e.bob, "all", "Квартальный отчёт", far.GetPage().GetId())
	if find(e.alice, "all", "Квартальный отчёт")[far.GetPage().GetId()] {
		t.Fatal("alice found a page of a workspace she is not in")
	}

	// Renamed a moment ago: found by the new title at once, no more by the old one.
	p := e.create(e.alice, "", "Черновик")
	expect(e.bob, ws, "Черновик", p.GetId())
	title := "Итоги ретро"
	e.must(200, e.alice, "PATCH", page(p.GetId()), &v1.UpdateWikiPageRequest{Title: &title}, nil)
	expect(e.bob, ws, "Итоги ретро", p.GetId())
	if find(e.bob, ws, "Черновик")[p.GetId()] {
		t.Fatal("found by the old title")
	}
}

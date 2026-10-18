//go:build integration

package app_test

import (
	"slices"
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
)

const (
	stWiki = v1.SearchType_SEARCH_TYPE_WIKI
	stDisk = v1.SearchType_SEARCH_TYPE_DISK
)

// TestSearchDiskAndWiki: the disk section finds live Disk folders and files by name through the
// Disk rule (another member's private folder and its content are invisible — to the workspace
// owner too —, a private folder shared with the caller is visible, trashed items are not, a guest
// sees only what was given to them, the path names only visible folders); the wiki section is
// part of the summary and follows the page rule.
func TestSearchDiskAndWiki(t *testing.T) {
	noSearchLimit(t)
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	carol := register(t, invite(t, o, wid))
	gus := register(t, invite(t, o, wid))
	guest := v1.WorkspaceRole_WORKSPACE_ROLE_GUEST
	o.must(200, "PATCH", "/api/workspaces/"+wid+"/members/"+gus.id, &v1.UpdateMemberRequest{Role: &guest}, nil)
	w := tag()
	scope := "&scope=" + wid
	on := true
	folder := func(u *user, parent, name string) *v1.DiskItem {
		t.Helper()
		var r v1.DiskItemResponse
		u.must(201, "POST", "/api/workspaces/"+wid+"/disk/folders", &v1.CreateDiskFolderRequest{ParentId: parent, Name: name}, &r)
		return r.GetItem()
	}
	file := func(u *user, parent, name string) *v1.DiskItem {
		t.Helper()
		code, it := diskUpload(t, u.token, wid, parent, name, []byte("data of "+name))
		if code != 201 && code != 200 {
			t.Fatalf("upload %s: %d", name, code)
		}
		return it
	}
	userEntry := func(id string) *v1.DiskPermissionEntry {
		return &v1.DiskPermissionEntry{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER, TargetId: id, Allow: uint64(perm.DiskView)}
	}

	docs := folder(o, "", "Docs")
	public := file(o, docs.GetId(), w+" public.txt")
	// Carol's private folder, and a private folder of hers shared with Bob.
	private := folder(carol, "", w+" private")
	carol.must(200, "PUT", "/api/disk/items/"+private.GetId()+"/permissions", &v1.UpdateDiskPermissionsRequest{Restricted: &on}, nil)
	secret := file(carol, private.GetId(), w+" secret.txt")
	shared := folder(carol, "", w+" shared")
	carol.must(200, "PUT", "/api/disk/items/"+shared.GetId()+"/permissions", &v1.UpdateDiskPermissionsRequest{Restricted: &on,
		Entries: []*v1.DiskPermissionEntry{userEntry(bob.id)}}, nil)
	inShared := file(carol, shared.GetId(), w+" plan.txt")
	// Trashed: neither the root of the deletion nor its content.
	gone := folder(bob, "", w+" gone")
	goneFile := file(bob, gone.GetId(), w+" gone.txt")
	bob.must(200, "POST", "/api/disk/items/"+gone.GetId()+"/trash", nil, nil)
	// Bob is given one file inside Carol's private folder: found, the folder not named.
	given := file(carol, private.GetId(), w+" given.txt")
	carol.must(200, "PUT", "/api/disk/items/"+given.GetId()+"/permissions", &v1.UpdateDiskPermissionsRequest{
		Entries: []*v1.DiskPermissionEntry{userEntry(bob.id)}}, nil)
	// The guest is given one file inside a folder they do not see.
	o.must(200, "PUT", "/api/disk/items/"+public.GetId()+"/permissions", &v1.UpdateDiskPermissionsRequest{
		Entries: []*v1.DiskPermissionEntry{userEntry(gus.id)}}, nil)

	diskHits := func(u *user) map[string]*v1.SearchHit {
		t.Helper()
		out := map[string]*v1.SearchHit{}
		for _, h := range section(t, doSearch(t, u, q(w)+scope+"&type=disk"), stDisk).GetItems() {
			out[h.GetDisk().GetItemId()] = h
		}
		return out
	}
	bh := diskHits(bob)
	wantHits(t, "bob", bh, public.GetId(), shared.GetId(), inShared.GetId(), given.GetId())
	for _, id := range []string{private.GetId(), secret.GetId(), gone.GetId(), goneFile.GetId()} {
		if bh[id] != nil {
			t.Fatalf("bob sees %s", id)
		}
	}
	p := bh[public.GetId()]
	if r := p.GetDisk(); r.GetFolder() || r.GetFileId() == "" || r.GetSize() == 0 || r.GetParentId() != docs.GetId() ||
		!slices.Equal(r.GetPath(), []string{"Docs"}) || p.GetTitle() != w+" public.txt" || p.GetSnippet() != "\u0002"+w+"\u0003 public.txt" {
		t.Fatalf("public hit %v", p)
	}
	if r := bh[inShared.GetId()].GetDisk(); !slices.Equal(r.GetPath(), []string{w + " shared"}) {
		t.Fatalf("shared file path %v", r.GetPath())
	}
	if r := bh[given.GetId()].GetDisk(); len(r.GetPath()) != 0 || r.GetParentId() != private.GetId() {
		t.Fatalf("given file hit %v", r)
	}
	// The Disk's own breadcrumbs follow the same rule (diskacl gives the ancestors their chains).
	var crumbs v1.DiskPathResponse
	bob.must(200, "GET", "/api/disk/items/"+given.GetId()+"/path", nil, &crumbs)
	if it := crumbs.GetItems(); len(it) != 1 || it[0].GetId() != given.GetId() {
		t.Fatalf("crumbs under a private folder: %v", it)
	}
	if r := bh[shared.GetId()].GetDisk(); !r.GetFolder() || r.GetFileId() != "" || len(r.GetPath()) != 0 {
		t.Fatalf("shared folder hit %v", r)
	}
	// The workspace owner does not see a member's private folder either (ADR-0094 addendum).
	wantHits(t, "owner", diskHits(o), public.GetId())
	wantHits(t, "carol", diskHits(carol), public.GetId(), private.GetId(), secret.GetId(), shared.GetId(), inShared.GetId(), given.GetId())
	// The guest: the given file, with no folder named above it.
	gh := diskHits(gus)
	wantHits(t, "guest", gh, public.GetId())
	if len(gh[public.GetId()].GetDisk().GetPath()) != 0 {
		t.Fatalf("guest path %v", gh[public.GetId()].GetDisk().GetPath())
	}
	// Nothing invisible is counted, in the summary and in both feed orders; the feeds page.
	wantCount(t, "bob disk", bob, q(w)+scope, stDisk, 4)
	var first, second v1.SearchResponse
	bob.must(200, "GET", "/api/search?"+q(w)+scope+"&type=disk&sort=new&limit=2", nil, &first)
	s1 := section(t, &first, stDisk)
	if len(s1.GetItems()) != 2 || s1.GetNextCursor() == "" {
		t.Fatalf("first page %v", s1)
	}
	bob.must(200, "GET", "/api/search?"+q(w)+scope+"&type=disk&sort=new&limit=2&cursor="+s1.GetNextCursor(), nil, &second)
	s2 := section(t, &second, stDisk)
	if len(s2.GetItems()) != 2 || s2.GetNextCursor() != "" || s2.GetItems()[1].GetDisk().GetItemId() != public.GetId() {
		t.Fatalf("second page %v", s2)
	}

	// Wiki: in the summary, by the page rule.
	var open, closed v1.WikiPageResponse
	o.must(201, "POST", "/api/workspaces/"+wid+"/wiki/pages", &v1.CreateWikiPageRequest{Title: w + " handbook"}, &open)
	carol.must(201, "POST", "/api/workspaces/"+wid+"/wiki/pages", &v1.CreateWikiPageRequest{Title: w + " diary"}, &closed)
	carol.must(200, "PUT", "/api/wiki/pages/"+closed.GetPage().GetId()+"/permissions", &v1.UpdateWikiPermissionsRequest{Restricted: &on}, nil)
	wikiHits := func(u *user) map[string]*v1.SearchHit {
		t.Helper()
		out := map[string]*v1.SearchHit{}
		for _, h := range section(t, doSearch(t, u, q(w)+scope), stWiki).GetItems() {
			out[h.GetWiki().GetPageId()] = h
		}
		return out
	}
	wantHits(t, "bob wiki", wikiHits(bob), open.GetPage().GetId())
	wantHits(t, "carol wiki", wikiHits(carol), open.GetPage().GetId(), closed.GetPage().GetId())
	wantCount(t, "bob wiki", bob, q(w)+scope, stWiki, 1)
}

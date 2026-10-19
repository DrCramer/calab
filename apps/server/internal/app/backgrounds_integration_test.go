//go:build integration

package app_test

import (
	"bytes"
	"context"
	"strings"
	"testing"

	xwebp "golang.org/x/image/webp"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
)

func bgUpload(t *testing.T, u *user, wsID string, data []byte) string {
	t.Helper()
	st, f, _ := upload(t, u, "/api/workspaces/"+wsID+"/files", "photo.png", data)
	if st != 201 {
		t.Fatalf("upload: %d", st)
	}
	return f.GetId()
}

func newBackground(t *testing.T, u *user, wsID, name, fileID string) *v1.WorkspaceBackground {
	t.Helper()
	var r v1.CreateBackgroundResponse
	u.must(201, "POST", "/api/workspaces/"+wsID+"/backgrounds", &v1.CreateBackgroundRequest{Name: name, FileId: fileID}, &r)
	return r.GetBackground()
}

// webpSize fetches path as u and returns the WebP's dimensions.
func webpSize(t *testing.T, u *user, path string) (int, int) {
	t.Helper()
	resp, b := get(t, u, path, nil)
	if resp.StatusCode != 200 {
		t.Fatalf("%s: %d", path, resp.StatusCode)
	}
	cfg, err := xwebp.DecodeConfig(bytes.NewReader(b))
	if err != nil {
		t.Fatalf("%s is not WebP: %v", path, err)
	}
	return cfg.Width, cfg.Height
}

// TestBackgroundsLibrary (ADR-0035, «фоны пространства»): create / rename / delete with
// MANAGE_WORKSPACE, the picture rules (the caller's own image of this workspace), the server-made
// 1280×720 WebP with a 320×180 thumbnail, at most 20, events and READY; the picture is readable by
// members and guests, not by outsiders; members and guests cannot manage, a bot with the bit can
// (ADR-0109); deleting removes the row only.
func TestBackgroundsLibrary(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	base := "/api/workspaces/" + wid + "/backgrounds"
	src := bgUpload(t, o, wid, pngBytes(400, 400))

	// Picture rules.
	o.must(422, "POST", base, &v1.CreateBackgroundRequest{Name: "Office", FileId: "nope"}, nil)
	st, txt, _ := upload(t, o, "/api/workspaces/"+wid+"/files", "a.txt", []byte("hello"))
	if st != 201 {
		t.Fatalf("upload text: %d", st)
	}
	o.must(422, "POST", base, &v1.CreateBackgroundRequest{Name: "Office", FileId: txt.GetId()}, nil)
	other := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	o.must(422, "POST", base, &v1.CreateBackgroundRequest{Name: "Office", FileId: bgUpload(t, o, other.GetId(), pngBytes(32, 32))}, nil)
	// Someone else's picture (e.g. an attachment of a restricted room) is refused.
	bobPic := bgUpload(t, bob, wid, pngBytes(64, 36))
	o.must(422, "POST", base, &v1.CreateBackgroundRequest{Name: "Office", FileId: bobPic}, nil)
	o.must(422, "POST", base, &v1.CreateBackgroundRequest{Name: "   ", FileId: src}, nil)
	o.must(422, "POST", base, &v1.CreateBackgroundRequest{Name: strings.Repeat("x", 41), FileId: src}, nil)

	// Rights: a member and a guest cannot manage.
	bob.must(403, "POST", base, &v1.CreateBackgroundRequest{Name: "Office", FileId: bobPic}, nil)
	g := register(t, invite(t, o, wid))
	guest := v1.WorkspaceRole_WORKSPACE_ROLE_GUEST
	o.must(200, "PATCH", "/api/workspaces/"+wid+"/members/"+g.id, &v1.UpdateMemberRequest{Role: &guest}, nil)
	g.must(403, "POST", base, &v1.CreateBackgroundRequest{Name: "Office", FileId: src}, nil)
	b := createBot(t, o, wid, "Painter")
	manage := newRole(t, o, wid, "Managers", perm.ManageWorkspace)
	if st, _ := setMemberRoles(o, wid, b.id, manage.GetId()); st != 200 {
		t.Fatalf("bot role: %d", st)
	}
	// A bot with MANAGE_WORKSPACE manages like a person (ADR-0109): its own picture only.
	b.must(422, "POST", base, &v1.CreateBackgroundRequest{Name: "Office", FileId: src}, nil)
	b.must(200, "GET", base, nil, nil)
	var bb v1.CreateBackgroundResponse
	b.must(201, "POST", base, &v1.CreateBackgroundRequest{Name: "Bot", FileId: bgUpload(t, &user{client: b.client, id: b.id}, wid, pngBytes(64, 36))}, &bb)
	b.must(204, "DELETE", base+"/"+bb.GetBackground().GetId(), nil, nil)

	bg := dialGW(t)
	bg.identify(bob.token)
	office := newBackground(t, o, wid, " Office ", src)
	if office.GetName() != "Office" || office.GetWorkspaceId() != wid || office.GetFileId() == "" || office.GetFileId() == src {
		t.Fatalf("created: %v", office)
	}
	bg.wait("BACKGROUND_CREATE", func(e *v1.DispatchEvent) bool {
		return e.GetBackgroundCreate().GetBackground().GetId() == office.GetId()
	})

	// The server-made picture: 1280×720 WebP, thumbnail 320×180; members and guests read it,
	// outsiders do not; the upload it was made from stays the uploader's only.
	pic := office.GetFileId()
	if w, h := webpSize(t, bob, "/api/files/"+pic); w != 1280 || h != 720 {
		t.Fatalf("picture %dx%d", w, h)
	}
	if w, h := webpSize(t, g, "/api/files/"+pic+"/thumbnail"); w != 320 || h != 180 {
		t.Fatalf("thumbnail %dx%d", w, h)
	}
	if st := fileStatus(t, g, pic); st != 200 {
		t.Fatalf("background for a guest: %d", st)
	}
	outsider := register(t, invite(t, o, other.GetId()))
	if st := fileStatus(t, outsider, pic); st != 404 {
		t.Fatalf("background for an outsider: %d", st)
	}
	if st := fileStatus(t, bob, src); st != 404 {
		t.Fatalf("source upload for a member: %d", st)
	}

	// Rename.
	name := "Open space"
	var up v1.UpdateBackgroundResponse
	o.must(200, "PATCH", base+"/"+office.GetId(), &v1.UpdateBackgroundRequest{Name: &name}, &up)
	if up.GetBackground().GetName() != name || up.GetBackground().GetFileId() != pic {
		t.Fatalf("updated: %v", up.GetBackground())
	}
	bg.wait("BACKGROUND_UPDATE", func(e *v1.DispatchEvent) bool { return e.GetBackgroundUpdate().GetBackground().GetName() == name })
	bob.must(403, "PATCH", base+"/"+office.GetId(), &v1.UpdateBackgroundRequest{Name: &name}, nil)
	long := strings.Repeat("я", 41)
	o.must(422, "PATCH", base+"/"+office.GetId(), &v1.UpdateBackgroundRequest{Name: &long}, nil)
	o.must(404, "PATCH", base+"/00000000-0000-0000-0000-000000000001", &v1.UpdateBackgroundRequest{Name: &name}, nil)
	foreign := newBackground(t, o, other.GetId(), "Other", bgUpload(t, o, other.GetId(), pngBytes(64, 36)))
	o.must(404, "PATCH", base+"/"+foreign.GetId(), &v1.UpdateBackgroundRequest{Name: &name}, nil)
	o.must(404, "DELETE", base+"/"+foreign.GetId(), nil, nil)

	// The list and READY carry them (guests too); outsiders get 404.
	var list v1.ListBackgroundsResponse
	g.must(200, "GET", base, nil, &list)
	if len(list.GetBackgrounds()) != 1 || list.GetBackgrounds()[0].GetName() != name {
		t.Fatalf("list: %v", list.GetBackgrounds())
	}
	outsider.must(404, "GET", base, nil, nil)
	found := false
	for _, s := range dialGW(t).identify(g.token).GetWorkspaces() { // a guest's READY
		if s.GetWorkspace().GetId() == wid {
			found = len(s.GetBackgrounds()) == 1 && s.GetBackgrounds()[0].GetId() == office.GetId()
		}
	}
	if !found {
		t.Fatal("background not in READY")
	}

	// At most 20.
	small := bgUpload(t, o, wid, pngBytes(64, 36))
	for i := 1; i < 20; i++ {
		newBackground(t, o, wid, "B", small)
	}
	o.must(409, "POST", base, &v1.CreateBackgroundRequest{Name: "21st", FileId: small}, nil)

	// Delete: the row only — the others stay, the picture is no longer the members'.
	bob.must(403, "DELETE", base+"/"+office.GetId(), nil, nil)
	o.must(204, "DELETE", base+"/"+office.GetId(), nil, nil)
	bg.wait("BACKGROUND_DELETE", func(e *v1.DispatchEvent) bool {
		d := e.GetBackgroundDelete()
		return d.GetBackgroundId() == office.GetId() && d.GetWorkspaceId() == wid
	})
	o.must(404, "DELETE", base+"/"+office.GetId(), nil, nil)
	bob.must(200, "GET", base, nil, &list)
	if len(list.GetBackgrounds()) != 19 {
		t.Fatalf("after delete: %d", len(list.GetBackgrounds()))
	}
	if st := fileStatus(t, bob, pic); st != 404 {
		t.Fatalf("deleted background's picture for a member: %d", st)
	}
	o.must(201, "POST", base, &v1.CreateBackgroundRequest{Name: "20th again", FileId: small}, nil)

	// Orphan cleanup (security review): live background pictures stay, the deleted one's picture
	// and the source uploads go, and the workspace quota equals the bytes of its files.
	ctx := context.Background()
	if _, err := testDB.Pool.Exec(ctx, "UPDATE files SET created_at = now() - interval '25 hours' WHERE workspace_id = $1", wid); err != nil {
		t.Fatal(err)
	}
	if _, err := testApp.Files.CleanupOrphans(ctx); err != nil {
		t.Fatal(err)
	}
	bob.must(200, "GET", base, nil, &list)
	if n := len(list.GetBackgrounds()); n != 20 {
		t.Fatalf("after cleanup: %d", n)
	}
	for _, b := range list.GetBackgrounds() {
		if st := fileStatus(t, bob, b.GetFileId()); st != 200 {
			t.Fatalf("live background %s after cleanup: %d", b.GetId(), st)
		}
	}
	for _, id := range []string{pic, src, small} {
		if st := fileStatus(t, o, id); st != 404 {
			t.Fatalf("orphan %s after cleanup: %d", id, st)
		}
	}
	var used, sum int64
	if err := testDB.Pool.QueryRow(ctx, "SELECT storage_used_bytes, (SELECT coalesce(sum(size), 0)::bigint FROM files WHERE workspace_id = $1) FROM workspaces WHERE id = $1", wid).Scan(&used, &sum); err != nil {
		t.Fatal(err)
	}
	if used != sum {
		t.Fatalf("workspace quota %d, files %d", used, sum)
	}
}

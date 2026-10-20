//go:build integration

package app_test

import (
	"slices"
	"strconv"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
)

func newApp(t *testing.T, u *user, wsID, name, url, icon string) *v1.WorkspaceApp {
	t.Helper()
	var r v1.CreateWorkspaceAppResponse
	u.must(201, "POST", "/api/workspaces/"+wsID+"/apps", &v1.CreateWorkspaceAppRequest{Name: name, Url: url, IconFileId: icon}, &r)
	return r.GetApp()
}

func appIDs(apps []*v1.WorkspaceApp) []string {
	out := make([]string, len(apps))
	for i, a := range apps {
		out[i] = a.GetId()
	}
	return out
}

func sameIDs(a, b []string) bool { return slices.Equal(a, b) }

func readyApps(t *testing.T, token, wsID string) ([]*v1.WorkspaceApp, bool) {
	t.Helper()
	for _, s := range dialGW(t).identify(token).GetWorkspaces() {
		if s.GetWorkspace().GetId() == wsID {
			return s.GetApps(), true
		}
	}
	return nil, false
}

// TestWorkspaceAppsCRUD (ADR-0050): create / list / update / delete with MANAGE_INTEGRATIONS,
// members see and admins manage, guests and bots neither, other workspaces 404, the icon's
// readability, READY and the events (not to guests).
func TestWorkspaceAppsCRUD(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	base := "/api/workspaces/" + wid + "/apps"

	g := register(t, invite(t, o, wid))
	guest := v1.WorkspaceRole_WORKSPACE_ROLE_GUEST
	o.must(200, "PATCH", "/api/workspaces/"+wid+"/members/"+g.id, &v1.UpdateMemberRequest{Role: &guest}, nil)

	bg := dialGW(t)
	bg.identify(bob.token)
	gg := dialGW(t)
	gg.identify(g.token)

	st, icon, _ := upload(t, o, "/api/workspaces/"+wid+"/files", "icon.png", pngBytes(64, 64))
	if st != 201 {
		t.Fatalf("upload icon: %d", st)
	}
	grafana := newApp(t, o, wid, "  Grafana ", "https://grafana.example.com/d/abc", icon.GetId())
	if grafana.GetName() != "Grafana" || grafana.GetWorkspaceId() != wid || grafana.GetIconFileId() != icon.GetId() ||
		grafana.GetIconUrl() != "/api/files/"+icon.GetId() || grafana.GetCreatedBy() != o.id || grafana.GetCreatedAt() == nil {
		t.Fatalf("created: %v", grafana)
	}
	bg.wait("WORKSPACE_APP_UPSERT", func(e *v1.DispatchEvent) bool {
		return e.GetWorkspaceAppUpsert().GetApp().GetId() == grafana.GetId()
	})
	wiki := newApp(t, o, wid, "Wiki", "http://wiki.local/", "")
	if wiki.GetPosition() <= grafana.GetPosition() || wiki.GetIconUrl() != "" {
		t.Fatalf("second app: %v (first at %v)", wiki, grafana.GetPosition())
	}

	// Members list them in order; guests cannot.
	var list v1.ListWorkspaceAppsResponse
	bob.must(200, "GET", base, nil, &list)
	if !sameIDs(appIDs(list.GetApps()), []string{grafana.GetId(), wiki.GetId()}) {
		t.Fatalf("list: %v", list.GetApps())
	}
	g.must(403, "GET", base, nil, nil)

	// The icon: members read it, guests and outsiders do not.
	if st := fileStatus(t, bob, icon.GetId()); st != 200 {
		t.Fatalf("icon for a member: %d", st)
	}
	if st := fileStatus(t, g, icon.GetId()); st != 404 {
		t.Fatalf("icon for a guest: %d", st)
	}
	other := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	outsider := register(t, invite(t, o, other.GetId()))
	if st := fileStatus(t, outsider, icon.GetId()); st != 404 {
		t.Fatalf("icon for an outsider: %d", st)
	}

	// Rights: a member cannot manage (403); a guest does not see (403 on the list, 404 on an app);
	// an outsider gets 404; a bot works by its bits (ADR-0109).
	name := "Grafana 2"
	bob.must(403, "POST", base, &v1.CreateWorkspaceAppRequest{Name: "X", Url: "https://x.example"}, nil)
	bob.must(403, "PATCH", "/api/workspace-apps/"+grafana.GetId(), &v1.UpdateWorkspaceAppRequest{Name: &name}, nil)
	bob.must(403, "DELETE", "/api/workspace-apps/"+grafana.GetId(), nil, nil)
	bob.must(403, "PUT", "/api/workspace-apps/"+grafana.GetId()+"/position", &v1.SetWorkspaceAppPositionRequest{}, nil)
	g.must(403, "POST", base, &v1.CreateWorkspaceAppRequest{Name: "X", Url: "https://x.example"}, nil)
	g.must(404, "PATCH", "/api/workspace-apps/"+grafana.GetId(), &v1.UpdateWorkspaceAppRequest{Name: &name}, nil)
	g.must(404, "DELETE", "/api/workspace-apps/"+grafana.GetId(), nil, nil)
	outsider.must(404, "GET", base, nil, nil)
	outsider.must(404, "PATCH", "/api/workspace-apps/"+grafana.GetId(), &v1.UpdateWorkspaceAppRequest{Name: &name}, nil)
	outsider.must(404, "DELETE", "/api/workspace-apps/"+grafana.GetId(), nil, nil)
	b := createBot(t, o, wid, "Appbot")
	integr := newRole(t, o, wid, "Integrators", perm.ManageIntegrations)
	if st, _ := setMemberRoles(o, wid, b.id, integr.GetId()); st != 200 {
		t.Fatalf("bot role: %d", st)
	}
	// A bot with MANAGE_INTEGRATIONS manages apps through the API like a person (ADR-0109); its
	// READY still carries none (apps are a client surface).
	b.must(200, "GET", base, nil, nil)
	var ba v1.CreateWorkspaceAppResponse
	b.must(201, "POST", base, &v1.CreateWorkspaceAppRequest{Name: "X", Url: "https://x.example"}, &ba)
	b.must(204, "DELETE", "/api/workspace-apps/"+ba.GetApp().GetId(), nil, nil)
	if apps, ok := readyApps(t, b.token, wid); !ok || len(apps) != 0 {
		t.Fatalf("bot READY apps: %v (%v)", apps, ok)
	}

	// A member given MANAGE_INTEGRATIONS manages.
	if st, _ := setMemberRoles(o, wid, bob.id, integr.GetId()); st != 200 {
		t.Fatalf("bob role: %d", st)
	}
	url := "https://grafana.example.com/d/xyz"
	var up v1.UpdateWorkspaceAppResponse
	bob.must(200, "PATCH", "/api/workspace-apps/"+grafana.GetId(), &v1.UpdateWorkspaceAppRequest{Name: &name, Url: &url}, &up)
	if up.GetApp().GetName() != name || up.GetApp().GetUrl() != url || up.GetApp().GetIconFileId() != icon.GetId() {
		t.Fatalf("updated: %v", up.GetApp())
	}
	bg.wait("WORKSPACE_APP_UPSERT (update)", func(e *v1.DispatchEvent) bool {
		return e.GetWorkspaceAppUpsert().GetApp().GetName() == name
	})
	// Someone else's upload cannot become the icon; the current one can be kept; "" clears.
	oIcon := icon.GetId()
	bob.must(200, "PATCH", "/api/workspace-apps/"+grafana.GetId(), &v1.UpdateWorkspaceAppRequest{IconFileId: &oIcon}, nil)
	st, other2, _ := upload(t, o, "/api/workspaces/"+wid+"/files", "o.png", pngBytes(32, 32))
	if st != 201 {
		t.Fatalf("upload: %d", st)
	}
	foreignIcon := other2.GetId()
	bob.must(422, "PATCH", "/api/workspace-apps/"+grafana.GetId(), &v1.UpdateWorkspaceAppRequest{IconFileId: &foreignIcon}, nil)
	empty := ""
	bob.must(200, "PATCH", "/api/workspace-apps/"+grafana.GetId(), &v1.UpdateWorkspaceAppRequest{IconFileId: &empty}, &up)
	if up.GetApp().GetIconFileId() != "" || up.GetApp().GetIconUrl() != "" {
		t.Fatalf("icon not cleared: %v", up.GetApp())
	}
	o.must(404, "PATCH", "/api/workspace-apps/00000000-0000-0000-0000-000000000001", &v1.UpdateWorkspaceAppRequest{Name: &name}, nil)

	// An app of another workspace is 404 for a member of this one only.
	foreign := newApp(t, o, other.GetId(), "Other", "https://other.example", "")
	bob.must(404, "PATCH", "/api/workspace-apps/"+foreign.GetId(), &v1.UpdateWorkspaceAppRequest{Name: &name}, nil)
	bob.must(404, "DELETE", "/api/workspace-apps/"+foreign.GetId(), nil, nil)
	// A neighbour from another workspace is refused.
	o.must(422, "PUT", "/api/workspace-apps/"+grafana.GetId()+"/position", &v1.SetWorkspaceAppPositionRequest{AfterAppId: foreign.GetId()}, nil)

	// Delete.
	bob.must(204, "DELETE", "/api/workspace-apps/"+wiki.GetId(), nil, nil)
	bg.wait("WORKSPACE_APP_DELETE", func(e *v1.DispatchEvent) bool {
		d := e.GetWorkspaceAppDelete()
		return d.GetAppId() == wiki.GetId() && d.GetWorkspaceId() == wid
	})
	bob.must(404, "DELETE", "/api/workspace-apps/"+wiki.GetId(), nil, nil)

	// The guest got none of the events.
	gg.quiet("app event for a guest", 300*time.Millisecond, func(e *v1.DispatchEvent) bool {
		return e.GetWorkspaceAppUpsert() != nil || e.GetWorkspaceAppDelete() != nil
	})

	// READY (a new session replaces the one above): members get the apps, guests none.
	if apps, ok := readyApps(t, bob.token, wid); !ok || !sameIDs(appIDs(apps), []string{grafana.GetId()}) {
		t.Fatalf("member READY apps: %v", apps)
	}
	if apps, ok := readyApps(t, g.token, wid); !ok || len(apps) != 0 {
		t.Fatalf("guest READY apps: %v (%v)", apps, ok)
	}
}

// TestWorkspaceAppsURLAndLimits (ADR-0050 §1): the URL rule on create and update, name bounds,
// at most 20 apps, and reordering between neighbours.
func TestWorkspaceAppsURLAndLimits(t *testing.T) {
	o, _, ws, _ := setupTeam(t)
	wid := ws.GetId()
	base := "/api/workspaces/" + wid + "/apps"

	for _, u := range []string{
		"https://example.com", "http://localhost:8080/", "http://10.0.0.5/x", "http://192.168.1.1",
		"http://172.20.1.1", "http://intranet/wiki", "http://nas.local",
	} {
		newApp(t, o, wid, "ok", u, "")
	}
	for _, u := range []string{
		"http://example.com", "http://8.8.8.8/", "javascript:alert(1)", "file:///etc/passwd",
		"ftp://example.com", "example.com", "https://user:pw@example.com", "data:text/html,x", "",
	} {
		o.must(422, "POST", base, &v1.CreateWorkspaceAppRequest{Name: "bad", Url: u}, nil)
	}
	o.must(422, "POST", base, &v1.CreateWorkspaceAppRequest{Name: "   ", Url: "https://example.com"}, nil)
	o.must(422, "POST", base, &v1.CreateWorkspaceAppRequest{Name: "12345678901234567890123456789012345678901", Url: "https://example.com"}, nil)
	o.must(422, "POST", base, &v1.CreateWorkspaceAppRequest{Name: "icon", Url: "https://example.com", IconFileId: "nope"}, nil)
	st, txt, _ := upload(t, o, "/api/workspaces/"+wid+"/files", "a.txt", []byte("hello"))
	if st != 201 {
		t.Fatalf("upload: %d", st)
	}
	o.must(422, "POST", base, &v1.CreateWorkspaceAppRequest{Name: "icon", Url: "https://example.com", IconFileId: txt.GetId()}, nil)

	var list v1.ListWorkspaceAppsResponse
	o.must(200, "GET", base, nil, &list)
	first := list.GetApps()[0]
	bad := "http://example.com"
	o.must(422, "PATCH", "/api/workspace-apps/"+first.GetId(), &v1.UpdateWorkspaceAppRequest{Url: &bad}, nil)

	// Reorder: the last one to the front, then between the first two, then to the end.
	ids := appIDs(list.GetApps())
	var pos v1.SetWorkspaceAppPositionResponse
	last := ids[len(ids)-1]
	o.must(200, "PUT", "/api/workspace-apps/"+last+"/position", &v1.SetWorkspaceAppPositionRequest{BeforeAppId: ids[0]}, &pos)
	want := append([]string{last}, ids[:len(ids)-1]...)
	if !sameIDs(appIDs(pos.GetApps()), want) {
		t.Fatalf("to front: %v, want %v", appIDs(pos.GetApps()), want)
	}
	// Many moves into the same gap exhaust it and renumber; the order stays right.
	for i := range 60 {
		cur := appIDs(pos.GetApps())
		mover := cur[len(cur)-1]
		o.must(200, "PUT", "/api/workspace-apps/"+mover+"/position",
			&v1.SetWorkspaceAppPositionRequest{AfterAppId: cur[0], BeforeAppId: cur[1]}, &pos)
		got := appIDs(pos.GetApps())
		if got[1] != mover {
			t.Fatalf("move %d: %v (mover %s)", i, got, mover)
		}
		for j := 1; j < len(pos.GetApps()); j++ {
			if pos.GetApps()[j].GetPosition() <= pos.GetApps()[j-1].GetPosition() {
				t.Fatalf("move %d: positions not increasing: %v", i, pos.GetApps())
			}
		}
	}
	o.must(422, "PUT", "/api/workspace-apps/"+ids[0]+"/position",
		&v1.SetWorkspaceAppPositionRequest{AfterAppId: ids[1], BeforeAppId: ids[3]}, nil)
	o.must(200, "PUT", "/api/workspace-apps/"+ids[0]+"/position", &v1.SetWorkspaceAppPositionRequest{}, &pos)
	if got := appIDs(pos.GetApps()); got[len(got)-1] != ids[0] {
		t.Fatalf("to end: %v", got)
	}

	// At most 20.
	for i := len(ids); i < 20; i++ {
		newApp(t, o, wid, "App "+strconv.Itoa(i), "https://example.com/"+strconv.Itoa(i), "")
	}
	o.must(409, "POST", base, &v1.CreateWorkspaceAppRequest{Name: "21st", Url: "https://example.com"}, nil)
}

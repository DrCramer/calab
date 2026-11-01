//go:build integration

package office

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/blob"
	"github.com/calaba/calaba/server/internal/db/dbtest"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/disk"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/files"
	"github.com/calaba/calaba/server/internal/perm"
)

func TestMain(m *testing.M) { os.Exit(dbtest.Run(m)) }

// The whole path over the real Disk: open → the Document Server downloads the pinned file →
// forcesave → the Disk item has the new sha256 / size / updated_at at once, the same id and
// name, the previous file is a version; a member with «Просмотр» opens read-only; an outsider
// gets 404; a save after losing «Правка» is refused.
func TestDiskStoreEndToEnd(t *testing.T) {
	ctx := context.Background()
	d := dbtest.Connect(t)
	store, err := blob.NewFS(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	fs := files.NewService(d, store, events.Nop{}, 10<<20, 0)
	dk := disk.New(d, events.Nop{}, fs, nil)
	user := func(name string) uuid.UUID {
		id := uuid.New()
		if _, err := d.Pool.Exec(ctx, `INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)`, id, name+"-"+id.String()[:8]+"@office.test", name); err != nil {
			t.Fatal(err)
		}
		return id
	}
	owner, alice, bob, outsider := user("Owner"), user("Alice"), user("Bob"), user("Outsider")
	ws := uuid.New()
	if _, err := d.Pool.Exec(ctx, `INSERT INTO workspaces (id, slug, name, owner_id) VALUES ($1, $2, 'Office', $3)`, ws, "of-"+ws.String()[:12], owner); err != nil {
		t.Fatal(err)
	}
	for u, role := range map[uuid.UUID]string{owner: "owner", alice: "member", bob: "member"} {
		if _, err := d.Q.AddMember(ctx, sqlc.AddMemberParams{WorkspaceID: ws, UserID: u, Role: role}); err != nil {
			t.Fatal(err)
		}
	}
	// The file: stored like an upload and filed by its owner (alice).
	body := xlsxOf(t, "v1")
	f, err := fs.StoreSystemFile(ctx, ws, alice, "График отпусков 2026.xlsx", mimeXlsx, bytes.NewReader(body), int64(len(body)))
	if err != nil {
		t.Fatal(err)
	}
	it, err := d.Q.CreateDiskItem(ctx, sqlc.CreateDiskItemParams{WorkspaceID: ws, Kind: "file", Name: "График отпусков 2026.xlsx", FileID: &f.ID, OwnerID: &alice})
	if err != nil {
		t.Fatal(err)
	}
	// bob: «Просмотр» only (a user override denying DISK_WRITE).
	if err := d.Q.InsertDiskPermission(ctx, sqlc.InsertDiskPermissionParams{ItemID: it.ID, TargetType: "user", TargetID: bob.String(), Deny: int64(perm.DiskWrite)}); err != nil {
		t.Fatal(err)
	}

	saved := map[string][]byte{}
	ds := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(saved[r.URL.Path]) }))
	defer ds.Close()
	svc := New(Config{Enabled: true, DocsURL: "https://docs.office.test", DocsInternalURL: ds.URL, APIURL: "http://api.office.test",
		Secret: dsSecret, URLKey: DeriveURLKey(apiSecret)}, &DiskStore{DB: d, Files: fs, Disk: dk}, &fakeSessions{m: map[uuid.UUID]Session{}})
	mux := http.NewServeMux()
	svc.Routes(mux, func(h http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			h.ServeHTTP(w, r.WithContext(perm.WithResolver(r.Context(), d.Q)))
		})
	})
	open := func(uid uuid.UUID) (int, *v1.OfficeConfigResponse, map[string]any) {
		r := httptest.NewRequestWithContext(ctx, http.MethodGet, "/api/office/config?item="+it.ID.String(), nil)
		r = r.WithContext(auth.WithIdentity(r.Context(), auth.Identity{UserID: uid}))
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		if w.Code != http.StatusOK {
			return w.Code, nil, nil
		}
		var resp v1.OfficeConfigResponse
		_ = protojson.Unmarshal(w.Body.Bytes(), &resp)
		var cfg map[string]any
		_ = json.Unmarshal([]byte(resp.ConfigJson), &cfg)
		return w.Code, &resp, cfg
	}
	if code, _, _ := open(outsider); code != http.StatusNotFound {
		t.Fatalf("outsider: %d", code)
	}
	if _, resp, cfg := open(bob); resp.Mode != v1.OfficeMode_OFFICE_MODE_VIEW || dig(cfg, "editorConfig", "user", "name") != "Bob" {
		t.Fatalf("bob: %v", resp)
	}
	_, resp, cfg := open(alice)
	if resp.Mode != v1.OfficeMode_OFFICE_MODE_EDIT {
		t.Fatalf("alice: %v", resp)
	}
	// The Document Server downloads the pinned version.
	fu, _ := url.Parse(dig(cfg, "document", "url").(string))
	r := httptest.NewRequestWithContext(ctx, http.MethodGet, fu.Path, nil)
	r.Header.Set("Authorization", "Bearer "+dsToken(t, dsSecret, jwt.MapClaims{"operation": "download"}))
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != http.StatusOK || !bytes.Equal(w.Body.Bytes(), body) {
		t.Fatalf("download %d", w.Code)
	}
	callback := func(b map[string]any) int {
		cb, _ := url.Parse(dig(cfg, "editorConfig", "callbackUrl").(string))
		raw, _ := json.Marshal(b)
		r := httptest.NewRequestWithContext(ctx, http.MethodPost, cb.Path, bytes.NewReader(raw))
		r.Header.Set("Authorization", "Bearer "+dsToken(t, dsSecret, jwt.MapClaims{"payload": b, "operation": "callback"}))
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		var out struct{ Error int }
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return out.Error
	}
	before := time.Now()
	saved["/s1"] = xlsxOf(t, "v2")
	if e := callback(map[string]any{"key": resp.Key, "status": 6, "filetype": "xlsx", "url": ds.URL + "/s1", "users": []string{alice.String()}}); e != 0 {
		t.Fatal("forcesave refused")
	}
	cur, err := d.Q.GetDiskItem(ctx, it.ID)
	if err != nil {
		t.Fatal(err)
	}
	nf, _ := d.Q.GetFile(ctx, *cur.FileID)
	if cur.ID != it.ID || cur.Name != it.Name || *cur.FileID == f.ID || nf.Sha256 != sum(xlsxOf(t, "v2")) || nf.Size != int64(len(xlsxOf(t, "v2"))) ||
		cur.UpdatedAt.Before(before.Add(-time.Second)) || nf.Mime != mimeXlsx || nf.Name != it.Name {
		t.Fatalf("after save: %+v %+v", cur, nf)
	}
	var versions int
	_ = d.Pool.QueryRow(ctx, `SELECT count(*) FROM disk_file_versions WHERE item_id = $1 AND file_id = $2`, it.ID, f.ID).Scan(&versions)
	if versions != 1 {
		t.Fatal("the previous file must be a version")
	}
	// The open-during-forcesave rule reads the newest version: the file the forcesave replaced.
	ds2 := &DiskStore{DB: d, Files: fs, Disk: dk}
	if last, err := ds2.LastVersion(ctx, it.ID); err != nil || last != f.ID {
		t.Fatalf("last version %v %v", last, err)
	}
	if last, err := ds2.LastVersion(ctx, uuid.New()); err != nil || last != uuid.Nil {
		t.Fatalf("no versions: %v %v", last, err)
	}
	// Alice (the item's owner) leaves the workspace during the session: her save is refused,
	// nothing is stored.
	if _, err := d.Pool.Exec(ctx, `DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`, ws, alice); err != nil {
		t.Fatal(err)
	}
	saved["/s2"] = xlsxOf(t, "v3")
	if e := callback(map[string]any{"key": resp.Key, "status": 2, "filetype": "xlsx", "url": ds.URL + "/s2", "users": []string{alice.String()}}); e != 1 {
		t.Fatal("a save after losing «Правка» accepted")
	}
	if again, _ := d.Q.GetDiskItem(ctx, it.ID); *again.FileID != *cur.FileID {
		t.Fatal("stored")
	}
	// Deleted forever while a session is live: the late save is refused and the session ends.
	if _, err := d.Pool.Exec(ctx, `DELETE FROM disk_items WHERE id = $1`, it.ID); err != nil {
		t.Fatal(err)
	}
	if e := callback(map[string]any{"key": resp.Key, "status": 2, "filetype": "xlsx", "url": ds.URL + "/s2", "users": []string{alice.String()}}); e != 1 {
		t.Fatal("a save into a deleted item accepted")
	}
}

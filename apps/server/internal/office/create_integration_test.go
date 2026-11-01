//go:build integration

package office

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

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

// «Создать» over the real Disk: the file is stored (sha256, size, quota), filed in the folder
// with a free name and journaled as an upload; «Просмотр» on the folder, the quota and a
// suspended workspace refuse it and leave nothing behind.
func TestCreateFromTemplate(t *testing.T) {
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
	owner, alice, bob := user("Owner"), user("Alice"), user("Bob")
	ws := uuid.New()
	if _, err := d.Pool.Exec(ctx, `INSERT INTO workspaces (id, slug, name, owner_id) VALUES ($1, $2, 'Office', $3)`, ws, "oc-"+ws.String()[:12], owner); err != nil {
		t.Fatal(err)
	}
	for u, role := range map[uuid.UUID]string{owner: "owner", alice: "member", bob: "member"} {
		if _, err := d.Q.AddMember(ctx, sqlc.AddMemberParams{WorkspaceID: ws, UserID: u, Role: role}); err != nil {
			t.Fatal(err)
		}
	}
	folder, err := d.Q.CreateDiskItem(ctx, sqlc.CreateDiskItemParams{WorkspaceID: ws, Kind: "folder", Name: "Отчёты", OwnerID: &owner})
	if err != nil {
		t.Fatal(err)
	}
	// bob: «Просмотр» on the folder.
	if err := d.Q.InsertDiskPermission(ctx, sqlc.InsertDiskPermissionParams{ItemID: folder.ID, TargetType: "user", TargetID: bob.String(), Deny: int64(perm.DiskWrite)}); err != nil {
		t.Fatal(err)
	}
	svc := New(Config{Enabled: true, DocsURL: "https://docs.office.test", APIURL: "http://api.office.test", Secret: dsSecret, URLKey: DeriveURLKey(apiSecret)},
		&DiskStore{DB: d, Files: fs, Disk: dk}, &fakeSessions{m: map[uuid.UUID]Session{}})
	mux := http.NewServeMux()
	svc.Routes(mux, func(h http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			h.ServeHTTP(w, r.WithContext(perm.WithResolver(r.Context(), d.Q)))
		})
	})
	create := func(uid uuid.UUID, body string) (int, *v1.DiskItem) {
		r := httptest.NewRequestWithContext(ctx, http.MethodPost, "/api/workspaces/"+ws.String()+"/office/create", strings.NewReader(body))
		r = r.WithContext(auth.WithIdentity(r.Context(), auth.Identity{UserID: uid}))
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		var resp v1.DiskItemResponse
		_ = protojson.Unmarshal(w.Body.Bytes(), &resp)
		return w.Code, resp.GetItem()
	}
	usage := func() (used int64, files int) {
		_ = d.Pool.QueryRow(ctx, `SELECT storage_used_bytes FROM workspaces WHERE id = $1`, ws).Scan(&used)
		_ = d.Pool.QueryRow(ctx, `SELECT count(*) FROM files WHERE workspace_id = $1`, ws).Scan(&files)
		return
	}
	in := `"parent_id":"` + folder.ID.String() + `"`
	code, it := create(alice, `{"extension":"docx","name":"Новый документ",`+in+`}`)
	if code != http.StatusCreated || it.GetName() != "Новый документ.docx" || it.GetParentId() != folder.ID.String() {
		t.Fatalf("create: %d %v", code, it)
	}
	code, again := create(alice, `{"extension":"docx","name":"Новый документ",`+in+`}`)
	if code != http.StatusCreated || again.GetName() != "Новый документ (2).docx" {
		t.Fatalf("a taken name: %d %v", code, again)
	}
	id, _ := uuid.Parse(it.GetId())
	row, err := d.Q.GetDiskItem(ctx, id)
	if err != nil || row.FileID == nil || *row.OwnerID != alice {
		t.Fatalf("item %+v %v", row, err)
	}
	f, err := d.Q.GetFile(ctx, *row.FileID)
	if err != nil || f.Mime != mimeDocx || f.Size <= 0 || len(f.Sha256) != 64 {
		t.Fatalf("file %+v %v", f, err)
	}
	var kind string
	if err := d.Pool.QueryRow(ctx, `SELECT kind FROM disk_activity WHERE item_id = $1`, id).Scan(&kind); err != nil || kind != "upload" {
		t.Fatalf("journal %q %v", kind, err)
	}
	used, n := usage()
	if used < 2*f.Size || n != 2 {
		t.Fatalf("quota counted %d for %d files", used, n)
	}
	// «Просмотр» on the folder: refused, nothing stored.
	if code, _ := create(bob, `{"extension":"xlsx",`+in+`}`); code != http.StatusForbidden && code != http.StatusNotFound {
		t.Fatalf("bob: %d", code)
	}
	if u2, n2 := usage(); u2 != used || n2 != n {
		t.Fatalf("a refused create left %d bytes, %d files", u2-used, n2-n)
	}
	// Bob may write into the root.
	if code, it := create(bob, `{"extension":"pptx","lang":"en"}`); code != http.StatusCreated || it.GetName() != "New presentation.pptx" {
		t.Fatalf("bob root: %d %v", code, it)
	}
	used, n = usage()
	// The quota: full workspace → 413, nothing stored.
	if _, err := d.Pool.Exec(ctx, `UPDATE workspaces SET storage_quota_bytes = storage_used_bytes + 10 WHERE id = $1`, ws); err != nil {
		t.Fatal(err)
	}
	if code, _ := create(alice, `{"extension":"xlsx"}`); code != http.StatusRequestEntityTooLarge {
		t.Fatalf("quota: %d", code)
	}
	if u2, n2 := usage(); u2 != used || n2 != n {
		t.Fatalf("over quota left %d bytes, %d files", u2-used, n2-n)
	}
	if _, err := d.Pool.Exec(ctx, `UPDATE workspaces SET storage_quota_bytes = 1 << 40, suspended_at = now() WHERE id = $1`, ws); err != nil {
		t.Fatal(err)
	}
	if code, _ := create(alice, `{"extension":"xlsx"}`); code < 400 {
		t.Fatalf("suspended: %d", code)
	}
	if u2, n2 := usage(); u2 != used || n2 != n {
		t.Fatalf("suspended left %d bytes, %d files", u2-used, n2-n)
	}
}

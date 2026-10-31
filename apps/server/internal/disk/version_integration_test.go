//go:build integration

package disk

import (
	"bytes"
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

type fakeEditors map[uuid.UUID][]uuid.UUID

func (f fakeEditors) EditorsOf(_ context.Context, ids []uuid.UUID) (map[uuid.UUID][]uuid.UUID, error) {
	out := map[uuid.UUID][]uuid.UUID{}
	for _, id := range ids {
		if u, ok := f[id]; ok {
			out[id] = u
		}
	}
	return out, nil
}

// A saved version (ADR-0143): same id, parent and name; the new file's sha256, size and
// updated_at at once; the previous file is a version in «История», readable through the item,
// counted in the quota and deleted with the item.
func TestDiskSaveVersion(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	dir := e.folder(e.alice, "", "HR")
	doc := e.upload(e.alice, dir.GetId(), "График отпусков 2026.xlsx", 100)
	id := uuid.MustParse(doc.GetId())
	first := uuid.MustParse(doc.GetFile().GetId())
	usedBefore := e.usage().GetUsedBytes()

	store := func(body string) sqlc.File {
		f, err := e.fs.StoreSystemFile(ctx, e.ws, e.bob, doc.GetName(), "application/octet-stream", bytes.NewReader([]byte(body)), int64(len(body)))
		if err != nil {
			t.Fatal(err)
		}
		return f
	}
	e.ev.take()
	v2 := store("version two")
	it, changed, err := e.svc.SaveVersion(ctx, id, first, e.bob, v2)
	if err != nil || !changed || it.ID != id || it.Name != doc.GetName() || it.ParentID == nil || it.ParentID.String() != dir.GetId() || *it.FileID != v2.ID {
		t.Fatalf("save: %+v %v %v", it, changed, err)
	}
	var got v1.DiskItemResponse
	e.must(200, e.alice, "GET", item(doc.GetId()), nil, &got)
	if got.GetItem().GetFile().GetSha256() != v2.Sha256 || got.GetItem().GetFile().GetSize() != uint64(v2.Size) || //nolint:gosec // test sizes
		!got.GetItem().GetUpdatedAt().AsTime().After(doc.GetUpdatedAt().AsTime().Add(-1)) || got.GetItem().GetId() != doc.GetId() {
		t.Fatalf("GET after save: %v", got.GetItem())
	}
	evs := e.ev.take()
	if len(evs) != 1 || evs[0].GetDiskItemUpsert().GetItem().GetId() != doc.GetId() {
		t.Fatalf("events %v", evs)
	}
	// «История»: an edit entry with both files.
	var hist v1.DiskActivityPage
	e.must(200, e.alice, "GET", item(doc.GetId())+"/activity", nil, &hist)
	if len(hist.GetActivities()) == 0 || hist.GetActivities()[0].GetKind() != v1.DiskActivityKind_DISK_ACTIVITY_KIND_EDIT || hist.GetActivities()[0].GetActorId() != e.bob.String() ||
		hist.GetActivities()[0].GetBefore().AsMap()["file_id"] != first.String() || hist.GetActivities()[0].GetAfter().AsMap()["sha256"] != v2.Sha256 {
		t.Fatalf("history %v", hist.GetActivities())
	}
	// The previous version is read through the item.
	e.must(200, e.bob, "GET", "/api/files/"+first.String(), nil, nil)
	e.must(404, e.outsider, "GET", "/api/files/"+first.String(), nil, nil)
	if u, want := e.usage().GetUsedBytes(), usedBefore+uint64(v2.Size); u != want { //nolint:gosec // test sizes
		t.Fatalf("quota %d, want %d", u, want)
	}
	if n, _ := e.d.Q.ListOrphanFiles(ctx, e.svc.Now().Add(48*3600e9)); containsFile(n, first) {
		t.Fatal("a version is an orphan")
	}

	// A save on a stale file is refused; nothing changes.
	v3 := store("version three")
	if _, _, err := e.svc.SaveVersion(ctx, id, first, e.bob, v3); !errors.Is(err, ErrStale) {
		t.Fatalf("stale: %v", err)
	}
	// The same bytes: no version.
	same := store("version two")
	if _, changed, err := e.svc.SaveVersion(ctx, id, v2.ID, e.bob, same); err != nil || changed {
		t.Fatalf("same sha: %v %v", changed, err)
	}
	if _, _, err := e.svc.SaveVersion(ctx, uuid.New(), v2.ID, e.bob, v3); !errors.Is(err, ErrNotFile) {
		t.Fatalf("gone item: %v", err)
	}
	// Refused and unchanged saves leave their files to the caller (office.DiskStore deletes them).
	for _, f := range []sqlc.File{v3, same} {
		if err := e.fs.DeleteFile(ctx, f.ID); err != nil {
			t.Fatal(err)
		}
	}

	// Pruning keeps MaxVersions.
	cur := v2.ID
	for i := range MaxVersions + 2 {
		f := store("v" + string(rune('a'+i%26)) + uuid.NewString())
		if _, _, err := e.svc.SaveVersion(ctx, id, cur, e.alice, f); err != nil {
			t.Fatal(err)
		}
		cur = f.ID
	}
	var n int
	if err := e.d.Pool.QueryRow(ctx, `SELECT count(*) FROM disk_file_versions WHERE item_id = $1`, id).Scan(&n); err != nil || n != MaxVersions {
		t.Fatalf("versions %d %v", n, err)
	}
	if _, err := e.d.Q.GetFile(ctx, first); err == nil {
		t.Fatal("the oldest version must be pruned")
	}

	// Delete forever: blocked while somebody edits it, then everything goes with the quota.
	e.svc.Editing = fakeEditors{id: {e.bob}}
	e.must(200, e.alice, "POST", item(doc.GetId())+"/trash", nil, nil)
	if w := e.call(e.alice, "DELETE", item(doc.GetId()), nil, nil); w.Code != 409 {
		t.Fatalf("delete while editing: %d", w.Code)
	}
	var listed v1.ListDiskItemsResponse
	e.must(200, e.alice, "GET", "/api/workspaces/"+e.ws.String()+"/disk/items?trashed=1", nil, &listed)
	e.svc.Editing = nil
	e.must(204, e.alice, "DELETE", item(doc.GetId()), nil, nil)
	if err := e.d.Pool.QueryRow(ctx, `SELECT count(*) FROM disk_file_versions WHERE item_id = $1`, id).Scan(&n); err != nil || n != 0 {
		t.Fatalf("versions left %d", n)
	}
	if u := e.usage().GetUsedBytes(); u != usedBefore-uint64(doc.GetFile().GetSize()) {
		t.Fatalf("quota after delete %d, want %d", u, usedBefore-uint64(doc.GetFile().GetSize()))
	}
}

func containsFile(fs []sqlc.File, id uuid.UUID) bool {
	for _, f := range fs {
		if f.ID == id {
			return true
		}
	}
	return false
}

// editor_ids in listings, GET and events.
func TestDiskEditorIDs(t *testing.T) {
	e := newEnv(t)
	doc := e.upload(e.alice, "", "a.xlsx", 10)
	id := uuid.MustParse(doc.GetId())
	e.svc.Editing = fakeEditors{id: {e.bob}}
	var out v1.ListDiskItemsResponse
	e.must(200, e.alice, "GET", "/api/workspaces/"+e.ws.String()+"/disk/items", nil, &out)
	if len(out.GetItems()) != 1 || len(out.GetItems()[0].GetEditorIds()) != 1 || out.GetItems()[0].GetEditorIds()[0] != e.bob.String() {
		t.Fatalf("list %v", out.GetItems())
	}
	e.ev.take()
	if err := e.svc.Announce(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	evs := e.ev.take()
	if len(evs) != 1 || len(evs[0].GetDiskItemUpsert().GetItem().GetEditorIds()) != 1 {
		t.Fatalf("announce %v", evs)
	}
}

// «Сохранить в Диск»: a copy of a readable file as a new item; the source stays.
func TestDiskImport(t *testing.T) {
	e := newEnv(t)
	src := e.upload(e.alice, "", "Отчёт.docx", 50)
	dst := e.folder(e.bob, "", "Мои")
	path := "/api/workspaces/" + e.ws.String() + "/disk/import"
	var out v1.DiskItemResponse
	e.must(201, e.bob, "POST", path, &v1.ImportDiskFileRequest{FileId: src.GetFile().GetId(), ParentId: dst.GetId()}, &out)
	if out.GetItem().GetId() == src.GetId() || out.GetItem().GetFile().GetId() == src.GetFile().GetId() ||
		out.GetItem().GetFile().GetSha256() != src.GetFile().GetSha256() || out.GetItem().GetName() != "Отчёт.docx" || out.GetItem().GetParentId() != dst.GetId() {
		t.Fatalf("import %v", out.GetItem())
	}
	e.must(201, e.bob, "POST", path, &v1.ImportDiskFileRequest{FileId: src.GetFile().GetId(), ParentId: dst.GetId()}, &out)
	if out.GetItem().GetName() != "Отчёт (2).docx" {
		t.Fatalf("a taken name: %q", out.GetItem().GetName())
	}
	e.must(404, e.outsider, "POST", path, &v1.ImportDiskFileRequest{FileId: src.GetFile().GetId()}, nil)
	e.must(404, e.bob, "POST", path, &v1.ImportDiskFileRequest{FileId: uuid.NewString()}, nil)
	// A guest without DISK_WRITE on the root cannot file it.
	if w := e.call(e.guest, "POST", path, &v1.ImportDiskFileRequest{FileId: src.GetFile().GetId()}, nil); w.Code != 403 && w.Code != 404 {
		t.Fatalf("guest import: %d", w.Code)
	}
}

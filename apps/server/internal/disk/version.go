package disk

import (
	"context"
	"errors"
	"net/http"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/diskacl"
	"github.com/calaba/calaba/server/internal/files"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/perm"
)

// Versions of Disk files (ADR-0143). A save from the office editor replaces an item's current
// file: the item keeps its id, parent and name, its file_id and updated_at move, and the previous
// files row stays in disk_file_versions (read through the item, counted in the quota, deleted with
// the item). The journal («История») gets an "edit" entry with both files. There is no other
// way to change an item's file: an upload never overwrites (a taken name gets «(2)»), so a bot or
// an API client cannot write over a file somebody is editing.

// MaxVersions bounds the previous versions kept per file item; older ones are deleted with their
// quota when a new one is saved.
const MaxVersions = 50

// Editors tells who has a file item open for editing in the office editor right now (ADR-0143):
// the item's editor_ids and the guard of a delete forever. nil = office editing is off.
type Editors interface {
	EditorsOf(ctx context.Context, items []uuid.UUID) (map[uuid.UUID][]uuid.UUID, error)
}

var (
	// ErrStale means the item's current file is no longer the one the save stands on.
	ErrStale = errors.New("disk: the item has a newer file")
	// ErrNotFile means no such file item (deleted forever, or a folder).
	ErrNotFile = errors.New("disk: no such file item")
)

// SaveVersion makes f (stored by files.StoreSystemFile, counted in the quota, not attached) the
// current file of item itemID if that is still expect (ErrStale otherwise; ErrNotFile when the
// item is gone). The previous file becomes a version; actor is who saved. changed is false when
// f has the current file's sha256: nothing is stored then and the caller deletes f. A trashed
// item takes the save (it is the same item; restoring it brings the edits back). After the
// commit: DISK_ITEM_UPSERT and the blobs of pruned versions are deleted.
func (s *Service) SaveVersion(ctx context.Context, itemID, expect, actor uuid.UUID, f sqlc.File) (it sqlc.DiskItem, changed bool, err error) {
	pre, err := s.db.Q.GetDiskItem(ctx, itemID)
	if db.IsNotFound(err) {
		return it, false, ErrNotFile
	}
	if err != nil {
		return it, false, err
	}
	var chain []perm.DiskNode
	var pruned []sqlc.File
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if err := writable(ctx, q, pre.WorkspaceID); err != nil {
			return err
		}
		// The workspaces row first (the order of an upload and of a delete forever), then the item.
		if err := q.LockDiskQuota(ctx, pre.WorkspaceID); err != nil {
			return err
		}
		cur, err := q.GetDiskItemForUpdate(ctx, itemID)
		if db.IsNotFound(err) {
			return ErrNotFile
		}
		if err != nil {
			return err
		}
		if cur.Kind != "file" || cur.FileID == nil {
			return ErrNotFile
		}
		if *cur.FileID != expect {
			return ErrStale
		}
		old, err := q.GetFile(ctx, expect)
		if err != nil {
			return err
		}
		if old.Sha256 == f.Sha256 {
			it = cur
			return nil
		}
		if it, err = q.ReplaceDiskItemFile(ctx, sqlc.ReplaceDiskItemFileParams{ID: itemID, FileID: f.ID, Expect: expect}); err != nil {
			if db.IsNotFound(err) {
				return ErrStale
			}
			return err
		}
		if err := q.InsertDiskFileVersion(ctx, sqlc.InsertDiskFileVersionParams{ItemID: itemID, FileID: old.ID, ActorID: &actor}); err != nil {
			return err
		}
		if pruned, err = q.PruneDiskFileVersions(ctx, sqlc.PruneDiskFileVersionsParams{ItemID: itemID, Keep: MaxVersions}); err != nil {
			return err
		}
		var freed int64
		for _, p := range pruned {
			freed += p.Size
		}
		if freed > 0 {
			if err := q.ReleaseQuota(ctx, sqlc.ReleaseQuotaParams{ID: it.WorkspaceID, Size: freed}); err != nil {
				return err
			}
		}
		before := snap{"file_id": old.ID.String(), "size": float64(old.Size), "sha256": old.Sha256}
		after := snap{"file_id": f.ID.String(), "size": float64(f.Size), "sha256": f.Sha256}
		if err := s.journal(ctx, q, it, &actor, "edit", before, after); err != nil {
			return err
		}
		ch, err := diskacl.Load(ctx, q, []uuid.UUID{itemID})
		if err != nil {
			return err
		}
		chain, changed = ch.Nodes(itemID), true
		return nil
	})
	if err != nil || !changed {
		return it, false, err
	}
	if len(pruned) > 0 && s.files != nil {
		keys := make([]sqlc.ListWorkspaceFileKeysRow, len(pruned))
		for i, p := range pruned {
			keys[i] = sqlc.ListWorkspaceFileKeysRow{Key: p.Key, ThumbnailKey: p.ThumbnailKey}
		}
		files.DeleteBlobs(context.WithoutCancel(ctx), s.files.Store(), keys)
	}
	s.publish(ctx, it.WorkspaceID, []*v1.DispatchEvent{upsertEvent(it, chain, nil)})
	return it, true, nil
}

// Announce sends DISK_ITEM_UPSERT of item id as it is now (who edits it changed: the event
// carries editor_ids). A gone item is no error.
func (s *Service) Announce(ctx context.Context, id uuid.UUID) error {
	ch, err := diskacl.Load(ctx, s.db.Q, []uuid.UUID{id})
	if err != nil || !ch.Has(id) {
		return err
	}
	it := ch.Item(id)
	s.publish(ctx, it.WorkspaceID, []*v1.DispatchEvent{upsertEvent(it, ch.Nodes(id), nil)})
	return nil
}

// editorsOf fills editor_ids of the file items of out (nil Editing: none). A failure of the
// session store leaves them empty: the listing never fails over a label.
func (s *Service) editorsOf(ctx context.Context, out []*v1.DiskItem) {
	if s.Editing == nil {
		return
	}
	var ids []uuid.UUID
	for _, it := range out {
		if it.GetKind() == v1.DiskItemKind_DISK_ITEM_KIND_FILE {
			if id, err := uuid.Parse(it.GetId()); err == nil {
				ids = append(ids, id)
			}
		}
	}
	if len(ids) == 0 {
		return
	}
	eds, err := s.Editing.EditorsOf(ctx, ids)
	if err != nil {
		return
	}
	for _, it := range out {
		if id, err := uuid.Parse(it.GetId()); err == nil {
			for _, u := range eds[id] {
				it.EditorIds = append(it.EditorIds, u.String())
			}
		}
	}
}

// editing refuses a change that would lose what somebody is editing now (delete forever).
func (s *Service) editing(ctx context.Context, it sqlc.DiskItem) error {
	if s.Editing == nil || it.Kind != "file" {
		return nil
	}
	eds, err := s.Editing.EditorsOf(ctx, []uuid.UUID{it.ID})
	if err != nil {
		return err
	}
	if len(eds[it.ID]) > 0 {
		return httpx.Conflict("the file is being edited").WithDetails("DISK_FILE_EDITING", 0, 0)
	}
	return nil
}

// AddFile files f (stored and counted, not attached: files.CopyInto / StoreSystemFile) as a new
// item of folder parent (nil = the root) of workspace ws for the caller of r, who needs DISK_WRITE
// there; a taken name gets «(2)». The office editor's «Сохранить как» and «Сохранить в Диск»
// (ADR-0143). The caller deletes f on an error.
func (s *Service) AddFile(r *http.Request, ws uuid.UUID, parent *uuid.UUID, f sqlc.File) (sqlc.DiskItem, perm.Bits, error) {
	c, err := member(r, ws)
	if err != nil {
		return sqlc.DiskItem{}, 0, err
	}
	ctx := r.Context()
	var it sqlc.DiskItem
	var chain []perm.DiskNode
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		var err error
		it, chain, err = s.attachFile(r, q, ws, c, parent, f)
		return err
	})
	if err != nil {
		return it, 0, err
	}
	s.publish(ctx, ws, []*v1.DispatchEvent{upsertEvent(it, chain, nil)})
	return it, perm.ComputeDiskItemIn(c.m, chain), nil
}

// attachFile creates the item of file f in folder parent in q's transaction, after the quota:
// writable, the tree lock, DISK_WRITE on the folder, a free name, the journal's "upload".
func (s *Service) attachFile(r *http.Request, q *sqlc.Queries, ws uuid.UUID, c caller, parent *uuid.UUID, f sqlc.File) (sqlc.DiskItem, []perm.DiskNode, error) {
	ctx := r.Context()
	if err := writable(ctx, q, ws); err != nil {
		return sqlc.DiskItem{}, nil, err
	}
	if err := q.LockDiskTree(ctx, ws); err != nil { // after the quota's workspaces row lock
		return sqlc.DiskItem{}, nil, err
	}
	ch, err := addable(r, q, ws, c, parent)
	if err != nil {
		return sqlc.DiskItem{}, nil, err
	}
	name, err := cleanName(f.Name)
	if err != nil {
		name = "file"
	}
	if name, err = freeName(ctx, q, ws, parent, name, "file", nil); err != nil {
		return sqlc.DiskItem{}, nil, err
	}
	it, err := q.CreateDiskItem(ctx, sqlc.CreateDiskItemParams{WorkspaceID: ws, ParentID: parent, Kind: "file", Name: name, FileID: &f.ID, OwnerID: &c.uid})
	if err != nil {
		return it, nil, err
	}
	if err := ch.AddChildren(ctx, q, parent, []sqlc.DiskItem{it}); err != nil {
		return it, nil, err
	}
	pl, err := place(ctx, q, parent)
	if err != nil {
		return it, nil, err
	}
	pl["name"], pl["size"], pl["mime"] = it.Name, float64(f.Size), f.Mime
	return it, ch.Nodes(it.ID), s.journal(ctx, q, it, &c.uid, "upload", nil, pl)
}

// importFile: POST /api/workspaces/{id}/disk/import — «Сохранить в Диск» (ADR-0143): a copy of a
// file the caller may read (a chat or task attachment, another Disk file) as a new item of a
// folder they may write to. The source stays as it is.
func (s *Service) importFile(w http.ResponseWriter, r *http.Request) error {
	ws, c, err := pathWorkspace(r)
	if err != nil {
		return err
	}
	var req v1.ImportDiskFileRequest
	if err := httpx.DecodeStrict(w, r, &req); err != nil {
		return err
	}
	src, err := uuid.Parse(req.GetFileId())
	if err != nil {
		return httpx.Validation("file_id", "must be an id")
	}
	parent, err := optUUID(req.GetParentId(), "parent_id")
	if err != nil {
		return err
	}
	ctx := r.Context()
	if err := writable(ctx, s.db.Q, ws); err != nil {
		return err
	}
	if _, err := addable(r, s.db.Q, ws, c, parent); err != nil { // early, before copying bytes
		return err
	}
	f, err := s.db.Q.GetFile(ctx, src)
	if db.IsNotFound(err) {
		return httpx.NotFound("file")
	}
	if err != nil {
		return err
	}
	if ok, err := s.files.CanRead(r, f); err != nil {
		return err
	} else if !ok {
		return httpx.NotFound("file")
	}
	name := f.Name
	if req.GetName() != "" {
		if name, err = cleanName(req.GetName()); err != nil {
			return err
		}
	}
	cp, err := s.files.CopyInto(ctx, ws, c.uid, f, name)
	if err != nil {
		return err
	}
	it, bits, err := s.AddFile(r, ws, parent, cp)
	if err != nil {
		_ = s.files.DeleteFile(context.WithoutCancel(ctx), cp.ID)
		return err
	}
	httpx.Write(w, http.StatusCreated, &v1.DiskItemResponse{Item: itemProto(it, &cp, false, nil, bits)})
	return nil
}

// ItemProto converts a new file item for its creator (no link, not shared yet).
func ItemProto(it sqlc.DiskItem, f sqlc.File, bits perm.Bits) *v1.DiskItem {
	return itemProto(it, &f, false, nil, bits)
}

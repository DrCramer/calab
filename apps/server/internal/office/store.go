package office

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/disk"
	"github.com/calaba/calaba/server/internal/diskacl"
	"github.com/calaba/calaba/server/internal/files"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/plans"
)

// DiskStore is the Store over the Disk (internal/disk, diskacl) and the files (internal/files):
// the access is the item's real one (perm.ComputeDiskItem over its chain) and an attachment's is
// files.CanRead (room membership, board access, the Disk, …) — the editor never reads what the
// caller could not download.
type DiskStore struct {
	DB    *db.DB
	Files *files.Service
	Disk  *disk.Service
	// PlanActive is plans.Service.CheckActive (nil: none): a workspace in the restricted mode
	// takes no saves (as uploads).
	PlanActive func(ctx context.Context, ws uuid.UUID, action string) error
}

var _ Store = (*DiskStore)(nil)

// ItemFor implements Store. The resolver checks the request's identity policy when ctx has one
// (perm.CheckAccess); requests of the Document Server have none and see plain membership.
func (d *DiskStore) ItemFor(ctx context.Context, uid, itemID uuid.UUID) (Item, error) {
	q := d.DB.Q
	ch, err := diskacl.Load(ctx, q, []uuid.UUID{itemID})
	if err != nil {
		return Item{}, err
	}
	if !ch.Has(itemID) {
		return Item{}, ErrNotFound
	}
	di := ch.Item(itemID)
	m, err := perm.NewResolver(q).Member(ctx, di.WorkspaceID, uid)
	if errors.Is(err, perm.ErrNotMember) {
		return Item{}, ErrNotFound
	}
	if err != nil {
		return Item{}, err
	}
	bits := ch.Bits(m, &itemID)
	if !bits.Has(perm.DiskView) {
		return Item{}, ErrNotFound
	}
	it, err := d.item(ctx, di)
	it.Bits = bits
	return it, err
}

// Item implements Store.
func (d *DiskStore) Item(ctx context.Context, itemID uuid.UUID) (Item, error) {
	di, err := d.DB.Q.GetDiskItem(ctx, itemID)
	if db.IsNotFound(err) {
		return Item{}, ErrNotFound
	}
	if err != nil {
		return Item{}, err
	}
	return d.item(ctx, di)
}

func (d *DiskStore) item(ctx context.Context, di sqlc.DiskItem) (Item, error) {
	if di.Kind != "file" || di.FileID == nil {
		return Item{}, ErrNotFound
	}
	f, err := d.DB.Q.GetFile(ctx, *di.FileID)
	if err != nil {
		return Item{}, err
	}
	it := Item{ID: di.ID, WorkspaceID: di.WorkspaceID, FileID: f.ID, ParentID: di.ParentID, Name: di.Name, Size: f.Size,
		Sha256: f.Sha256, Trashed: di.TrashedAt != nil}
	ws, err := d.DB.Q.GetWorkspace(ctx, di.WorkspaceID)
	if err != nil {
		return it, err
	}
	it.ReadOnly = ws.SuspendedAt != nil
	if !it.ReadOnly && d.PlanActive != nil && d.PlanActive(ctx, di.WorkspaceID, plans.RestrictedUpload) != nil {
		it.ReadOnly = true
	}
	return it, nil
}

// FileFor implements Store.
func (d *DiskStore) FileFor(r *http.Request, fileID uuid.UUID) (File, error) {
	f, err := d.DB.Q.GetFile(r.Context(), fileID)
	if db.IsNotFound(err) {
		return File{}, ErrNotFound
	}
	if err != nil {
		return File{}, err
	}
	ok, err := d.Files.CanRead(r, f)
	if err != nil {
		return File{}, err
	}
	if !ok {
		return File{}, ErrNotFound
	}
	return File{ID: f.ID, WorkspaceID: f.WorkspaceID, Name: f.Name, Size: f.Size, Sha256: f.Sha256}, nil
}

// OpenFile implements Store.
func (d *DiskStore) OpenFile(ctx context.Context, fileID uuid.UUID) (io.ReadCloser, int64, error) {
	f, err := d.DB.Q.GetFile(ctx, fileID)
	if db.IsNotFound(err) {
		return nil, 0, ErrNotFound
	}
	if err != nil {
		return nil, 0, err
	}
	return d.Files.Open(ctx, f)
}

// SaveVersion implements Store: the bytes become a files row (quota, sha256) uploaded by the
// actor, then the item's current file (disk.SaveVersion, compare and swap on expect).
func (d *DiskStore) SaveVersion(ctx context.Context, itemID, expect, actor uuid.UUID, f Format, body []byte) (Item, error) {
	cur, err := d.Item(ctx, itemID)
	if err != nil {
		return Item{}, err
	}
	if cur.FileID != expect {
		return Item{}, ErrConflict
	}
	if cur.ReadOnly {
		return Item{}, errors.New("office: the workspace takes no writes")
	}
	nf, err := d.Files.StoreSystemFile(ctx, cur.WorkspaceID, actor, cur.Name, f.Mime, bytes.NewReader(body), int64(len(body)))
	if err != nil {
		return Item{}, err
	}
	_, changed, err := d.Disk.SaveVersion(ctx, itemID, expect, actor, nf)
	if err != nil || !changed {
		_ = d.Files.DeleteFile(context.WithoutCancel(ctx), nf.ID)
	}
	switch {
	case errors.Is(err, disk.ErrStale):
		return Item{}, ErrConflict
	case errors.Is(err, disk.ErrNotFile):
		return Item{}, ErrNotFound
	case err != nil:
		return Item{}, err
	}
	return d.Item(ctx, itemID)
}

// AddFile implements Store.
func (d *DiskStore) AddFile(r *http.Request, ws uuid.UUID, parent *uuid.UUID, name string, f Format, body []byte) (*v1.DiskItem, error) {
	uid := mustUser(r)
	nf, err := d.Files.StoreSystemFile(r.Context(), ws, uid, name, f.Mime, bytes.NewReader(body), int64(len(body)))
	if errors.Is(err, files.ErrNoRoom) {
		return nil, files.QuotaExceeded()
	}
	if err != nil {
		return nil, err
	}
	it, bits, err := d.Disk.AddFile(r, ws, parent, nf)
	if err != nil {
		_ = d.Files.DeleteFile(context.WithoutCancel(r.Context()), nf.ID)
		return nil, err
	}
	return disk.ItemProto(it, nf, bits), nil
}

// LastVersion implements Store.
func (d *DiskStore) LastVersion(ctx context.Context, itemID uuid.UUID) (uuid.UUID, error) {
	id, err := d.DB.Q.LastDiskFileVersion(ctx, itemID)
	if db.IsNotFound(err) {
		return uuid.Nil, nil
	}
	return id, err
}

// DisplayName implements Store.
func (d *DiskStore) DisplayName(ctx context.Context, uid uuid.UUID) (string, error) {
	u, err := d.DB.Q.GetUser(ctx, uid)
	if err != nil {
		return "", err
	}
	return u.DisplayName, nil
}

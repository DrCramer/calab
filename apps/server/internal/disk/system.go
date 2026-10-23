package disk

import (
	"context"
	"errors"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/diskacl"
)

// Files the server itself puts on the Disk (phone call recordings, ADR-0131): no caller, no
// DISK_WRITE check — the feature that files them is the admin's switch. The file row is stored
// and counted in the quota before (files.StoreSystemFile); here it becomes an item.

// Folder is one level of the path a server file goes into, from the root.
type Folder struct {
	Name string
	// Restricted: a folder created now gets «Только выбранные» — its owner alone sees it until
	// they share it. An existing folder is used as it is (its access is the owner's business)
	// only when the owner owns it: a folder of that name somebody else made beforehand would
	// hand them (its owner sees all below it) what is filed there — the path is blocked then.
	Restricted bool
}

// ErrPathBlocked means a file (not a folder) holds the name of a folder of the path, or a
// folder of the path at a Restricted level belongs to somebody other than the owner.
var ErrPathBlocked = errors.New("disk: a file or another member's folder holds the name of a folder on the path")

// PlaceFile files f as name into path, creating the missing folders; new folders and the file are
// owned by owner (the workspace owner). A taken file name gets «(2)» before the extension. The
// journal entries have no actor (the server). DISK_ITEM_UPSERT goes out for every new item.
func (s *Service) PlaceFile(ctx context.Context, ws, owner uuid.UUID, path []Folder, f sqlc.File, name string) (sqlc.DiskItem, error) {
	var file sqlc.DiskItem
	var evs []*v1.DispatchEvent
	err := s.db.Tx(ctx, func(q *sqlc.Queries) error {
		evs = evs[:0]
		if err := writable(ctx, q, ws); err != nil {
			return err
		}
		if err := q.LockDiskTree(ctx, ws); err != nil {
			return err
		}
		ch, err := diskacl.Load(ctx, q, nil)
		if err != nil {
			return err
		}
		var parent *uuid.UUID
		for _, lvl := range path {
			dir, created, err := s.folder(ctx, q, ws, owner, parent, lvl)
			if err != nil {
				return err
			}
			if err := ch.AddChildren(ctx, q, parent, []sqlc.DiskItem{dir}); err != nil {
				return err
			}
			if created {
				evs = append(evs, upsertEvent(dir, ch.Nodes(dir.ID), nil))
			}
			id := dir.ID
			parent = &id
		}
		clean, err := cleanName(name)
		if err != nil {
			clean = "file"
		}
		if clean, err = freeName(ctx, q, ws, parent, clean, "file", nil); err != nil {
			return err
		}
		if file, err = q.CreateDiskItem(ctx, sqlc.CreateDiskItemParams{WorkspaceID: ws, ParentID: parent, Kind: "file", Name: clean, FileID: &f.ID, OwnerID: &owner}); err != nil {
			return err
		}
		if err := ch.AddChildren(ctx, q, parent, []sqlc.DiskItem{file}); err != nil {
			return err
		}
		evs = append(evs, upsertEvent(file, ch.Nodes(file.ID), nil))
		pl, err := place(ctx, q, parent)
		if err != nil {
			return err
		}
		pl["name"], pl["size"], pl["mime"] = file.Name, float64(f.Size), f.Mime
		return s.journal(ctx, q, file, nil, "upload", nil, pl)
	})
	if err != nil {
		return sqlc.DiskItem{}, err
	}
	s.publish(ctx, ws, evs)
	return file, nil
}

// folder finds the live folder lvl.Name of parent or creates it (owned by owner, restricted as
// lvl says), under LockDiskTree.
func (s *Service) folder(ctx context.Context, q *sqlc.Queries, ws, owner uuid.UUID, parent *uuid.UUID, lvl Folder) (sqlc.DiskItem, bool, error) {
	name, err := cleanName(lvl.Name)
	if err != nil {
		return sqlc.DiskItem{}, false, err
	}
	dir, err := q.GetDiskFolderByName(ctx, sqlc.GetDiskFolderByNameParams{WorkspaceID: ws, ParentID: parent, Name: name})
	if err == nil {
		if lvl.Restricted && (dir.OwnerID == nil || *dir.OwnerID != owner) {
			return dir, false, ErrPathBlocked // a member's own folder: they would see the files
		}
		return dir, false, nil
	}
	if !db.IsNotFound(err) {
		return dir, false, err
	}
	if taken, err := q.DiskNameTaken(ctx, sqlc.DiskNameTakenParams{WorkspaceID: ws, ParentID: parent, Name: name}); err != nil {
		return dir, false, err
	} else if taken {
		return dir, false, ErrPathBlocked
	}
	if dir, err = q.CreateDiskItem(ctx, sqlc.CreateDiskItemParams{WorkspaceID: ws, ParentID: parent, Kind: "folder", Name: name, OwnerID: &owner}); err != nil {
		return dir, false, err
	}
	if lvl.Restricted {
		yes := true
		if dir, err = q.UpdateDiskItem(ctx, sqlc.UpdateDiskItemParams{ID: dir.ID, Restricted: &yes}); err != nil {
			return dir, false, err
		}
	}
	pl, err := place(ctx, q, parent)
	if err != nil {
		return dir, false, err
	}
	pl["name"] = dir.Name
	return dir, true, s.journal(ctx, q, dir, nil, "create", nil, pl)
}

-- Versions of Disk files (ADR-0143): a save from the office editor (ONLYOFFICE) stores a new files
-- row as the item's current file (same item id, parent and name); the previous file stays here.
--
-- disk_file_versions  one row per previous file of an item, the newest by id. The files row is
--                     a reference like disk_items.file_id: ListOrphanFiles and
--                     UnattachedBytesByUploader skip it, DeleteDiskSubtreeFiles deletes it with
--                     the item (its quota released in the same transaction), files.CanRead reads
--                     it through its item (DISK_VIEW). Deleting the files row (pruning) deletes
--                     the version row (CASCADE). At most disk.MaxVersions per item.
-- disk_activity.kind  + 'edit': a saved version (before / after: file_id, size, sha256).
--
-- Safe on a populated database: a new empty table; the CHECK swap is NOT VALID first and then
-- validated (a scan without a write lock).

-- +goose Up
SET LOCAL lock_timeout = '10s';

CREATE TABLE disk_file_versions (
    id         uuid PRIMARY KEY DEFAULT uuidv7(),
    item_id    uuid NOT NULL REFERENCES disk_items (id) ON DELETE CASCADE,
    file_id    uuid NOT NULL UNIQUE REFERENCES files (id) ON DELETE CASCADE,
    -- Who saved the version that replaced this file (the editor of the next one).
    actor_id   uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX disk_file_versions_item_idx ON disk_file_versions (item_id, id);
CREATE INDEX disk_file_versions_actor_idx ON disk_file_versions (actor_id) WHERE actor_id IS NOT NULL;

ALTER TABLE disk_activity DROP CONSTRAINT disk_activity_kind_check;
ALTER TABLE disk_activity ADD CONSTRAINT disk_activity_kind_check
    CHECK (kind IN ('create', 'upload', 'rename', 'move', 'share', 'link_on', 'link_off', 'trash', 'restore',
                    'delete', 'edit')) NOT VALID;
ALTER TABLE disk_activity VALIDATE CONSTRAINT disk_activity_kind_check;

-- +goose Down
SET LOCAL lock_timeout = '10s';
DELETE FROM disk_activity WHERE kind = 'edit';
ALTER TABLE disk_activity DROP CONSTRAINT disk_activity_kind_check;
ALTER TABLE disk_activity ADD CONSTRAINT disk_activity_kind_check
    CHECK (kind IN ('create', 'upload', 'rename', 'move', 'share', 'link_on', 'link_off', 'trash', 'restore', 'delete'));
-- The version files become orphans; the orphan cleanup removes them and releases their quota.
DROP TABLE disk_file_versions;

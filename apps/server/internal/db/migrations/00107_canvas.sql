-- Canvas (ADR-0114): a tree of folders and canvases of a workspace with Yjs content, per-item
-- access, trash, version history and a journal. The server stores and relays the Yjs bytes, it
-- never parses them. The tables follow the Wiki's (00090) with the differences of the ADR: no
-- icon / cover / files / public links in v1, folders next to documents (kind), snapshots up to
-- 4 MiB, ≤ 50 versions per canvas.
--
-- canvas_items         one tree per workspace (parent_id NULL = top level), siblings ordered by
--                      (position, id) with gaps (a move takes a free position between its
--                      neighbours and writes one row; canvas/positions.go). kind 'folder' holds items,
--                      'canvas' holds a document; a canvas has no children and a folder no
--                      content (the API keeps the parent a folder, depth ≤ 32). plain_text /
--                      preview / doc_size come from the last snapshot the client posted;
--                      plain_text is what search indexes, capped at 256 KiB. next_seq is the
--                      canvas's update counter: an append takes it and bumps it in one statement
--                      (row lock per canvas, no global sequence; the ADR's «bigserial» is the
--                      same per-canvas order without a hot sequence). Trash: trashed_at on the
--                      whole subtree (one timestamp), trashed_root on the item the deletion
--                      started at. Deleting an item deletes its subtree (CASCADE).
-- canvas_updates       Yjs updates after the snapshot, (canvas_id, seq) with seq from next_seq;
--                      ≤ 64 KiB each (one sync frame).
-- canvas_snapshots     the current snapshot (Y.encodeStateAsUpdate) through through_seq; ≤ 4 MiB.
-- canvas_versions      history: state + the authors since the previous version; ≤ 50 per canvas
--                      (PruneCanvasVersions), one per 10 minutes and only when the state changed.
-- canvas_permissions   role / user overrides of CANVAS_VIEW | CANVAS_WRITE (1 << 41 | 1 << 42),
--                      like wiki_permissions; a deleted role / a leaving member drops theirs
--                      (queries/roles.sql, workspaces.sql).
-- canvas_activity      the journal, like wiki_activity (private: entries of a restricted subtree
--                      deleted forever stay out of the workspace journal); item_id SET NULL on
--                      delete forever.
-- canvas_item_heads    canvas_items without plain_text (a view): what listings, paths and access
--                      checks read.
-- workspaces.canvas_trash_days the trash retention in days; NULL = never (default).
-- workspace_audit.subject_type admits 'canvas_item' («Сделать меня владельцем» of a private canvas
-- or folder, like the Disk and the Wiki).
-- Built-in member role: + CANVAS_VIEW | CANVAS_WRITE (6597069766656), existing roles and new
-- workspaces (workspace_builtin_roles). CANVAS_MANAGE (1 << 43) is in ADMINISTRATOR.
--
-- Safe on a populated database: new tables, a nullable column without a default (metadata
-- only), one UPDATE of the member roles (one row per workspace). The search index over
-- plain_text comes with the search section (a separate CONCURRENTLY migration).

-- +goose Up
SET LOCAL lock_timeout = '10s';

CREATE TABLE canvas_items (
    id           uuid PRIMARY KEY DEFAULT uuidv7(),
    workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    parent_id    uuid REFERENCES canvas_items (id) ON DELETE CASCADE,
    kind         text NOT NULL CHECK (kind IN ('folder', 'canvas')),
    name         text NOT NULL DEFAULT '' CHECK (char_length(name) <= 200),
    position     integer NOT NULL DEFAULT 0 CHECK (position >= 0),
    owner_id     uuid REFERENCES users (id) ON DELETE SET NULL,
    restricted   boolean NOT NULL DEFAULT false,
    plain_text   text NOT NULL DEFAULT '' CHECK (octet_length(plain_text) <= 262144),
    preview      text NOT NULL DEFAULT '' CHECK (char_length(preview) <= 200),
    doc_size     integer NOT NULL DEFAULT 0 CHECK (doc_size BETWEEN 0 AND 4194304),
    next_seq     bigint NOT NULL DEFAULT 1 CHECK (next_seq >= 1),
    updated_by   uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    trashed_at   timestamptz,
    trashed_by   uuid REFERENCES users (id) ON DELETE SET NULL,
    trashed_root boolean NOT NULL DEFAULT false,
    CONSTRAINT canvas_items_trash_check CHECK (NOT trashed_root OR trashed_at IS NOT NULL),
    CONSTRAINT canvas_items_parent_check CHECK (parent_id IS DISTINCT FROM id),
    CONSTRAINT canvas_items_folder_check CHECK (kind = 'canvas' OR (plain_text = '' AND preview = '' AND doc_size = 0))
) WITH (fillfactor = 85); -- room on the page keeps the next_seq bump of every append a HOT update
-- The tree: live children of a folder (or of the top level) in order.
-- With id: the listing's keyset (position, id) without a sort.
CREATE INDEX canvas_items_tree_idx ON canvas_items (workspace_id, parent_id, position, id) WHERE trashed_at IS NULL;
-- Subtrees (trash / restore / path CTEs, including trashed items), has_children and the CASCADE.
CREATE INDEX canvas_items_parent_idx ON canvas_items (parent_id) WHERE parent_id IS NOT NULL;
-- The trash: its roots by deletion time; the sweeper's candidates per workspace.
CREATE INDEX canvas_items_trash_idx ON canvas_items (workspace_id, trashed_at) WHERE trashed_root;
CREATE INDEX canvas_items_owner_idx ON canvas_items (owner_id) WHERE owner_id IS NOT NULL;
CREATE INDEX canvas_items_updated_by_idx ON canvas_items (updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX canvas_items_trashed_by_idx ON canvas_items (trashed_by) WHERE trashed_by IS NOT NULL;

CREATE TABLE canvas_updates (
    canvas_id  uuid NOT NULL REFERENCES canvas_items (id) ON DELETE CASCADE,
    seq        bigint NOT NULL CHECK (seq >= 1),
    data       bytea NOT NULL CHECK (octet_length(data) BETWEEN 1 AND 65536), -- one Yjs update
    author_id  uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (canvas_id, seq)
);
CREATE INDEX canvas_updates_author_idx ON canvas_updates (author_id) WHERE author_id IS NOT NULL;

CREATE TABLE canvas_snapshots (
    canvas_id   uuid PRIMARY KEY REFERENCES canvas_items (id) ON DELETE CASCADE,
    state       bytea NOT NULL CHECK (octet_length(state) <= 4194304),
    through_seq bigint NOT NULL CHECK (through_seq >= 0),
    saved_by    uuid REFERENCES users (id) ON DELETE SET NULL,
    saved_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX canvas_snapshots_saved_by_idx ON canvas_snapshots (saved_by) WHERE saved_by IS NOT NULL;

CREATE TABLE canvas_versions (
    id         uuid PRIMARY KEY DEFAULT uuidv7(),
    canvas_id  uuid NOT NULL REFERENCES canvas_items (id) ON DELETE CASCADE,
    state      bytea NOT NULL CHECK (octet_length(state) <= 4194304),
    -- Who edited since the previous version (no FK: a gone account stays an id the client
    -- shows as «удалённый пользователь»).
    authors    uuid[] NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX canvas_versions_canvas_idx ON canvas_versions (canvas_id, created_at DESC);

CREATE TABLE canvas_permissions (
    canvas_id   uuid NOT NULL REFERENCES canvas_items (id) ON DELETE CASCADE,
    target_type text NOT NULL CHECK (target_type IN ('role', 'user')),
    target_id   text NOT NULL,
    allow       bigint NOT NULL DEFAULT 0,
    deny        bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (canvas_id, target_type, target_id),
    CONSTRAINT canvas_permissions_bits_check CHECK ((allow | deny) & ~6597069766656::bigint = 0 AND allow & deny = 0)
);
-- A role deleted / a member leaving drops their overrides.
CREATE INDEX canvas_permissions_target_idx ON canvas_permissions (target_type, target_id);

CREATE TABLE canvas_activity (
    id           uuid PRIMARY KEY DEFAULT uuidv7(),
    workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    item_id      uuid REFERENCES canvas_items (id) ON DELETE SET NULL,
    item_name    text NOT NULL DEFAULT '',
    actor_id     uuid REFERENCES users (id) ON DELETE SET NULL,
    kind         text NOT NULL CHECK (kind IN ('create', 'rename', 'move', 'share', 'trash', 'restore', 'delete', 'version')),
    before       jsonb,
    after        jsonb,
    private      boolean NOT NULL DEFAULT false,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX canvas_activity_item_idx ON canvas_activity (item_id, id) WHERE item_id IS NOT NULL;
CREATE INDEX canvas_activity_workspace_idx ON canvas_activity (workspace_id, id);
CREATE INDEX canvas_activity_actor_idx ON canvas_activity (workspace_id, actor_id, id) WHERE actor_id IS NOT NULL;

-- An item without its text: listings, paths and access checks never carry plain_text (≤ 256 KiB).
CREATE VIEW canvas_item_heads AS
    SELECT id, workspace_id, parent_id, kind, name, position, owner_id, restricted, preview, doc_size, next_seq,
           updated_by, created_at, updated_at, trashed_at, trashed_by, trashed_root
    FROM canvas_items;

-- The ALTERs of existing tables last: their ACCESS EXCLUSIVE locks are held to the commit.
ALTER TABLE workspace_audit DROP CONSTRAINT workspace_audit_subject_type_check;
ALTER TABLE workspace_audit ADD CONSTRAINT workspace_audit_subject_type_check
    CHECK (subject_type IN ('room', 'board', 'disk_item', 'wiki_page', 'canvas_item'));
ALTER TABLE workspaces ADD COLUMN canvas_trash_days integer
    CHECK (canvas_trash_days IS NULL OR canvas_trash_days BETWEEN 1 AND 3650);

UPDATE workspace_roles SET permissions = permissions | 6597069766656 WHERE builtin = 'member';

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION workspace_builtin_roles() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO workspace_roles (workspace_id, name, position, permissions, builtin) VALUES
        (NEW.id, 'owner', 1001, 1024, 'owner'),
        (NEW.id, 'admin', 1000, 1024, 'admin'),
        (NEW.id, 'member', 1, 7524791500919, 'member'),
        (NEW.id, 'guest', 0, 48, 'guest');
    RETURN NULL;
END
$$;
-- +goose StatementEnd

-- +goose Down
SET LOCAL lock_timeout = '10s';
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION workspace_builtin_roles() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO workspace_roles (workspace_id, name, position, permissions, builtin) VALUES
        (NEW.id, 'owner', 1001, 1024, 'owner'),
        (NEW.id, 'admin', 1000, 1024, 'admin'),
        (NEW.id, 'member', 1, 927721734263, 'member'),
        (NEW.id, 'guest', 0, 48, 'guest');
    RETURN NULL;
END
$$;
-- +goose StatementEnd
UPDATE workspace_roles SET permissions = permissions & ~15393162788864::bigint WHERE permissions & 15393162788864 <> 0;
DELETE FROM workspace_audit WHERE subject_type = 'canvas_item';
ALTER TABLE workspace_audit DROP CONSTRAINT workspace_audit_subject_type_check;
ALTER TABLE workspace_audit ADD CONSTRAINT workspace_audit_subject_type_check
    CHECK (subject_type IN ('room', 'board', 'disk_item', 'wiki_page'));
DROP VIEW canvas_item_heads;
DROP TABLE canvas_activity;
DROP TABLE canvas_permissions;
DROP TABLE canvas_versions;
DROP TABLE canvas_snapshots;
DROP TABLE canvas_updates;
DROP TABLE canvas_items;
ALTER TABLE workspaces DROP COLUMN canvas_trash_days;

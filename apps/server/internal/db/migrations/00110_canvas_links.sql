-- The public read-only link of a canvas (ADR-0114 wave 5): whoever has the link sees the canvas
-- through an anonymous receive-only sync socket, never writes it and never sees who is on it.
--
-- canvas_links     one row per link ever made. code is the credential: 43 characters, base64url
--                  of 32 random bytes (like the Wiki's and the Disk's links). At most one link of
--                  a canvas is not revoked (canvas_links_live_idx); an expired one is revoked when
--                  a new one is made. A link works while it is not revoked, not expired, its item
--                  is a live canvas that is not restricted (nor below a restricted folder) and the
--                  workspace is not suspended — the server checks all of that on every visit and
--                  socket recheck. Turning restricted on, moving into a restricted folder and the
--                  trash revoke the links of the subtree; deleting the canvas forever deletes them
--                  (CASCADE). views counts the visits of the anonymous page (no deduplication).
-- canvas_activity  admits 'link_on' / 'link_off' (the link was made / revoked by a person).
--
-- Safe on a populated database: a new table, and the kind CHECK of canvas_activity replaced
-- NOT VALID then validated (no long lock: VALIDATE takes SHARE UPDATE EXCLUSIVE).

-- +goose Up
SET LOCAL lock_timeout = '10s';

CREATE TABLE canvas_links (
    code       text PRIMARY KEY CHECK (code ~ '^[A-Za-z0-9_-]{43}$'),
    canvas_id  uuid NOT NULL REFERENCES canvas_items (id) ON DELETE CASCADE,
    created_by uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz,
    revoked_at timestamptz,
    views      bigint NOT NULL DEFAULT 0 CHECK (views >= 0)
);
-- One link of a canvas that is not revoked; also the lookup of a canvas's live link.
CREATE UNIQUE INDEX canvas_links_live_idx ON canvas_links (canvas_id) WHERE revoked_at IS NULL;
-- The CASCADE from canvas_items (revoked links included).
CREATE INDEX canvas_links_canvas_idx ON canvas_links (canvas_id);
-- ON DELETE SET NULL from users.
CREATE INDEX canvas_links_created_by_idx ON canvas_links (created_by) WHERE created_by IS NOT NULL;

ALTER TABLE canvas_activity DROP CONSTRAINT canvas_activity_kind_check;
ALTER TABLE canvas_activity ADD CONSTRAINT canvas_activity_kind_check
    CHECK (kind IN ('create', 'rename', 'move', 'share', 'trash', 'restore', 'delete', 'version', 'comment', 'resolve',
                    'link_on', 'link_off')) NOT VALID;
ALTER TABLE canvas_activity VALIDATE CONSTRAINT canvas_activity_kind_check;

-- +goose Down
SET LOCAL lock_timeout = '10s';
DELETE FROM canvas_activity WHERE kind IN ('link_on', 'link_off');
ALTER TABLE canvas_activity DROP CONSTRAINT canvas_activity_kind_check;
ALTER TABLE canvas_activity ADD CONSTRAINT canvas_activity_kind_check
    CHECK (kind IN ('create', 'rename', 'move', 'share', 'trash', 'restore', 'delete', 'version', 'comment', 'resolve'));
DROP TABLE canvas_links;

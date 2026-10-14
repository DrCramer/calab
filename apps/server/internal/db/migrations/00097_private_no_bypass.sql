-- Private rooms and boards hidden from admins and the owner (addenda 2026-10-14 to ADR-0058 and
-- ADR-0078; owner, 14.10: «доски тоже двух типов: публичная — для всех в пространстве, или
-- приватная — видна только автору и тем, кого добавили»; «с комнатами так же»).
--
-- 1. One kind of private: is_private now means what restricted meant, minus the owner's bypass.
--    restricted is aligned with is_private (the rule reads either; the handlers write both).
-- 2. Nobody who works in a private room or board today is locked out: its creator keeps it
--    (rooms: a personal VIEW_ROOM | MANAGE_ROOM, as whoever closed a room got under ADR-0048;
--    boards: the creator already holds a personal override with every board bit, and the rule
--    keeps VIEW_BOARD for the creator), and so do the owner and the admins who took part — wrote
--    a message in the room, created a task on the board — through a personal allow. Admins who
--    only could see it by their role lose it: that is the point.
-- 3. workspaces.owner_sees_private: «Владелец видит приватное», off by default; the workspace
--    owner alone toggles it and alone gets every bit on private rooms, boards, Disk items and
--    Wiki pages while it is on.
-- 4. workspace_audit: the workspace journal of these decisions (the toggle, «Сделать меня
--    владельцем» of a former member's private item). Ids only: no names of private items.
--
-- Safe on a populated database: the column has a constant default; the updates touch private
-- rooms / boards only.

-- +goose Up
SET LOCAL lock_timeout = '10s';

ALTER TABLE workspaces ADD COLUMN owner_sees_private boolean NOT NULL DEFAULT false;

-- The creator of a permanent private room keeps managing it (temporary rooms: the creator is
-- recognized by the rule, ADR-0044).
INSERT INTO room_permissions (room_id, target_type, target_id, allow, deny)
SELECT r.id, 'user', r.created_by::text, (1 | 256), 0  -- VIEW_ROOM | MANAGE_ROOM
FROM rooms r
JOIN workspace_members m ON m.workspace_id = r.workspace_id AND m.user_id = r.created_by
WHERE (r.is_private OR r.restricted) AND r.expires_at IS NULL AND r.archived_at IS NULL
  AND m.role IN ('owner', 'admin')
ON CONFLICT (room_id, target_type, target_id) DO UPDATE
    SET allow = room_permissions.allow | (EXCLUDED.allow & ~room_permissions.deny);

-- The owner and admins who wrote in a private room keep it as members.
INSERT INTO room_permissions (room_id, target_type, target_id, allow, deny)
SELECT r.id, 'user', m.user_id::text, 1, 0  -- VIEW_ROOM
FROM rooms r
JOIN workspace_members m ON m.workspace_id = r.workspace_id AND m.role IN ('owner', 'admin')
WHERE (r.is_private OR r.restricted) AND r.expires_at IS NULL AND r.archived_at IS NULL
  AND EXISTS (SELECT 1 FROM messages x WHERE x.room_id = r.id AND x.author_id = m.user_id AND x.deleted_at IS NULL)
ON CONFLICT (room_id, target_type, target_id) DO UPDATE
    SET allow = room_permissions.allow | (EXCLUDED.allow & ~room_permissions.deny);

-- The owner and admins who created a task on a private board keep it (VIEW_BOARD | CREATE_TASKS |
-- EDIT_TASKS).
INSERT INTO board_permissions (board_id, target_type, target_id, allow, deny)
SELECT b.id, 'user', m.user_id::text, (131072 | 262144 | 524288), 0
FROM boards b
JOIN workspace_members m ON m.workspace_id = b.workspace_id AND m.role IN ('owner', 'admin')
WHERE (b.is_private OR b.restricted)
  AND EXISTS (SELECT 1 FROM tasks t WHERE t.board_id = b.id AND t.created_by = m.user_id)
ON CONFLICT (board_id, target_type, target_id) DO UPDATE
    SET allow = board_permissions.allow | (EXCLUDED.allow & ~board_permissions.deny);

UPDATE rooms SET restricted = true WHERE is_private AND NOT restricted;
UPDATE rooms SET is_private = true WHERE restricted AND NOT is_private;
UPDATE boards SET restricted = true WHERE is_private AND NOT restricted;
UPDATE boards SET is_private = true WHERE restricted AND NOT is_private;

CREATE TABLE workspace_audit (
    id                uuid PRIMARY KEY DEFAULT uuidv7(),
    workspace_id      uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    actor_id          uuid REFERENCES users (id) ON DELETE SET NULL,
    kind              text NOT NULL CHECK (kind IN ('owner_sees_private_on', 'owner_sees_private_off', 'take_over')),
    subject_type      text CHECK (subject_type IN ('room', 'board', 'disk_item', 'wiki_page')),
    subject_id        uuid,
    previous_owner_id uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workspace_audit_workspace_idx ON workspace_audit (workspace_id, id DESC);

-- +goose Down
SET LOCAL lock_timeout = '10s';

DROP TABLE workspace_audit;
ALTER TABLE workspaces DROP COLUMN owner_sees_private;

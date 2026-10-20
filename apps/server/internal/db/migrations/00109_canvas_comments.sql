-- Canvas comments and @mentions (ADR-0114 wave 4): a server entity next to the Yjs document,
-- never inside it.
--
-- canvas_comments  one row per comment. A thread is a root (parent_id NULL) and its replies
--                  (parent_id = the root; one level: the API attaches a reply to a reply to the
--                  root). A root carries the pin: object_id (the id of a document object, as
--                  the client's Yjs map keys it; NULL = a comment on the field) and x / y (the
--                  pin's offset from the object, or its point in the world). A reply's pin
--                  fields are NULL / 0. body ≤ 2000 characters; mentions ≤ 10 user ids (the ones
--                  the server accepted: members who see the canvas); notified: everyone a
--                  mention notice was ever sent to for this comment (an edit notifies only the
--                  new ones). resolved_at / resolved_by on roots only. Deleting is a hard
--                  delete: a reply alone, a root with its thread (parent CASCADE). Deleting the
--                  canvas forever deletes its comments (CASCADE); the trash keeps them.
-- canvas_activity  admits 'comment' (a comment was written) and 'resolve' (a thread was
--                  resolved): the fact and the ids only, never the text.
--
-- Safe on a populated database: a new table, and the kind CHECK of canvas_activity replaced
-- NOT VALID then validated (no long lock: VALIDATE takes SHARE UPDATE EXCLUSIVE).

-- +goose Up
SET LOCAL lock_timeout = '10s';

CREATE TABLE canvas_comments (
    id          uuid PRIMARY KEY DEFAULT uuidv7(),
    canvas_id   uuid NOT NULL REFERENCES canvas_items (id) ON DELETE CASCADE,
    parent_id   uuid REFERENCES canvas_comments (id) ON DELETE CASCADE,
    object_id   text CHECK (object_id IS NULL OR char_length(object_id) BETWEEN 1 AND 64),
    x           double precision NOT NULL DEFAULT 0,
    y           double precision NOT NULL DEFAULT 0,
    author_id   uuid REFERENCES users (id) ON DELETE SET NULL,
    body        text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
    mentions    uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(mentions) <= 10),
    notified    uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(notified) <= 100),
    resolved_at timestamptz,
    resolved_by uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    edited_at   timestamptz,
    CONSTRAINT canvas_comments_parent_check CHECK (parent_id IS DISTINCT FROM id),
    CONSTRAINT canvas_comments_reply_check CHECK (parent_id IS NULL OR (object_id IS NULL AND resolved_at IS NULL)),
    CONSTRAINT canvas_comments_pin_check CHECK (x BETWEEN -1e7 AND 1e7 AND y BETWEEN -1e7 AND 1e7)
);
-- A canvas's comments by time (the listing, the live count) and the CASCADE from canvas_items.
CREATE INDEX canvas_comments_canvas_idx ON canvas_comments (canvas_id, created_at);
-- The replies of a thread and the CASCADE from the root.
CREATE INDEX canvas_comments_parent_idx ON canvas_comments (parent_id) WHERE parent_id IS NOT NULL;
-- The open threads of a canvas (the «открытые» filter, the counter on the button).
CREATE INDEX canvas_comments_open_idx ON canvas_comments (canvas_id, id) WHERE parent_id IS NULL AND resolved_at IS NULL;
-- ON DELETE SET NULL from users.
CREATE INDEX canvas_comments_author_idx ON canvas_comments (author_id) WHERE author_id IS NOT NULL;
CREATE INDEX canvas_comments_resolved_by_idx ON canvas_comments (resolved_by) WHERE resolved_by IS NOT NULL;

ALTER TABLE canvas_activity DROP CONSTRAINT canvas_activity_kind_check;
ALTER TABLE canvas_activity ADD CONSTRAINT canvas_activity_kind_check
    CHECK (kind IN ('create', 'rename', 'move', 'share', 'trash', 'restore', 'delete', 'version', 'comment', 'resolve')) NOT VALID;
ALTER TABLE canvas_activity VALIDATE CONSTRAINT canvas_activity_kind_check;

-- +goose Down
SET LOCAL lock_timeout = '10s';
DELETE FROM canvas_activity WHERE kind IN ('comment', 'resolve');
ALTER TABLE canvas_activity DROP CONSTRAINT canvas_activity_kind_check;
ALTER TABLE canvas_activity ADD CONSTRAINT canvas_activity_kind_check
    CHECK (kind IN ('create', 'rename', 'move', 'share', 'trash', 'restore', 'delete', 'version'));
DROP TABLE canvas_comments;

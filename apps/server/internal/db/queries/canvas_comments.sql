-- Canvas comments (ADR-0127 wave 4, migration 00117). Access is checked by the handlers
-- (internal/canvas/comments.go) on the canvas before any of these run.

-- name: LockCanvasComments :exec
-- Serializes the comment writes of one canvas (the live count under its limit). Taken inside
-- the transaction, never with LockCanvasTree.
SELECT pg_advisory_xact_lock(hashtext('calaba.canvas.comments.' || sqlc.arg('canvas_id')::uuid::text));

-- name: CountCanvasComments :one
SELECT count(*)::int FROM canvas_comments WHERE canvas_id = sqlc.arg('canvas_id');

-- name: CountOpenCanvasThreads :one
SELECT count(*)::int FROM canvas_comments
WHERE canvas_id = sqlc.arg('canvas_id') AND parent_id IS NULL AND resolved_at IS NULL;

-- name: InsertCanvasComment :one
INSERT INTO canvas_comments (canvas_id, parent_id, object_id, x, y, author_id, body, mentions, notified)
VALUES (sqlc.arg('canvas_id'), sqlc.narg('parent_id'), sqlc.narg('object_id'), sqlc.arg('x'), sqlc.arg('y'),
        sqlc.arg('author_id'), sqlc.arg('body'), sqlc.arg('mentions')::uuid[], sqlc.arg('notified')::uuid[])
RETURNING *;

-- name: GetCanvasComment :one
SELECT * FROM canvas_comments WHERE id = sqlc.arg('id');

-- name: GetCanvasCommentForUpdate :one
SELECT * FROM canvas_comments WHERE id = sqlc.arg('id') FOR UPDATE;

-- name: GetCanvasCommentWorkspace :one
-- The workspace of a comment's canvas (the identity scope of /api/canvas/comments/{id}).
SELECT i.workspace_id FROM canvas_comments c JOIN canvas_items i ON i.id = c.canvas_id WHERE c.id = sqlc.arg('id');

-- name: ListCanvasThreads :many
-- A page of a canvas's roots, the oldest first, after the cursor (a root id: uuidv7 orders by
-- time; the nil uuid = the first page); open_only leaves the resolved ones out.
SELECT * FROM canvas_comments
WHERE canvas_id = sqlc.arg('canvas_id') AND parent_id IS NULL
  AND id > sqlc.arg('cursor')::uuid
  AND (NOT sqlc.arg('open_only')::boolean OR resolved_at IS NULL)
ORDER BY id
LIMIT sqlc.arg('lim');

-- name: ListCanvasReplies :many
-- The replies of the roots, the oldest first.
SELECT * FROM canvas_comments WHERE parent_id = ANY(sqlc.arg('roots')::uuid[]) ORDER BY id;

-- name: UpdateCanvasCommentBody :one
UPDATE canvas_comments SET body = sqlc.arg('body'), mentions = sqlc.arg('mentions')::uuid[],
    notified = sqlc.arg('notified')::uuid[], edited_at = now()
WHERE id = sqlc.arg('id')
RETURNING *;

-- name: ResolveCanvasThread :one
-- resolved: true marks the root resolved by resolved_by, false opens it again.
UPDATE canvas_comments SET
    resolved_at = CASE WHEN sqlc.arg('resolved')::boolean THEN now() END,
    resolved_by = CASE WHEN sqlc.arg('resolved')::boolean THEN sqlc.narg('resolved_by')::uuid END
WHERE id = sqlc.arg('id') AND parent_id IS NULL
RETURNING *;

-- name: DeleteCanvasComment :execrows
-- A reply alone, a root with its replies (CASCADE).
DELETE FROM canvas_comments WHERE id = sqlc.arg('id');

-- name: CanvasMentionFacts :many
-- What a mention notice needs about each recipient: their workspace notification level
-- ('mentions' when unset), a workspace mute, and whether they hide message text in
-- notifications (ADR-0072).
SELECT u.id::uuid AS user_id, coalesce(s.level, 'mentions')::text AS level,
    (s.muted_until IS NOT NULL AND s.muted_until > now())::boolean AS muted,
    usr.hide_message_text_in_notifications
FROM unnest(sqlc.arg('user_ids')::uuid[]) AS u (id)
JOIN users usr ON usr.id = u.id
LEFT JOIN workspace_notification_settings s ON s.user_id = u.id AND s.workspace_id = sqlc.arg('workspace_id');

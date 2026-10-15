-- Comments on a meeting (ADR-0103).

-- name: CountEventComments :many
SELECT event_id, count(*)::integer AS n FROM event_comments
WHERE event_id = ANY(sqlc.arg('event_ids')::uuid[]) GROUP BY event_id;

-- name: ListEventComments :many
-- The newest `lim` comments of an event older than `before` (uuidv7: id order = time order),
-- newest first; the caller reverses them.
SELECT * FROM event_comments
WHERE event_id = sqlc.arg('event_id')::uuid
  AND (sqlc.narg('before')::uuid IS NULL OR id < sqlc.narg('before')::uuid)
ORDER BY id DESC
LIMIT sqlc.arg('lim')::integer;

-- name: GetEventComment :one
SELECT * FROM event_comments WHERE id = $1 AND event_id = $2;

-- name: InsertEventComment :one
INSERT INTO event_comments (event_id, author_id, body) VALUES ($1, $2, $3) RETURNING *;

-- name: UpdateEventComment :one
UPDATE event_comments SET body = $3, edited_at = now() WHERE id = $1 AND event_id = $2 RETURNING *;

-- name: DeleteEventComment :execrows
DELETE FROM event_comments WHERE id = $1 AND event_id = $2;

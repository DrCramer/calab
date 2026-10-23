-- The public read-only links of canvases (ADR-0127 wave 5, migration 00020).

-- name: GetCanvasLink :one
-- The live link of a canvas (not revoked, not expired).
SELECT * FROM canvas_links
WHERE canvas_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now());

-- name: GetCanvasLinkForUpdate :one
-- The link of a canvas that is not revoked (expired or not), locked: a create or a revoke.
SELECT * FROM canvas_links WHERE canvas_id = $1 AND revoked_at IS NULL FOR UPDATE;

-- name: InsertCanvasLink :one
INSERT INTO canvas_links (canvas_id, code, created_by, expires_at)
VALUES (sqlc.arg('canvas_id'), sqlc.arg('code'), sqlc.narg('created_by'), sqlc.narg('expires_at'))
RETURNING *;

-- name: SetCanvasLinkExpiry :one
UPDATE canvas_links SET expires_at = sqlc.narg('expires_at') WHERE code = sqlc.arg('code') AND revoked_at IS NULL
RETURNING *;

-- name: RevokeCanvasLink :execrows
-- The link of a canvas that is not revoked; an expired one counts (it is revoked for good).
UPDATE canvas_links SET revoked_at = now() WHERE canvas_id = $1 AND revoked_at IS NULL;

-- name: RevokeCanvasSubtreeLinks :many
-- Every link of item id and of the items below it that is not revoked (a restricted switch, a
-- move into a restricted folder, the trash); the canvases whose link was revoked. Bounded at 64
-- levels like ListCanvasSubtree.
WITH RECURSIVE down (id, depth) AS (
    SELECT sqlc.arg('id')::uuid, 0
    UNION ALL
    SELECT c.id, down.depth + 1 FROM canvas_items c JOIN down ON c.parent_id = down.id WHERE down.depth < 64
)
UPDATE canvas_links l SET revoked_at = now()
FROM down
WHERE l.canvas_id = down.id AND l.revoked_at IS NULL
RETURNING l.canvas_id;

-- name: GetCanvasLinkByCode :one
-- An anonymous visit: the live link with its item. The caller checks the rest (a live canvas,
-- not restricted along its chain, the workspace).
SELECT sqlc.embed(l), sqlc.embed(ci)
FROM canvas_links l
JOIN canvas_item_heads ci ON ci.id = l.canvas_id
WHERE l.code = $1 AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now());

-- name: CountCanvasLinkView :exec
UPDATE canvas_links SET views = views + 1 WHERE code = $1 AND revoked_at IS NULL;

-- name: PurgeRevokedCanvasLinks :execrows
-- Links revoked before the cutoff are dropped (the sweep, a batch at a time): a revoked code
-- never works again, so the row only keeps its history, which the journal has.
DELETE FROM canvas_links WHERE code IN (
    SELECT l.code FROM canvas_links l WHERE l.revoked_at < sqlc.arg('cutoff')::timestamptz LIMIT 1000);

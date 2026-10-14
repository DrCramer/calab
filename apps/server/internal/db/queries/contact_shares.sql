-- name: LockContactShareUser :exec
-- Serialize one person's shares: the hourly count and the insert see each other.
SELECT pg_advisory_xact_lock(hashtextextended('contact:' || sqlc.arg('user_id')::uuid::text, 46));

-- name: ContactShareExists :one
SELECT EXISTS (SELECT 1 FROM bot_contact_shares WHERE message_id = $1 AND button_id = $2 AND user_id = $3);

-- name: CountRecentContactShares :one
SELECT count(*) FROM bot_contact_shares WHERE user_id = $1 AND created_at > now() - interval '1 hour';

-- name: InsertContactShare :one
INSERT INTO bot_contact_shares (workspace_id, bot_user_id, user_id, room_id, message_id, button_id, fields)
VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *;

-- name: ListContactShares :many
-- The journal of a workspace, newest first (keyset by id: uuidv7 = insertion order).
SELECT * FROM bot_contact_shares
WHERE workspace_id = $1 AND (sqlc.narg('before')::uuid IS NULL OR id < sqlc.narg('before')::uuid)
ORDER BY id DESC LIMIT $2;

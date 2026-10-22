-- CBF-60: the AI integration of a workspace (ai.proto).

-- name: LockWorkspaceAi :exec
-- Serializes saves of one workspace's AI settings (the keep-the-key rule reads the stored row).
SELECT pg_advisory_xact_lock(hashtext('calaba.ai.' || sqlc.arg('workspace_id')::uuid::text));

-- name: GetWorkspaceAi :one
SELECT * FROM workspace_ai WHERE workspace_id = $1;

-- name: PutWorkspaceAi :one
INSERT INTO workspace_ai (workspace_id, provider, base_url, model, key_enc, key_hint, updated_at, updated_by)
VALUES ($1, $2, $3, $4, $5, $6, now(), $7)
ON CONFLICT (workspace_id) DO UPDATE
SET provider = excluded.provider, base_url = excluded.base_url, model = excluded.model,
    key_enc = excluded.key_enc, key_hint = excluded.key_hint,
    updated_at = now(), updated_by = excluded.updated_by
RETURNING *;

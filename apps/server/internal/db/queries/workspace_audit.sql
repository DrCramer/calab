-- name: InsertWorkspaceAudit :exec
INSERT INTO workspace_audit (workspace_id, actor_id, kind, subject_type, subject_id, previous_owner_id) VALUES (sqlc.arg('workspace_id'), sqlc.narg('actor_id'), sqlc.arg('kind'), sqlc.narg('subject_type'), sqlc.narg('subject_id'), sqlc.narg('previous_owner_id'));

-- name: ListWorkspaceAudit :many
-- The workspace journal (addendum 2026-10-14), newest first; before = the last id of the
-- previous page (NULL = from the top).
SELECT * FROM workspace_audit
WHERE workspace_id = sqlc.arg('workspace_id')
  AND (sqlc.narg('before')::uuid IS NULL OR id < sqlc.narg('before')::uuid)
ORDER BY id DESC
LIMIT sqlc.arg('lim');

-- name: SetOwnerSeesPrivate :execrows
-- «Владелец видит приватное»: 1 row when the value changed, 0 when it already was so.
UPDATE workspaces SET owner_sees_private = sqlc.arg('on')
WHERE id = sqlc.arg('id') AND owner_sees_private <> sqlc.arg('on');

-- name: IsWorkspaceMember :one
-- Whether the user is a current member of the workspace (take-over: a former member's item).
SELECT EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = sqlc.arg('workspace_id') AND user_id = sqlc.arg('user_id'))::boolean;

-- name: InsertWorkspaceAudit :exec
INSERT INTO workspace_audit (workspace_id, actor_id, kind, subject_type, subject_id, previous_owner_id) VALUES (sqlc.arg('workspace_id'), sqlc.narg('actor_id'), sqlc.arg('kind'), sqlc.narg('subject_type'), sqlc.narg('subject_id'), sqlc.narg('previous_owner_id'));

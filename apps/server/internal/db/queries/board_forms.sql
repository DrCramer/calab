-- name: ListBoardForms :many
SELECT * FROM board_forms WHERE board_id = $1 ORDER BY created_at, id;

-- name: GetBoardForm :one
SELECT * FROM board_forms WHERE id = $1 AND board_id = $2;

-- name: GetBoardFormByCode :one
SELECT * FROM board_forms WHERE code = $1;

-- name: GetBoardFormWorkspace :one
SELECT b.workspace_id FROM board_forms f JOIN boards b ON b.id = f.board_id WHERE f.code = $1;

-- name: CountBoardForms :one
SELECT count(*) FROM board_forms WHERE board_id = $1;

-- name: InsertBoardForm :one
INSERT INTO board_forms (board_id, code, definition, created_by, updated_by) VALUES ($1, $2, $3, $4, $4) RETURNING *;

-- name: UpdateBoardForm :one
UPDATE board_forms SET definition = $3, revision = revision + 1, updated_at = now(), updated_by = $5
WHERE id = $1 AND board_id = $2 AND revision = $4 RETURNING *;

-- name: DeleteBoardForm :execrows
DELETE FROM board_forms WHERE id = $1 AND board_id = $2;

-- name: GetBoardFormSubmission :one
SELECT * FROM board_form_submissions WHERE form_id = $1 AND nonce = $2;

-- name: InsertBoardFormSubmission :one
INSERT INTO board_form_submissions (form_id, nonce, request_hash, actor_id, task_id)
VALUES ($1, $2, $3, $4, $5) RETURNING *;

-- name: InsertBoardFormUpload :exec
INSERT INTO board_form_uploads (file_id, form_id, field_id, token_hash, actor_id, size)
VALUES ($1, $2, $3, $4, $5, $6);

-- name: BoardFormPendingBytes :one
SELECT coalesce(sum(size), 0)::bigint FROM board_form_uploads WHERE form_id = $1;

-- name: GetBoardFormUploads :many
-- Staged uploads by token hash, locked until the submission commits.
SELECT u.*, f.name AS file_name FROM board_form_uploads u JOIN files f ON f.id = u.file_id
WHERE u.token_hash = ANY(sqlc.arg('hashes')::bytea[]) FOR UPDATE OF u;

-- name: DeleteBoardFormUploads :exec
DELETE FROM board_form_uploads WHERE file_id = ANY(sqlc.arg('ids')::uuid[]);

-- name: DeleteExpiredBoardFormUploads :many
-- Staged uploads never submitted (ADR-0064 v2). A row a submission holds (FOR UPDATE) is
-- re-checked after it commits and skipped when the submission took it.
DELETE FROM board_form_uploads WHERE file_id IN (
    SELECT x.file_id FROM board_form_uploads x WHERE x.created_at < $1 ORDER BY x.created_at LIMIT 500)
RETURNING file_id;

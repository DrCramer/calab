-- Board forms v2 (ADR-0064 «v2 (2026-10-14)»): the owner of the routes (last editor), staged
-- uploads of FILE fields, and files without an uploader (uploaded through a form).
-- +goose Up
ALTER TABLE board_forms ADD COLUMN updated_by uuid REFERENCES users(id) ON DELETE SET NULL;
UPDATE board_forms SET updated_by = created_by;

-- NULL = uploaded through a board form: no account, and no uploader read rule.
ALTER TABLE files ALTER COLUMN uploader_id DROP NOT NULL;

CREATE TABLE board_form_uploads (
    file_id    uuid PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
    form_id    uuid NOT NULL REFERENCES board_forms(id) ON DELETE CASCADE,
    field_id   uuid NOT NULL,
    token_hash bytea NOT NULL UNIQUE,
    actor_id   uuid REFERENCES users(id) ON DELETE CASCADE, -- NULL = anonymous
    size       bigint NOT NULL CHECK (size >= 0),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX board_form_uploads_form_idx ON board_form_uploads(form_id);
CREATE INDEX board_form_uploads_created_idx ON board_form_uploads(created_at);

-- +goose Down
DROP TABLE board_form_uploads;
DELETE FROM files WHERE uploader_id IS NULL;
ALTER TABLE files ALTER COLUMN uploader_id SET NOT NULL;
ALTER TABLE board_forms DROP COLUMN updated_by;

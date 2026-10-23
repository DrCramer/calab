-- Smart tasks (CBF-68, ADR-0118): the board's instruction for the AI and the workspace's last
-- AI check.
--
-- boards.ai_instruction  «Инструкция для ИИ» of the board settings (MANAGE_BOARD writes it, only
--                        VIEW_BOARD reads it, never in lists or BOARD_* events): how the model
--                        shapes a smart task of this board. '' = none (the user's text as is).
-- workspace_ai_check     the last «Проверить» of the workspace: fingerprint is an HMAC of
--                        provider, base URL, model and key (never the key itself), so any change
--                        of the four makes the saved settings «unchecked» again. Smart tasks run
--                        only when the fingerprint matches the saved settings and ok is true.

-- +goose Up
ALTER TABLE boards ADD COLUMN ai_instruction text NOT NULL DEFAULT ''
    CHECK (char_length(ai_instruction) <= 4000);

CREATE TABLE workspace_ai_check (
    workspace_id uuid PRIMARY KEY REFERENCES workspaces (id) ON DELETE CASCADE,
    fingerprint  bytea NOT NULL,
    ok           boolean NOT NULL,
    error        text NOT NULL DEFAULT '' CHECK (char_length(error) <= 64),
    checked_at   timestamptz NOT NULL DEFAULT now()
);

-- +goose Down
DROP TABLE workspace_ai_check;
ALTER TABLE boards DROP COLUMN ai_instruction;

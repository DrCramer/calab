-- Contacts shared with bots (ADR-0100): one row per confirmed REQUEST_CONTACT button. The row is
-- the limit (one share per button per person, at most 10 per person per hour) and the journal
-- of the bot's workspace (VIEW_JOURNALS): who shared which fields with which bot, when — never
-- the values (they live in the profile and go to the bot only).
--
-- message_id and bot_user_id have no foreign key: the journal outlives the message and the bot.
-- A deleted workspace or person takes their rows with them.

-- +goose Up
CREATE TABLE bot_contact_shares (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    bot_user_id uuid NOT NULL,
    user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    room_id uuid NOT NULL,
    message_id uuid NOT NULL,
    button_id text NOT NULL,
    fields text[] NOT NULL CHECK (cardinality(fields) BETWEEN 1 AND 2 AND fields <@ ARRAY['phone', 'email']),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (message_id, button_id, user_id)
);
CREATE INDEX bot_contact_shares_user_idx ON bot_contact_shares (user_id, created_at);
CREATE INDEX bot_contact_shares_workspace_idx ON bot_contact_shares (workspace_id, id);

-- +goose Down
DROP TABLE bot_contact_shares;

-- A bot acts on behalf of its owner (ADR-0106).
--
-- 1. bots.acts_as_owner: the owner's switch (only bots.owner_user_id changes it); since: when it
--    was last turned on (shown in the card, NULL while off).
-- 2. messages.via_bot_id / task_activity.via_bot_id: the bot that made the owner's action (the
--    author / actor stays the owner). NULL for everything else.
--
-- Safe on a populated database: nullable columns without defaults are metadata only; the
-- foreign keys are NOT VALID (every existing value is NULL, so there is nothing to check, and
-- the big tables are not scanned under a lock). Users are never deleted (bots are disabled).

-- +goose Up
ALTER TABLE bots ADD COLUMN acts_as_owner boolean NOT NULL DEFAULT false;
ALTER TABLE bots ADD COLUMN acts_as_owner_since timestamptz;

ALTER TABLE messages ADD COLUMN via_bot_id uuid;
ALTER TABLE messages ADD CONSTRAINT messages_via_bot_id_fkey
    FOREIGN KEY (via_bot_id) REFERENCES users (id) NOT VALID;

ALTER TABLE task_activity ADD COLUMN via_bot_id uuid;
ALTER TABLE task_activity ADD CONSTRAINT task_activity_via_bot_id_fkey
    FOREIGN KEY (via_bot_id) REFERENCES users (id) NOT VALID;

-- +goose Down
ALTER TABLE task_activity DROP COLUMN via_bot_id;
ALTER TABLE messages DROP COLUMN via_bot_id;
ALTER TABLE bots DROP COLUMN acts_as_owner_since;
ALTER TABLE bots DROP COLUMN acts_as_owner;

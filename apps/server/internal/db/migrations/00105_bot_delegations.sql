-- A member lets a bot act on their behalf (ADR-0111, extends ADR-0106 beyond the bot's owner).
--
-- 1. bot_delegations: the member's own consent, per workspace × bot × member; since = when it
--    was given. Only the member inserts or deletes their row (the server never takes it from a
--    request of anyone else). A row counts only while it is newer than both memberships
--    (since >= joined_at of the member and of the bot): leaving the workspace and coming back,
--    or the bot being removed and re-added, never revives an old consent.
-- 2. bot_delegation_invites: a pending suggestion by invited_by to user_id; the bot's DM to
--    the invitee (message_id, with the keyboard_revision it was sent with) carries the buttons
--    «Принять» / «Отказаться». Accepting is the invitee's own click; any edit of the message
--    (the bot is its author) changes the revision and voids the buttons.

-- +goose Up
CREATE TABLE bot_delegations (
    workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    bot_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    since        timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, bot_id, user_id),
    CONSTRAINT bot_delegations_not_self CHECK (bot_id <> user_id)
);
CREATE INDEX bot_delegations_bot_user_idx ON bot_delegations (bot_id, user_id);

CREATE TABLE bot_delegation_invites (
    workspace_id      uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    bot_id            uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    user_id           uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    invited_by        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    message_id        uuid,
    keyboard_revision bigint NOT NULL DEFAULT 0,
    created_at        timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, bot_id, user_id),
    CONSTRAINT bot_delegation_invites_not_self CHECK (bot_id <> user_id AND invited_by <> user_id)
);
CREATE UNIQUE INDEX bot_delegation_invites_message_idx ON bot_delegation_invites (message_id) WHERE message_id IS NOT NULL;

-- +goose Down
DROP TABLE bot_delegation_invites;
DROP TABLE bot_delegations;

-- A bot asks a member for their consent itself (CBF-41, ADR-0119, extends ADR-0111 §5).
--
-- bot_delegation_declines: the last «Отказаться» of user_id for bot_id in workspace_id. For 7
-- days after it nobody (the bot included) may invite the member to that bot there again
-- (409 DELEGATION_INVITE_DECLINED with Retry-After). Giving the consent removes the row.
-- Invitations by the bot itself are bot_delegation_invites rows with invited_by = bot_id.

-- +goose Up
CREATE TABLE bot_delegation_declines (
    workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    bot_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    declined_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, bot_id, user_id)
);

-- +goose Down
DROP TABLE bot_delegation_declines;

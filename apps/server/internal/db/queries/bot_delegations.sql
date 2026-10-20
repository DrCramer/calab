-- A member lets a bot act on their behalf (ADR-0111). A consent counts only while it is newer
-- than both memberships and the member is a live person with a non-guest role there.

-- name: GetMemberDelegation :one
-- The gate of "Calab-On-Behalf: <user id>": the bot's token state, and whether user_id is a
-- live person who has a counting consent for this bot in at least one workspace (each
-- workspace a request touches is checked again with BotDelegationCounts).
SELECT b.token_id, (b.revoked_at IS NOT NULL)::boolean AS revoked,
    (bu.disabled_at IS NOT NULL)::boolean AS bot_disabled,
    COALESCE(u.disabled_at IS NULL AND NOT u.is_bot AND NOT u.is_guest, false)::boolean AS member_active,
    EXISTS(SELECT FROM bot_delegations d
        JOIN workspace_members m ON m.workspace_id = d.workspace_id AND m.user_id = d.user_id AND m.role <> 'guest' AND d.since >= m.joined_at
        JOIN workspace_members bm ON bm.workspace_id = d.workspace_id AND bm.user_id = d.bot_id AND d.since >= bm.joined_at
        WHERE d.bot_id = b.user_id AND d.user_id = sqlc.arg('user_id'))::boolean AS consented
FROM bots b JOIN users bu ON bu.id = b.user_id
LEFT JOIN users u ON u.id = sqlc.arg('user_id')
WHERE b.user_id = sqlc.arg('bot_id');

-- name: BotDelegationCounts :one
-- Whether user_id's consent for bot_id in workspace_id counts now.
SELECT EXISTS(SELECT FROM bot_delegations d
    JOIN workspace_members m ON m.workspace_id = d.workspace_id AND m.user_id = d.user_id AND m.role <> 'guest' AND d.since >= m.joined_at
    JOIN workspace_members bm ON bm.workspace_id = d.workspace_id AND bm.user_id = d.bot_id AND d.since >= bm.joined_at
    JOIN users u ON u.id = d.user_id AND u.disabled_at IS NULL AND NOT u.is_bot AND NOT u.is_guest
    WHERE d.workspace_id = sqlc.arg('workspace_id') AND d.bot_id = sqlc.arg('bot_id') AND d.user_id = sqlc.arg('user_id'))::boolean;

-- name: LockMemberDelegations :many
-- WithMutation of a request on behalf of a member: the consents stay put until the commit, so
-- a revocation (DeleteBotDelegation) waits for the requests already admitted and stops the
-- next ones.
SELECT workspace_id FROM bot_delegations
WHERE bot_id = sqlc.arg('bot_id') AND user_id = sqlc.arg('user_id')
ORDER BY workspace_id FOR SHARE;

-- name: ListBotDelegations :many
-- The counting consents for a bot in a workspace, oldest first.
SELECT d.user_id, d.since FROM bot_delegations d
JOIN workspace_members m ON m.workspace_id = d.workspace_id AND m.user_id = d.user_id AND m.role <> 'guest' AND d.since >= m.joined_at
JOIN workspace_members bm ON bm.workspace_id = d.workspace_id AND bm.user_id = d.bot_id AND d.since >= bm.joined_at
JOIN users u ON u.id = d.user_id AND u.disabled_at IS NULL AND NOT u.is_bot AND NOT u.is_guest
WHERE d.workspace_id = sqlc.arg('workspace_id') AND d.bot_id = sqlc.arg('bot_id')
ORDER BY d.since, d.user_id;

-- name: UpsertBotDelegation :one
-- The member's own consent. A row that no longer counts (an older membership) is renewed.
INSERT INTO bot_delegations (workspace_id, bot_id, user_id)
VALUES (sqlc.arg('workspace_id'), sqlc.arg('bot_id'), sqlc.arg('user_id'))
ON CONFLICT (workspace_id, bot_id, user_id) DO UPDATE SET since = now()
RETURNING *;

-- name: DeleteBotDelegation :execrows
DELETE FROM bot_delegations
WHERE workspace_id = sqlc.arg('workspace_id') AND bot_id = sqlc.arg('bot_id') AND user_id = sqlc.arg('user_id');

-- name: ListBotDelegationInvites :many
-- Pending invitations for a bot in a workspace, oldest first.
SELECT * FROM bot_delegation_invites
WHERE workspace_id = sqlc.arg('workspace_id') AND bot_id = sqlc.arg('bot_id')
ORDER BY created_at, user_id;

-- name: InsertBotDelegationInvite :one
-- No row = the member is already invited for this bot here (the first invitation stays).
INSERT INTO bot_delegation_invites (workspace_id, bot_id, user_id, invited_by)
VALUES (sqlc.arg('workspace_id'), sqlc.arg('bot_id'), sqlc.arg('user_id'), sqlc.arg('invited_by'))
ON CONFLICT (workspace_id, bot_id, user_id) DO NOTHING
RETURNING *;

-- name: SetBotDelegationInviteMessage :exec
UPDATE bot_delegation_invites SET message_id = sqlc.arg('message_id'), keyboard_revision = sqlc.arg('keyboard_revision')
WHERE workspace_id = sqlc.arg('workspace_id') AND bot_id = sqlc.arg('bot_id') AND user_id = sqlc.arg('user_id');

-- name: DeleteBotDelegationInvite :one
DELETE FROM bot_delegation_invites
WHERE workspace_id = sqlc.arg('workspace_id') AND bot_id = sqlc.arg('bot_id') AND user_id = sqlc.arg('user_id')
RETURNING *;

-- name: GetBotDelegationInviteByMessage :one
-- The invitation a bot's DM carries (the click on its buttons), locked.
SELECT * FROM bot_delegation_invites WHERE message_id = sqlc.arg('message_id') FOR UPDATE;

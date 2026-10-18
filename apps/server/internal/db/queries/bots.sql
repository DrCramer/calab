-- ADR-0031: bots, their tokens, commands, webhook outbox and blocks.

-- name: CreateBotUser :one
-- A bot account: no email or password, "verified" (nothing to verify; DMs need it).
-- Its users.username is the bot username (ADR-0077: one namespace with people's nicknames).
INSERT INTO users (email, password_hash, display_name, settings, is_bot, email_verified_at, username)
VALUES (NULL, NULL, $1, $2, true, now(), sqlc.arg('username')::citext)
RETURNING *;

-- name: CreateBot :one
INSERT INTO bots (user_id, owner_user_id, workspace_id, username, description, token_id, token_hash, token_prefix)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
RETURNING *;

-- name: GetBot :one
SELECT * FROM bots WHERE user_id = $1;

-- name: GetBotForUpdate :one
SELECT * FROM bots WHERE user_id = $1 FOR UPDATE;

-- name: GetBotWithUser :one
SELECT sqlc.embed(b), sqlc.embed(u) FROM bots b JOIN users u ON u.id = b.user_id WHERE b.user_id = $1;

-- name: GetBotByUsername :one
SELECT sqlc.embed(b), sqlc.embed(u) FROM bots b JOIN users u ON u.id = b.user_id WHERE b.username = $1;

-- name: GetBotAuth :one
-- What a bot token is checked against: the current token of a live bot account.
SELECT b.token_id, b.token_hash FROM bots b JOIN users u ON u.id = b.user_id
WHERE b.user_id = $1 AND u.disabled_at IS NULL AND b.token_hash IS NOT NULL;

-- name: ListWorkspaceBots :many
-- Bots that are members of a workspace (created there or added), by name.
SELECT sqlc.embed(b), sqlc.embed(u) FROM workspace_members m
JOIN bots b ON b.user_id = m.user_id
JOIN users u ON u.id = b.user_id
WHERE m.workspace_id = $1
ORDER BY lower(u.display_name), b.user_id;

-- name: CountWorkspaceBots :one
SELECT count(*) FROM workspace_members m JOIN users u ON u.id = m.user_id
WHERE m.workspace_id = $1 AND u.is_bot;

-- name: LockWorkspaceBots :exec
-- Serializes the plan limit check of bots joining one workspace.
SELECT pg_advisory_xact_lock(hashtext('calaba.bots:' || sqlc.arg('workspace_id')::text));

-- name: SetBotToken :one
UPDATE bots SET token_id = $2, token_hash = $3, token_prefix = $4, revoked_at = NULL
WHERE user_id = $1
RETURNING *;

-- name: RevokeBotToken :one
UPDATE bots SET token_id = NULL, token_hash = NULL, token_prefix = '', revoked_at = now()
WHERE user_id = $1
RETURNING *;

-- name: UpdateBotDescription :one
UPDATE bots SET description = $2 WHERE user_id = $1
RETURNING *;

-- name: DeleteBot :exec
DELETE FROM bots WHERE user_id = $1;

-- name: ClearUsername :exec
-- A deleted bot frees its username (ADR-0077).
UPDATE users SET username = NULL WHERE id = $1;

-- name: DisableUser :exec
UPDATE users SET disabled_at = coalesce(disabled_at, now()) WHERE id = $1;

-- name: RemoveUserEverywhere :many
-- Removes an account from every workspace (a deleted bot); returns the workspaces.
DELETE FROM workspace_members WHERE user_id = $1
RETURNING workspace_id;

-- name: DeleteUserOverridesEverywhere :exec
DELETE FROM room_permissions WHERE target_type = 'user' AND target_id = sqlc.arg('user_id')::text;

-- name: DeleteBotCommands :exec
DELETE FROM bot_commands WHERE bot_user_id = $1;

-- name: InsertBotCommands :exec
INSERT INTO bot_commands (bot_user_id, name, description, position)
-- Parallel arrays (set-returning functions in one SELECT list are zipped).
SELECT sqlc.arg('bot_user_id')::uuid, unnest(sqlc.arg('names')::text[]), unnest(sqlc.arg('descriptions')::text[]),
       unnest(sqlc.arg('positions')::smallint[]);

-- name: ListBotCommands :many
SELECT * FROM bot_commands WHERE bot_user_id = ANY(sqlc.arg('bot_ids')::uuid[])
ORDER BY bot_user_id, position;

-- name: ListWorkspaceBotIDs :many
-- Live bots (with a token) that are members of a workspace.
SELECT b.user_id, b.username FROM workspace_members m JOIN bots b ON b.user_id = m.user_id
JOIN users u ON u.id = b.user_id
WHERE m.workspace_id = $1 AND b.token_hash IS NOT NULL AND u.disabled_at IS NULL
ORDER BY b.user_id;

-- name: SetBotWebhook :one
UPDATE bots SET webhook_url = $2, webhook_secret_enc = $3, webhook_disabled_at = NULL,
    webhook_failing_since = NULL, webhook_last_error = ''
WHERE user_id = $1
RETURNING *;

-- name: ClearBotWebhook :one
UPDATE bots SET webhook_url = NULL, webhook_secret_enc = NULL, webhook_disabled_at = NULL,
    webhook_failing_since = NULL, webhook_last_error = ''
WHERE user_id = $1
RETURNING *;

-- name: ListWebhookBots :many
-- Bots with a working webhook and their workspaces (NULL workspace: member of none).
SELECT b.user_id, m.workspace_id FROM bots b
JOIN users u ON u.id = b.user_id
LEFT JOIN workspace_members m ON m.user_id = b.user_id
WHERE b.webhook_url IS NOT NULL AND b.webhook_disabled_at IS NULL AND b.token_hash IS NOT NULL
  AND u.disabled_at IS NULL;

-- name: ListTaskNoticeRelayUsers :many
-- The users who relay their task notices to bots (ADR-0090; the bots' cache of who to look up).
SELECT id FROM users WHERE task_notify_bots <> '{}';

-- name: TaskNoticeRelayBots :many
-- The bots that get a task notice of the user in the workspace (ADR-0090 §3-4): from the user's
-- task_notify_bots, those still a bot with a valid token, members of the workspace and not
-- blocked by the user.
SELECT b.user_id FROM users u
JOIN bots b ON b.user_id = ANY(u.task_notify_bots)
JOIN users bu ON bu.id = b.user_id
JOIN workspace_members m ON m.user_id = b.user_id AND m.workspace_id = sqlc.arg('workspace_id')
WHERE u.id = sqlc.arg('user_id') AND bu.disabled_at IS NULL AND b.token_hash IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM bot_blocks k WHERE k.user_id = u.id AND k.bot_user_id = b.user_id)
ORDER BY b.user_id;

-- name: RemoveTaskNotifyBot :exec
-- A deleted bot leaves every user's task_notify_bots (ADR-0090 §4).
UPDATE users SET task_notify_bots = array_remove(task_notify_bots, sqlc.arg('bot_user_id')::uuid)
WHERE task_notify_bots <> '{}' AND sqlc.arg('bot_user_id')::uuid = ANY(task_notify_bots);

-- name: EnqueueWebhookDeliveries :exec
-- ids are generated by the application (uuid v7): the body carries its delivery id.
INSERT INTO bot_webhook_deliveries (id, bot_user_id, payload)
SELECT unnest(sqlc.arg('ids')::uuid[]), unnest(sqlc.arg('bot_ids')::uuid[]), unnest(sqlc.arg('payloads')::bytea[]);

-- name: ClaimWebhookDeliveries :many
-- Takes due deliveries: next_at moves one lease ahead (a crashed worker's rows come back).
UPDATE bot_webhook_deliveries SET next_at = now() + sqlc.arg('lease')::interval
WHERE id IN (
    SELECT d.id FROM bot_webhook_deliveries d
    WHERE d.delivered_at IS NULL AND d.failed_at IS NULL AND d.next_at <= now()
    ORDER BY d.next_at, d.id
    LIMIT sqlc.arg('lim')
    FOR UPDATE SKIP LOCKED
)
RETURNING *;

-- name: MarkWebhookDelivered :exec
UPDATE bot_webhook_deliveries SET delivered_at = now(), payload = NULL, attempts = attempts + 1, error = ''
WHERE id = $1;

-- name: MarkWebhookRetry :exec
UPDATE bot_webhook_deliveries SET attempts = attempts + 1, next_at = $2, error = $3 WHERE id = $1;

-- name: MarkWebhookFailed :exec
UPDATE bot_webhook_deliveries SET attempts = attempts + 1, failed_at = now(), payload = NULL, error = $2
WHERE id = $1;

-- name: FailPendingWebhookDeliveries :exec
UPDATE bot_webhook_deliveries SET failed_at = now(), payload = NULL, error = $2
WHERE bot_user_id = $1 AND delivered_at IS NULL AND failed_at IS NULL;

-- name: CountPendingWebhookDeliveries :one
SELECT count(*) FROM bot_webhook_deliveries
WHERE bot_user_id = $1 AND delivered_at IS NULL AND failed_at IS NULL;

-- name: DeleteOldWebhookDeliveries :execrows
DELETE FROM bot_webhook_deliveries
WHERE created_at < $1 AND (delivered_at IS NOT NULL OR failed_at IS NOT NULL);

-- name: BotWebhookOK :exec
UPDATE bots SET webhook_last_ok_at = now(), webhook_failing_since = NULL, webhook_last_error = ''
WHERE user_id = $1;

-- name: BotWebhookFailing :one
UPDATE bots SET webhook_failing_since = coalesce(webhook_failing_since, now()), webhook_last_error = $2
WHERE user_id = $1
RETURNING *;

-- name: DisableBotWebhook :one
UPDATE bots SET webhook_disabled_at = now() WHERE user_id = $1 AND webhook_disabled_at IS NULL
RETURNING *;

-- name: BlockBot :exec
INSERT INTO bot_blocks (user_id, bot_user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING;

-- name: UnblockBot :exec
DELETE FROM bot_blocks WHERE user_id = $1 AND bot_user_id = $2;

-- name: IsBotBlocked :one
SELECT EXISTS (SELECT 1 FROM bot_blocks WHERE user_id = $1 AND bot_user_id = $2)::boolean;

-- name: ListBlockedBots :many
SELECT bot_user_id FROM bot_blocks WHERE user_id = $1 ORDER BY created_at;

-- name: SetBotActsAsOwner :one
-- ADR-0106: the owner's switch; since = when it was turned on (kept while it stays on).
UPDATE bots SET acts_as_owner = sqlc.arg('on')::boolean,
    acts_as_owner_since = CASE WHEN NOT sqlc.arg('on')::boolean THEN NULL
        WHEN acts_as_owner THEN acts_as_owner_since ELSE now() END
WHERE user_id = sqlc.arg('user_id')
RETURNING *;

-- name: GetOnBehalfDelegation :one
-- ADR-0106: what a request "on behalf of the owner" is checked against: the bot's switch and
-- current token, and whether its owner is a live person who is still a member of the bot's
-- home workspace (where only they can turn the switch off: an owner who left or was removed
-- from it no longer controls the bot, so it no longer acts as them).
SELECT b.acts_as_owner, b.owner_user_id, b.token_id, (b.revoked_at IS NOT NULL)::boolean AS revoked,
    (bu.disabled_at IS NOT NULL)::boolean AS bot_disabled,
    (o.disabled_at IS NULL AND NOT o.is_bot AND NOT o.is_guest
        AND EXISTS(SELECT FROM workspace_members hm WHERE hm.workspace_id = b.workspace_id AND hm.user_id = o.id))::boolean AS owner_active
FROM bots b JOIN users bu ON bu.id = b.user_id JOIN users o ON o.id = b.owner_user_id
WHERE b.user_id = sqlc.arg('bot_id');

-- name: GetOnBehalfWorkspaceState :one
-- ADR-0106: one snapshot of a workspace for a request of bot_id on behalf of owner_id: the
-- bot's and the owner's membership, the owner's ban / directory suspension, the workspace's
-- suspension and the identity policy a bot cannot satisfy for a person.
SELECT (w.suspended_at IS NOT NULL)::boolean AS workspace_suspended,
    EXISTS(SELECT FROM workspace_members bm WHERE bm.workspace_id = w.id AND bm.user_id = sqlc.arg('bot_id'))::boolean AS bot_member,
    (m.user_id IS NOT NULL)::boolean AS owner_member,
    (COALESCE(x.status = 'suspended', false) OR EXISTS(SELECT FROM workspace_bans wb
        WHERE wb.workspace_id = w.id AND (wb.user_id = u.id OR wb.email = u.email)))::boolean AS owner_suspended,
    COALESCE(p.mode, 'off')::text AS policy_mode,
    (o.user_id IS NOT NULL)::boolean AS directory_required,
    COALESCE(o.status = 'active', false)::boolean AS directory_active,
    COALESCE(d.disabled_at IS NULL AND d.last_success_at IS NOT NULL
        AND d.last_success_at + make_interval(secs => d.max_staleness_seconds) > clock_timestamp(), false)::boolean AS directory_fresh
FROM workspaces w JOIN users u ON u.id = sqlc.arg('owner_id')
LEFT JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = u.id
LEFT JOIN workspace_identity_access x ON x.workspace_id = w.id AND x.user_id = u.id
LEFT JOIN workspace_identity_policies p ON p.workspace_id = w.id
LEFT JOIN workspace_directories d ON d.workspace_id = w.id
LEFT JOIN directory_objects o ON o.workspace_id = w.id AND o.directory_id = d.id AND o.user_id = u.id
WHERE w.id = sqlc.arg('workspace_id');

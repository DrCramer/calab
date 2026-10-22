-- ADR-0046: SIP telephony — the provider account and the call journal.

-- name: LockSipAccount :exec
-- Serializes saves of one workspace's settings (LiveKit trunk create / replace / delete).
SELECT pg_advisory_xact_lock(hashtext('calaba.sip.' || sqlc.arg('workspace_id')::uuid::text));

-- name: GetSipAccount :one
SELECT * FROM sip_accounts WHERE workspace_id = $1;

-- name: PutSipAccount :one
INSERT INTO sip_accounts (workspace_id, provider, host, transport, username, password_enc, caller_id,
                          outbound_prefix, allowed_prefixes, trunk_id, enabled, last_error, updated_at, updated_by,
                          auth_username, port)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, '', now(), $12, $13, $14)
ON CONFLICT (workspace_id) DO UPDATE
SET provider = excluded.provider, host = excluded.host, transport = excluded.transport,
    username = excluded.username, auth_username = excluded.auth_username, port = excluded.port,
    password_enc = excluded.password_enc, caller_id = excluded.caller_id,
    outbound_prefix = excluded.outbound_prefix, allowed_prefixes = excluded.allowed_prefixes,
    trunk_id = excluded.trunk_id, enabled = excluded.enabled, last_error = '',
    updated_at = now(), updated_by = excluded.updated_by
RETURNING *;

-- name: SetSipLastError :exec
-- A refused save or a failed connection test: only last_error changes ('' clears it).
INSERT INTO sip_accounts (workspace_id, last_error) VALUES ($1, $2)
ON CONFLICT (workspace_id) DO UPDATE SET last_error = excluded.last_error;

-- name: SetWorkspaceSipEnabled :one
UPDATE workspaces SET sip_enabled = $2 WHERE id = $1 RETURNING *;

-- name: InsertSipCall :one
INSERT INTO sip_calls (id, workspace_id, room_id, number, direction, started_by, participant_identity)
VALUES ($1, $2, $3, $4, 'out', $5, $6)
RETURNING *;

-- name: GetSipCall :one
SELECT * FROM sip_calls WHERE id = $1;

-- name: GetLiveSipCallByRoom :one
SELECT * FROM sip_calls WHERE room_id = $1 AND status IN ('dialing', 'ringing', 'active');

-- name: ListLiveSipCallsByWorkspace :many
-- WorkspaceSnapshot.sip_calls: the live calls of the workspace's rooms.
SELECT * FROM sip_calls
WHERE workspace_id = $1 AND room_id IS NOT NULL AND status IN ('dialing', 'ringing', 'active')
ORDER BY id;

-- name: ListLiveSipCalls :many
-- The sweeper: live calls placed before the cutoff, oldest first.
SELECT * FROM sip_calls
WHERE status IN ('dialing', 'ringing', 'active') AND started_at < $1 AND direction = 'out'
ORDER BY started_at
LIMIT 200;

-- name: MarkSipCallRinging :one
UPDATE sip_calls SET status = 'ringing'
WHERE id = $1 AND status = 'dialing'
RETURNING *;

-- name: MarkSipCallActive :one
UPDATE sip_calls
SET status = 'active', answered_at = coalesce(answered_at, now()),
    sip_call_id = CASE WHEN sqlc.arg('sip_call_id')::text <> '' THEN sqlc.arg('sip_call_id')::text ELSE sip_call_id END
WHERE id = sqlc.arg('id') AND status IN ('dialing', 'ringing')
RETURNING *;

-- name: FinishSipCall :one
-- ENDED / FAILED once: a call that is already final is left as it is (no row).
UPDATE sip_calls
SET status = sqlc.arg('status'), reason = sqlc.arg('reason'), ended_by = sqlc.narg('ended_by'), ended_at = now(),
    sip_call_id = CASE WHEN sqlc.arg('sip_call_id')::text <> '' THEN sqlc.arg('sip_call_id')::text ELSE sip_call_id END
WHERE id = sqlc.arg('id') AND status IN ('dialing', 'ringing', 'active')
RETURNING *;

-- name: ListSipCalls :many
-- The journal, newest first; from / to bound started_at, cursor = the last id of the previous page.
SELECT * FROM sip_calls
WHERE workspace_id = sqlc.arg('workspace_id')
  AND (sqlc.narg('from')::timestamptz IS NULL OR started_at >= sqlc.narg('from')::timestamptz)
  AND (sqlc.narg('to')::timestamptz IS NULL OR started_at < sqlc.narg('to')::timestamptz)
  AND (sqlc.narg('cursor')::uuid IS NULL OR id < sqlc.narg('cursor')::uuid)
ORDER BY id DESC
LIMIT sqlc.arg('lim');

-- ---- inbound calls (ADR-0117 step 2)

-- name: SetSipInbound :one
-- PUT …/sip/inbound: the switch, the entry point, the provider addresses and the LiveKit objects
-- made from them, in one write (the row exists: telephony was saved before).
UPDATE sip_accounts
SET inbound_enabled = sqlc.arg('inbound_enabled'), inbound_kind = sqlc.arg('inbound_kind'),
    inbound_menu_id = sqlc.narg('inbound_menu_id'), inbound_extension_id = sqlc.narg('inbound_extension_id'),
    inbound_group_id = sqlc.narg('inbound_group_id'), inbound_allowed_cidrs = sqlc.arg('inbound_allowed_cidrs'),
    inbound_trunk_id = sqlc.arg('inbound_trunk_id'), inbound_rule_id = sqlc.arg('inbound_rule_id'),
    last_error = '', updated_at = now(), updated_by = sqlc.narg('updated_by')
WHERE workspace_id = sqlc.arg('workspace_id')
RETURNING *;

-- name: SetSipInboundLiveKit :exec
-- The LiveKit inbound trunk / dispatch rule ids alone (telephony switched off: both deleted).
UPDATE sip_accounts SET inbound_trunk_id = $2, inbound_rule_id = $3 WHERE workspace_id = $1;

-- name: InsertSipInboundCall :one
-- An inbound line got into its LiveKit room: RINGING from the start (FAILED rows for refusals).
INSERT INTO sip_calls (id, workspace_id, number, direction, participant_identity, sip_call_id, lk_room, status, reason, ended_at)
VALUES (sqlc.arg('id'), sqlc.arg('workspace_id'), sqlc.arg('number'), 'in', sqlc.arg('participant_identity'),
        sqlc.arg('sip_call_id'), sqlc.arg('lk_room'), sqlc.arg('status'), sqlc.arg('reason'),
        CASE WHEN sqlc.arg('status')::text IN ('ended', 'failed') THEN now() END)
RETURNING *;

-- name: GetSipCallByLKRoom :one
SELECT * FROM sip_calls WHERE lk_room = $1 AND lk_room <> '';

-- name: UpdateSipInboundRinging :one
-- Who rings now, the route so far and what the call came through, while it rings.
UPDATE sip_calls SET ringing_user_ids = $2, route = $3, via = $4
WHERE id = $1 AND direction = 'in' AND status = 'ringing'
RETURNING *;

-- name: AnswerSipInboundCall :one
-- The first accept wins: the call rings the user and nobody answered yet.
UPDATE sip_calls
SET status = 'active', answered_at = now(), answered_by = sqlc.arg('user_id')::uuid, ringing_user_ids = '{}'
WHERE id = sqlc.arg('id') AND direction = 'in' AND status = 'ringing' AND answered_by IS NULL
  AND sqlc.arg('user_id')::uuid = ANY (ringing_user_ids)
RETURNING *;

-- name: CountLiveInboundCalls :one
SELECT count(*) FROM sip_calls
WHERE workspace_id = $1 AND direction = 'in' AND status IN ('dialing', 'ringing', 'active');

-- name: ListLiveInboundCallsForUser :many
-- WorkspaceSnapshot.sip_calls: the live inbound calls that ring the user or that the user took.
SELECT * FROM sip_calls
WHERE workspace_id = sqlc.arg('workspace_id') AND direction = 'in' AND status IN ('dialing', 'ringing', 'active')
  AND (sqlc.arg('user_id')::uuid = ANY (ringing_user_ids) OR answered_by = sqlc.arg('user_id')::uuid)
ORDER BY id;

-- name: ListLiveInboundCalls :many
-- The inbound sweeper: live inbound calls placed before the cutoff, oldest first.
SELECT * FROM sip_calls
WHERE direction = 'in' AND status IN ('dialing', 'ringing', 'active') AND started_at < $1
ORDER BY started_at
LIMIT 200;

-- name: ListLiveInboundCallsByWorkspace :many
SELECT * FROM sip_calls
WHERE workspace_id = $1 AND direction = 'in' AND status IN ('dialing', 'ringing', 'active')
ORDER BY id;

-- name: SetSipGroupNextPosition :exec
-- The round-robin pointer after a call (not a settings change: updated_at stays).
UPDATE sip_groups SET next_position = $3 WHERE workspace_id = $1 AND id = $2;

-- name: GetSipPromptFile :one
-- The IVR worker downloads a prompt: only files that are a menu's prompt.
SELECT f.* FROM files f JOIN sip_ivr_menus m ON m.prompt_file_id = f.id WHERE f.id = $1;

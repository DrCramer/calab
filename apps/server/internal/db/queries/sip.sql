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

-- name: ListActiveSipCalls :many
-- GET …/sip/calls (ADR-0128): the workspace's live calls of both directions started after the
-- cutoff (older rows are lost ones the sweepers will close), oldest first.
SELECT * FROM sip_calls
WHERE workspace_id = $1 AND status IN ('dialing', 'ringing', 'active') AND started_at > $2
ORDER BY started_at
LIMIT 100;

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

-- name: SipInboundNumberTaken :one
-- Another workspace already takes inbound calls on this caller ID (sip_accounts_inbound_caller_idx).
SELECT EXISTS (
    SELECT 1 FROM sip_accounts
    WHERE caller_id = sqlc.arg('caller_id') AND workspace_id <> sqlc.arg('workspace_id') AND inbound_trunk_id <> ''
);

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

-- name: UpdateSipInboundTransfer :one
-- A transfer of an answered call starts / ends (ADR-0132): who rings now and the route so far;
-- the call stays active with answered_by.
UPDATE sip_calls SET ringing_user_ids = $2, route = $3
WHERE id = $1 AND direction = 'in' AND status = 'active'
RETURNING *;

-- name: TransferSipInboundCall :one
-- The target of a transfer answers (ADR-0132): the call is theirs; only while it rings them.
UPDATE sip_calls
SET answered_by = sqlc.arg('user_id')::uuid, ringing_user_ids = '{}', route = sqlc.arg('route')
WHERE id = sqlc.arg('id') AND direction = 'in' AND status = 'active'
  AND sqlc.arg('user_id')::uuid = ANY (ringing_user_ids)
RETURNING *;

-- name: ReturnSipInboundTransfer :one
-- The target of a transfer answered but never connected (ADR-0132): the call is back with the
-- member who handed it over, still on it.
UPDATE sip_calls SET answered_by = sqlc.arg('user_id')::uuid, ringing_user_ids = '{}', route = sqlc.arg('route')
WHERE id = sqlc.arg('id') AND direction = 'in' AND status = 'active'
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
-- The IVR worker downloads a prompt: only files that are a menu's prompt or recording notice.
SELECT f.* FROM files f WHERE f.id = $1
  AND EXISTS (SELECT 1 FROM sip_ivr_menus m WHERE m.prompt_file_id = f.id OR m.notice_file_id = f.id);

-- ---- inbound calls over a registration (ADR-0121)

-- name: SetSipRegistration :one
-- PUT …/sip/inbound: the mode and the registration fields (same transaction as SetSipInbound).
UPDATE sip_accounts
SET inbound_mode = sqlc.arg('inbound_mode'), reg_registrar = sqlc.arg('reg_registrar'), reg_domain = sqlc.arg('reg_domain'),
    reg_expires = sqlc.arg('reg_expires'), reg_keepalive_sec = sqlc.arg('reg_keepalive_sec'),
    reg_contact_user = sqlc.arg('reg_contact_user'), reg_auth_username = sqlc.arg('reg_auth_username'),
    reg_password_enc = sqlc.narg('reg_password_enc'), reg_trunk_password_enc = sqlc.narg('reg_trunk_password_enc'),
    reg_status = sqlc.arg('reg_status'), reg_error = '', reg_status_at = now(),
    reg_registered_at = CASE WHEN sqlc.arg('reg_status')::text = 'registered' THEN reg_registered_at END,
    reg_expires_at = CASE WHEN sqlc.arg('reg_status')::text = 'registered' THEN reg_expires_at END,
    reg_contact = CASE WHEN sqlc.arg('reg_status')::text = 'registered' THEN reg_contact ELSE '' END
WHERE workspace_id = sqlc.arg('workspace_id')
RETURNING *;

-- name: SipRegistrationTaken :one
-- Another workspace already registers this account (sip_accounts_reg_account_idx).
SELECT EXISTS (
    SELECT 1 FROM sip_accounts
    WHERE inbound_mode = 'register' AND inbound_trunk_id <> '' AND workspace_id <> sqlc.arg('workspace_id')
      AND username = sqlc.arg('username')
      AND lower(CASE WHEN reg_domain <> '' THEN reg_domain ELSE host END) = lower(sqlc.arg('domain')::text)
);

-- name: ListSipRegisterAccounts :many
-- What the registration agent registers: live inbound trunks in REGISTER mode.
SELECT * FROM sip_accounts
WHERE inbound_mode = 'register' AND inbound_trunk_id <> '' AND enabled AND inbound_enabled
ORDER BY workspace_id;

-- name: SetSipRegStatus :execrows
-- The agent's report: the state changes, or the heartbeat refreshes it (not more often than every
-- 10 s unless the status, the error or the contact changed). Only accounts still in REGISTER mode.
UPDATE sip_accounts
SET reg_status = sqlc.arg('reg_status'), reg_error = sqlc.arg('reg_error'), reg_status_at = now(),
    reg_registered_at = CASE WHEN sqlc.arg('reg_status')::text = 'registered' AND reg_status <> 'registered' THEN now()
                             WHEN sqlc.arg('reg_status')::text = 'registered' THEN reg_registered_at END,
    reg_expires_at = sqlc.narg('reg_expires_at'), reg_contact = sqlc.arg('reg_contact')
WHERE workspace_id = sqlc.arg('workspace_id') AND inbound_mode = 'register' AND inbound_trunk_id <> ''
  AND (reg_status <> sqlc.arg('reg_status') OR reg_error <> sqlc.arg('reg_error') OR reg_contact <> sqlc.arg('reg_contact')
       OR reg_status_at IS NULL OR reg_status_at < now() - interval '10 seconds');

-- name: SetSipRegUnavailable :exec
-- No registration agent connected: every live REGISTER account shows «unavailable».
UPDATE sip_accounts SET reg_status = 'unavailable', reg_status_at = now()
WHERE inbound_mode = 'register' AND inbound_trunk_id <> '' AND reg_status <> 'unavailable';

-- name: CountSipRegStatus :many
-- calab_sip_registrations{status}.
SELECT reg_status, count(*)::bigint AS n FROM sip_accounts
WHERE inbound_mode = 'register' AND inbound_trunk_id <> '' GROUP BY reg_status;

-- name: SetSipCallProviderCallID :exec
UPDATE sip_calls SET provider_call_id = $2 WHERE id = $1 AND provider_call_id = '';

-- ---- call recording (ADR-0131)

-- name: SetSipRecording :one
-- PUT …/sip/recording: the admin's switches. updated_at stays: it is the provider form's
-- version (the client re-mounts the form on it).
INSERT INTO sip_accounts (workspace_id, record_inbound, record_outbound)
VALUES ($1, $2, $3)
ON CONFLICT (workspace_id) DO UPDATE
SET record_inbound = excluded.record_inbound, record_outbound = excluded.record_outbound
RETURNING *;

-- name: InsertSipCallRecording :one
-- A call is being recorded; a second insert for the same call (a redelivered webhook) conflicts.
INSERT INTO sip_call_recordings (id, workspace_id, call_id, direction, number, lk_room, file)
VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (call_id) DO NOTHING
RETURNING *;

-- name: MarkSipRecordingStarted :one
UPDATE sip_call_recordings SET egress_id = $2, status = 'recording'
WHERE id = $1 AND status = 'starting'
RETURNING *;

-- name: MarkSipRecordingStopRequested :one
UPDATE sip_call_recordings SET stopped_at = coalesce(stopped_at, now())
WHERE id = $1 AND status IN ('starting', 'recording')
RETURNING *;

-- name: MarkSipRecordingFailed :one
UPDATE sip_call_recordings SET status = 'failed', error = sqlc.arg('error'), ended_at = now()
WHERE id = sqlc.arg('id') AND status IN ('starting', 'recording')
RETURNING *;

-- name: MarkSipRecordingStored :one
UPDATE sip_call_recordings
SET status = 'stored', ended_at = now(), size_bytes = sqlc.arg('size_bytes'), file_id = sqlc.arg('file_id'),
    disk_item_id = sqlc.arg('disk_item_id')
WHERE id = sqlc.arg('id') AND status = 'recording'
RETURNING *;

-- name: GetSipRecordingByEgress :one
SELECT * FROM sip_call_recordings WHERE egress_id = $1;

-- name: GetLiveSipRecordingByCall :one
SELECT * FROM sip_call_recordings WHERE call_id = $1 AND status IN ('starting', 'recording');

-- name: ListLiveSipRecordings :many
SELECT * FROM sip_call_recordings WHERE status IN ('starting', 'recording') ORDER BY started_at LIMIT 200;

-- name: CountLiveSipRecordings :one
SELECT count(*) FROM sip_call_recordings WHERE status IN ('starting', 'recording');

-- name: ListSipRecordingFilesToDelete :many
-- Raw files of finished recordings still on the volume / in the bucket (a failed copy to the Disk
-- keeps its file a while for the admin to recover by hand).
SELECT * FROM sip_call_recordings
WHERE status IN ('stored', 'failed') AND file <> '' AND ended_at < sqlc.arg('before')
ORDER BY ended_at LIMIT 200;

-- name: ForgetSipRecordingFile :exec
UPDATE sip_call_recordings SET file = '' WHERE id = $1;

-- name: GetSipCallRecording :one
SELECT * FROM sip_call_recordings WHERE id = $1;

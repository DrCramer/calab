-- ADR-0137 §1: the call journal — events of a call, its employees, the journal pages, the
-- missed badge, the retention worker and the workspace's telephony policy.

-- name: InsertSipCallEvents :exec
-- The events of one transition in one statement (a JSON array of rows in the column shape); a
-- seq already stored (a retried transition) is skipped.
INSERT INTO sip_call_events (call_id, seq, at, kind, user_id, peer_user_id, target_kind, target_id, target_name, digits, reason)
SELECT sqlc.arg('call_id')::uuid, e.seq, e.at, e.kind, e.user_id, e.peer_user_id, e.target_kind, e.target_id, e.target_name,
       e.digits, e.reason
FROM jsonb_to_recordset(sqlc.arg('events')::jsonb)
     AS e (seq int, at timestamptz, kind text, user_id uuid, peer_user_id uuid, target_kind text, target_id uuid,
           target_name text, digits text, reason text)
WHERE EXISTS (SELECT 1 FROM sip_calls c WHERE c.id = sqlc.arg('call_id')::uuid)
ON CONFLICT (call_id, seq) DO NOTHING;

-- name: UpsertSipCallParties :exec
-- The employees of a call (a JSON array of {user_id, placed, rang, answered, transferred}); a
-- flag once set stays (OR). Users deleted meanwhile are skipped.
INSERT INTO sip_call_parties (call_id, user_id, workspace_id, started_at, placed, rang, answered, transferred)
SELECT c.id, p.user_id, c.workspace_id, c.started_at, p.placed, p.rang, p.answered, p.transferred
FROM sip_calls c,
     jsonb_to_recordset(sqlc.arg('parties')::jsonb) AS p (user_id uuid, placed bool, rang bool, answered bool, transferred bool)
WHERE c.id = sqlc.arg('call_id')::uuid AND EXISTS (SELECT 1 FROM users u WHERE u.id = p.user_id)
ON CONFLICT (call_id, user_id) DO UPDATE
SET placed = sip_call_parties.placed OR excluded.placed, rang = sip_call_parties.rang OR excluded.rang,
    answered = sip_call_parties.answered OR excluded.answered, transferred = sip_call_parties.transferred OR excluded.transferred;

-- name: LockSipCallJournal :one
-- Events from outside the inbound state machine (outbound calls, the recording, refused and lost
-- inbound calls): the call row locked, the last seq stored.
SELECT c.direction, (SELECT coalesce(max(e.seq), 0) FROM sip_call_events e WHERE e.call_id = c.id)::int AS last_seq
FROM sip_calls c WHERE c.id = $1
FOR NO KEY UPDATE OF c;

-- name: MarkSipCallMissed :execrows
-- An inbound call ended without an answer after it rang somebody, or in a menu (no input, a
-- route to «hang up»), or by the schedule's off-hours «hang up» (ADR-0138).
UPDATE sip_calls c SET missed = true
WHERE c.id = $1 AND c.direction = 'in' AND c.status = 'ended' AND c.answered_at IS NULL AND NOT c.missed
  AND (c.reason IN ('no_input', 'hangup_menu', 'off_hours') OR EXISTS (SELECT 1 FROM sip_call_parties p WHERE p.call_id = c.id AND p.rang));

-- name: ListSipJournal :many
-- The workspace's journal, newest first, page key (started_at, id). digits: a substring of the
-- number; peers: the numbers of contacts that matched a text query (T2).
SELECT c.* FROM sip_calls c
WHERE c.workspace_id = sqlc.arg('workspace_id')
  AND (sqlc.arg('direction')::text = '' OR c.direction = sqlc.arg('direction')::text)
  AND (NOT sqlc.arg('missed')::bool OR c.missed)
  AND (sqlc.arg('digits')::text = '' OR strpos(c.peer_e164, sqlc.arg('digits')::text) > 0 OR strpos(c.number, sqlc.arg('digits')::text) > 0)
  AND (NOT sqlc.arg('by_peers')::bool OR c.peer_e164 = ANY (sqlc.arg('peers')::text[]))
  AND (sqlc.narg('from')::timestamptz IS NULL OR c.started_at >= sqlc.narg('from')::timestamptz)
  AND (sqlc.narg('to')::timestamptz IS NULL OR c.started_at < sqlc.narg('to')::timestamptz)
  AND (sqlc.narg('cursor_at')::timestamptz IS NULL OR (c.started_at, c.id) < (sqlc.narg('cursor_at')::timestamptz, sqlc.narg('cursor_id')::uuid))
ORDER BY c.started_at DESC, c.id DESC
LIMIT sqlc.arg('lim');

-- name: ListSipJournalForUser :many
-- The calls of one employee (sip_call_parties), the same filters; missed = missed and it rang them.
SELECT c.* FROM sip_call_parties p JOIN sip_calls c ON c.id = p.call_id
WHERE p.workspace_id = sqlc.arg('workspace_id') AND p.user_id = sqlc.arg('user_id')
  AND (sqlc.arg('direction')::text = '' OR c.direction = sqlc.arg('direction')::text)
  AND (NOT sqlc.arg('missed')::bool OR (c.missed AND p.rang))
  AND (sqlc.arg('digits')::text = '' OR strpos(c.peer_e164, sqlc.arg('digits')::text) > 0 OR strpos(c.number, sqlc.arg('digits')::text) > 0)
  AND (NOT sqlc.arg('by_peers')::bool OR c.peer_e164 = ANY (sqlc.arg('peers')::text[]))
  AND (sqlc.narg('from')::timestamptz IS NULL OR p.started_at >= sqlc.narg('from')::timestamptz)
  AND (sqlc.narg('to')::timestamptz IS NULL OR p.started_at < sqlc.narg('to')::timestamptz)
  AND (sqlc.narg('cursor_at')::timestamptz IS NULL OR (p.started_at, p.call_id) < (sqlc.narg('cursor_at')::timestamptz, sqlc.narg('cursor_id')::uuid))
ORDER BY p.started_at DESC, p.call_id DESC
LIMIT sqlc.arg('lim');

-- name: ListSipCallParties :many
SELECT * FROM sip_call_parties WHERE call_id = ANY (sqlc.arg('call_ids')::uuid[]) ORDER BY call_id, user_id;

-- name: SipCallsWithEvents :many
SELECT id::uuid FROM unnest(sqlc.arg('call_ids')::uuid[]) AS id
WHERE EXISTS (SELECT 1 FROM sip_call_events e WHERE e.call_id = id);

-- name: ListSipCallEvents :many
SELECT * FROM sip_call_events WHERE call_id = $1 ORDER BY at, seq LIMIT 1000;

-- name: GetSipCallRecordingByCall :one
SELECT * FROM sip_call_recordings WHERE call_id = $1;

-- name: CountSipMissed :one
-- The missed badge: the member's missed calls (it rang them, nobody answered) since they last
-- looked at «Recent»; at most 999.
SELECT count(*)::int FROM (
    SELECT 1 FROM sip_call_parties p JOIN sip_calls c ON c.id = p.call_id
    WHERE p.workspace_id = sqlc.arg('workspace_id') AND p.user_id = sqlc.arg('user_id') AND p.rang AND c.missed
      AND p.started_at > (SELECT m.sip_seen_at FROM workspace_members m
                          WHERE m.workspace_id = sqlc.arg('workspace_id') AND m.user_id = sqlc.arg('user_id'))
    LIMIT 999
) x;

-- name: SetSipSeen :exec
UPDATE workspace_members SET sip_seen_at = now() WHERE workspace_id = $1 AND user_id = $2;

-- name: ListSipRetention :many
-- The retention worker: every workspace with a telephony account and its period.
SELECT workspace_id, retention_months FROM sip_accounts ORDER BY workspace_id;

-- name: DeleteOldSipCalls :execrows
-- One batch of the workspace's finished calls older than the cutoff (events and parties
-- cascade). A call whose recording still has a raw file (or records) waits for it.
DELETE FROM sip_calls WHERE id IN (
    SELECT c.id FROM sip_calls c
    WHERE c.workspace_id = sqlc.arg('workspace_id') AND c.started_at < sqlc.arg('before')
      AND c.status IN ('ended', 'failed')
      AND NOT EXISTS (SELECT 1 FROM sip_call_recordings r
                      WHERE r.call_id = c.id AND (r.file <> '' OR r.status IN ('starting', 'recording')))
    ORDER BY c.started_at
    LIMIT 1000
);

-- name: SetSipPolicy :one
-- PUT …/sip/policy: the journal's retention and the outbound limits.
UPDATE sip_accounts
SET retention_months = sqlc.arg('retention_months'), out_per_hour = sqlc.arg('out_per_hour'),
    out_per_user_hour = sqlc.arg('out_per_user_hour')
WHERE workspace_id = sqlc.arg('workspace_id')
RETURNING *;

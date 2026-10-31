-- ADR-0137 §2/§3 (T2): the phone book of the telephony section, caller ID, the personal call.

-- name: LockSipContacts :exec
-- Serializes the workspace's contact writes: the 10 000 cap and «a number belongs to one
-- contact» are checked before the write.
SELECT pg_advisory_xact_lock(hashtext('calaba.sip.contacts.' || sqlc.arg('workspace_id')::uuid::text));

-- name: CountSipContacts :one
SELECT count(*)::int FROM sip_contacts WHERE workspace_id = $1;

-- name: InsertSipContact :one
INSERT INTO sip_contacts (id, workspace_id, name, company, note, created_by, updated_by)
VALUES ($1, $2, $3, $4, $5, $6, $6)
RETURNING *;

-- name: UpdateSipContact :one
UPDATE sip_contacts
SET name = sqlc.arg('name'), company = sqlc.arg('company'), note = sqlc.arg('note'),
    updated_by = sqlc.narg('updated_by'), updated_at = now()
WHERE workspace_id = sqlc.arg('workspace_id') AND id = sqlc.arg('id')
RETURNING *;

-- name: GetSipContact :one
SELECT * FROM sip_contacts WHERE workspace_id = $1 AND id = $2;

-- name: GetSipContactForUpdate :one
SELECT * FROM sip_contacts WHERE workspace_id = $1 AND id = $2 FOR UPDATE;

-- name: DeleteSipContact :execrows
DELETE FROM sip_contacts WHERE workspace_id = $1 AND id = $2;

-- name: DeleteSipContactPhones :exec
DELETE FROM sip_contact_phones WHERE workspace_id = $1 AND contact_id = $2;

-- name: InsertSipContactPhones :exec
-- The numbers of contacts (a JSON array of {contact_id, number, label, position}), one statement.
INSERT INTO sip_contact_phones (contact_id, workspace_id, number, label, position)
SELECT p.contact_id, sqlc.arg('workspace_id')::uuid, p.number, p.label, p.position
FROM jsonb_to_recordset(sqlc.arg('phones')::jsonb) AS p (contact_id uuid, number text, label text, position smallint);

-- name: InsertSipContacts :exec
-- An import: the contacts (a JSON array of {id, name, company, note}) in one statement.
INSERT INTO sip_contacts (id, workspace_id, name, company, note, created_by, updated_by)
SELECT c.id, sqlc.arg('workspace_id')::uuid, c.name, c.company, c.note, sqlc.narg('created_by')::uuid, sqlc.narg('created_by')::uuid
FROM jsonb_to_recordset(sqlc.arg('contacts')::jsonb) AS c (id uuid, name text, company text, note text);

-- name: SipContactNumberOwners :many
-- Who has the numbers in the workspace: conflicts on a write, caller ID on a call.
SELECT p.number, c.id, c.name, c.company
FROM sip_contact_phones p JOIN sip_contacts c ON c.id = p.contact_id
WHERE p.workspace_id = sqlc.arg('workspace_id') AND p.number = ANY (sqlc.arg('numbers')::text[]);

-- name: ListSipContactPhones :many
SELECT * FROM sip_contact_phones WHERE contact_id = ANY (sqlc.arg('contact_ids')::uuid[]) ORDER BY contact_id, position, number;

-- name: ListSipContacts :many
-- A page of the phone book: by sort_group, sort_key, id; text matches a part of the name or the
-- company (folded: sip_fold, any locale), digits a part of a number.
SELECT c.* FROM sip_contacts c
WHERE c.workspace_id = sqlc.arg('workspace_id')
  AND (sqlc.arg('text')::text = '' OR strpos(c.search_key, sip_fold(sqlc.arg('text')::text)) > 0)
  AND (sqlc.arg('digits')::text = '' OR EXISTS (SELECT 1 FROM sip_contact_phones p
                                               WHERE p.contact_id = c.id AND strpos(p.number, sqlc.arg('digits')::text) > 0))
  AND (NOT sqlc.arg('after')::bool OR (c.sort_group, c.sort_key COLLATE "C", c.id)
       > (sqlc.arg('cursor_group')::smallint, sqlc.arg('cursor_key')::text COLLATE "C", sqlc.arg('cursor_id')::uuid))
ORDER BY c.sort_group, c.sort_key COLLATE "C", c.id
LIMIT sqlc.arg('lim');

-- name: SipContactNumbersByText :many
-- The journal's text search (ADR-0137 §1): the numbers of the contacts whose name or company
-- has the text.
SELECT p.number FROM sip_contacts c JOIN sip_contact_phones p ON p.contact_id = c.id
WHERE c.workspace_id = sqlc.arg('workspace_id')
  AND strpos(c.search_key, sip_fold(sqlc.arg('text')::text)) > 0
ORDER BY p.number
LIMIT 500;

-- name: ListSipContactRetention :many
-- The retention worker: every workspace with contacts and its period (12 months without an account).
SELECT w.workspace_id, coalesce(a.retention_months, 12)::smallint AS retention_months
FROM (SELECT DISTINCT c.workspace_id FROM sip_contacts c) w
LEFT JOIN sip_accounts a ON a.workspace_id = w.workspace_id
ORDER BY w.workspace_id;

-- name: DeleteOldSipContacts :execrows
-- One batch of the workspace's contacts nobody edited since the cutoff and none of whose numbers
-- called or was called since then (ADR-0137 «Хранение»).
DELETE FROM sip_contacts WHERE id IN (
    SELECT c.id FROM sip_contacts c
    WHERE c.workspace_id = sqlc.arg('workspace_id') AND c.updated_at < sqlc.arg('before')
      AND NOT EXISTS (SELECT 1 FROM sip_contact_phones p JOIN sip_calls s
                          ON s.workspace_id = p.workspace_id AND s.peer_e164 = p.number
                      WHERE p.contact_id = c.id AND s.started_at >= sqlc.arg('before'))
    ORDER BY c.updated_at
    LIMIT 1000
);

-- name: ListSipMemberPhones :many
-- Caller ID by an employee's profile phone (ADR-0077): the people of the workspace (not guests,
-- not bots, not disabled) with a phone.
SELECT u.id, u.phone::text AS phone
FROM workspace_members m JOIN users u ON u.id = m.user_id
WHERE m.workspace_id = $1 AND m.role <> 'guest' AND NOT u.is_bot AND NOT u.is_guest AND u.disabled_at IS NULL
  AND u.email IS NOT NULL AND u.phone IS NOT NULL
LIMIT 5000;

-- name: HasSipExtension :one
-- The member has an internal number of the workspace (ADR-0117): the telephony section is theirs.
SELECT EXISTS (SELECT 1 FROM sip_extensions WHERE workspace_id = $1 AND user_id = $2);

-- name: ListBotUsers :many
-- Which of the users are bots (caller ID never tells a bot whose phone a number is).
SELECT id FROM users WHERE id = ANY (sqlc.arg('ids')::uuid[]) AND is_bot;

-- ---- the personal call (ADR-0137 §3)

-- name: InsertSipPersonalCall :one
INSERT INTO sip_calls (id, workspace_id, number, direction, started_by, participant_identity, lk_room, origin, peer_e164)
VALUES ($1, $2, $3, 'out', $4, $5, $6, 'personal', $3)
RETURNING *;

-- name: ListLivePersonalCallsByWorkspace :many
SELECT * FROM sip_calls
WHERE workspace_id = $1 AND origin = 'personal' AND status IN ('dialing', 'ringing', 'active')
ORDER BY id;

-- name: ListLivePersonalCallsForUser :many
-- WorkspaceSnapshot.sip_calls: the user's own live personal calls.
SELECT * FROM sip_calls
WHERE workspace_id = $1 AND origin = 'personal' AND started_by = $2 AND status IN ('dialing', 'ringing', 'active')
ORDER BY id;

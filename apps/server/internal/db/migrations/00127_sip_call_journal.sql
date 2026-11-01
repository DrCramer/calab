-- The call journal of the telephony section (ADR-0137 §1, stage T1).
--
-- sip_calls.origin       where a call comes from: 'room' (a voice room's line, ADR-0046),
--                        'personal' (a call from the telephony section, T2), 'inbound' (a call to
--                        the workspace's number, ADR-0117), 'test' (the connection test). room_id
--                        NULL alone meant both a test and a deleted room; old rows are told apart
--                        by the number: the account's own caller ID is a test.
-- sip_calls.peer_e164    the outside party's number in E.164 ('' = not a number, e.g. hidden):
--                        search by number and matching with contacts (T2).
-- sip_calls.missed       an inbound call nobody answered after it rang somebody, or that ended in
--                        a menu (no_input / hangup_menu): set when the call ends.
-- sip_call_events        the call's steps in order (menu, key, ring, answer, transfer, end …),
--                        names of menus / groups as they were then (target_name), no FK on the
--                        targets (they are deleted). seq: the inbound state machine numbers its
--                        events 1, 2, … (an insert of the same seq after a retried transition is
--                        a no-op); events from outside the machine (outbound calls, recording)
--                        take max(seq) + 1 under the call row's lock, from 1000001 on for inbound
--                        calls so the machine's numbers never collide. Read ordered by (at, seq).
-- sip_call_parties       the employees of a call (placed it, it rang them, answered, transferred):
--                        «my calls» and «my missed» without scanning the events.
-- sip_accounts.retention_months   the journal (and, from T2, the contacts) are kept this long:
--                        1, 3, 6, 12, 24 or 36 months; default 12 (owner, 27.10). The hourly
--                        worker deletes older calls — on rollout, calls older than a year go.
-- sip_accounts.out_per_hour / out_per_user_hour   outbound calls per hour of the workspace /
--                        of one member (owner, 27.10: 120 / 30, was 20 per workspace).
-- workspace_members.sip_seen_at   when the member last looked at «Recent» (the missed badge
--                        counts their missed calls after it); now() for everybody on rollout so
--                        old calls do not light the badge.

-- +goose Up
ALTER TABLE sip_calls
    ADD COLUMN origin    text NOT NULL DEFAULT 'room' CHECK (origin IN ('room', 'personal', 'inbound', 'test')),
    ADD COLUMN peer_e164 text NOT NULL DEFAULT '' CHECK (peer_e164 = '' OR peer_e164 ~ '^\+[1-9][0-9]{6,14}$'),
    ADD COLUMN missed    boolean NOT NULL DEFAULT false;

UPDATE sip_calls c
SET origin = CASE
        WHEN c.direction = 'in' THEN 'inbound'
        WHEN c.room_id IS NOT NULL THEN 'room'
        WHEN EXISTS (SELECT 1 FROM sip_accounts a WHERE a.workspace_id = c.workspace_id AND a.caller_id = c.number) THEN 'test'
        ELSE 'room'
    END,
    peer_e164 = CASE WHEN c.number ~ '^\+[1-9][0-9]{6,14}$' THEN c.number ELSE '' END,
    missed = c.direction = 'in' AND c.status = 'ended' AND c.answered_at IS NULL
        AND (c.route ~ '(ext|group):' OR c.reason IN ('no_input', 'hangup_menu'));

-- Every insert names its origin from now on.
ALTER TABLE sip_calls ALTER COLUMN origin DROP DEFAULT;

-- The journal: newest first per workspace, the page key (started_at, id).
CREATE INDEX sip_calls_journal_idx ON sip_calls (workspace_id, started_at DESC, id DESC);
CREATE INDEX sip_calls_peer_idx ON sip_calls (workspace_id, peer_e164) WHERE peer_e164 <> '';

CREATE TABLE sip_call_events (
    call_id      uuid NOT NULL REFERENCES sip_calls (id) ON DELETE CASCADE,
    seq          integer NOT NULL CHECK (seq >= 1),
    at           timestamptz NOT NULL,
    kind         text NOT NULL CHECK (kind IN ('started', 'menu', 'key', 'dialed', 'no_input', 'notice', 'group', 'ring',
                                               'ring_end', 'fallback', 'answered', 'transfer', 'transfer_end', 'dialing',
                                               'provider_ringing', 'recording', 'ended')),
    user_id      uuid REFERENCES users (id) ON DELETE SET NULL,
    peer_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
    target_kind  text NOT NULL DEFAULT '' CHECK (target_kind IN ('', 'menu', 'group', 'extension', 'user', 'room')),
    target_id    uuid,
    target_name  text NOT NULL DEFAULT '' CHECK (char_length(target_name) <= 64),
    digits       text NOT NULL DEFAULT '' CHECK (char_length(digits) <= 16),
    reason       text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 64),
    PRIMARY KEY (call_id, seq)
);
CREATE INDEX sip_call_events_user_idx ON sip_call_events (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX sip_call_events_peer_user_idx ON sip_call_events (peer_user_id) WHERE peer_user_id IS NOT NULL;

CREATE TABLE sip_call_parties (
    call_id      uuid NOT NULL REFERENCES sip_calls (id) ON DELETE CASCADE,
    user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    started_at   timestamptz NOT NULL,
    placed       boolean NOT NULL DEFAULT false,
    rang         boolean NOT NULL DEFAULT false,
    answered     boolean NOT NULL DEFAULT false,
    transferred  boolean NOT NULL DEFAULT false,
    PRIMARY KEY (call_id, user_id)
);
CREATE INDEX sip_call_parties_user_idx ON sip_call_parties (workspace_id, user_id, started_at DESC, call_id DESC);
CREATE INDEX sip_call_parties_user_fk_idx ON sip_call_parties (user_id);

-- Old calls: who placed them and who answered (who rang them is not known).
INSERT INTO sip_call_parties (call_id, user_id, workspace_id, started_at, placed, answered)
SELECT c.id, u.user_id, c.workspace_id, c.started_at, bool_or(u.placed), bool_or(u.answered)
FROM sip_calls c
CROSS JOIN LATERAL (VALUES (c.started_by, true, false), (c.answered_by, false, true)) AS u (user_id, placed, answered)
WHERE u.user_id IS NOT NULL
GROUP BY c.id, u.user_id, c.workspace_id, c.started_at;

ALTER TABLE sip_accounts
    ADD COLUMN retention_months  smallint NOT NULL DEFAULT 12 CHECK (retention_months IN (1, 3, 6, 12, 24, 36)),
    ADD COLUMN out_per_hour      integer NOT NULL DEFAULT 120 CHECK (out_per_hour BETWEEN 1 AND 1000),
    ADD COLUMN out_per_user_hour integer NOT NULL DEFAULT 30 CHECK (out_per_user_hour BETWEEN 1 AND 1000);

ALTER TABLE workspace_members ADD COLUMN sip_seen_at timestamptz NOT NULL DEFAULT now();

-- +goose Down
ALTER TABLE workspace_members DROP COLUMN sip_seen_at;
ALTER TABLE sip_accounts DROP COLUMN out_per_user_hour, DROP COLUMN out_per_hour, DROP COLUMN retention_months;
DROP TABLE sip_call_parties;
DROP TABLE sip_call_events;
DROP INDEX sip_calls_peer_idx;
DROP INDEX sip_calls_journal_idx;
ALTER TABLE sip_calls DROP COLUMN missed, DROP COLUMN peer_e164, DROP COLUMN origin;

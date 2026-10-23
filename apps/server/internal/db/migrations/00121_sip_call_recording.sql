-- Phone call recording to the workspace Disk (ADR-0131, CBF-81).
--
-- sip_accounts.record_inbound / record_outbound  the admin's switches (default off): answered
--                                inbound calls / connected outbound calls are recorded.
-- sip_ivr_menus.notice_file_id   the «recording notice» of a voice menu: Ogg/Opus made from an
--                                upload like the greeting; it plays to the caller right before a
--                                key or a dialed number rings a person, a bot or a group. NULL =
--                                nothing plays.
-- sip_call_recordings            one row per recorded call: the egress, its raw file (on the
--                                recordings volume or in the files bucket, like a meeting
--                                recording) and, once stored, the Disk item it became.

-- +goose Up
ALTER TABLE sip_accounts
    ADD COLUMN record_inbound boolean NOT NULL DEFAULT false,
    ADD COLUMN record_outbound boolean NOT NULL DEFAULT false;

ALTER TABLE sip_ivr_menus
    ADD COLUMN notice_file_id uuid REFERENCES files (id) ON DELETE SET NULL,
    ADD COLUMN notice_duration_ms integer NOT NULL DEFAULT 0 CHECK (notice_duration_ms >= 0);
CREATE UNIQUE INDEX sip_ivr_menus_notice_idx ON sip_ivr_menus (notice_file_id) WHERE notice_file_id IS NOT NULL;

CREATE TABLE sip_call_recordings (
    id           uuid PRIMARY KEY DEFAULT uuidv7(),
    workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    call_id      uuid NOT NULL UNIQUE REFERENCES sip_calls (id) ON DELETE CASCADE,
    direction    text NOT NULL CHECK (direction IN ('in', 'out')),
    number       text NOT NULL DEFAULT '',
    lk_room      text NOT NULL,
    egress_id    text UNIQUE,
    -- relative to RECORDINGS_PATH (or the blob key in the files bucket): phone/<workspace>/<id>.ogg
    file         text NOT NULL,
    status       text NOT NULL DEFAULT 'starting' CHECK (status IN ('starting', 'recording', 'stored', 'failed')),
    error        text NOT NULL DEFAULT '' CHECK (char_length(error) <= 200),
    started_at   timestamptz NOT NULL DEFAULT now(),
    stopped_at   timestamptz,
    ended_at     timestamptz,
    size_bytes   bigint NOT NULL DEFAULT 0,
    file_id      uuid REFERENCES files (id) ON DELETE SET NULL,
    disk_item_id uuid REFERENCES disk_items (id) ON DELETE SET NULL
);
CREATE INDEX sip_call_recordings_live_idx ON sip_call_recordings (started_at) WHERE status IN ('starting', 'recording');
CREATE INDEX sip_call_recordings_workspace_idx ON sip_call_recordings (workspace_id, id DESC);
CREATE INDEX sip_call_recordings_file_idx ON sip_call_recordings (file_id) WHERE file_id IS NOT NULL;
CREATE INDEX sip_call_recordings_item_idx ON sip_call_recordings (disk_item_id) WHERE disk_item_id IS NOT NULL;

-- +goose Down
DROP TABLE sip_call_recordings;
DROP INDEX sip_ivr_menus_notice_idx;
ALTER TABLE sip_ivr_menus DROP COLUMN notice_duration_ms, DROP COLUMN notice_file_id;
ALTER TABLE sip_accounts DROP COLUMN record_outbound, DROP COLUMN record_inbound;

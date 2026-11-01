-- The working-hours schedule of the inbound entry point (ADR-0138).
--
-- sip_accounts.schedule_*      the switch, the IANA time zone, the week of working hours as a
--                              JSON array [{"weekday": 1..7 (Monday = 1), "start": 0..1439,
--                              "end": 1..1440}] (end < start = ends the next day; validated by
--                              the API: no overlaps, ≤ 6 a day) and the holiday calendar
--                              ('' = none, 'ru' = the Russian production calendar of ADR-0136).
-- sip_accounts.off_hours_*     where a call outside the working hours goes: the same kind + one
--                              nullable FK column per kind as the entry point (00111), ON DELETE
--                              SET NULL of that column only (a deleted target hangs up); 'hangup'
--                              ends the call with reason 'off_hours'. notice_file_id: Ogg/Opus
--                              made like a menu's prompt, played before the route.
-- sip_call_events.kind         + 'schedule' (reason 'off_hours', target = the off-hours route).

-- +goose Up
ALTER TABLE sip_accounts
    ADD COLUMN schedule_enabled         boolean NOT NULL DEFAULT false,
    ADD COLUMN schedule_tz              text NOT NULL DEFAULT 'Europe/Moscow' CHECK (char_length(schedule_tz) BETWEEN 1 AND 64),
    ADD COLUMN schedule_hours           jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(schedule_hours) = 'array'),
    ADD COLUMN schedule_holidays        text NOT NULL DEFAULT '' CHECK (schedule_holidays IN ('', 'ru')),
    ADD COLUMN off_hours_kind           text NOT NULL DEFAULT 'hangup' CHECK (off_hours_kind IN ('hangup', 'menu', 'extension', 'group')),
    ADD COLUMN off_hours_menu_id        uuid,
    ADD COLUMN off_hours_extension_id   uuid,
    ADD COLUMN off_hours_group_id       uuid,
    ADD COLUMN off_hours_notice_file_id uuid REFERENCES files (id) ON DELETE SET NULL,
    ADD COLUMN off_hours_notice_ms      integer NOT NULL DEFAULT 0 CHECK (off_hours_notice_ms BETWEEN 0 AND 180000),
    ADD FOREIGN KEY (workspace_id, off_hours_menu_id) REFERENCES sip_ivr_menus (workspace_id, id) ON DELETE SET NULL (off_hours_menu_id),
    ADD FOREIGN KEY (workspace_id, off_hours_extension_id) REFERENCES sip_extensions (workspace_id, id) ON DELETE SET NULL (off_hours_extension_id),
    ADD FOREIGN KEY (workspace_id, off_hours_group_id) REFERENCES sip_groups (workspace_id, id) ON DELETE SET NULL (off_hours_group_id),
    ADD CONSTRAINT sip_accounts_off_hours_target_check CHECK ((off_hours_kind = 'menu' OR off_hours_menu_id IS NULL)
           AND (off_hours_kind = 'extension' OR off_hours_extension_id IS NULL)
           AND (off_hours_kind = 'group' OR off_hours_group_id IS NULL));
CREATE INDEX sip_accounts_off_hours_menu_idx ON sip_accounts (workspace_id, off_hours_menu_id) WHERE off_hours_menu_id IS NOT NULL;
CREATE INDEX sip_accounts_off_hours_extension_idx ON sip_accounts (workspace_id, off_hours_extension_id) WHERE off_hours_extension_id IS NOT NULL;
CREATE INDEX sip_accounts_off_hours_group_idx ON sip_accounts (workspace_id, off_hours_group_id) WHERE off_hours_group_id IS NOT NULL;
CREATE UNIQUE INDEX sip_accounts_off_hours_notice_idx ON sip_accounts (off_hours_notice_file_id) WHERE off_hours_notice_file_id IS NOT NULL;

ALTER TABLE sip_call_events DROP CONSTRAINT sip_call_events_kind_check;
ALTER TABLE sip_call_events ADD CONSTRAINT sip_call_events_kind_check
    CHECK (kind IN ('started', 'menu', 'key', 'dialed', 'no_input', 'notice', 'group', 'ring', 'ring_end', 'fallback',
                    'answered', 'transfer', 'transfer_end', 'dialing', 'provider_ringing', 'recording', 'ended', 'schedule'));

-- +goose Down
DELETE FROM sip_call_events WHERE kind = 'schedule';
ALTER TABLE sip_call_events DROP CONSTRAINT sip_call_events_kind_check;
ALTER TABLE sip_call_events ADD CONSTRAINT sip_call_events_kind_check
    CHECK (kind IN ('started', 'menu', 'key', 'dialed', 'no_input', 'notice', 'group', 'ring', 'ring_end', 'fallback',
                    'answered', 'transfer', 'transfer_end', 'dialing', 'provider_ringing', 'recording', 'ended'));
DROP INDEX sip_accounts_off_hours_notice_idx;
DROP INDEX sip_accounts_off_hours_group_idx;
DROP INDEX sip_accounts_off_hours_extension_idx;
DROP INDEX sip_accounts_off_hours_menu_idx;
ALTER TABLE sip_accounts
    DROP CONSTRAINT sip_accounts_off_hours_target_check,
    DROP COLUMN off_hours_notice_ms, DROP COLUMN off_hours_notice_file_id,
    DROP COLUMN off_hours_group_id, DROP COLUMN off_hours_extension_id, DROP COLUMN off_hours_menu_id,
    DROP COLUMN off_hours_kind, DROP COLUMN schedule_holidays, DROP COLUMN schedule_hours,
    DROP COLUMN schedule_tz, DROP COLUMN schedule_enabled;

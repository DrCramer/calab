-- Telephony exchange, step 2 (ADR-0117, CBF-65): inbound calls on the workspace's number.
--
-- sip_accounts.inbound_*   the switch, the entry point (a menu, a number or a group; the same
--                          kind + one nullable FK column per kind as the routes of 00109, ON
--                          DELETE SET NULL of that column only: deleting the target never blocks,
--                          a missing entry point hangs up), the provider addresses beyond the
--                          resolved host, and the LiveKit SIPInboundTrunk / SIPDispatchRule made
--                          from them ('' = none).
-- sip_calls (direction in) lk_room: the LiveKit room LiveKit made for the call
--                          («sipin_<workspace id>_<caller>_<random>»), unique while live;
--                          answered_by, route (the path for the journal), ringing_user_ids (who
--                          rings now: SIP_CALL_UPDATE recipients and READY) and via (the name of
--                          the menu / group it came through, for the modal).

-- +goose Up
ALTER TABLE sip_accounts
    ADD COLUMN inbound_enabled        boolean NOT NULL DEFAULT false,
    ADD COLUMN inbound_kind           text NOT NULL DEFAULT 'hangup' CHECK (inbound_kind IN ('hangup', 'menu', 'extension', 'group')),
    ADD COLUMN inbound_menu_id        uuid,
    ADD COLUMN inbound_extension_id   uuid,
    ADD COLUMN inbound_group_id       uuid,
    ADD COLUMN inbound_allowed_cidrs  text[] NOT NULL DEFAULT '{}',
    ADD COLUMN inbound_trunk_id       text NOT NULL DEFAULT '',
    ADD COLUMN inbound_rule_id        text NOT NULL DEFAULT '',
    ADD FOREIGN KEY (workspace_id, inbound_menu_id) REFERENCES sip_ivr_menus (workspace_id, id) ON DELETE SET NULL (inbound_menu_id),
    ADD FOREIGN KEY (workspace_id, inbound_extension_id) REFERENCES sip_extensions (workspace_id, id) ON DELETE SET NULL (inbound_extension_id),
    ADD FOREIGN KEY (workspace_id, inbound_group_id) REFERENCES sip_groups (workspace_id, id) ON DELETE SET NULL (inbound_group_id),
    ADD CHECK ((inbound_kind = 'menu' OR inbound_menu_id IS NULL)
           AND (inbound_kind = 'extension' OR inbound_extension_id IS NULL)
           AND (inbound_kind = 'group' OR inbound_group_id IS NULL));
CREATE INDEX sip_accounts_inbound_menu_idx ON sip_accounts (workspace_id, inbound_menu_id) WHERE inbound_menu_id IS NOT NULL;
CREATE INDEX sip_accounts_inbound_extension_idx ON sip_accounts (workspace_id, inbound_extension_id) WHERE inbound_extension_id IS NOT NULL;
CREATE INDEX sip_accounts_inbound_group_idx ON sip_accounts (workspace_id, inbound_group_id) WHERE inbound_group_id IS NOT NULL;

ALTER TABLE sip_calls
    ADD COLUMN lk_room          text NOT NULL DEFAULT '',
    ADD COLUMN answered_by      uuid REFERENCES users (id) ON DELETE SET NULL,
    ADD COLUMN route            text NOT NULL DEFAULT '' CHECK (char_length(route) <= 500),
    ADD COLUMN ringing_user_ids uuid[] NOT NULL DEFAULT '{}',
    ADD COLUMN via              text NOT NULL DEFAULT '' CHECK (char_length(via) <= 64);
-- One call per LiveKit room: what makes a redelivered participant_joined a no-op.
CREATE UNIQUE INDEX sip_calls_lk_room_idx ON sip_calls (lk_room) WHERE lk_room <> '';
CREATE INDEX sip_calls_answered_by_idx ON sip_calls (answered_by) WHERE answered_by IS NOT NULL;
-- READY: the live inbound calls of a workspace (a handful at most).
CREATE INDEX sip_calls_inbound_live_idx ON sip_calls (workspace_id)
    WHERE direction = 'in' AND status IN ('dialing', 'ringing', 'active');

-- +goose Down
DROP INDEX sip_calls_inbound_live_idx;
DROP INDEX sip_calls_answered_by_idx;
DROP INDEX sip_calls_lk_room_idx;
ALTER TABLE sip_calls DROP COLUMN via, DROP COLUMN ringing_user_ids, DROP COLUMN route, DROP COLUMN answered_by, DROP COLUMN lk_room;
ALTER TABLE sip_accounts
    DROP COLUMN inbound_rule_id, DROP COLUMN inbound_trunk_id, DROP COLUMN inbound_allowed_cidrs,
    DROP COLUMN inbound_group_id, DROP COLUMN inbound_extension_id, DROP COLUMN inbound_menu_id,
    DROP COLUMN inbound_kind, DROP COLUMN inbound_enabled;

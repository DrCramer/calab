-- Telephony exchange, step 1 (ADR-0117, CBF-65): internal numbers of people, bots and groups,
-- call groups and voice menus (IVR) of a workspace. Inbound calls themselves come in step 2.
--
-- sip_extensions    one numbering plan per workspace (2..6 digits, a leading zero allowed): a
--                   member's number (kind user; bots are users, ADR-0031) or a group's own
--                   number (kind group, made and dropped with the group). user_id is SET NULL
--                   when the member leaves: the number and every route to it stay, unassigned.
--                   A member has at most one number.
-- sip_groups        a group rings its members all at once (ring_all, ring_sec) or one after the
--                   other (round_robin, member_ring_sec each, starting at next_position).
-- sip_group_members the members of a group in their order (position 0..n-1); only user numbers.
-- sip_ivr_menus     a voice menu: the prompt (an Ogg/Opus file made by the server, ADR-0036
--                   transcoding), how long to wait for a key, how often to repeat, and where to go
--                   when nobody presses anything.
-- sip_ivr_items     the action of a key 0-9 * # of a menu.
--
-- A route target (group on_fail_*, menu no_input_*, item action_*) is a kind plus one nullable
-- FK column per kind of object, so the FKs are real: every reference is ON DELETE SET NULL (of
-- that column only) — deleting a member, a number, a group or a menu is never blocked by a
-- route; a target whose column became NULL behaves like hangup and the settings show it as
-- missing. The composite FKs (workspace_id, …) keep every reference inside the workspace.
--
-- workspace_members.sip_extension: the member's number (WorkspaceMember.extension), kept by the
-- extension handlers in the same transaction ('' = none).

-- +goose Up
CREATE TABLE sip_groups (
    id                   uuid PRIMARY KEY DEFAULT uuidv7(),
    workspace_id         uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    name                 text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 64),
    strategy             text NOT NULL DEFAULT 'ring_all' CHECK (strategy IN ('ring_all', 'round_robin')),
    ring_sec             integer NOT NULL DEFAULT 30 CHECK (ring_sec BETWEEN 10 AND 60),
    member_ring_sec      integer NOT NULL DEFAULT 15 CHECK (member_ring_sec BETWEEN 5 AND 60),
    next_position        integer NOT NULL DEFAULT 0 CHECK (next_position >= 0),
    on_fail_kind         text NOT NULL DEFAULT 'hangup' CHECK (on_fail_kind IN ('hangup', 'menu', 'extension', 'group')),
    on_fail_menu_id      uuid,
    on_fail_extension_id uuid,
    on_fail_group_id     uuid,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, id),
    CHECK ((on_fail_kind = 'menu' OR on_fail_menu_id IS NULL)
       AND (on_fail_kind = 'extension' OR on_fail_extension_id IS NULL)
       AND (on_fail_kind = 'group' OR on_fail_group_id IS NULL))
);

CREATE TABLE sip_extensions (
    id           uuid PRIMARY KEY DEFAULT uuidv7(),
    workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    number       text NOT NULL CHECK (number ~ '^[0-9]{2,6}$'),
    kind         text NOT NULL CHECK (kind IN ('user', 'group')),
    user_id      uuid,
    group_id     uuid,
    description  text NOT NULL DEFAULT '' CHECK (char_length(description) <= 64),
    created_at   timestamptz NOT NULL DEFAULT now(),
    created_by   uuid REFERENCES users (id) ON DELETE SET NULL,
    UNIQUE (workspace_id, id),
    UNIQUE (workspace_id, number),
    FOREIGN KEY (workspace_id, user_id) REFERENCES workspace_members (workspace_id, user_id) ON DELETE SET NULL (user_id),
    FOREIGN KEY (workspace_id, group_id) REFERENCES sip_groups (workspace_id, id) ON DELETE CASCADE,
    CHECK ((kind = 'user' AND group_id IS NULL) OR (kind = 'group' AND user_id IS NULL AND group_id IS NOT NULL))
);
CREATE UNIQUE INDEX sip_extensions_user_idx ON sip_extensions (workspace_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX sip_extensions_group_idx ON sip_extensions (group_id) WHERE group_id IS NOT NULL;
CREATE INDEX sip_extensions_created_by_idx ON sip_extensions (created_by) WHERE created_by IS NOT NULL;

CREATE TABLE sip_group_members (
    workspace_id uuid NOT NULL,
    group_id     uuid NOT NULL,
    extension_id uuid NOT NULL,
    position     integer NOT NULL CHECK (position >= 0),
    PRIMARY KEY (group_id, extension_id),
    UNIQUE (group_id, position),
    FOREIGN KEY (workspace_id, group_id) REFERENCES sip_groups (workspace_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, extension_id) REFERENCES sip_extensions (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX sip_group_members_extension_idx ON sip_group_members (workspace_id, extension_id);

CREATE TABLE sip_ivr_menus (
    id                    uuid PRIMARY KEY DEFAULT uuidv7(),
    workspace_id          uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    name                  text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 64),
    prompt_file_id        uuid REFERENCES files (id) ON DELETE SET NULL,
    prompt_duration_ms    integer NOT NULL DEFAULT 0 CHECK (prompt_duration_ms >= 0),
    input_timeout_sec     integer NOT NULL DEFAULT 5 CHECK (input_timeout_sec BETWEEN 3 AND 15),
    repeats               integer NOT NULL DEFAULT 3 CHECK (repeats BETWEEN 1 AND 5),
    no_input_kind         text NOT NULL DEFAULT 'hangup' CHECK (no_input_kind IN ('hangup', 'menu', 'extension', 'group')),
    no_input_menu_id      uuid,
    no_input_extension_id uuid,
    no_input_group_id     uuid,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    updated_by            uuid REFERENCES users (id) ON DELETE SET NULL,
    UNIQUE (workspace_id, id),
    FOREIGN KEY (workspace_id, no_input_menu_id) REFERENCES sip_ivr_menus (workspace_id, id) ON DELETE SET NULL (no_input_menu_id),
    FOREIGN KEY (workspace_id, no_input_extension_id) REFERENCES sip_extensions (workspace_id, id) ON DELETE SET NULL (no_input_extension_id),
    FOREIGN KEY (workspace_id, no_input_group_id) REFERENCES sip_groups (workspace_id, id) ON DELETE SET NULL (no_input_group_id),
    CHECK ((no_input_kind = 'menu' OR no_input_menu_id IS NULL)
       AND (no_input_kind = 'extension' OR no_input_extension_id IS NULL)
       AND (no_input_kind = 'group' OR no_input_group_id IS NULL))
);
CREATE UNIQUE INDEX sip_ivr_menus_prompt_idx ON sip_ivr_menus (prompt_file_id) WHERE prompt_file_id IS NOT NULL;
CREATE INDEX sip_ivr_menus_workspace_idx ON sip_ivr_menus (workspace_id, id);
CREATE INDEX sip_ivr_menus_updated_by_idx ON sip_ivr_menus (updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX sip_ivr_menus_no_input_menu_idx ON sip_ivr_menus (workspace_id, no_input_menu_id) WHERE no_input_menu_id IS NOT NULL;
CREATE INDEX sip_ivr_menus_no_input_extension_idx ON sip_ivr_menus (workspace_id, no_input_extension_id) WHERE no_input_extension_id IS NOT NULL;
CREATE INDEX sip_ivr_menus_no_input_group_idx ON sip_ivr_menus (workspace_id, no_input_group_id) WHERE no_input_group_id IS NOT NULL;

-- The group's fallback refers to menus and numbers, made after the groups.
ALTER TABLE sip_groups
    ADD FOREIGN KEY (workspace_id, on_fail_menu_id) REFERENCES sip_ivr_menus (workspace_id, id) ON DELETE SET NULL (on_fail_menu_id),
    ADD FOREIGN KEY (workspace_id, on_fail_extension_id) REFERENCES sip_extensions (workspace_id, id) ON DELETE SET NULL (on_fail_extension_id),
    ADD FOREIGN KEY (workspace_id, on_fail_group_id) REFERENCES sip_groups (workspace_id, id) ON DELETE SET NULL (on_fail_group_id);
CREATE INDEX sip_groups_workspace_idx ON sip_groups (workspace_id, id);
CREATE INDEX sip_groups_on_fail_menu_idx ON sip_groups (workspace_id, on_fail_menu_id) WHERE on_fail_menu_id IS NOT NULL;
CREATE INDEX sip_groups_on_fail_extension_idx ON sip_groups (workspace_id, on_fail_extension_id) WHERE on_fail_extension_id IS NOT NULL;
CREATE INDEX sip_groups_on_fail_group_idx ON sip_groups (workspace_id, on_fail_group_id) WHERE on_fail_group_id IS NOT NULL;

CREATE TABLE sip_ivr_items (
    workspace_id        uuid NOT NULL,
    menu_id             uuid NOT NULL,
    digit               text NOT NULL CHECK (digit ~ '^[0-9*#]$'),
    action_kind         text NOT NULL CHECK (action_kind IN ('hangup', 'repeat', 'menu', 'extension', 'group')),
    action_menu_id      uuid,
    action_extension_id uuid,
    action_group_id     uuid,
    PRIMARY KEY (menu_id, digit),
    FOREIGN KEY (workspace_id, menu_id) REFERENCES sip_ivr_menus (workspace_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, action_menu_id) REFERENCES sip_ivr_menus (workspace_id, id) ON DELETE SET NULL (action_menu_id),
    FOREIGN KEY (workspace_id, action_extension_id) REFERENCES sip_extensions (workspace_id, id) ON DELETE SET NULL (action_extension_id),
    FOREIGN KEY (workspace_id, action_group_id) REFERENCES sip_groups (workspace_id, id) ON DELETE SET NULL (action_group_id),
    CHECK ((action_kind = 'menu' OR action_menu_id IS NULL)
       AND (action_kind = 'extension' OR action_extension_id IS NULL)
       AND (action_kind = 'group' OR action_group_id IS NULL))
);
CREATE INDEX sip_ivr_items_workspace_menu_idx ON sip_ivr_items (workspace_id, menu_id);
CREATE INDEX sip_ivr_items_action_menu_idx ON sip_ivr_items (workspace_id, action_menu_id) WHERE action_menu_id IS NOT NULL;
CREATE INDEX sip_ivr_items_action_extension_idx ON sip_ivr_items (workspace_id, action_extension_id) WHERE action_extension_id IS NOT NULL;
CREATE INDEX sip_ivr_items_action_group_idx ON sip_ivr_items (workspace_id, action_group_id) WHERE action_group_id IS NOT NULL;

ALTER TABLE workspace_members ADD COLUMN sip_extension text NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE workspace_members DROP COLUMN sip_extension;
DROP TABLE sip_ivr_items;
ALTER TABLE sip_groups DROP COLUMN on_fail_menu_id, DROP COLUMN on_fail_extension_id, DROP COLUMN on_fail_group_id;
DROP TABLE sip_ivr_menus;
DROP TABLE sip_group_members;
DROP TABLE sip_extensions;
DROP TABLE sip_groups;

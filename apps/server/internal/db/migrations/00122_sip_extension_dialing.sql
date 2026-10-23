-- Dialing an internal number from a voice menu (ADR-0129, CBF-80).
--
-- sip_ivr_menus.dial_extensions   off (the default): the keys of the menu only. On: the caller may
--                                 also dial an internal number (a person, a bot, a group) while
--                                 the menu plays or waits; the digits are collected until a 3 s
--                                 pause or «#».
-- sip_extensions.external_blocked a person's / bot's number that external callers may not dial
--                                 from a menu (it is «not found» to them); the routes an admin
--                                 set (keys, entry point, fallbacks) and groups still ring it.
--                                 Never set on a group's number.

-- +goose Up
ALTER TABLE sip_ivr_menus ADD COLUMN dial_extensions boolean NOT NULL DEFAULT false;
ALTER TABLE sip_extensions ADD COLUMN external_blocked boolean NOT NULL DEFAULT false,
    ADD CONSTRAINT sip_extensions_external_blocked_user CHECK (NOT external_blocked OR kind = 'user');

-- +goose Down
ALTER TABLE sip_extensions DROP CONSTRAINT sip_extensions_external_blocked_user, DROP COLUMN external_blocked;
ALTER TABLE sip_ivr_menus DROP COLUMN dial_extensions;

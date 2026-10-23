-- Inbound calls over a registration at the provider (ADR-0121, CBF-65).
--
-- sip_accounts.inbound_mode   'direct' (the provider sends INVITE to our IP, ADR-0117) or
--                             'register' (the agent calab-sipreg registers the account at the
--                             provider and hands its INVITEs to LiveKit SIP over loopback).
-- sip_accounts.reg_*          the registration: registrar / domain ('' = host:port / host), the
--                             requested interval and keepalive, the opaque Contact user part
--                             (also the auth user of the loopback trunk; generated once), the
--                             optional own credentials ('' / NULL = the account's) and the
--                             loopback trunk's digest password — both sealed with sealbox
--                             "calaba/sip-register/v1". The state (reg_status … reg_contact) is
--                             what the agent reported last.
-- sip_calls.provider_call_id  the provider's Call-ID of a call that came over the registration.

-- +goose Up
ALTER TABLE sip_accounts
    ADD COLUMN inbound_mode           text NOT NULL DEFAULT 'direct' CHECK (inbound_mode IN ('direct', 'register')),
    ADD COLUMN reg_registrar          text NOT NULL DEFAULT '' CHECK (char_length(reg_registrar) <= 260),
    ADD COLUMN reg_domain             text NOT NULL DEFAULT '' CHECK (char_length(reg_domain) <= 253),
    ADD COLUMN reg_expires            integer NOT NULL DEFAULT 600 CHECK (reg_expires BETWEEN 60 AND 3600),
    ADD COLUMN reg_keepalive_sec      integer NOT NULL DEFAULT 30 CHECK (reg_keepalive_sec = 0 OR reg_keepalive_sec BETWEEN 15 AND 120),
    ADD COLUMN reg_contact_user       text NOT NULL DEFAULT '',
    ADD COLUMN reg_auth_username      text NOT NULL DEFAULT '',
    ADD COLUMN reg_password_enc       bytea,
    ADD COLUMN reg_trunk_password_enc bytea,
    ADD COLUMN reg_status             text NOT NULL DEFAULT 'off'
        CHECK (reg_status IN ('off', 'unavailable', 'registering', 'registered', 'failed')),
    ADD COLUMN reg_error              text NOT NULL DEFAULT '' CHECK (char_length(reg_error) <= 200),
    ADD COLUMN reg_registered_at      timestamptz,
    ADD COLUMN reg_expires_at         timestamptz,
    ADD COLUMN reg_contact            text NOT NULL DEFAULT '' CHECK (char_length(reg_contact) <= 300),
    ADD COLUMN reg_status_at          timestamptz;
-- The agent finds the account of an INVITE by the Contact user part.
CREATE UNIQUE INDEX sip_accounts_reg_contact_user_idx ON sip_accounts (reg_contact_user) WHERE reg_contact_user <> '';
-- One registration of an account at a provider: a second workspace registering the same
-- credentials would take over the provider's single binding and its calls.
CREATE UNIQUE INDEX sip_accounts_reg_account_idx ON sip_accounts (lower(CASE WHEN reg_domain <> '' THEN reg_domain ELSE host END), username)
    WHERE inbound_mode = 'register' AND inbound_trunk_id <> '';

ALTER TABLE sip_calls ADD COLUMN provider_call_id text NOT NULL DEFAULT '' CHECK (char_length(provider_call_id) <= 200);

-- +goose Down
ALTER TABLE sip_calls DROP COLUMN provider_call_id;
DROP INDEX sip_accounts_reg_account_idx;
DROP INDEX sip_accounts_reg_contact_user_idx;
ALTER TABLE sip_accounts
    DROP COLUMN reg_status_at, DROP COLUMN reg_contact, DROP COLUMN reg_expires_at, DROP COLUMN reg_registered_at,
    DROP COLUMN reg_error, DROP COLUMN reg_status, DROP COLUMN reg_trunk_password_enc, DROP COLUMN reg_password_enc,
    DROP COLUMN reg_auth_username, DROP COLUMN reg_contact_user, DROP COLUMN reg_keepalive_sec, DROP COLUMN reg_expires,
    DROP COLUMN reg_domain, DROP COLUMN reg_registrar, DROP COLUMN inbound_mode;

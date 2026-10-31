-- Ad attribution and server-side Yandex Metrika conversions (ADR-0135).
-- user_attribution: the first-touch campaign of an account, sent by the web client with the
-- registration (utm_* / yclid from the landing link, ym_client_id = the Metrika ClientID the
-- landing passes only after the visitor consented to analytics). One row per account, written
-- once; nothing else (no IP, no user agent).
-- metrika_conversions: the outbox of Measurement Protocol hits. dedupe_key makes a conversion
-- once-only ('signup:<user id>', 'purchase:<payment id>'): a redelivered payment webhook finds
-- the row and adds nothing. No email / name: the client id, the goal and the payment facts.

-- +goose Up
CREATE TABLE user_attribution (
    user_id      uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    utm_source   text NOT NULL DEFAULT '',
    utm_medium   text NOT NULL DEFAULT '',
    utm_campaign text NOT NULL DEFAULT '',
    utm_content  text NOT NULL DEFAULT '',
    utm_term     text NOT NULL DEFAULT '',
    yclid        text NOT NULL DEFAULT '',
    ym_client_id text NOT NULL DEFAULT '',
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE metrika_conversions (
    id             uuid PRIMARY KEY DEFAULT uuidv7(),
    dedupe_key     text NOT NULL UNIQUE,
    goal           text NOT NULL CHECK (goal IN ('signup', 'purchase')),
    client_id      text NOT NULL,
    occurred_at    timestamptz NOT NULL,
    -- purchase only: the payment in minor units of its currency, the account's plan and the
    -- payment id (Metrika transaction id).
    amount_minor   bigint NOT NULL DEFAULT 0,
    currency       text NOT NULL DEFAULT '',
    plan           text NOT NULL DEFAULT '',
    transaction_id text NOT NULL DEFAULT '',
    attempts       integer NOT NULL DEFAULT 0,
    next_at        timestamptz NOT NULL DEFAULT now(), -- due time; a claim moves it one lease ahead
    sent_at        timestamptz,
    failed_at      timestamptz,                         -- given up (rejected or too many attempts)
    error          text NOT NULL DEFAULT '',
    created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX metrika_conversions_due_idx ON metrika_conversions (next_at)
    WHERE sent_at IS NULL AND failed_at IS NULL;

-- +goose Down
DROP TABLE metrika_conversions;
DROP TABLE user_attribution;

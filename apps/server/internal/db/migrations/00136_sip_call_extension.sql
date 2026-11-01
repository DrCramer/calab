-- An extension dialed after the number of a room's phone call (ADR-0046 addendum «Тональный
-- набор»): «+7 495 123-45-67 доб. 101» dials +74951234567 and keeps «101» here; the caller's
-- client sends it as tones once the line answers. Keys 0-9 * # and «,» (a 2 s pause), at most
-- 20 characters (sip.SplitExtension). Empty = none.
--
-- Safe on a populated database: a column with a constant default (metadata only); no CHECK, so
-- no scan under the lock (the server writes only validated values).

-- +goose Up
SET LOCAL lock_timeout = '10s';

ALTER TABLE sip_calls ADD COLUMN IF NOT EXISTS extension text NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE sip_calls DROP COLUMN IF EXISTS extension;

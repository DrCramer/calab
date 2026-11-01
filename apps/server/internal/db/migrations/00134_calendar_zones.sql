-- Extra time zones of the calendar's hour axis (board #85): set per user in Settings → Calendar,
-- shown as muted hour columns next to the main axis in the day and week views.
--
-- users.calendar_zones  [{"zone": "Asia/Kolkata", "label": "Дели"}, …]: at most 2 entries, in the
--                       order of the axis; zone is an IANA name, label is optional (≤ 16
--                       characters; empty = the city of the zone). Checked by PATCH /api/me.
--
-- Safe on a populated database: a column with a constant default (metadata only); no CHECK, so
-- no scan under the lock (the server writes only validated lists).

-- +goose Up
SET LOCAL lock_timeout = '10s';

ALTER TABLE users ADD COLUMN IF NOT EXISTS calendar_zones jsonb NOT NULL DEFAULT '[]';

-- +goose Down
ALTER TABLE users DROP COLUMN IF EXISTS calendar_zones;

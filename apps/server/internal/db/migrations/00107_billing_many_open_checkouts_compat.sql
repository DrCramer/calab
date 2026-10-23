-- Reconcile upstream 00102 when a self-hosted database already used version 00102 for
-- screen-share presets. Fresh databases have already applied the upstream index changes;
-- the guarded statements make this migration safe for both histories.
-- +goose Up
DROP INDEX IF EXISTS billing_checkouts_one_open_idx;
CREATE INDEX IF NOT EXISTS billing_checkouts_open_idx ON billing_checkouts (account_id) WHERE status = 'open';

DROP INDEX IF EXISTS billing_autotopup_attempts_one_open_idx;
CREATE UNIQUE INDEX IF NOT EXISTS billing_autotopup_attempts_one_open_idx ON billing_autotopup_attempts (account_id)
    WHERE status IN ('prepared', 'dispatched', 'unknown');

-- +goose Down
-- The upstream migration 00102 owns the reversible schema change. This compatibility
-- migration only backfills it for installations whose historical 00102 was already occupied.
SELECT 1;

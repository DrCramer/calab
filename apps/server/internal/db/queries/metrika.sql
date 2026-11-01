-- Ad attribution and the Metrika conversion outbox (ADR-0135, migration 00139).

-- name: InsertUserAttribution :exec
-- First touch only: a second write for the same account changes nothing.
INSERT INTO user_attribution (user_id, utm_source, utm_medium, utm_campaign, utm_content, utm_term, yclid, ym_client_id)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT (user_id) DO NOTHING;

-- name: GetUserAttribution :one
SELECT * FROM user_attribution WHERE user_id = $1;

-- name: GetBillingOwnerMetrikaClientID :one
-- The Metrika ClientID of the owner of the billing account's workspace (the payer), '' if none.
SELECT COALESCE((
    SELECT ua.ym_client_id
    FROM billing_accounts a
    JOIN workspaces w ON w.id = a.workspace_id
    JOIN user_attribution ua ON ua.user_id = w.owner_id
    WHERE a.id = $1
), '')::text;

-- name: InsertMetrikaConversion :exec
-- Once per dedupe_key: a repeat (a redelivered webhook) is a no-op.
INSERT INTO metrika_conversions (dedupe_key, goal, client_id, occurred_at, amount_minor, currency, plan, transaction_id)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT (dedupe_key) DO NOTHING;

-- name: ClaimMetrikaConversions :many
-- Takes due conversions: next_at moves one lease ahead (a crashed worker's rows come back).
UPDATE metrika_conversions SET next_at = now() + sqlc.arg('lease')::interval, attempts = attempts + 1
WHERE id IN (
    SELECT c.id FROM metrika_conversions c
    WHERE c.sent_at IS NULL AND c.failed_at IS NULL AND c.next_at <= now()
    ORDER BY c.next_at, c.id
    LIMIT sqlc.arg('lim')
    FOR UPDATE SKIP LOCKED
)
RETURNING *;

-- name: MarkMetrikaConversionSent :exec
UPDATE metrika_conversions SET sent_at = now(), error = '' WHERE id = $1;

-- name: MarkMetrikaConversionRetry :exec
UPDATE metrika_conversions SET next_at = sqlc.arg('next_at'), error = sqlc.arg('error') WHERE id = sqlc.arg('id');

-- name: MarkMetrikaConversionFailed :exec
UPDATE metrika_conversions SET failed_at = now(), error = sqlc.arg('error') WHERE id = sqlc.arg('id');

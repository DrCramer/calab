-- Billing: a new payment never waits for an older one (owner 2026-10-19: «не могу начать
-- оплату, пишет "есть незавершённая оплата" — пусть хоть сколько запускает»; ADR-0080 and
-- ADR-0083 amendments of 2026-10-19).
--
--   * billing_checkouts: any number of open hosted checkouts per account. Every one keeps its
--     own provider session and is credited by its own payment (one row per provider payment id,
--     one funding lot per payment); reconciliation and the Tochka poll already walk every open
--     row. The partial index stays for the lookups by account, without UNIQUE.
--   * billing_autotopup_attempts: one charge of a saved card *in flight* per account (prepared,
--     dispatched, unknown — our request is out or its outcome is not known; Tochka attributes a
--     charge by reading the subscription's operations, which needs it). A one-click charge waiting
--     for the payer's 3-D Secure ('requires_action', Stripe, identified by its PaymentIntent) no
--     longer blocks the next one.

-- +goose Up
DROP INDEX billing_checkouts_one_open_idx;
CREATE INDEX billing_checkouts_open_idx ON billing_checkouts (account_id) WHERE status = 'open';

DROP INDEX billing_autotopup_attempts_one_open_idx;
CREATE UNIQUE INDEX billing_autotopup_attempts_one_open_idx ON billing_autotopup_attempts (account_id)
    WHERE status IN ('prepared', 'dispatched', 'unknown');

-- +goose Down
-- Back to one open of each per account: the older open checkouts are closed as expired in our
-- database only (a late payment of one is still credited by the webhook / import), a 3-D Secure
-- charge next to another open charge is failed as 00078's Down does.
UPDATE billing_checkouts c SET status = 'expired', updated_at = now()
WHERE c.status = 'open' AND EXISTS (
    SELECT 1 FROM billing_checkouts n WHERE n.account_id = c.account_id AND n.status = 'open' AND n.id > c.id);
DROP INDEX billing_checkouts_open_idx;
CREATE UNIQUE INDEX billing_checkouts_one_open_idx ON billing_checkouts (account_id) WHERE status = 'open';

UPDATE billing_autotopup_attempts a SET status = 'failed', failure_code = 'authentication_required', finished_at = now()
WHERE a.status = 'requires_action' AND EXISTS (
    SELECT 1 FROM billing_autotopup_attempts o WHERE o.account_id = a.account_id AND o.id <> a.id
      AND (o.status IN ('prepared', 'dispatched', 'unknown') OR (o.status = 'requires_action' AND o.id > a.id)));
DROP INDEX billing_autotopup_attempts_one_open_idx;
CREATE UNIQUE INDEX billing_autotopup_attempts_one_open_idx ON billing_autotopup_attempts (account_id)
    WHERE status IN ('prepared', 'dispatched', 'requires_action', 'unknown');

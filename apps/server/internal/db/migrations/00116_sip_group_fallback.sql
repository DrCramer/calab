-- The optional fallback of a call group (ADR-0124, CBF-72).
--
-- sip_groups.fallback_enabled  off (the default): the group rings until somebody answers or the
--                              caller hangs up — all at once keeps ringing, round-robin goes
--                              around the circle again and again; on_fail_* is kept but unused.
--                              On: after fallback_sec seconds of ringing (or at once when
--                              nobody can ring) the call follows on_fail_* (another group, a
--                              person / bot number, a menu, or hang up).
-- sip_groups.fallback_sec      the timeout of the fallback, 5..600 s. ring_sec is unused since:
--                              all at once rings until the fallback.
--
-- Existing groups: a fallback somewhere other than «hang up» stays on with the time it took
-- before (ring_sec for all at once; member_ring_sec × members, one circle, for round-robin);
-- a group that hung up after ring_sec now rings until somebody answers — the owner's default.

-- +goose Up
ALTER TABLE sip_groups
    ADD COLUMN fallback_enabled boolean NOT NULL DEFAULT false,
    ADD COLUMN fallback_sec     integer NOT NULL DEFAULT 30 CHECK (fallback_sec BETWEEN 5 AND 600);

UPDATE sip_groups g
SET fallback_enabled = true,
    fallback_sec = CASE WHEN g.strategy = 'round_robin'
        THEN least(600, greatest(5, g.member_ring_sec * greatest(1, (SELECT count(*) FROM sip_group_members m WHERE m.group_id = g.id))))
        ELSE g.ring_sec END
WHERE g.on_fail_kind <> 'hangup';

-- +goose Down
ALTER TABLE sip_groups DROP COLUMN fallback_sec, DROP COLUMN fallback_enabled;

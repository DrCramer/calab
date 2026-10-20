-- Links of a temporary room survive its archive (ADR-0107).
--
-- room_invites.archive_revoked: the link was revoked by the archive of its temporary room (not
-- by hand), was still usable then, and comes back when the room is restored or made permanent.
-- A link revoked by hand never has it.
--
-- Backfill: rooms in the archive now. The archive revoked their links in the transaction that
-- archived the room, so revoked_at = archived_at (both now() of that transaction). Only links
-- usable at that moment: no expiry, bound to the room (expiry >= the room's end) or not expired
-- yet, and uses left; meeting links (event_id) never come back and are not marked.

-- +goose Up
ALTER TABLE room_invites ADD COLUMN archive_revoked boolean NOT NULL DEFAULT false;

UPDATE room_invites i SET archive_revoked = true
FROM rooms r
WHERE r.id = i.room_id AND r.expires_at IS NOT NULL AND r.archived_at IS NOT NULL
  AND i.revoked_at = r.archived_at AND i.event_id IS NULL
  AND (i.expires_at IS NULL OR i.expires_at >= r.expires_at OR i.expires_at > i.revoked_at)
  AND (i.max_uses = 0 OR i.uses < i.max_uses);

-- +goose Down
ALTER TABLE room_invites DROP COLUMN archive_revoked;

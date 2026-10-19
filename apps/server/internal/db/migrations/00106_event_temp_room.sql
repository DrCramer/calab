-- A meeting asks for its own temporary room (ADR-0112): the server creates it 1 h before the
-- start (at once when the meeting is closer) on behalf of the organizer and sets room_id.
-- temp_room stays true after that: room_id is then the meeting's own room, whose end follows
-- the meeting (end + 1 h). One-off meetings only (no rrule).

-- +goose Up
ALTER TABLE events ADD COLUMN temp_room boolean NOT NULL DEFAULT false;
ALTER TABLE events ADD CONSTRAINT events_temp_room_one_off CHECK (NOT temp_room OR rrule IS NULL);
-- The sweep: requests still waiting for their room.
CREATE INDEX events_temp_room_due_idx ON events (starts_at) WHERE temp_room AND room_id IS NULL AND cancelled_at IS NULL;

-- +goose Down
DROP INDEX events_temp_room_due_idx;
ALTER TABLE events DROP CONSTRAINT events_temp_room_one_off;
ALTER TABLE events DROP COLUMN temp_room;

-- Comments on a meeting (ADR-0103): one row per comment of an event (the series as a whole).
-- Read and written by whoever sees the event (calendar.viewer.sees); the author edits, the
-- author or an editor of the event deletes (hard delete). A deleted event or author takes its
-- comments with it.

-- +goose Up
CREATE TABLE event_comments (
    id         uuid PRIMARY KEY DEFAULT uuidv7(),
    event_id   uuid NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    author_id  uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    body       text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
    created_at timestamptz NOT NULL DEFAULT now(),
    edited_at  timestamptz
);
CREATE INDEX event_comments_event_idx ON event_comments (event_id, id);

-- +goose Down
DROP TABLE event_comments;

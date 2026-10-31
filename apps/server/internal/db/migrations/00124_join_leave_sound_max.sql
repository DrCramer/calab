-- Join/leave cues in big voice rooms: others' join/leave sounds play only while the room has
-- at most N people. Workspace default 10; a room override NULL = use the default; 0 = never.
-- Metadata-only column additions (constant default): no table rewrite.

-- +goose Up
ALTER TABLE workspaces ADD COLUMN default_join_leave_sound_max integer NOT NULL DEFAULT 10
    CHECK (default_join_leave_sound_max BETWEEN 0 AND 99);
ALTER TABLE rooms ADD COLUMN join_leave_sound_max integer CHECK (join_leave_sound_max BETWEEN 0 AND 99);

-- +goose Down
ALTER TABLE rooms DROP COLUMN join_leave_sound_max;
ALTER TABLE workspaces DROP COLUMN default_join_leave_sound_max;

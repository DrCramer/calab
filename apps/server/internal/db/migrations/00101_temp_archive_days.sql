-- Archive retention of temporary rooms per workspace (ADR-0044 addendum 14.10): how many days
-- a closed temporary room stays in the archive before it is deleted with its history. Replaces
-- the global TEMP_ROOM_RETENTION_DAYS. Options in the UI: 1 / 7 / 30 / 90 / 365.
--
-- Existing workspaces keep the behaviour they had (the env default was 90, one of the options);
-- workspaces created later start with 30.

-- +goose Up
ALTER TABLE workspaces ADD COLUMN temp_archive_days integer NOT NULL DEFAULT 90
    CHECK (temp_archive_days IN (1, 7, 30, 90, 365));
ALTER TABLE workspaces ALTER COLUMN temp_archive_days SET DEFAULT 30;

-- +goose Down
ALTER TABLE workspaces DROP COLUMN temp_archive_days;

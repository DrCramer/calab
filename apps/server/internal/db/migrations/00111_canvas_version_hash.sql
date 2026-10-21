-- canvas_versions.state_hash: sha256 of the state, written with the version (InsertCanvasVersion).
-- The version rule (ADR-0114 §1: at most one per VersionEvery, only when the state changed) reads
-- it instead of hashing the last version's state (up to 4 MiB) on every stored snapshot, inside
-- the transaction that holds the canvas row lock (second review, minor 4). A version stored before
-- has NULL: the first comparison that needs it computes and keeps it (SetCanvasVersionHash).
--
-- Safe on a populated database: a nullable column without a default is a change of the catalog
-- only (no rewrite, no scan); IF NOT EXISTS makes it idempotent.

-- +goose Up
SET LOCAL lock_timeout = '10s';
ALTER TABLE canvas_versions ADD COLUMN IF NOT EXISTS state_hash bytea;

-- +goose Down
SET LOCAL lock_timeout = '10s';
ALTER TABLE canvas_versions DROP COLUMN IF EXISTS state_hash;

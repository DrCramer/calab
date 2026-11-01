-- +goose NO TRANSACTION
-- Task search by a bare number («532» finds DOC-532, INV-532, … on every board): the number arm
-- of the search condition needs an index of its own, (board_id, number) cannot serve it.

-- +goose Up
CREATE INDEX CONCURRENTLY IF NOT EXISTS tasks_number_idx ON tasks (number);

-- +goose Down
DROP INDEX CONCURRENTLY IF EXISTS tasks_number_idx;

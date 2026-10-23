-- Smart tasks (CBF-75, ADR-0123): «Искать дубли за 2 недели» of the board settings.
--
-- boards.ai_find_duplicates  when on, a smart task filed on this board is first compared by the
--                            model with the board's tasks of the last 14 days that the person
--                            sees; the model may refuse it as a duplicate. MANAGE_BOARD writes it.

-- +goose Up
ALTER TABLE boards ADD COLUMN ai_find_duplicates boolean NOT NULL DEFAULT false;

-- +goose Down
ALTER TABLE boards DROP COLUMN ai_find_duplicates;

-- Private journal entries (ADR-0094 §2 / ADR-0096 §2, addendum 2026-10-14): a restricted Disk
-- item or Wiki page («Только выбранные») is hidden from ADMINISTRATOR, DISK_MANAGE / WIKI_MANAGE
-- and the workspace owner, and so are its entries in the workspace journal. While the item lives
-- the journal checks its access chain; once it is deleted forever (item_id / page_id SET NULL)
-- the chain is gone, so the entries of every item of a restricted subtree are marked private in
-- the deleting transaction, and the workspace journal leaves them out.
--
-- Safe on a populated database: a NOT NULL column with a constant default (metadata only).

-- +goose Up
SET LOCAL lock_timeout = '10s';

ALTER TABLE disk_activity ADD COLUMN private boolean NOT NULL DEFAULT false;
ALTER TABLE wiki_activity ADD COLUMN private boolean NOT NULL DEFAULT false;

-- +goose Down
SET LOCAL lock_timeout = '10s';

ALTER TABLE wiki_activity DROP COLUMN private;
ALTER TABLE disk_activity DROP COLUMN private;

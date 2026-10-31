-- Draft pull requests and one-shot Git events of board task links (ADR-0060 §4, board task #101).
-- task_git_links.draft  the pull / merge request is a draft: PR_READY fires when a stored draft
--                       stops being one.
-- task_git_links.seen   keys of one-shot events already fired for the link («approved:alice»,
--                       «review:bob», ≤ 50): a redelivery or GitLab's second «approved» fires nothing.
--
-- Safe on a populated table: two columns with constant defaults (metadata only, no rewrite).

-- +goose Up
SET LOCAL lock_timeout = '10s';
ALTER TABLE task_git_links ADD COLUMN draft boolean NOT NULL DEFAULT false;
ALTER TABLE task_git_links ADD COLUMN seen text[] NOT NULL DEFAULT '{}';

-- +goose Down
ALTER TABLE task_git_links DROP COLUMN seen;
ALTER TABLE task_git_links DROP COLUMN draft;

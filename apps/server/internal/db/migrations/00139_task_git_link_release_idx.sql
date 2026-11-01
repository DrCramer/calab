-- +goose NO TRANSACTION
-- Release matching (board task #101): a release of up to 5000 commits probes the links by commit
-- SHA and by a merged pull request's merge / squash / head SHA. Without these the query walked
-- every link of the board's tasks and compared it with the whole list (≈ 6 s for a board of 5000
-- tasks); with them, one index probe per SHA (≈ 60 ms). Concurrently: task_git_links is populated.

-- +goose Up
CREATE INDEX CONCURRENTLY IF NOT EXISTS task_git_links_commit_ref_idx ON task_git_links (ref) WHERE kind = 'commit';
CREATE INDEX CONCURRENTLY IF NOT EXISTS task_git_links_merge_shas_idx ON task_git_links USING gin (merge_shas) WHERE kind = 'pr';

-- +goose Down
DROP INDEX CONCURRENTLY IF EXISTS task_git_links_merge_shas_idx;
DROP INDEX CONCURRENTLY IF EXISTS task_git_links_commit_ref_idx;

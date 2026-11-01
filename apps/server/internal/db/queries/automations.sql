-- Board automations (ADR-0060): rules, their runs, the board's Git webhook and task Git links.

-- ---- rules ----

-- name: ListBoardRules :many
SELECT * FROM board_rules WHERE board_id = $1 ORDER BY position, id;

-- name: ListEnabledBoardRules :many
-- The rules a change of the board may run (board_rules_enabled_idx): one lookup per board and
-- transaction; a board without rules costs this probe only.
SELECT * FROM board_rules WHERE board_id = $1 AND enabled ORDER BY position, id;

-- name: GetBoardRule :one
SELECT * FROM board_rules WHERE id = $1;

-- name: GetBoardRuleForUpdate :one
SELECT * FROM board_rules WHERE id = $1 FOR UPDATE;

-- name: GetBoardRuleWorkspace :one
-- The workspace of a rule (identity route resolution).
SELECT b.workspace_id FROM board_rules r JOIN boards b ON b.id = r.board_id WHERE r.id = $1;

-- name: CountBoardRules :one
SELECT count(*)::integer FROM board_rules WHERE board_id = $1;

-- name: BoardRuleCounts :many
SELECT board_id, count(*)::integer AS rules FROM board_rules
WHERE board_id = ANY(sqlc.arg('board_ids')::uuid[]) GROUP BY board_id;

-- name: CreateBoardRule :one
INSERT INTO board_rules (board_id, name, enabled, position, trigger_kind, trigger, condition, actions, created_by)
VALUES (sqlc.arg('board_id'), sqlc.arg('name'), sqlc.arg('enabled'),
        (SELECT coalesce(max(position) + 1, 0) FROM board_rules WHERE board_id = sqlc.arg('board_id')),
        sqlc.arg('trigger_kind'), sqlc.arg('trigger'), sqlc.narg('condition'), sqlc.arg('actions'), sqlc.narg('created_by'))
RETURNING *;

-- name: UpdateBoardRule :one
UPDATE board_rules SET name = sqlc.arg('name'), enabled = sqlc.arg('enabled'), trigger_kind = sqlc.arg('trigger_kind'),
    trigger = sqlc.arg('trigger'), condition = sqlc.narg('condition'), actions = sqlc.arg('actions'), updated_at = now()
WHERE id = sqlc.arg('id')
RETURNING *;

-- name: SetBoardRulePosition :exec
UPDATE board_rules SET position = $2 WHERE id = $1;

-- name: DeleteBoardRule :execrows
DELETE FROM board_rules WHERE id = $1;

-- name: RecordBoardRuleRuns :one
-- After the runs of one transaction (once per rule, in rule id order): the counters and the
-- error state (last_error of the last run, '' when it was clean).
UPDATE board_rules SET runs_count = runs_count + sqlc.arg('runs')::integer, last_run_at = now(),
    last_error = sqlc.arg('last_error')
WHERE id = sqlc.arg('id')
RETURNING *;

-- name: InsertBoardRuleRun :exec
INSERT INTO board_rule_runs (rule_id, task_id, trigger_kind, ok, error, actions_applied, sched_key)
VALUES (sqlc.arg('rule_id'), sqlc.narg('task_id'), sqlc.arg('trigger_kind'), sqlc.arg('ok'), sqlc.arg('error'),
        sqlc.arg('actions_applied'), sqlc.narg('sched_key'));

-- name: ClaimScheduledRuleRun :execrows
-- A scheduled trigger fires once per (rule, task, key date): the claim row is the run itself,
-- updated with the outcome in the same transaction.
INSERT INTO board_rule_runs (rule_id, task_id, trigger_kind, ok, sched_key)
VALUES (sqlc.arg('rule_id'), sqlc.arg('task_id'), sqlc.arg('trigger_kind'), true, sqlc.arg('sched_key'))
ON CONFLICT (rule_id, task_id, sched_key) WHERE sched_key IS NOT NULL DO NOTHING;

-- name: FinishScheduledRuleRun :exec
UPDATE board_rule_runs SET ok = sqlc.arg('ok'), error = sqlc.arg('error'), actions_applied = sqlc.arg('actions_applied')
WHERE rule_id = sqlc.arg('rule_id') AND task_id = sqlc.arg('task_id') AND sched_key = sqlc.arg('sched_key');

-- name: ListRuleRuns :many
SELECT * FROM board_rule_runs WHERE rule_id = $1 ORDER BY created_at DESC, id DESC LIMIT sqlc.arg('lim');

-- name: TrimRuleRuns :execrows
-- The sweeper: runs older than 90 days and all but the newest 100 of each rule.
DELETE FROM board_rule_runs WHERE id IN (
    SELECT x.id FROM (
        SELECT id, created_at, row_number() OVER (PARTITION BY rule_id ORDER BY created_at DESC, id DESC) AS n
        FROM board_rule_runs
    ) x WHERE x.n > 100 OR x.created_at < now() - interval '90 days'
    LIMIT 5000
);

-- name: ListScheduledRules :many
-- Enabled scheduled rules of live boards (board_rules_scheduled_idx).
SELECT r.* FROM board_rules r JOIN boards b ON b.id = r.board_id AND b.archived_at IS NULL
WHERE r.enabled AND r.trigger_kind IN ('due_in', 'overdue', 'stale')
ORDER BY r.board_id, r.position;

-- ---- Git ----

-- name: GetBoardGit :one
SELECT * FROM board_git WHERE board_id = $1;

-- name: UpsertBoardGit :one
INSERT INTO board_git (board_id, provider, secret_enc, created_by)
VALUES (sqlc.arg('board_id'), sqlc.arg('provider'), sqlc.arg('secret_enc'), sqlc.narg('created_by'))
ON CONFLICT (board_id) DO UPDATE SET provider = excluded.provider, secret_enc = excluded.secret_enc,
    created_by = excluded.created_by, created_at = now(), last_error = '', events_count = 0, last_event_at = NULL
RETURNING *;

-- name: DeleteBoardGit :execrows
DELETE FROM board_git WHERE board_id = $1;

-- name: RecordBoardGitEvent :exec
UPDATE board_git SET last_event_at = now(), events_count = events_count + 1, last_error = sqlc.arg('last_error')
WHERE board_id = sqlc.arg('board_id');

-- name: ListTaskGitLinks :many
SELECT * FROM task_git_links WHERE task_id = $1 ORDER BY updated_at DESC, id DESC;

-- name: GetTaskGitLink :one
SELECT * FROM task_git_links
WHERE task_id = $1 AND kind = $2 AND provider = $3 AND repo = $4 AND ref = $5;

-- name: UpsertTaskGitLink :one
-- merge_shas: an event without them (an edit) keeps the stored ones.
INSERT INTO task_git_links (task_id, kind, provider, repo, ref, title, url, state, author, draft, seen, merge_shas)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, sqlc.arg('draft'), coalesce(sqlc.arg('seen')::text[], '{}'),
    coalesce(sqlc.arg('merge_shas')::text[], '{}'))
ON CONFLICT (task_id, kind, provider, repo, ref) DO UPDATE SET title = excluded.title, url = excluded.url,
    state = excluded.state, author = CASE WHEN excluded.author = '' THEN task_git_links.author ELSE excluded.author END,
    draft = excluded.draft, seen = excluded.seen,
    merge_shas = CASE WHEN cardinality(excluded.merge_shas) > 0 THEN excluded.merge_shas ELSE task_git_links.merge_shas END,
    updated_at = now()
RETURNING *;

-- name: UpdateBoardGitBacklink :one
-- PATCH /api/boards/{id}/git: unset arguments keep the stored value; a new token or address
-- clears the last backlink error. The token is bound to its address: a changed address without
-- a new token forgets the stored one (it never follows the board to another host).
UPDATE board_git SET backlink = coalesce(sqlc.narg('backlink'), backlink),
    api_token_enc = CASE WHEN sqlc.arg('set_token')::boolean THEN sqlc.narg('api_token_enc')
        WHEN sqlc.narg('gitlab_url')::text IS NOT NULL AND sqlc.narg('gitlab_url')::text <> gitlab_url THEN NULL
        ELSE api_token_enc END,
    gitlab_url = coalesce(sqlc.narg('gitlab_url'), gitlab_url),
    backlink_error = CASE WHEN sqlc.arg('set_token')::boolean OR sqlc.narg('gitlab_url') IS NOT NULL THEN '' ELSE backlink_error END
WHERE board_id = sqlc.arg('board_id')
RETURNING *;

-- name: SetBoardGitBacklinkError :exec
UPDATE board_git SET backlink_error = sqlc.arg('backlink_error')
WHERE board_id = sqlc.arg('board_id') AND backlink_error <> sqlc.arg('backlink_error');

-- ---- Releases (board task #101) ----

-- name: UpsertBoardRelease :one
-- A repeat of (board, environment, sha) updates name and url; created = a new row.
INSERT INTO board_releases (board_id, environment, sha, name, url, created_by)
VALUES (sqlc.arg('board_id'), sqlc.arg('environment'), sqlc.arg('sha'), sqlc.arg('name'), sqlc.arg('url'), sqlc.narg('created_by'))
ON CONFLICT (board_id, environment, sha) DO UPDATE SET name = excluded.name, url = excluded.url, updated_at = now()
RETURNING board_releases.*, (xmax = 0)::boolean AS created;

-- name: ReleaseTasksByCommits :many
-- Live tasks of the board linked to a commit of shas, or to a pull request whose merge / squash /
-- head commit is one of them, not yet in a release of the environment; by number, at most lim.
-- One index probe per SHA (migration 00139): LATERAL keeps the plan off a walk of every link of
-- the board compared with the whole list (`&&` / `= ANY` with 5000 SHAs: seconds).
SELECT t.id, t.number FROM tasks t
WHERE t.board_id = sqlc.arg('board_id') AND t.archived_at IS NULL
  AND t.id IN (
    SELECT x.task_id FROM unnest(sqlc.arg('shas')::text[]) s(sha) CROSS JOIN LATERAL (
      SELECT l.task_id FROM task_git_links l WHERE l.kind = 'commit' AND l.ref = s.sha
      UNION ALL
      SELECT l.task_id FROM task_git_links l WHERE l.kind = 'pr' AND l.merge_shas @> ARRAY[s.sha]) x)
  AND NOT EXISTS (SELECT 1 FROM task_releases r WHERE r.task_id = t.id AND r.environment = sqlc.arg('environment'))
ORDER BY t.number
LIMIT sqlc.arg('lim');

-- name: BoardReleaseEnvironments :many
SELECT DISTINCT environment FROM board_releases WHERE board_id = $1;

-- name: LiveTasksByNumbers :many
-- released: the task is already in a release of the environment.
SELECT t.id, t.number,
    EXISTS (SELECT 1 FROM task_releases r WHERE r.task_id = t.id AND r.environment = sqlc.arg('environment'))::boolean AS released
FROM tasks t
WHERE t.board_id = sqlc.arg('board_id') AND t.number = ANY(sqlc.arg('numbers')::int[]) AND t.archived_at IS NULL;

-- name: AddTaskRelease :execrows
INSERT INTO task_releases (task_id, environment, release_id) VALUES ($1, $2, $3)
ON CONFLICT (task_id, environment) DO NOTHING;

-- name: CountReleaseTasks :exec
UPDATE board_releases SET tasks_count = (SELECT count(*) FROM task_releases r WHERE r.release_id = board_releases.id)
WHERE id = $1;

-- name: GetBoardRelease :one
SELECT * FROM board_releases WHERE id = $1;

-- name: ListBoardReleases :many
SELECT * FROM board_releases
WHERE board_id = sqlc.arg('board_id') AND (sqlc.arg('environment')::text = '' OR environment = sqlc.arg('environment'))
ORDER BY created_at DESC, id DESC
LIMIT sqlc.arg('lim');

-- name: ListTaskReleases :many
SELECT tr.task_id, tr.release_id, tr.environment, tr.created_at, r.name, r.url
FROM task_releases tr JOIN board_releases r ON r.id = tr.release_id
WHERE tr.task_id = ANY(sqlc.arg('task_ids')::uuid[])
ORDER BY tr.task_id, tr.created_at DESC, tr.environment;

-- name: TrimTaskGitLinks :execrows
-- ≤ 50 links per task: the oldest commits go first, then the oldest others.
DELETE FROM task_git_links d WHERE d.id IN (
    SELECT o.id FROM task_git_links o WHERE o.task_id = sqlc.arg('task_id')::uuid
    ORDER BY (o.kind = 'commit') DESC, o.updated_at, o.id
    LIMIT greatest((SELECT count(*) FROM task_git_links c WHERE c.task_id = sqlc.arg('task_id')::uuid) - 50, 0)
);

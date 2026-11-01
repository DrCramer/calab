-- Board releases and the GitLab backlink (board task #101, ADR-0060 §4).
--
-- board_releases         a deploy of a board's repository posted by CI (POST /api/boards/{id}/releases):
--                        one row per (board, environment, sha); a repeat updates name / url.
-- task_releases          the release of an environment a task entered: once per (task, environment).
-- task_git_links.merge_shas  the merge, squash and head commits of a merge request (matched against
--                        the commits of a release).
-- board_git.backlink, api_token_enc, gitlab_url, backlink_error
--                        the optional note «Задача Calab: KEY — title url» on a newly linked merge
--                        request (GitLab): the switch (off), the sealed token, its GitLab origin and
--                        why the last note failed.
--
-- Safe on a populated database: two new, empty tables (their indexes too); the other tables only
-- get columns with constant defaults or nullable ones (metadata only, no rewrite, no scan).

-- +goose Up
SET LOCAL lock_timeout = '10s';

CREATE TABLE board_releases (
    id          uuid PRIMARY KEY DEFAULT uuidv7(),
    board_id    uuid NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
    environment text NOT NULL CHECK (environment ~ '^[a-z0-9][a-z0-9._-]{0,31}$'),
    sha         text NOT NULL CHECK (sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
    name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 64),
    url         text NOT NULL DEFAULT '' CHECK (char_length(url) <= 2048),
    created_by  uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    tasks_count integer NOT NULL DEFAULT 0,
    UNIQUE (board_id, environment, sha)
);
CREATE INDEX board_releases_board_idx ON board_releases (board_id, created_at DESC);
CREATE INDEX board_releases_created_by_idx ON board_releases (created_by) WHERE created_by IS NOT NULL;

CREATE TABLE task_releases (
    task_id     uuid NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    environment text NOT NULL,
    release_id  uuid NOT NULL REFERENCES board_releases (id) ON DELETE CASCADE,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (task_id, environment)
);
CREATE INDEX task_releases_release_idx ON task_releases (release_id);

ALTER TABLE task_git_links ADD COLUMN merge_shas text[] NOT NULL DEFAULT '{}';

ALTER TABLE board_git ADD COLUMN backlink boolean NOT NULL DEFAULT false;
ALTER TABLE board_git ADD COLUMN api_token_enc bytea;
ALTER TABLE board_git ADD COLUMN gitlab_url text NOT NULL DEFAULT '';
ALTER TABLE board_git ADD COLUMN backlink_error text NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE board_git DROP COLUMN backlink_error;
ALTER TABLE board_git DROP COLUMN gitlab_url;
ALTER TABLE board_git DROP COLUMN api_token_enc;
ALTER TABLE board_git DROP COLUMN backlink;
ALTER TABLE task_git_links DROP COLUMN merge_shas;
DROP TABLE task_releases;
DROP TABLE board_releases;

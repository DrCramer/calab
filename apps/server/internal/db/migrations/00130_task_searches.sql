-- Saved task searches (ADR-0139): a person's named task filters in a workspace, shown in the
-- left panel of the boards next to «Мои задачи».
--
-- task_searches  query: TaskSearchQuery in protojson (q, state, filter, sort) — stored, not run:
--                the search checks access every time. ≤ 50 per person and workspace (the API).
--                The rows of a person who left stay until they come back or the workspace is
--                deleted: every route checks the membership first.

-- +goose Up
CREATE TABLE task_searches (
    id           uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
    query        jsonb NOT NULL DEFAULT '{}',
    position     integer NOT NULL DEFAULT 0,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX task_searches_owner_idx ON task_searches (workspace_id, user_id, position);

-- +goose Down
DROP TABLE task_searches;

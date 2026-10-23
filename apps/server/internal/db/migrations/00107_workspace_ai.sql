-- AI integration of a workspace (CBF-60, ai.proto): the active language model provider.
--
-- workspace_ai  one row per workspace. provider 'gptunnel' (base URL from GPTUNNEL_AI_URL, base_url
--               stays '') or 'openai' (any OpenAI-compatible API at base_url). key_enc is the API
--               key sealed with sealbox ("calaba/workspace-ai-key/v1", from JWT_SECRET, like the
--               SIP password); key_hint is its last 4 characters for the mask. Never returned.

-- +goose Up
CREATE TABLE workspace_ai (
    workspace_id uuid PRIMARY KEY REFERENCES workspaces (id) ON DELETE CASCADE,
    provider     text NOT NULL CHECK (provider IN ('gptunnel', 'openai')),
    base_url     text NOT NULL DEFAULT '' CHECK (char_length(base_url) <= 500),
    model        text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 128),
    key_enc      bytea,
    key_hint     text NOT NULL DEFAULT '' CHECK (char_length(key_hint) <= 4),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    updated_by   uuid REFERENCES users (id) ON DELETE SET NULL
);
CREATE INDEX workspace_ai_updated_by_idx ON workspace_ai (updated_by) WHERE updated_by IS NOT NULL;

-- +goose Down
DROP TABLE workspace_ai;

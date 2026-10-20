-- Screen-share enum is persisted as text in workspace defaults and room overrides.
-- +goose Up
ALTER TABLE workspaces DROP CONSTRAINT workspaces_default_max_stream_preset_check;
ALTER TABLE workspaces ADD CONSTRAINT workspaces_default_max_stream_preset_check
    CHECK (default_max_stream_preset IN (
        'economy', 'h720', 'h1080', 'original', 'h720_30', 'h1080_30', 'h1080_60',
        'h1440_30', 'h1440_60', 'h2160_30', 'h2160_60', 'original_60'
    ));

ALTER TABLE rooms DROP CONSTRAINT rooms_max_stream_preset_check;
ALTER TABLE rooms ADD CONSTRAINT rooms_max_stream_preset_check
    CHECK (max_stream_preset IS NULL OR max_stream_preset IN (
        'economy', 'h720', 'h1080', 'original', 'h720_30', 'h1080_30', 'h1080_60',
        'h1440_30', 'h1440_60', 'h2160_30', 'h2160_60', 'original_60'
    ));

-- +goose Down
ALTER TABLE rooms DROP CONSTRAINT rooms_max_stream_preset_check;
ALTER TABLE rooms ADD CONSTRAINT rooms_max_stream_preset_check
    CHECK (max_stream_preset IS NULL OR max_stream_preset IN ('economy', 'h720', 'h1080', 'original'));

ALTER TABLE workspaces DROP CONSTRAINT workspaces_default_max_stream_preset_check;
ALTER TABLE workspaces ADD CONSTRAINT workspaces_default_max_stream_preset_check
    CHECK (default_max_stream_preset IN ('economy', 'h720', 'h1080', 'original'));

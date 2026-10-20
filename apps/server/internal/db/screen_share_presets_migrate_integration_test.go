//go:build integration

package db

import (
	"context"
	"strings"
	"testing"
)

// TestSelfHostMigrationHistoryUpgradesPastPresetVersion verifies that an installation which
// recorded its screen-share preset migration as 00102 still receives the upstream 00102 billing
// change and can then reapply the expanded preset constraints.
func TestSelfHostMigrationHistoryUpgradesPastPresetVersion(t *testing.T) {
	ctx := context.Background()
	d, err := Connect(ctx, newTestDatabase(t))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	if err := d.MigrateTo(ctx, 101); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`ALTER TABLE workspaces DROP CONSTRAINT workspaces_default_max_stream_preset_check`,
		`ALTER TABLE workspaces ADD CONSTRAINT workspaces_default_max_stream_preset_check CHECK (default_max_stream_preset IN ('economy', 'h720', 'h1080', 'original', 'h720_30', 'h1080_30', 'h1080_60', 'h1440_30', 'h1440_60', 'h2160_30', 'h2160_60', 'original_60'))`,
		`ALTER TABLE rooms DROP CONSTRAINT rooms_max_stream_preset_check`,
		`ALTER TABLE rooms ADD CONSTRAINT rooms_max_stream_preset_check CHECK (max_stream_preset IS NULL OR max_stream_preset IN ('economy', 'h720', 'h1080', 'original', 'h720_30', 'h1080_30', 'h1080_60', 'h1440_30', 'h1440_60', 'h2160_30', 'h2160_60', 'original_60'))`,
		`INSERT INTO goose_db_version (version_id, is_applied) VALUES (102, true)`,
	} {
		if _, err := d.Pool.Exec(ctx, statement); err != nil {
			t.Fatalf("%s: %v", statement, err)
		}
	}

	if err := d.MigrateTo(ctx, 107); err != nil {
		t.Fatalf("upgrade old self-host migration history: %v", err)
	}
	for _, index := range []string{"billing_checkouts_open_idx", "billing_autotopup_attempts_one_open_idx"} {
		var exists bool
		if err := d.Pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1)`, index).Scan(&exists); err != nil || !exists {
			t.Errorf("compatibility migration did not create %s: exists=%v err=%v", index, exists, err)
		}
	}
	if err := d.MigrateTo(ctx, 108); err != nil {
		t.Fatalf("reapply expanded preset constraints: %v", err)
	}
	for _, constraint := range []string{"workspaces_default_max_stream_preset_check", "rooms_max_stream_preset_check"} {
		var definition string
		if err := d.Pool.QueryRow(ctx, `SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = $1`, constraint).Scan(&definition); err != nil {
			t.Fatalf("read %s: %v", constraint, err)
		}
		if !strings.Contains(definition, "h2160_60") {
			t.Errorf("%s does not permit expanded presets: %s", constraint, definition)
		}
	}
}

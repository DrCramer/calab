//go:build integration

package db

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

// TestCanvasMigration: 00102 (ADR-0107) adds CANVAS_VIEW | CANVAS_WRITE to the member roles that
// exist, nothing to the others, and for new workspaces through the trigger; going down removes
// the bits and the tables again (bits 41-43 from every role), and up works once more.
func TestCanvasMigration(t *testing.T) {
	ctx := context.Background()
	d, err := Connect(ctx, newTestDatabase(t))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	must := func(sql string, args ...any) {
		t.Helper()
		if _, err := d.Pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
	}
	perms := func(ws uuid.UUID, builtin string) int64 {
		t.Helper()
		var p int64
		if err := d.Pool.QueryRow(ctx, `SELECT permissions FROM workspace_roles WHERE workspace_id = $1 AND builtin = $2`, ws, builtin).Scan(&p); err != nil {
			t.Fatal(err)
		}
		return p
	}
	if err := d.MigrateTo(ctx, 101); err != nil {
		t.Fatal(err)
	}
	owner, ws := uuid.New(), uuid.New()
	must(`INSERT INTO users (id, email, display_name) VALUES ($1, 'canvas-mig@example.com', 'o')`, owner)
	must(`INSERT INTO workspaces (id, slug, name, owner_id) VALUES ($1, 'canvas-mig', 'W', $2)`, ws, owner)
	// A custom role holding CANVAS_MANAGE's bit by hand: going down clears it too.
	must(`INSERT INTO workspace_roles (workspace_id, name, position, permissions) VALUES ($1, 'x', 5, $2)`, ws, int64(1)|int64(1)<<43)
	memberBefore := perms(ws, "member")

	if err := d.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	if got := perms(ws, "member"); got != memberBefore|3<<41 {
		t.Fatalf("member role %d → %d, want the canvas bits added", memberBefore, got)
	}
	if got := perms(ws, "admin"); got != 1024 {
		t.Fatalf("admin role changed: %d", got)
	}
	if got := perms(ws, "guest"); got != 48 {
		t.Fatalf("guest role changed: %d", got)
	}
	ws2 := uuid.New()
	must(`INSERT INTO workspaces (id, slug, name, owner_id) VALUES ($1, 'canvas-mig2', 'W', $2)`, ws2, owner)
	if got := perms(ws2, "member"); got != memberBefore|3<<41 {
		t.Fatalf("new workspace member role %d, want %d", got, memberBefore|3<<41)
	}

	p, err := newProvider(d)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.DownTo(ctx, 101); err != nil {
		t.Fatalf("down: %v", err)
	}
	if got := perms(ws, "member"); got != memberBefore {
		t.Fatalf("member role after down: %d, want %d", got, memberBefore)
	}
	var custom int64
	if err := d.Pool.QueryRow(ctx, `SELECT permissions FROM workspace_roles WHERE workspace_id = $1 AND name = 'x'`, ws).Scan(&custom); err != nil || custom != 1 {
		t.Fatalf("custom role after down: %d %v", custom, err)
	}
	var tables int
	if err := d.Pool.QueryRow(ctx, `SELECT count(*) FROM information_schema.tables WHERE table_name LIKE 'canvas\_%'`).Scan(&tables); err != nil || tables != 0 {
		t.Fatalf("canvas tables after down: %d %v", tables, err)
	}
	ws3 := uuid.New()
	must(`INSERT INTO workspaces (id, slug, name, owner_id) VALUES ($1, 'canvas-mig3', 'W', $2)`, ws3, owner)
	if got := perms(ws3, "member"); got != memberBefore {
		t.Fatalf("new workspace member role after down: %d, want %d", got, memberBefore)
	}
	if err := d.Migrate(ctx); err != nil {
		t.Fatalf("up again: %v", err)
	}
}

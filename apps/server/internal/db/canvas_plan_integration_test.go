//go:build integration

package db_test

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/calaba/calaba/server/internal/db/dbtest"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// explainGeneric runs a query the way the server does (pgx prepares it: run is a call of the
// generated method on conn), then explains that same prepared statement with the generic plan
// Postgres switches to after five executions.
func explainGeneric(ctx context.Context, t *testing.T, conn *pgxpool.Conn, name string, run func(q *sqlc.Queries) error, args string) string {
	t.Helper()
	if err := run(sqlc.New(conn)); err != nil {
		t.Fatal(err)
	}
	var stmt string
	if err := conn.QueryRow(ctx, `SELECT name FROM pg_prepared_statements WHERE statement LIKE $1`, "-- name: "+name+" %").Scan(&stmt); err != nil {
		t.Fatalf("%s is not prepared: %v", name, err)
	}
	if _, err := conn.Exec(ctx, `SET plan_cache_mode = force_generic_plan`); err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = conn.Exec(ctx, `RESET plan_cache_mode`) }()
	rows, err := conn.Query(ctx, fmt.Sprintf(`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF) EXECUTE %q(%s)`, stmt, args))
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var plan []string
	for rows.Next() {
		var line string
		if err := rows.Scan(&line); err != nil {
			t.Fatal(err)
		}
		plan = append(plan, line)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return strings.Join(plan, "\n")
}

// Second review, minor 13: a page of one level of the tree reads that level only, from its cursor
// on, also in the generic plan of the prepared statement (a workspace of 20 000 items: 200 folders
// of 99 canvases and a few canvases on the top level; the folder's page starts at position 50).
func TestCanvasChildrenPlan(t *testing.T) {
	ctx := context.Background()
	d := dbtest.Connect(t)
	user, ws := canvasSeed(ctx, t, d)
	if _, err := d.Pool.Exec(ctx, `
		WITH f AS (
			INSERT INTO canvas_items (workspace_id, kind, name, owner_id, position)
			SELECT $1, 'folder', 'F' || i, $2, i FROM generate_series(0, 199) i RETURNING id)
		INSERT INTO canvas_items (workspace_id, parent_id, kind, name, owner_id, position)
		SELECT $1, f.id, 'canvas', 'C' || j, $2, j FROM f, generate_series(0, 98) j`, ws, user); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Pool.Exec(ctx, `
		INSERT INTO canvas_items (workspace_id, kind, name, owner_id, position)
		SELECT $1, 'canvas', 'Top' || i, $2, 200 + i FROM generate_series(0, 4) i`, ws, user); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Pool.Exec(ctx, `ANALYZE canvas_items`); err != nil {
		t.Fatal(err)
	}
	var folder uuid.UUID
	if err := d.Pool.QueryRow(ctx, `SELECT id FROM canvas_items WHERE workspace_id = $1 AND name = 'F7'`, ws).Scan(&folder); err != nil {
		t.Fatal(err)
	}
	conn, err := d.Pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()

	root := explainGeneric(ctx, t, conn, "ListCanvasRootChildren", func(q *sqlc.Queries) error {
		_, err := q.ListCanvasRootChildren(ctx, sqlc.ListCanvasRootChildrenParams{WorkspaceID: ws, Lim: 100})
		return err
	}, fmt.Sprintf("'%s'::uuid, 0, '%s'::uuid, 100", ws, uuid.Nil))
	sub := explainGeneric(ctx, t, conn, "ListCanvasFolderChildren", func(q *sqlc.Queries) error {
		_, err := q.ListCanvasFolderChildren(ctx, sqlc.ListCanvasFolderChildrenParams{WorkspaceID: ws, ParentID: folder, Lim: 100})
		return err
	}, fmt.Sprintf("'%s'::uuid, '%s'::uuid, 50, '%s'::uuid, 100", ws, folder, uuid.Nil))
	t.Logf("top level, generic plan:\n%s", root)
	t.Logf("a folder, generic plan:\n%s", sub)
	// Each page is read through the tree index from its level and its cursor on: nothing of another
	// level, nothing before the cursor filtered out (the index has id: the keyset is its condition).
	for name, plan := range map[string]string{"top level": root, "folder": sub} {
		main := plan[:strings.Index(plan, "SubPlan")]
		if !strings.Contains(main, "Index Scan using canvas_items_tree_idx on canvas_items") || !strings.Contains(main, "parent_id") ||
			!strings.Contains(main, `ROW("position", id) > ROW($`) || strings.Contains(main, "Rows Removed by Filter") || strings.Contains(main, "BitmapOr") {
			t.Fatalf("%s: not a scan of its level from the cursor:\n%s", name, plan)
		}
	}
}

//go:build integration

package canvas

import (
	"bytes"
	"context"
	"fmt"
	"strings"
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/ysync"
)

// Second review, minor 3: a workspace whose purge fails does not stop the purge of the next ones
// (it is named in the error and tried again next run), and the roots go a few per transaction so
// that the workspace's tree lock is free between them (each transaction has its own now(): the
// journal's delete entries show how many there were).
func TestCanvasTrashSweepPerWorkspace(t *testing.T) {
	ctx := context.Background()
	fail, ok := newEnv(t, ysync.Config{}), newEnv(t, ysync.Config{})
	if bytes.Compare(ok.ws[:], fail.ws[:]) < 0 {
		fail, ok = ok, fail // the failing workspace is swept first (ListCanvasSweepWorkspaces orders by id)
	}
	expire := func(e *env, n int, prefix string) []string {
		e.must(200, e.admin, "PUT", "/api/workspaces/"+e.ws.String()+"/canvas/settings", &v1.CanvasSettings{TrashDays: 1}, nil)
		ids := make([]string, n)
		for i := range ids {
			it := e.create(e.alice, "", fmt.Sprintf("%s %d", prefix, i))
			e.must(200, e.alice, "POST", item(it.GetId())+"/trash", nil, nil)
			ids[i] = it.GetId()
		}
		if _, err := e.d.Pool.Exec(ctx, `UPDATE canvas_items SET trashed_at = now() - interval '2 days' WHERE id = ANY($1::uuid[])`, ids); err != nil {
			t.Fatal(err)
		}
		return ids
	}
	broken := expire(fail, 1, "Broken")[0]
	const roots = 2*sweepBatch + 2
	gone := expire(ok, roots, "Old")
	// The delete of the broken root fails in the database.
	for _, sql := range []string{
		`CREATE FUNCTION canvas_sweep_test_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused by the test'; END $$`,
		fmt.Sprintf(`CREATE TRIGGER canvas_sweep_test_refuse BEFORE DELETE ON canvas_items FOR EACH ROW WHEN (OLD.id = '%s') EXECUTE FUNCTION canvas_sweep_test_refuse()`, broken),
	} {
		if _, err := ok.d.Pool.Exec(ctx, sql); err != nil {
			t.Fatal(err)
		}
	}
	dropped := false
	drop := func() {
		if dropped {
			return
		}
		dropped = true
		if _, err := ok.d.Pool.Exec(ctx, `DROP TRIGGER canvas_sweep_test_refuse ON canvas_items; DROP FUNCTION canvas_sweep_test_refuse()`); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(drop)

	n, err := ok.svc.TrashSweep(ctx)
	if n != roots || err == nil || !strings.Contains(err.Error(), fail.ws.String()) {
		t.Fatalf("sweep: %d %v, want %d and an error naming %s", n, err, roots, fail.ws)
	}
	var left, txs int
	if err := ok.d.Pool.QueryRow(ctx, `SELECT count(*) FROM canvas_items WHERE id = ANY($1::uuid[])`, gone).Scan(&left); err != nil || left != 0 {
		t.Fatalf("left %d of the other workspace's roots (%v)", left, err)
	}
	if err := ok.d.Pool.QueryRow(ctx, `SELECT count(DISTINCT created_at) FROM canvas_activity WHERE workspace_id = $1 AND kind = 'delete'`, ok.ws).Scan(&txs); err != nil || txs != 3 {
		t.Fatalf("%d roots deleted in %d transactions (%v), want 3 of ≤ %d", roots, txs, err, sweepBatch)
	}
	fail.must(200, fail.alice, "GET", item(broken), nil, nil)
	// Repaired: the next run takes it.
	drop()
	if n, err := ok.svc.TrashSweep(ctx); n != 1 || err != nil {
		t.Fatalf("second sweep: %d %v", n, err)
	}
	fail.must(404, fail.alice, "GET", item(broken), nil, nil)
}

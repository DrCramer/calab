//go:build integration

package canvas

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/ysync"
)

// A move, a trash and a restore in a folder of 50 write the one row they touch: the siblings keep
// their positions (no renumbering), and the order stays right. Repeated moves into one gap spread
// the level once it runs out.
func TestCanvasSparsePositions(t *testing.T) {
	e := newEnv(t, ysync.Config{})
	ctx := context.Background()
	f := e.mkdir(e.alice, "", "F")
	var names []string
	ids := map[string]string{}
	for i := range 50 {
		n := fmt.Sprintf("n%02d", i)
		ids[n] = e.create(e.alice, f.GetId(), n).GetId()
		names = append(names, n)
	}
	query := "parent=" + f.GetId() + "&limit=100"
	order := func(want []string) {
		t.Helper()
		if got := strings.Join(e.names(e.alice, query), ","); got != strings.Join(want, ",") {
			t.Fatalf("order %q, want %q", got, strings.Join(want, ","))
		}
	}
	// written: how many rows of the folder got a new version since the last call.
	versions := map[string]string{}
	written := func() int {
		t.Helper()
		rows, err := e.d.Pool.Query(ctx, `SELECT id::text, xmin::text FROM canvas_items WHERE parent_id = $1`, f.GetId())
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		n := 0
		for rows.Next() {
			var id, x string
			if err := rows.Scan(&id, &x); err != nil {
				t.Fatal(err)
			}
			if versions[id] != x {
				n++
			}
			versions[id] = x
		}
		return n
	}
	written()
	move := func(n string, at int32) {
		t.Helper()
		e.must(200, e.alice, "PATCH", item(ids[n]), &v1.UpdateCanvasItemRequest{Position: proto.Int32(at)}, nil)
		i := indexOf(names, n)
		names = append(names[:i], names[i+1:]...)
		names = append(names[:at], append([]string{n}, names[at:]...)...)
	}
	move("n49", 10)
	if w := written(); w != 1 {
		t.Fatalf("a move wrote %d rows, want 1", w)
	}
	order(names)
	move("n00", 49)
	move("n20", 0)
	if w := written(); w != 2 {
		t.Fatalf("two moves wrote %d rows, want 2", w)
	}
	order(names)
	e.must(200, e.alice, "POST", item(ids["n05"])+"/trash", nil, nil)
	if w := written(); w != 1 {
		t.Fatalf("a trash wrote %d rows, want 1", w)
	}
	trashed := indexOf(names, "n05")
	order(append(append([]string{}, names[:trashed]...), names[trashed+1:]...))
	e.must(200, e.alice, "POST", item(ids["n05"])+"/restore", nil, nil)
	if w := written(); w != 1 {
		t.Fatalf("a restore wrote %d rows, want 1", w)
	}
	names = append(append(names[:trashed], names[trashed+1:]...), "n05") // back last
	order(names)
	// Out of the folder and back: the folder's rows stay as they are.
	e.must(200, e.alice, "PATCH", item(ids["n30"]), &v1.UpdateCanvasItemRequest{ParentId: proto.String("")}, nil)
	if w := written(); w != 0 {
		t.Fatalf("a move out rewrote %d siblings", w)
	}
	e.must(200, e.alice, "PATCH", item(ids["n30"]), &v1.UpdateCanvasItemRequest{ParentId: proto.String(f.GetId()), Position: proto.Int32(1)}, nil)
	i := indexOf(names, "n30")
	names = append(names[:i], names[i+1:]...)
	names = append(names[:1], append([]string{"n30"}, names[1:]...)...)
	order(names)
	// Twenty moves into the same gap: the order holds when the gap runs out and the level spreads.
	for k := range 20 {
		n := names[len(names)-1-k%2]
		move(n, 3)
		order(names)
	}
}

func indexOf(s []string, v string) int {
	for i, x := range s {
		if x == v {
			return i
		}
	}
	return -1
}

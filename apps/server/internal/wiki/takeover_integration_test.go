//go:build integration

package wiki

import (
	"context"
	"slices"
	"testing"

	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
)

// «Владелец видит приватное» and «Сделать меня владельцем» for the Wiki (addendum 2026-10-14):
// a member's private page stays hidden from the owner with the setting off; with it on the owner
// sees it with every bit, takes it over once its creator left (409 while they are a member), and
// trashes / empties / deletes it. The admin gets nothing from the setting.
func TestWikiOwnerSeesPrivateTakeOver(t *testing.T) {
	e := newEnv(t, SyncConfig{})
	ctx := context.Background()
	ws := "/api/workspaces/" + e.ws.String()
	secret := e.create(e.alice, "", "Secret")
	e.must(200, e.alice, "PUT", page(secret.GetId())+"/permissions", &v1.UpdateWikiPermissionsRequest{Restricted: proto.Bool(true)}, nil)
	sub := e.create(e.alice, secret.GetId(), "Inner")
	seesPrivate := func(on bool) {
		t.Helper()
		if _, err := e.d.Pool.Exec(ctx, `UPDATE workspaces SET owner_sees_private = $2 WHERE id = $1`, e.ws, on); err != nil {
			t.Fatal(err)
		}
	}
	e.must(404, e.owner, "GET", page(secret.GetId()), nil, nil)
	e.must(404, e.owner, "POST", page(secret.GetId())+"/take-over", nil, nil)
	seesPrivate(true)
	var got v1.WikiPageResponse
	e.must(200, e.owner, "GET", page(sub.GetId()), nil, &got)
	if got.GetPage().GetMyBits() != uint64(perm.Wiki) {
		t.Fatalf("owner's bits %b", got.GetPage().GetMyBits())
	}
	if l := e.titles(e.owner, ""); !slices.Contains(l, "Secret") {
		t.Fatalf("owner lists %v", l)
	}
	e.must(404, e.admin, "GET", page(secret.GetId()), nil, nil)
	e.must(409, e.owner, "POST", page(secret.GetId())+"/take-over", nil, nil)
	e.must(403, e.alice, "POST", page(secret.GetId())+"/take-over", nil, nil)
	if _, err := e.d.Pool.Exec(ctx, `DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`, e.ws, e.alice); err != nil {
		t.Fatal(err)
	}
	seesPrivate(false)
	e.must(404, e.owner, "GET", page(secret.GetId()), nil, nil)
	seesPrivate(true)
	var took v1.WikiPageResponse
	e.must(200, e.owner, "POST", page(secret.GetId())+"/take-over", nil, &took)
	if took.GetPage().GetOwnerId() != e.owner.String() {
		t.Fatalf("took over: %v", &took)
	}
	var n int
	if err := e.d.Pool.QueryRow(ctx, `SELECT count(*) FROM workspace_audit WHERE workspace_id = $1 AND kind = 'take_over'
		AND subject_type = 'wiki_page' AND subject_id = $2 AND previous_owner_id = $3`, e.ws, secret.GetId(), e.alice).Scan(&n); err != nil || n != 1 {
		t.Fatalf("audit rows %d %v", n, err)
	}
	// The subpage (still alice's) can be taken over as well: it is inside a private subtree.
	e.must(200, e.owner, "POST", page(sub.GetId())+"/take-over", nil, nil)
	seesPrivate(false)
	e.must(200, e.owner, "GET", page(secret.GetId()), nil, nil) // now the owner's own
	seesPrivate(true)
	e.must(200, e.owner, "POST", page(secret.GetId())+"/trash", nil, nil)
	var emptied v1.EmptyWikiTrashResponse
	e.must(200, e.owner, "POST", ws+"/wiki/trash/empty", nil, &emptied)
	if emptied.GetDeleted() == 0 {
		t.Fatalf("emptied %v", &emptied)
	}
	e.must(404, e.owner, "GET", page(secret.GetId()), nil, nil)
}

//go:build integration

package wiki

import (
	"testing"
	"time"

	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
)

// The Wiki's socket after its move onto internal/ysync (CBF-70): a change of the page's access
// reaches its live sockets at once (Kick), not at the periodic recheck (an hour here) — restricted
// or a deny of VIEW closes them 4003, a deny of WRITE makes them read-only (the next UPDATE closes
// 4003, nothing is stored), a guest without a grant is refused and one with a VIEW grant reads but
// never writes.
func TestWikiSyncLiveAccessChange(t *testing.T) {
	e := newEnv(t, SyncConfig{RecheckInterval: time.Hour})

	p := e.create(e.alice, "", "Restricted later")
	s := e.dial(e.bob, p.GetId())
	s.next(frameSnapshot)
	e.must(200, e.alice, "PATCH", page(p.GetId()), &v1.UpdateWikiPageRequest{Restricted: proto.Bool(true)}, nil)
	s.closed(closeForbidden)

	p2 := e.create(e.alice, "", "Denied later")
	s2 := e.dial(e.bob, p2.GetId())
	s2.next(frameSnapshot)
	e.must(200, e.alice, "PUT", page(p2.GetId())+"/permissions", &v1.UpdateWikiPermissionsRequest{Entries: []*v1.WikiPermissionEntry{
		{TargetType: user, TargetId: e.bob.String(), Deny: uint64(perm.WikiView)}}}, nil)
	s2.closed(closeForbidden)

	p3 := e.create(e.alice, "", "Read-only later")
	s3 := e.dial(e.bob, p3.GetId())
	s3.next(frameSnapshot)
	e.must(200, e.alice, "PUT", page(p3.GetId())+"/permissions", &v1.UpdateWikiPermissionsRequest{Entries: []*v1.WikiPermissionEntry{
		{TargetType: user, TargetId: e.bob.String(), Allow: uint64(perm.WikiView), Deny: uint64(perm.WikiWrite)}}}, nil)
	// The recheck runs on the socket's own goroutine: an UPDATE sent before it lands is stored
	// (and echoed), the first one after it closes the socket.
	echoed, closed := 0, false
	for deadline := time.Now().Add(3 * time.Second); !closed && time.Now().Before(deadline); {
		s3.send(updateFrame(0, []byte("x")))
		f, code := s3.read()
		if f == nil {
			if code != closeForbidden {
				t.Fatalf("read-only socket closed %d, want %d", code, closeForbidden)
			}
			closed = true
			break
		}
		echoed++
		time.Sleep(50 * time.Millisecond)
	}
	if !closed {
		t.Fatal("a socket that lost WIKI_WRITE can still write")
	}
	if n := countUpdates(t, e, p3.GetId()); n != echoed {
		t.Fatalf("stored %d updates, echoed %d", n, echoed)
	}

	// Guests: nothing without a grant; a VIEW grant reads and may not write.
	g := e.create(e.alice, "", "For the guest")
	e.dial(e.guest, g.GetId()).closed(closeForbidden)
	e.must(200, e.alice, "PUT", page(g.GetId())+"/permissions", &v1.UpdateWikiPermissionsRequest{Entries: []*v1.WikiPermissionEntry{
		{TargetType: user, TargetId: e.guest.String(), Allow: uint64(perm.WikiView)}}}, nil)
	gs := e.dial(e.guest, g.GetId())
	gs.next(frameSnapshot)
	gs.send(updateFrame(0, []byte("guest")))
	gs.closed(closeForbidden)
	if n := countUpdates(t, e, g.GetId()); n != 0 {
		t.Fatalf("a view-only guest stored %d updates", n)
	}
}

func countUpdates(t *testing.T, e *env, pageID string) int {
	t.Helper()
	var n int
	if err := e.d.Pool.QueryRow(t.Context(), `SELECT count(*) FROM wiki_page_updates WHERE page_id = $1`, pageID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

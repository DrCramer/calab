//go:build integration

package canvas

import (
	"testing"
	"time"

	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/ysync"
)

// A change of access on a folder (restricted, overrides, a move into a restricted folder) closes the
// live sockets of the canvases below it at once, not at the next periodic recheck (30 s): the
// socket of a canvas is keyed by the canvas, the folder has none.
func TestCanvasFolderAccessChangeClosesSockets(t *testing.T) {
	e := newEnv(t, ysync.Config{})
	// restricted switch of the folder
	f := e.mkdir(e.alice, "", "Team")
	deep := e.mkdir(e.alice, f.GetId(), "Deep")
	c := e.create(e.alice, deep.GetId(), "Board")
	s := e.dial(e.bob, c.GetId())
	s.next(frameSnapshot)
	e.must(200, e.alice, "PATCH", item(f.GetId()), &v1.UpdateCanvasItemRequest{Restricted: proto.Bool(true)}, nil)
	s.closed(ysync.CloseForbidden)

	// a deny of VIEW in the folder's overrides
	f2 := e.mkdir(e.alice, "", "Team 2")
	c2 := e.create(e.alice, f2.GetId(), "Board 2")
	s2 := e.dial(e.bob, c2.GetId())
	s2.next(frameSnapshot)
	e.must(200, e.alice, "PUT", item(f2.GetId())+"/permissions", &v1.UpdateCanvasPermissionsRequest{Entries: []*v1.CanvasPermissionEntry{
		{TargetType: user, TargetId: e.bob.String(), Deny: uint64(perm.CanvasView)}}}, nil)
	s2.closed(ysync.CloseForbidden)

	// a move of the folder into a restricted one
	priv := e.mkdir(e.alice, "", "Private")
	e.must(200, e.alice, "PATCH", item(priv.GetId()), &v1.UpdateCanvasItemRequest{Restricted: proto.Bool(true)}, nil)
	f3 := e.mkdir(e.alice, "", "Team 3")
	c3 := e.create(e.alice, f3.GetId(), "Board 3")
	s3 := e.dial(e.bob, c3.GetId())
	s3.next(frameSnapshot)
	e.must(200, e.alice, "PATCH", item(f3.GetId()), &v1.UpdateCanvasItemRequest{ParentId: proto.String(priv.GetId())}, nil)
	s3.closed(ysync.CloseForbidden)

	// a deny of WRITE only makes the socket read-only: it stays, its next UPDATE closes it
	f4 := e.mkdir(e.alice, "", "Team 4")
	c4 := e.create(e.alice, f4.GetId(), "Board 4")
	s4 := e.dial(e.bob, c4.GetId())
	s4.next(frameSnapshot)
	e.must(200, e.alice, "PUT", item(f4.GetId())+"/permissions", &v1.UpdateCanvasPermissionsRequest{Entries: []*v1.CanvasPermissionEntry{
		{TargetType: user, TargetId: e.bob.String(), Allow: uint64(perm.CanvasView), Deny: uint64(perm.CanvasWrite)}}}, nil)
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		s4.send(updateFrame(0, []byte("x")))
		if f, _ := s4.read(); f == nil {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("a socket that lost CANVAS_WRITE through its folder can still write")
}

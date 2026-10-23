//go:build integration

package canvas

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/ysync"
)

// The adversarial paths of the second review (CBF-70): ids of another workspace, an editor who
// is not the owner reaching for the structure, the access dialog, the link or the take-over, a
// guest granted WRITE reaching beyond it, a reply threaded under another canvas's comment.
func TestCanvasEscalationAndForeignIDs(t *testing.T) {
	e := newEnv(t, ysync.Config{})
	ctx := context.Background()
	ws := "/api/workspaces/" + e.ws.String()

	// A second workspace where alice is a member too, with a folder and a canvas of hers.
	other := uuid.New()
	e.exec(`INSERT INTO workspaces (id, slug, name, owner_id) VALUES ($1, $2, 'Other', $3)`, other, "cv2-"+other.String()[:12], e.outsider)
	for u, r := range map[uuid.UUID]string{e.outsider: "owner", e.alice: "member"} {
		if _, err := e.d.Q.AddMember(ctx, sqlc.AddMemberParams{WorkspaceID: other, UserID: u, Role: r}); err != nil {
			t.Fatal(err)
		}
	}
	var foreignFolder, foreignCanvas v1.CanvasItemResponse
	e.must(201, e.alice, "POST", "/api/workspaces/"+other.String()+"/canvas/items", &v1.CreateCanvasItemRequest{Kind: folder, Name: "Foreign"}, &foreignFolder)
	e.must(201, e.alice, "POST", "/api/workspaces/"+other.String()+"/canvas/items", &v1.CreateCanvasItemRequest{Kind: board, Name: "Foreign board"}, &foreignCanvas)
	ff, fc := foreignFolder.GetItem().GetId(), foreignCanvas.GetItem().GetId()

	// Cross-workspace: a folder of the other workspace is never a parent here (create, list, move),
	// even for someone who sees it there.
	e.must(404, e.alice, "POST", ws+"/canvas/items", &v1.CreateCanvasItemRequest{ParentId: ff, Kind: board, Name: "x"}, nil)
	e.must(404, e.alice, "GET", ws+"/canvas/items?parent="+ff, nil, nil)
	mine := e.create(e.alice, "", "Mine")
	e.must(404, e.alice, "PATCH", item(mine.GetId()), &v1.UpdateCanvasItemRequest{ParentId: proto.String(ff)}, nil)
	e.must(404, e.alice, "PATCH", item(fc), &v1.UpdateCanvasItemRequest{ParentId: proto.String(e.mkdir(e.alice, "", "Here").GetId())}, nil)
	// A member of this workspace only (bob) does not see the other workspace's items at all.
	e.must(404, e.bob, "GET", item(fc), nil, nil)
	e.must(404, e.bob, "GET", item(fc)+"/comments", nil, nil)
	e.dial(e.bob, fc).closed(ysync.CloseForbidden)
	// An override naming a member of the other workspace only is refused.
	e.must(422, e.alice, "PUT", item(mine.GetId())+"/permissions", &v1.UpdateCanvasPermissionsRequest{Entries: []*v1.CanvasPermissionEntry{
		{TargetType: user, TargetId: e.outsider.String(), Allow: uint64(perm.CanvasView)}}}, nil)
	// …and so is a role of the other workspace.
	var foreignRole uuid.UUID
	if err := e.d.Pool.QueryRow(ctx, `SELECT id FROM workspace_roles WHERE workspace_id = $1 AND builtin = 'member'`, other).Scan(&foreignRole); err != nil {
		t.Fatal(err)
	}
	e.must(422, e.alice, "PUT", item(mine.GetId())+"/permissions", &v1.UpdateCanvasPermissionsRequest{Entries: []*v1.CanvasPermissionEntry{
		{TargetType: role, TargetId: foreignRole.String(), Allow: uint64(perm.CanvasView)}}}, nil)

	// An editor who is not the owner (bob with a personal WRITE on alice's private canvas) edits the
	// content but reaches nothing of the structure: no access dialog (read or write), no link, no
	// rename, no restricted switch, no take-over; his own grant cannot widen itself.
	priv := e.create(e.alice, "", "Private")
	e.must(200, e.alice, "PUT", item(priv.GetId())+"/permissions", &v1.UpdateCanvasPermissionsRequest{Restricted: proto.Bool(true),
		Entries: []*v1.CanvasPermissionEntry{{TargetType: user, TargetId: e.bob.String(), Allow: uint64(perm.CanvasView | perm.CanvasWrite)}}}, nil)
	b := e.dial(e.bob, priv.GetId())
	b.next(frameSnapshot)
	b.send(updateFrame(0, []byte("edit;")))
	b.next(frameUpdate)
	e.must(403, e.bob, "GET", item(priv.GetId())+"/permissions", nil, nil)
	e.must(403, e.bob, "PUT", item(priv.GetId())+"/permissions", &v1.UpdateCanvasPermissionsRequest{Entries: []*v1.CanvasPermissionEntry{
		{TargetType: user, TargetId: e.guest.String(), Allow: uint64(perm.CanvasView)}}}, nil)
	e.must(403, e.bob, "PATCH", item(priv.GetId()), &v1.UpdateCanvasItemRequest{Restricted: proto.Bool(false)}, nil)
	e.must(403, e.bob, "GET", linkPath(priv.GetId()), nil, nil)
	e.must(403, e.bob, "POST", linkPath(priv.GetId()), &v1.CreateCanvasLinkRequest{}, nil)
	e.must(403, e.bob, "POST", item(priv.GetId())+"/take-over", nil, nil)
	e.must(403, e.admin, "POST", item(mine.GetId())+"/take-over", nil, nil) // not the owner of the workspace
	// The owner is still a member: no take-over even for the workspace owner who sees private.
	e.exec(`UPDATE workspaces SET owner_sees_private = true WHERE id = $1`, e.ws)
	e.must(409, e.owner, "POST", item(priv.GetId())+"/take-over", nil, nil)
	if got := e.call(e.bob, "GET", item(priv.GetId()), nil); got.Code != 200 {
		t.Fatalf("bob lost his grant: %d", got.Code)
	}

	// A guest granted WRITE on a folder creates inside it and owns what he creates — nothing
	// above it: not the folder's structure, not the top level.
	box := e.mkdir(e.alice, "", "Guest box")
	e.must(200, e.alice, "PUT", item(box.GetId())+"/permissions", &v1.UpdateCanvasPermissionsRequest{Entries: []*v1.CanvasPermissionEntry{
		{TargetType: user, TargetId: e.guest.String(), Allow: uint64(perm.CanvasView | perm.CanvasWrite)}}}, nil)
	g := e.create(e.guest, box.GetId(), "Guest's")
	e.must(403, e.guest, "PATCH", item(box.GetId()), &v1.UpdateCanvasItemRequest{Name: proto.String("Mine now")}, nil)
	e.must(403, e.guest, "PUT", item(box.GetId())+"/permissions", &v1.UpdateCanvasPermissionsRequest{}, nil)
	e.must(403, e.guest, "PATCH", item(g.GetId()), &v1.UpdateCanvasItemRequest{ParentId: proto.String("")}, nil) // the top level needs CANVAS_WRITE there
	e.must(403, e.guest, "POST", ws+"/canvas/items", &v1.CreateCanvasItemRequest{Kind: board, Name: "top"}, nil)
	e.must(403, e.guest, "PUT", ws+"/canvas/settings", &v1.CanvasSettings{TrashDays: 1}, nil)
	e.must(403, e.guest, "GET", ws+"/canvas/activity", nil, nil)

	// A reply cannot be threaded under a comment of another canvas, nor be moved there by an edit.
	c1, c2 := e.create(e.alice, "", "One"), e.create(e.alice, "", "Two")
	root := e.comment(e.alice, c1.GetId(), &v1.CreateCanvasCommentRequest{Body: "root"})
	e.must(404, e.alice, "POST", item(c2.GetId())+"/comments", &v1.CreateCanvasCommentRequest{Body: "x", ParentId: root.GetId()}, nil)
	// A comment of a canvas the caller does not see is a 404 for every route, its id says nothing.
	e.must(404, e.outsider, "PATCH", "/api/canvas/comments/"+root.GetId(), &v1.UpdateCanvasCommentRequest{Body: proto.String("hijack")}, nil)
	e.must(404, e.outsider, "DELETE", "/api/canvas/comments/"+root.GetId(), nil, nil)
	// Another member edits nobody's comment but his own; resolving takes CANVAS_WRITE only.
	e.must(403, e.bob, "PATCH", "/api/canvas/comments/"+root.GetId(), &v1.UpdateCanvasCommentRequest{Body: proto.String("hijack")}, nil)
	e.must(403, e.bob, "DELETE", "/api/canvas/comments/"+root.GetId(), nil, nil)
	e.must(200, e.bob, "PATCH", "/api/canvas/comments/"+root.GetId(), &v1.UpdateCanvasCommentRequest{Resolved: proto.Bool(true)}, nil)
}

// A public link reaches its own canvas only: the viewer socket of a code is bound to the canvas
// the code named at connect, and the anonymous routes answer nothing about the workspace.
func TestCanvasLinkBoundToItsCanvas(t *testing.T) {
	e := newEnv(t, ysync.Config{})
	srv := e.public()
	ip := newAddrs()
	a, b := e.create(e.alice, "", "A"), e.create(e.alice, "", "B")
	code := e.link(e.alice, a.GetId(), 0, 201).GetLink().GetCode()
	// The member route of another canvas with the code as a token: an invalid token.
	e.dialToken(srv, code, b.GetId()).closed(ysync.CloseAuth)
	// The viewer gets A's updates, never B's.
	v := e.view(srv, code, ip.v4(1))
	v.next(frameSnapshot)
	wb := e.dial(e.alice, b.GetId())
	wb.next(frameSnapshot)
	wb.send(updateFrame(0, []byte("b;")))
	wb.next(frameUpdate)
	wa := e.dial(e.alice, a.GetId())
	wa.next(frameSnapshot)
	wa.send(updateFrame(0, []byte("a;")))
	if f := v.next(frameUpdate); string(f[9:]) != "a;" {
		t.Fatalf("viewer got %q", f[9:])
	}
	// The public page names the canvas, and nothing of the workspace or its people.
	var pc v1.PublicCanvas
	e.must(200, uuid.Nil, "GET", publicPath(code), nil, &pc)
	if pc.GetName() != "A" || !pc.GetReadOnly() {
		t.Fatalf("public canvas: %v", &pc)
	}
}

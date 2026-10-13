//go:build integration

package app_test

import (
	"context"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

func roomIconMessages(t *testing.T, u *user, roomID string) []*v1.Message {
	t.Helper()
	var list v1.ListMessagesResponse
	u.must(200, "GET", "/api/rooms/"+roomID+"/messages", nil, &list)
	var out []*v1.Message
	for _, m := range list.GetMessages() {
		if m.GetSystem().GetRoomIcon() != nil {
			out = append(out, m)
		}
	}
	return out
}

// TestRoomPicture (ADR-0092): PATCH icon_file_id sets and clears the room picture under
// MANAGE_ROOM, only with the caller's own image of the workspace; every change posts the
// system message room_icon (with ROOM_UPDATE and MESSAGE_CREATE), READY and the room list
// carry the field and the preview, the pictures stay readable to the room, and a deleted file
// clears the field.
func TestRoomPicture(t *testing.T) {
	o, bob, ws, voice := setupTeam(t)
	wid := ws.GetId()
	var cr v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+wid+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_TEXT, Name: "general"}, &cr)
	room := cr.GetRoom()
	path := "/api/rooms/" + room.GetId()
	if room.GetIconFileId() != "" {
		t.Fatalf("new room has a picture: %v", room)
	}

	files := "/api/workspaces/" + wid + "/files"
	st, pic, _ := upload(t, o, files, "pic.png", pngBytes(64, 64))
	if st != 201 {
		t.Fatalf("upload: %d", st)
	}
	_, pic2, _ := upload(t, o, files, "pic2.png", pngBytes(32, 32))
	_, text, _ := upload(t, o, files, "notes.txt", []byte("not an image"))
	_, bobPic, _ := upload(t, bob, files, "bob.png", pngBytes(16, 16))

	bg := dialGW(t)
	bg.identify(bob.token)

	// Members without MANAGE_ROOM: 403.
	icon := pic.GetId()
	if st := bob.do("PATCH", path, &v1.UpdateRoomRequest{IconFileId: &icon}, nil); st != 403 {
		t.Fatalf("member sets the picture: %d, want 403", st)
	}
	// Not an image, someone else's file, garbage: 422.
	for _, bad := range []string{text.GetId(), bobPic.GetId(), "nope", "00000000-0000-0000-0000-000000000000"} {
		if st := o.do("PATCH", path, &v1.UpdateRoomRequest{IconFileId: &bad}, nil); st != 422 {
			t.Fatalf("picture %q: %d, want 422", bad, st)
		}
	}
	if len(roomIconMessages(t, o, room.GetId())) != 0 {
		t.Fatal("a rejected change posted a system message")
	}

	// Set: the response, ROOM_UPDATE and the system message from the caller.
	var up v1.UpdateRoomResponse
	o.must(200, "PATCH", path, &v1.UpdateRoomRequest{IconFileId: &icon}, &up)
	if up.GetRoom().GetIconFileId() != icon {
		t.Fatalf("set: %v", up.GetRoom())
	}
	bg.wait("ROOM_UPDATE", func(e *v1.DispatchEvent) bool {
		return e.GetRoomUpdate().GetRoom().GetId() == room.GetId() && e.GetRoomUpdate().GetRoom().GetIconFileId() == icon
	})
	created := bg.wait("MESSAGE_CREATE room_icon", func(e *v1.DispatchEvent) bool {
		return e.GetMessageCreate().GetMessage().GetSystem().GetRoomIcon() != nil
	}).GetMessageCreate().GetMessage()
	if created.GetRoomId() != room.GetId() || created.GetAuthorId() != o.id || created.GetKind() != v1.MessageKind_MESSAGE_KIND_SYSTEM ||
		created.GetSystem().GetRoomIcon().GetFileId() != icon {
		t.Fatalf("system message: %v", created)
	}
	// The same picture again: no change, no new message.
	o.must(200, "PATCH", path, &v1.UpdateRoomRequest{IconFileId: &icon}, nil)
	if n := len(roomIconMessages(t, o, room.GetId())); n != 1 {
		t.Fatalf("room_icon messages after a no-op: %d, want 1", n)
	}

	// The member reads the picture; READY and the room list carry it and the preview.
	if res, _ := get(t, bob, "/api/files/"+icon, nil); res.StatusCode != 200 {
		t.Fatalf("member reads the picture: %d", res.StatusCode)
	}
	if got := visibleRooms(t, bob, wid)[room.GetId()]; got.GetIconFileId() != icon {
		t.Fatalf("GET rooms: %v", got)
	}
	var snap *v1.WorkspaceSnapshot
	for _, s := range dialGW(t).identify(bob.token).GetWorkspaces() {
		if s.GetWorkspace().GetId() == wid {
			snap = s
		}
	}
	found := false
	for _, r := range snap.GetRooms() {
		if r.GetId() == room.GetId() {
			found = r.GetIconFileId() == icon
		}
	}
	if !found {
		t.Fatal("READY: the room has no picture")
	}
	if last := snap.GetRoomLastMessages()[room.GetId()]; last.GetId() != created.GetId() || last.GetSystem().GetRoomIcon().GetFileId() != icon {
		t.Fatalf("READY preview: %v", last)
	}

	// Replace: the old picture stays readable through its system message.
	icon2 := pic2.GetId()
	o.must(200, "PATCH", path, &v1.UpdateRoomRequest{IconFileId: &icon2}, nil)
	if res, _ := get(t, bob, "/api/files/"+icon, nil); res.StatusCode != 200 {
		t.Fatalf("member reads the old picture: %d", res.StatusCode)
	}

	// Clear: "" removes it and posts a message without a file.
	empty := ""
	o.must(200, "PATCH", path, &v1.UpdateRoomRequest{IconFileId: &empty}, &up)
	if up.GetRoom().GetIconFileId() != "" {
		t.Fatalf("cleared: %v", up.GetRoom())
	}
	msgs := roomIconMessages(t, o, room.GetId())
	if len(msgs) != 3 || msgs[0].GetSystem().GetRoomIcon().GetFileId() != "" {
		t.Fatalf("room_icon messages: %v", msgs)
	}

	// A voice room takes a picture too; the cleanup keeps the pictures of rooms and of live
	// system messages, and a deleted file clears the field (ON DELETE SET NULL).
	o.must(200, "PATCH", "/api/rooms/"+voice.GetId(), &v1.UpdateRoomRequest{IconFileId: &icon2}, nil)
	ctx := context.Background()
	orphans, err := testDB.Q.ListOrphanFiles(ctx, time.Now().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	orphan := map[string]bool{}
	for _, f := range orphans {
		orphan[f.ID.String()] = true
	}
	if orphan[icon] || orphan[icon2] || !orphan[text.GetId()] {
		t.Fatalf("orphans: picture %v, picture2 %v, text %v", orphan[icon], orphan[icon2], orphan[text.GetId()])
	}
	if _, err := testDB.Pool.Exec(ctx, "DELETE FROM files WHERE id = $1", icon2); err != nil {
		t.Fatal(err)
	}
	var gr v1.GetRoomResponse
	o.must(200, "GET", "/api/rooms/"+voice.GetId(), nil, &gr)
	if gr.GetRoom().GetIconFileId() != "" {
		t.Fatalf("picture of a deleted file: %v", gr.GetRoom())
	}
}

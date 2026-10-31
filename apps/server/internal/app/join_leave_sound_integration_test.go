//go:build integration

package app_test

import (
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// join_leave_sound_max: workspace default 10, room override set / cleared, 0..99, voice only,
// the same permissions as the other media settings.
func TestJoinLeaveSoundMax(t *testing.T) {
	o, bob, ws, room := setupTeam(t)
	rid := room.GetId()
	effective := func() *v1.RoomMediaSettings {
		t.Helper()
		var got v1.GetRoomResponse
		o.must(200, "GET", "/api/rooms/"+rid, nil, &got)
		return got.GetRoom().GetMedia()
	}
	if m := effective(); m.JoinLeaveSoundMax == nil || m.GetJoinLeaveSoundMax() != 10 {
		t.Fatalf("default join_leave_sound_max %v, want 10", m.JoinLeaveSoundMax)
	}
	if d := room.GetMediaOverride(); d.JoinLeaveSoundMax != nil {
		t.Fatalf("new room has an override %d", d.GetJoinLeaveSoundMax())
	}

	bad, five, zero, twenty := uint32(100), uint32(5), uint32(0), uint32(20)
	o.must(422, "PATCH", "/api/workspaces/"+ws.GetId(), &v1.UpdateWorkspaceRequest{DefaultJoinLeaveSoundMax: &bad}, nil)
	bob.must(403, "PATCH", "/api/workspaces/"+ws.GetId(), &v1.UpdateWorkspaceRequest{DefaultJoinLeaveSoundMax: &five}, nil)
	var wr v1.UpdateWorkspaceResponse
	o.must(200, "PATCH", "/api/workspaces/"+ws.GetId(), &v1.UpdateWorkspaceRequest{DefaultJoinLeaveSoundMax: &five}, &wr)
	if got := wr.GetWorkspace().GetMediaDefaults().GetJoinLeaveSoundMax(); got != 5 {
		t.Fatalf("workspace media_defaults join_leave_sound_max %d, want 5", got)
	}
	if got := effective().GetJoinLeaveSoundMax(); got != 5 {
		t.Fatalf("join_leave_sound_max %d after workspace default 5", got)
	}

	// Room override: validated, 0 (= never) is a value of its own, an empty override clears it.
	patch := func(code int, by *user, n *uint32) {
		t.Helper()
		by.must(code, "PATCH", "/api/rooms/"+rid, &v1.UpdateRoomRequest{MediaOverride: &v1.RoomMediaOverride{JoinLeaveSoundMax: n}}, nil)
	}
	patch(422, o, &bad)
	patch(403, bob, &twenty)
	patch(200, o, &twenty)
	if got := effective().GetJoinLeaveSoundMax(); got != 20 {
		t.Fatalf("override 20: got %d", got)
	}
	patch(200, o, &zero)
	if m := effective(); m.JoinLeaveSoundMax == nil || m.GetJoinLeaveSoundMax() != 0 {
		t.Fatalf("override 0: got %v", m.JoinLeaveSoundMax)
	}
	var gr v1.GetRoomResponse
	o.must(200, "GET", "/api/rooms/"+rid, nil, &gr)
	if ov := gr.GetRoom().GetMediaOverride(); ov.JoinLeaveSoundMax == nil || ov.GetJoinLeaveSoundMax() != 0 {
		t.Fatalf("override not returned: %v", ov)
	}
	patch(200, o, nil) // the whole override is replaced: unset = workspace default
	if got := effective().GetJoinLeaveSoundMax(); got != 5 {
		t.Fatalf("cleared override: got %d, want the workspace default 5", got)
	}

	// Created with an override; text rooms take no media settings.
	var cr v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+ws.GetId()+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_VOICE, Name: "big",
		MediaOverride: &v1.RoomMediaOverride{JoinLeaveSoundMax: &twenty}}, &cr)
	if got := cr.GetRoom().GetMedia().GetJoinLeaveSoundMax(); got != 20 {
		t.Fatalf("created with 20: got %d", got)
	}
	o.must(422, "POST", "/api/workspaces/"+ws.GetId()+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_VOICE, Name: "bad",
		MediaOverride: &v1.RoomMediaOverride{JoinLeaveSoundMax: &bad}}, nil)
	var text v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+ws.GetId()+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_TEXT, Name: "text"}, &text)
	o.must(422, "PATCH", "/api/rooms/"+text.GetRoom().GetId(), &v1.UpdateRoomRequest{MediaOverride: &v1.RoomMediaOverride{JoinLeaveSoundMax: &twenty}}, nil)
}

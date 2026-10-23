//go:build integration

package app_test

import (
	"context"
	"fmt"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/livekit/protocol/livekit"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/app"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/recording"
	"github.com/calaba/calaba/server/internal/rtc"
	"github.com/calaba/calaba/server/internal/voice"
)

// phoneEgress is the LiveKit Egress of the phone recording tests (ADR-0131): it records the
// starts and stops.
type phoneEgress struct {
	mu     sync.Mutex
	seq    int
	starts []phoneStart
	stops  []string
}

type phoneStart struct {
	id, room string
	out      rtc.FileOutput
}

func (f *phoneEgress) StartAudioRecording(_ context.Context, room string, out rtc.FileOutput) (*rtc.EgressInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.seq++
	id := fmt.Sprintf("EG_phone_%d_%d", time.Now().UnixNano(), f.seq)
	f.starts = append(f.starts, phoneStart{id: id, room: room, out: out})
	// The shared instance's worker asks its own egress fake about live phone recordings: there
	// the egress runs on (this test ends it by hand), so that worker leaves the row alone.
	egFake.mu.Lock()
	egFake.items[id] = &livekit.EgressInfo{EgressId: id, RoomName: room, Status: livekit.EgressStatus_EGRESS_ACTIVE}
	egFake.mu.Unlock()
	return &rtc.EgressInfo{EgressID: id, RoomName: room, Status: rtc.EgressStarting}, nil
}

func (f *phoneEgress) StopEgress(_ context.Context, id string) (*rtc.EgressInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.stops = append(f.stops, id)
	return &rtc.EgressInfo{EgressID: id, Status: rtc.EgressEnding}, nil
}

func (f *phoneEgress) ListEgress(context.Context, string, string, bool) ([]rtc.EgressInfo, error) {
	return nil, nil
}

func (f *phoneEgress) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.starts)
}

// started waits for the n-th start (1-based).
func (f *phoneEgress) started(t *testing.T, n int) phoneStart {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		f.mu.Lock()
		if len(f.starts) >= n {
			s := f.starts[n-1]
			f.mu.Unlock()
			return s
		}
		f.mu.Unlock()
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("no egress start #%d", n)
	return phoneStart{}
}

func (f *phoneEgress) stopped(id string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, s := range f.stops {
		if s == id {
			return true
		}
	}
	return false
}

// TestSIPRecording (ADR-0131): the switches (MANAGE_INTEGRATIONS only), an answered inbound
// call recorded from the answer into /phone_recordings/<day>/ of the Disk — the folder made for
// the owner alone, the file counted in the storage — the stop on hang-up, a full storage, an
// outbound call, and nothing recorded with the switch off.
func TestSIPRecording(t *testing.T) {
	ctx := context.Background()
	cfg := *testCfg
	cfg.IVRAgentToken = "it-ivr-token"
	eg := &phoneEgress{}
	a := app.New(app.Deps{Config: &cfg, DB: testDB, Redis: testRedis, Events: events.Redis{C: testRedis}, Blob: testStore, LiveKit: lkRec,
		Mail: testMail, SIP: &fakeSIP{}, IVRAgent: &fakeIVR{}, Egress: eg, UnfurlAllowAddr: func(netip.Addr) bool { return true }})
	server := httptest.NewServer(a.Handler)
	t.Cleanup(server.Close)

	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	wid := ws.GetId()
	setPlan(t, wid, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_ENTERPRISE})
	bob := register(t, invite(t, o, wid))
	// Dave manages telephony: he switches recording but does not see the recordings.
	dave := register(t, invite(t, o, wid))
	tel := newRole(t, o, wid, "Telephony", perm.ManageIntegrations)
	if st, _ := setMemberRoles(o, wid, dave.id, tel.GetId()); st != 200 {
		t.Fatalf("dave's role: %d", st)
	}
	base := "/api/workspaces/" + wid + "/sip"

	// The switches: off by default; not before the provider is saved; MANAGE_INTEGRATIONS only.
	var g v1.GetSipSettingsResponse
	pushHTTP(t, server, o, 200, "GET", base, nil, &g)
	if g.GetSettings().GetRecordInbound() || g.GetSettings().GetRecordOutbound() || !g.GetSettings().GetRecordingAvailable() {
		t.Fatalf("defaults: %v", g.GetSettings())
	}
	pushHTTP(t, server, o, 409, "PUT", base+"/recording", &v1.PutSipRecordingRequest{RecordInbound: true}, nil)
	pushHTTP(t, server, o, 200, "PUT", base, &v1.PutSipSettingsRequest{Enabled: true, Provider: "Zadarma", Host: "203.0.113.10", CallerId: "+74951234567"}, nil)
	var before v1.GetSipSettingsResponse
	pushHTTP(t, server, o, 200, "GET", base, nil, &before)
	pushHTTP(t, server, bob, 403, "PUT", base+"/recording", &v1.PutSipRecordingRequest{RecordInbound: true}, nil)
	var put v1.PutSipRecordingResponse
	pushHTTP(t, server, dave, 200, "PUT", base+"/recording", &v1.PutSipRecordingRequest{RecordInbound: true}, &put)
	if s := put.GetSettings(); !s.GetRecordInbound() || s.GetRecordOutbound() || !s.GetUpdatedAt().AsTime().Equal(before.GetSettings().GetUpdatedAt().AsTime()) {
		t.Fatalf("switched: %v (the provider form's version must stay)", s)
	}

	var ext v1.SipExtensionResponse
	pushHTTP(t, server, o, 201, "POST", base+"/extensions", &v1.CreateSipExtensionRequest{Number: "101", UserId: bob.id}, &ext)
	toBob := &v1.SipRouteTarget{Kind: v1.SipRouteKind_SIP_ROUTE_KIND_EXTENSION, Id: ext.GetExtension().GetId()}
	pushHTTP(t, server, o, 200, "PUT", base+"/inbound", &v1.PutSipInboundRequest{Enabled: true, Target: toBob}, nil)

	// call rings bob, bob answers; it returns the call and its LiveKit room.
	call := func(number string) (string, string) {
		t.Helper()
		room := rtc.InboundRoomPrefix(uuid.MustParse(wid)) + "_" + number + "_" + uniq("")
		if err := a.SIP.Inbound(ctx, rtc.EventParticipantJoined, room, inboundLine(number)); err != nil {
			t.Fatal(err)
		}
		row, err := testDB.Q.GetSipCallByLKRoom(ctx, room)
		if err != nil {
			t.Fatal(err)
		}
		if n := eg.count(); n != 0 && eg.starts[n-1].room == room {
			t.Fatal("recording started while the call rang")
		}
		pushHTTP(t, server, bob, 200, "POST", "/api/sip/inbound/"+row.ID.String()+"/accept", nil, nil)
		return row.ID.String(), room
	}
	// end hangs up, lets the egress end with its file (size bytes; 0 = none) and returns the row.
	end := func(cid string, st phoneStart, size int) sqlc.SipCallRecording {
		t.Helper()
		if size > 0 {
			path := filepath.Join(recordDir, strings.TrimPrefix(st.out.Filepath, "/out/"))
			if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte(strings.Repeat("O", size)), 0o600); err != nil {
				t.Fatal(err)
			}
		}
		pushHTTP(t, server, bob, 200, "DELETE", "/api/sip/inbound/"+cid, nil, nil)
		deadline := time.Now().Add(5 * time.Second)
		for !eg.stopped(st.id) && time.Now().Before(deadline) {
			time.Sleep(20 * time.Millisecond)
		}
		if !eg.stopped(st.id) {
			t.Fatal("the egress was not stopped on hang-up")
		}
		if err := a.Recording.HandleEgress(ctx, rtc.EventEgressEnded, &rtc.EgressInfo{EgressID: st.id, Status: rtc.EgressComplete}); err != nil {
			t.Fatal(err)
		}
		rec, err := testDB.Q.GetSipRecordingByEgress(ctx, &st.id)
		if err != nil {
			t.Fatal(err)
		}
		return rec
	}

	// An answered call is recorded in its own room as Ogg; the file lands on the Disk.
	cid, room := call("+79161234567")
	st := eg.started(t, 1)
	if st.room != room || st.out.FileType != rtc.FileOGG || !strings.HasSuffix(st.out.Filepath, ".ogg") {
		t.Fatalf("egress: %+v", st)
	}
	var used0 int64
	if err := testDB.Pool.QueryRow(ctx, `SELECT storage_used_bytes FROM workspaces WHERE id = $1`, wid).Scan(&used0); err != nil {
		t.Fatal(err)
	}
	rec := end(cid, st, 2048)
	if rec.Status != "stored" || rec.DiskItemID == nil || rec.FileID == nil || rec.SizeBytes != 2048 || rec.File != "" {
		t.Fatalf("recording: %+v", rec)
	}
	if _, err := os.Stat(filepath.Join(recordDir, strings.TrimPrefix(st.out.Filepath, "/out/"))); !os.IsNotExist(err) {
		t.Fatalf("the raw file stays: %v", err)
	}
	item, err := testDB.Q.GetDiskItem(ctx, *rec.DiskItemID)
	if err != nil {
		t.Fatal(err)
	}
	day, name := recording.PhoneName(rec.StartedAt, time.UTC, "+79161234567", true)
	if item.Name != name || !strings.HasSuffix(name, "_79161234567_IN.ogg") || item.OwnerID == nil || item.OwnerID.String() != o.id || item.ParentID == nil {
		t.Fatalf("file item: %+v (want %s)", item, name)
	}
	dayDir, err := testDB.Q.GetDiskItem(ctx, *item.ParentID)
	if err != nil || dayDir.Name != day || dayDir.Restricted || dayDir.ParentID == nil {
		t.Fatalf("day folder: %+v %v", dayDir, err)
	}
	root, err := testDB.Q.GetDiskItem(ctx, *dayDir.ParentID)
	if err != nil || root.Name != recording.PhoneRoot || !root.Restricted || root.ParentID != nil || root.OwnerID == nil || root.OwnerID.String() != o.id {
		t.Fatalf("root folder: %+v %v", root, err)
	}
	var used1 int64
	if err := testDB.Pool.QueryRow(ctx, `SELECT storage_used_bytes FROM workspaces WHERE id = $1`, wid).Scan(&used1); err != nil || used1 != used0+2048 {
		t.Fatalf("storage: %d → %d %v", used0, used1, err)
	}
	// The owner sees it; the member who took the call and the telephony admin do not.
	pushHTTP(t, server, o, 200, "GET", "/api/disk/items/"+item.ID.String(), nil, nil)
	pushHTTP(t, server, bob, 404, "GET", "/api/disk/items/"+item.ID.String(), nil, nil)
	pushHTTP(t, server, dave, 404, "GET", "/api/disk/items/"+root.ID.String(), nil, nil)

	// A second call the same minute: the same folders, the name gets «(2)»; an egress without a
	// file is a failed recording and nothing on the Disk.
	cid2, _ := call("+79161234567")
	st2 := eg.started(t, 2)
	rec2 := end(cid2, st2, 100)
	item2, err := testDB.Q.GetDiskItem(ctx, *rec2.DiskItemID)
	if err != nil || item2.ParentID == nil || *item2.ParentID != dayDir.ID {
		t.Fatalf("second file: %+v %v", item2, err)
	}
	if day2, name2 := recording.PhoneName(rec2.StartedAt, time.UTC, "+79161234567", true); day2 == day && name2 == name &&
		item2.Name != strings.TrimSuffix(name, ".ogg")+" (2).ogg" {
		t.Fatalf("same minute: %s", item2.Name)
	}
	cid3, _ := call("+79160000003")
	if rec3 := end(cid3, eg.started(t, 3), 0); rec3.Status != "failed" || rec3.Error != "no_audio" || rec3.DiskItemID != nil {
		t.Fatalf("no file: %+v", rec3)
	}

	// The storage is full: the recording fails, the call was not touched.
	if _, err := testDB.Pool.Exec(ctx, "UPDATE workspaces SET storage_quota_bytes = storage_used_bytes + 10 WHERE id = $1", wid); err != nil {
		t.Fatal(err)
	}
	cid4, _ := call("+79160000004")
	if rec4 := end(cid4, eg.started(t, 4), 4096); rec4.Status != "failed" || rec4.Error != "quota" || rec4.DiskItemID != nil {
		t.Fatalf("full storage: %+v", rec4)
	}
	if _, err := testDB.Pool.Exec(ctx, "UPDATE workspaces SET storage_quota_bytes = 10737418240 WHERE id = $1", wid); err != nil {
		t.Fatal(err)
	}

	// Outbound: recorded only with its own switch, in the voice room of the call.
	rid := uuid.MustParse(voiceRoom(t, o, wid, "Звонки", 0))
	outCall := func() uuid.UUID {
		t.Helper()
		id := uuid.Must(uuid.NewV7())
		c, err := testDB.Q.InsertSipCall(ctx, sqlc.InsertSipCallParams{ID: id, WorkspaceID: uuid.MustParse(wid), RoomID: &rid, Number: "+74957654321",
			StartedBy: ptrUUID(uuid.MustParse(o.id)), ParticipantIdentity: "sip_" + id.String()})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := testDB.Q.MarkSipCallActive(ctx, sqlc.MarkSipCallActiveParams{ID: c.ID, SipCallID: "SCL_x"}); err != nil {
			t.Fatal(err)
		}
		a.Recording.CallConnected(ctx, c.ID)
		return c.ID
	}
	first := outCall()
	time.Sleep(300 * time.Millisecond)
	if eg.count() != 4 {
		t.Fatal("an outbound call was recorded with its switch off")
	}
	pushHTTP(t, server, o, 200, "PUT", base+"/recording", &v1.PutSipRecordingRequest{RecordInbound: false, RecordOutbound: true}, nil)
	if _, err := testDB.Q.FinishSipCall(ctx, sqlc.FinishSipCallParams{ID: first, Status: "ended", Reason: "hangup"}); err != nil {
		t.Fatal(err)
	}
	outID := outCall()
	st5 := eg.started(t, 5)
	if st5.room != voice.RoomName(uuid.MustParse(wid), rid) || st5.out.FileType != rtc.FileOGG {
		t.Fatalf("outbound egress: %+v", st5)
	}
	a.Recording.CallConnected(ctx, outID) // a repeated «connected» records nothing more
	time.Sleep(300 * time.Millisecond)
	if eg.count() != 5 {
		t.Fatal("a second recording of the same call")
	}
	if _, err := testDB.Q.FinishSipCall(ctx, sqlc.FinishSipCallParams{ID: outID, Status: "ended", Reason: "hangup"}); err != nil {
		t.Fatal(err)
	}
	a.Recording.CallEnded(ctx, outID)
	deadline := time.Now().Add(5 * time.Second)
	for !eg.stopped(st5.id) && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if !eg.stopped(st5.id) {
		t.Fatal("the outbound egress was not stopped")
	}

	// Inbound switched off: an answered call is not recorded.
	cid6, _ := call("+79160000006")
	time.Sleep(300 * time.Millisecond)
	if eg.count() != 5 {
		t.Fatal("an inbound call was recorded with its switch off")
	}
	pushHTTP(t, server, bob, 200, "DELETE", "/api/sip/inbound/"+cid6, nil, nil)

	// A member's own folder of that name (made before the owner's, or after it went to the
	// trash) is never used: its owner would see every recording filed below it.
	pushHTTP(t, server, o, 200, "POST", "/api/disk/items/"+root.ID.String()+"/trash", nil, nil)
	var trap v1.DiskItemResponse
	pushHTTP(t, server, bob, 201, "POST", "/api/workspaces/"+wid+"/disk/folders", &v1.CreateDiskFolderRequest{Name: "Phone_Recordings"}, &trap)
	pushHTTP(t, server, o, 200, "PUT", base+"/recording", &v1.PutSipRecordingRequest{RecordInbound: true}, nil)
	cid7, _ := call("+79160000007")
	if rec7 := end(cid7, eg.started(t, 6), 2048); rec7.Status != "failed" || rec7.Error != "path_blocked" || rec7.DiskItemID != nil || rec7.FileID != nil {
		t.Fatalf("a member's folder: %+v", rec7)
	}
	var inTrap int
	if err := testDB.Pool.QueryRow(ctx, `SELECT count(*) FROM disk_items WHERE parent_id = $1`, trap.GetItem().GetId()).Scan(&inTrap); err != nil || inTrap != 0 {
		t.Fatalf("filed into the member's folder: %d %v", inTrap, err)
	}
}

func ptrUUID(u uuid.UUID) *uuid.UUID { return &u }

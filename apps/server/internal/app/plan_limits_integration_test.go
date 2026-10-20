//go:build integration

package app_test

import (
	"context"
	"strings"
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/caldav/caldavtest"
)

// Free plan limits of 28.09 (ADR-0024 «Пометка 2026-09-28»): 50 members (bots take a seat,
// guests do not), voice up to «Нормальное» (16 kbps), one bot, one sticker pack; TEAM lifts
// them, ENTERPRISE has no limits at all.

// fillSeats adds n plain members straight in the database (registering 50 users through the
// API would only test registration).
func fillSeats(t *testing.T, wsID string, n int) {
	t.Helper()
	_, err := testDB.Pool.Exec(context.Background(), `
WITH u AS (
    INSERT INTO users (email, display_name, email_verified_at)
    SELECT 'seat-' || gen_random_uuid() || '@example.com', 'seat', now() FROM generate_series(1, $2) RETURNING id
)
INSERT INTO workspace_members (workspace_id, user_id, role) SELECT $1, id, 'member' FROM u`, wsID, n)
	if err != nil {
		t.Fatal(err)
	}
}

func setPlan(t *testing.T, wsID string, req *v1.AdminSetPlanRequest) {
	t.Helper()
	superadminUser(t).must(200, "PUT", "/api/admin/workspaces/"+wsID+"/plan", req, nil)
}

func wantPlanLimit(t *testing.T, what string, st int, e *v1.ApiError, used, limit uint64) {
	t.Helper()
	if st != 409 || e.GetCode() != v1.ErrorCode_ERROR_CODE_CONFLICT || e.GetReason() != "PLAN_LIMIT" || e.GetUsed() != used || e.GetLimit() != limit {
		t.Fatalf("%s: %d %v, want 409 PLAN_LIMIT %d/%d", what, st, e, used, limit)
	}
}

func TestPlanMembersLimit(t *testing.T) {
	withFreeLimits(t)
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	wsID := ws.GetId()
	if l := ws.GetPlan().GetLimits(); l.GetMembers() != 50 || l.GetAudioTierMaxKbps() != 16 || l.GetBots() != 1 || l.GetStickerPacks() != 1 {
		t.Fatalf("free limits: %v", l)
	}
	code := invite(t, o, wsID)    // owner = 1
	fillSeats(t, wsID, 47)        // 48
	register(t, code)             // 49: registration by an invitation
	createBot(t, o, wsID, "seat") // 50: a bot takes a seat

	// Full: no new link, no email invitation, nobody joins.
	st, e := o.apiErrBody("POST", "/api/workspaces/"+wsID+"/invites", &v1.CreateInviteRequest{})
	wantPlanLimit(t, "invite link", st, e, 50, 50)
	st, e = o.apiErrBody("POST", "/api/workspaces/"+wsID+"/invites/email", &v1.CreateEmailInviteRequest{Email: uniq("full") + "@example.com"})
	wantPlanLimit(t, "email invite", st, e, 50, 50)
	outsider := register(t, invite(t, o, createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId()))
	st, e = outsider.apiErrBody("POST", "/api/invites/"+code+"/join", nil)
	wantPlanLimit(t, "join by code", st, e, 50, 50)
	st, e = o.apiErrBody("POST", "/api/workspaces/"+wsID+"/members", &v1.AddMemberRequest{UserId: outsider.id})
	wantPlanLimit(t, "add member", st, e, 50, 50)
	anon := &client{t: t, ip: "10.71.0.1"}
	st, e = anon.apiErrBody("POST", "/api/auth/register", &v1.RegisterRequest{
		Email: uniq("late") + "@example.com", Password: "password123", DisplayName: "Late", InviteCode: code, DeviceName: "test",
	})
	wantPlanLimit(t, "register by invite", st, e, 50, 50)
	open := v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_OPEN
	o.must(200, "PATCH", "/api/workspaces/"+wsID, &v1.UpdateWorkspaceRequest{Visibility: &open}, nil)
	st, e = outsider.apiErrBody("POST", "/api/workspaces/"+wsID+"/join", nil)
	wantPlanLimit(t, "join open workspace", st, e, 50, 50)
	st, e = o.apiErrBody("POST", "/api/workspaces/"+wsID+"/bots", &v1.CreateBotRequest{DisplayName: "b2", Username: strings.ReplaceAll(uniq("b2_"), "-", "_")})
	if st != 409 || e.GetReason() != "PLAN_LIMIT" {
		t.Fatalf("second bot: %d %v", st, e)
	}

	// Guests take no seat: a room link still lets one in; promoting them needs a seat.
	var room v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+wsID+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_TEXT, Name: "guests"}, &room)
	var link v1.CreateRoomInviteResponse
	o.must(201, "POST", "/api/rooms/"+room.GetRoom().GetId()+"/invites", &v1.CreateRoomInviteRequest{}, &link)
	var gj v1.JoinRoomInviteResponse
	(&client{t: t, ip: "10.71.0.2"}).must(201, "POST", "/api/room-invites/"+link.GetInvite().GetCode()+"/join", &v1.JoinRoomInviteRequest{Nickname: "Гость"}, &gj)
	st, e = o.apiErrBody("POST", "/api/workspaces/"+wsID+"/members/"+gj.GetMe().GetUser().GetId()+"/promote", nil)
	wantPlanLimit(t, "promote guest", st, e, 50, 50)

	// A seat frees up: joining works again.
	if _, err := testDB.Pool.Exec(context.Background(),
		`DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = (SELECT m.user_id FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 AND u.display_name = 'seat' LIMIT 1)`, wsID); err != nil {
		t.Fatal(err)
	}
	outsider.must(200, "POST", "/api/invites/"+code+"/join", nil, nil)

	// TEAM: 100 members. Guests are not counted (the guest above got in at a full workspace),
	// promoting one needs a seat.
	setPlan(t, wsID, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_TEAM})
	fillSeats(t, wsID, 50) // 50 → 100
	st, e = o.apiErrBody("POST", "/api/workspaces/"+wsID+"/invites", &v1.CreateInviteRequest{})
	wantPlanLimit(t, "team invite", st, e, 100, 100)
	st, e = outsider2(t, o).apiErrBody("POST", "/api/invites/"+code+"/join", nil)
	wantPlanLimit(t, "team join by code", st, e, 100, 100)
	st, e = o.apiErrBody("POST", "/api/workspaces/"+wsID+"/members/"+gj.GetMe().GetUser().GetId()+"/promote", nil)
	wantPlanLimit(t, "team promote guest", st, e, 100, 100)

	// BUSINESS (PLAN_ENTERPRISE): 500 members.
	setPlan(t, wsID, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_ENTERPRISE})
	o.must(201, "POST", "/api/workspaces/"+wsID+"/invites", &v1.CreateInviteRequest{}, nil)
	o.must(200, "POST", "/api/workspaces/"+wsID+"/members/"+gj.GetMe().GetUser().GetId()+"/promote", nil, nil)
}

// outsider2 registers a user of another workspace (someone who is not yet a member).
func outsider2(t *testing.T, o *user) *user {
	t.Helper()
	return register(t, invite(t, o, createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId()))
}

func TestPlanAudioTier(t *testing.T) {
	withFreeLimits(t)
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	wsID := ws.GetId()
	patchWS := func(kbps uint32) (int, *v1.ApiError) {
		return o.apiErrBody("PATCH", "/api/workspaces/"+wsID, &v1.UpdateWorkspaceRequest{DefaultAudioBitrateKbps: &kbps})
	}
	// The stored default (32, before the cap) stays accepted as is; raising is refused.
	if st, e := patchWS(32); st != 200 {
		t.Fatalf("unchanged default: %d %v", st, e)
	}
	st, e := patchWS(64)
	wantPlanLimit(t, "default 64", st, e, 64, 16)
	if st, e := patchWS(16); st != 200 {
		t.Fatalf("default 16: %d %v", st, e)
	}
	st, e = patchWS(32)
	wantPlanLimit(t, "default back to 32", st, e, 32, 16)

	good, normal := uint32(32), uint32(16)
	st, e = o.apiErrBody("POST", "/api/workspaces/"+wsID+"/rooms", &v1.CreateRoomRequest{
		Type: v1.RoomType_ROOM_TYPE_VOICE, Name: "v", MediaOverride: &v1.RoomMediaOverride{AudioBitrateKbps: &good},
	})
	wantPlanLimit(t, "room 32", st, e, 32, 16)
	var cr v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+wsID+"/rooms", &v1.CreateRoomRequest{
		Type: v1.RoomType_ROOM_TYPE_VOICE, Name: "v", MediaOverride: &v1.RoomMediaOverride{AudioBitrateKbps: &normal},
	}, &cr)
	rid := cr.GetRoom().GetId()
	st, e = o.apiErrBody("PATCH", "/api/rooms/"+rid, &v1.UpdateRoomRequest{MediaOverride: &v1.RoomMediaOverride{AudioBitrateKbps: &good}})
	wantPlanLimit(t, "room patch 32", st, e, 32, 16)

	// A room stored above the cap (before it, or on a lapsed plan) gets min(room, plan) at join.
	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE rooms SET audio_bitrate_kbps = 64 WHERE id = $1", rid); err != nil {
		t.Fatal(err)
	}
	j := joinPending(t, o, rid)
	if j.GetMedia().GetAudioBitrateKbps() != 16 || j.GetPlanLimits().GetAudioTierMaxKbps() != 16 {
		t.Fatalf("join on free: media %v limits %v", j.GetMedia(), j.GetPlanLimits())
	}

	// TEAM: any tier.
	setPlan(t, wsID, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_TEAM})
	best := uint32(64)
	o.must(200, "PATCH", "/api/rooms/"+rid, &v1.UpdateRoomRequest{MediaOverride: &v1.RoomMediaOverride{AudioBitrateKbps: &best}}, nil)
	if st, e := patchWS(64); st != 200 {
		t.Fatalf("team default 64: %d %v", st, e)
	}
	j = joinPending(t, o, rid)
	if j.GetMedia().GetAudioBitrateKbps() != 64 || j.GetPlanLimits().GetAudioTierMaxKbps() != 0 {
		t.Fatalf("join on team: media %v limits %v", j.GetMedia(), j.GetPlanLimits())
	}
}

func TestPlanFreeCounts(t *testing.T) {
	withFreeLimits(t)
	o := owner(t)
	wsID := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId()
	createBot(t, o, wsID, "one")
	st, e := o.apiErrBody("POST", "/api/workspaces/"+wsID+"/bots", &v1.CreateBotRequest{DisplayName: "two", Username: strings.ReplaceAll(uniq("two_"), "-", "_")})
	wantPlanLimit(t, "second bot", st, e, 1, 1)
	createPack(t, o, wsID, "One")
	st, e = o.apiErrBody("POST", "/api/workspaces/"+wsID+"/sticker-packs", &v1.CreateStickerPackRequest{Name: "Two"})
	wantPlanLimit(t, "second pack", st, e, 1, 1)

	// The superadmin sees the counts against the limits.
	var aw v1.AdminGetWorkspaceResponse
	superadminUser(t).must(200, "GET", "/api/admin/workspaces/"+wsID, nil, &aw)
	if u := aw.GetWorkspace().GetUsage(); u.GetBots() != 1 || u.GetStickerPacks() != 1 || u.GetMembers() != 2 {
		t.Fatalf("admin usage: %v", u)
	}

	// TEAM (5 bots, packs unlimited).
	setPlan(t, wsID, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_TEAM})
	createBot(t, o, wsID, "two")
	createPack(t, o, wsID, "Two")
}

// BUSINESS = PLAN_ENTERPRISE (owner, 30.09): 50 in a room, 500 members, 20 bots, 50 boards, 1 TiB;
// voice tier, sticker packs and video are not limited.
func TestPlanBusinessLimits(t *testing.T) {
	withFreeLimits(t)
	o := owner(t)
	wsID := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId()
	createBot(t, o, wsID, "one")
	createPack(t, o, wsID, "One")
	fillSeats(t, wsID, 48) // 50 with the owner and the bot: Free is full
	st, e := o.apiErrBody("POST", "/api/workspaces/"+wsID+"/invites", &v1.CreateInviteRequest{})
	wantPlanLimit(t, "free invite", st, e, 50, 50)

	setPlan(t, wsID, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_ENTERPRISE, Note: "business"})
	var gw v1.GetWorkspaceResponse
	o.must(200, "GET", "/api/workspaces/"+wsID, nil, &gw)
	if p := gw.GetWorkspace().GetPlan(); p.GetPlan() != v1.Plan_PLAN_ENTERPRISE || p.GetLimits().GetRoomMembers() != 50 ||
		p.GetLimits().GetMembers() != 500 || p.GetLimits().GetBots() != 20 || p.GetLimits().GetBoards() != 50 ||
		p.GetLimits().GetStorageMb() != 1<<20 || p.GetLimits().GetAudioTierMaxKbps() != 0 ||
		p.GetLimits().GetStreamMaxPreset() != v1.ScreenSharePreset_SCREEN_SHARE_PRESET_UNSPECIFIED {
		t.Fatalf("business plan: %v", p)
	}
	fillSeats(t, wsID, 5)
	o.must(201, "POST", "/api/workspaces/"+wsID+"/invites", &v1.CreateInviteRequest{}, nil)
	createBot(t, o, wsID, "two")
	createPack(t, o, wsID, "Two")
	best := uint32(64)
	o.must(200, "PATCH", "/api/workspaces/"+wsID, &v1.UpdateWorkspaceRequest{DefaultAudioBitrateKbps: &best}, nil)

	// ENTERPRISE takes per-workspace overrides (ADR-0113, TestAdminPlanIdentityAndOverrides), validated like CUSTOM.
	st, e = superadminUser(t).apiErrBody("PUT", "/api/admin/workspaces/"+wsID+"/plan",
		&v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_ENTERPRISE, Limits: &v1.PlanLimits{RoomMembers: 5000}})
	if st != 422 {
		t.Fatalf("business with limits: %d %v", st, e)
	}
}

// CalDAV is not part of Free (owner, 30.09). It belongs to a person: one workspace whose plan
// has it is enough. A Free-only user keeps the stored account, but nothing syncs or is read.
func TestPlanCalDAV(t *testing.T) {
	withFreeLimits(t)
	// A fresh person: the shared owner belongs to workspaces of other tests, some on paid plans.
	boss := owner(t)
	wsID := createWorkspace(t, boss, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId()
	o := register(t, invite(t, boss, wsID))
	fake := caldavtest.New("anna", "app-pass")
	defer fake.Close()
	calDAVCAs.AddCert(fake.Certificate())
	connect := &v1.ConnectCalDavRequest{Url: fake.URL + "/", Username: "anna", Password: "app-pass"}

	// Free: locked, nothing to connect.
	var resp v1.CalDavAccountResponse
	o.must(200, "GET", "/api/me/caldav", nil, &resp)
	if !resp.GetPlanLocked() || resp.GetAccount() != nil {
		t.Fatalf("free, no account: %v", &resp)
	}
	st, e := o.apiErrBody("POST", "/api/me/caldav", connect)
	wantPlanLimit(t, "connect on free", st, e, 0, 0)

	// Team: connects, imports.
	setPlan(t, wsID, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_TEAM})
	o.must(200, "POST", "/api/me/caldav", connect, &resp)
	o.must(200, "PUT", "/api/me/caldav", &v1.UpdateCalDavRequest{CalendarHref: fake.URL + fake.Calendar(), Import: true}, nil)
	o.must(200, "GET", "/api/me/caldav", nil, &resp)
	if resp.GetPlanLocked() || resp.GetAccount() == nil {
		t.Fatalf("team: %v", &resp)
	}

	// Back to Free: the account stays, every call that uses it is refused, sync is stopped.
	setPlan(t, wsID, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_FREE})
	o.must(200, "GET", "/api/me/caldav", nil, &resp)
	if !resp.GetPlanLocked() || resp.GetAccount().GetCalendarHref() == "" || !resp.GetAccount().GetImport() {
		t.Fatalf("free with an account: %v", &resp)
	}
	st, e = o.apiErrBody("POST", "/api/me/caldav/sync", nil)
	wantPlanLimit(t, "sync on free", st, e, 0, 0)
	st, e = o.apiErrBody("PUT", "/api/me/caldav", &v1.UpdateCalDavRequest{CalendarHref: fake.URL + fake.Calendar(), Import: true})
	wantPlanLimit(t, "update on free", st, e, 0, 0)
	st, e = o.apiErrBody("PATCH", "/api/me/caldav", &v1.SetCalDavShareRequest{ShareLevel: v1.CalDavShareLevel_CAL_DAV_SHARE_LEVEL_DETAILS})
	wantPlanLimit(t, "share on free", st, e, 0, 0)
	st, e = o.apiErrBody("GET", "/api/me/external-events?from=2026-10-05T00:00:00Z&to=2026-10-06T00:00:00Z", nil)
	wantPlanLimit(t, "external events on free", st, e, 0, 0)

	// A second workspace on Team lifts it for the person.
	ws2 := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId()
	setPlan(t, ws2, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_TEAM})
	o.must(200, "POST", "/api/me/caldav/sync", nil, &resp)
	if resp.GetPlanLocked() {
		t.Fatalf("second workspace on team: %v", &resp)
	}

	// Disconnecting is always allowed.
	setPlan(t, ws2, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_FREE})
	o.must(204, "DELETE", "/api/me/caldav", nil, nil)
}

// Web apps and task approvals are part of every plan (owner, 30.09): on Free they are not
// refused with PLAN_LIMIT. Telephony is Business only since 02.10 (TestSIPPlanBusinessOnly).
func TestPlanFreeHasAppsApprovals(t *testing.T) {
	withFreeLimits(t)
	o := owner(t)
	wsID := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId()
	bob := register(t, invite(t, o, wsID))
	b := createBoard(t, o, wsID, &v1.CreateBoardRequest{Name: "Plans", Key: "PLN", Template: v1.BoardTemplate_BOARD_TEMPLATE_DEVELOPMENT}, 201)
	todo := statusOf(b, v1.BoardStatusType_BOARD_STATUS_TYPE_UNSTARTED)
	newApp(t, o, wsID, "Grafana", "https://grafana.example.com", "")
	task := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "Согласовать", StatusId: todo, ApproverIds: []string{bob.id}}, 201)
	if task.GetApprovalState() != v1.TaskApprovalState_TASK_APPROVAL_STATE_PENDING {
		t.Fatalf("free approvals: %v", task)
	}
}

// Musician mode (ADR-0052) is Team and above: PATCH /api/voice/self {musician: true} in a Free
// workspace's room is 409 PLAN_LIMIT (used = limit = 0, like CalDAV), turning it off always
// works, and the same device is accepted once the workspace is on Team.
func TestPlanMusicianMode(t *testing.T) {
	liveKitUp(t)
	withFreeLimits(t)
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	rid := voiceRoom(t, o, ws.GetId(), "jam", 0)
	m := register(t, invite(t, o, ws.GetId()))
	joinPending(t, m, rid)
	on, off := true, false
	st, e := m.apiErrBody("PATCH", "/api/voice/self", &v1.UpdateVoiceSelfRequest{Musician: &on})
	wantPlanLimit(t, "musician on Free", st, e, 0, 0)
	m.must(204, "PATCH", "/api/voice/self", &v1.UpdateVoiceSelfRequest{Musician: &off}, nil)
	setPlan(t, ws.GetId(), &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_TEAM, Note: "paid"})
	m.must(204, "PATCH", "/api/voice/self", &v1.UpdateVoiceSelfRequest{Musician: &on}, nil)
}

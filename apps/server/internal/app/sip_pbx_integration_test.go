//go:build integration

package app_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/sip"
)

func memberExtension(t *testing.T, u *user, wid, target string) string {
	t.Helper()
	var p v1.GetMemberResponse
	u.must(200, "GET", "/api/workspaces/"+wid+"/members/"+target, nil, &p)
	return p.GetMember().GetExtension()
}

func routeTo(kind v1.SipRouteKind, id string) *v1.SipRouteTarget {
	return &v1.SipRouteTarget{Kind: kind, Id: id}
}

// TestSIPExchange (ADR-0117 step 1): numbers, groups and voice menus — who may manage them
// (MANAGE_INTEGRATIONS, never guests, bots by the bit, 404 outside), the plan, validation
// (number format and uniqueness, one number per member, members and targets of this workspace
// only), WorkspaceMember.extension, and that deleting a number, a group, a menu or a member is
// never blocked by a route (the route stays, missing).
func TestSIPExchange(t *testing.T) {
	ctx := context.Background()
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	base := "/api/workspaces/" + wid + "/sip"
	other := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	outsider := register(t, invite(t, o, other.GetId())) // a member of another workspace only
	carol := register(t, invite(t, o, wid))
	g := register(t, invite(t, o, wid))
	guest := v1.WorkspaceRole_WORKSPACE_ROLE_GUEST
	o.must(200, "PATCH", "/api/workspaces/"+wid+"/members/"+g.id, &v1.UpdateMemberRequest{Role: &guest}, nil)

	// The plan: telephony is Business; reading works below it, changes do not.
	o.must(200, "GET", base+"/extensions", nil, nil)
	if st, e := o.apiErrBody("POST", base+"/extensions", &v1.CreateSipExtensionRequest{Number: "101", UserId: bob.id}); st != 409 || e.GetReason() != "PLAN_LIMIT" {
		t.Fatalf("below the plan: %d %v", st, e)
	}
	setPlan(t, wid, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_ENTERPRISE})

	// Who: outsiders 404, members without the bit and guests 403; the number list is open to
	// members but not guests.
	outsider.must(404, "GET", base+"/extensions", nil, nil)
	outsider.must(404, "GET", base+"/groups", nil, nil)
	outsider.must(404, "POST", base+"/extensions", &v1.CreateSipExtensionRequest{Number: "101", UserId: bob.id}, nil)
	bob.must(200, "GET", base+"/extensions", nil, nil)
	g.must(403, "GET", base+"/extensions", nil, nil)
	for _, c := range []*user{bob, g} {
		c.must(403, "POST", base+"/extensions", &v1.CreateSipExtensionRequest{Number: "101", UserId: bob.id}, nil)
		c.must(403, "GET", base+"/groups", nil, nil)
		c.must(403, "GET", base+"/ivr", nil, nil)
		c.must(403, "POST", base+"/groups", &v1.CreateSipGroupRequest{Name: "x", Number: "1001"}, nil)
		c.must(403, "POST", base+"/ivr", &v1.CreateSipIvrMenuRequest{Name: "x"}, nil)
	}

	// Numbers: format, members only (not a guest, not an outsider), unique, one per member.
	for _, n := range []string{"1", "1234567", "12a", " 101", ""} {
		st, e := o.apiErrBody("POST", base+"/extensions", &v1.CreateSipExtensionRequest{Number: n, UserId: bob.id})
		if st != 422 || e.GetField() != "number" {
			t.Fatalf("number %q: %d %v", n, st, e)
		}
	}
	for _, u := range []string{g.id, outsider.id, "nope", ""} {
		st, e := o.apiErrBody("POST", base+"/extensions", &v1.CreateSipExtensionRequest{Number: "101", UserId: u})
		if st != 422 || e.GetField() != "userId" {
			t.Fatalf("user %q: %d %v", u, st, e)
		}
	}
	gw := dialGW(t)
	gw.identify(bob.token)
	var bobExt v1.SipExtensionResponse
	o.must(201, "POST", base+"/extensions", &v1.CreateSipExtensionRequest{Number: "101", UserId: bob.id, Description: " Бухгалтерия "}, &bobExt)
	if e := bobExt.GetExtension(); e.GetNumber() != "101" || e.GetKind() != v1.SipExtensionKind_SIP_EXTENSION_KIND_USER ||
		e.GetUserId() != bob.id || e.GetDescription() != "Бухгалтерия" {
		t.Fatalf("created: %v", e)
	}
	gw.wait("WORKSPACE_MEMBER_UPDATE with the number", func(e *v1.DispatchEvent) bool {
		u := e.GetWorkspaceMemberUpdate()
		return u != nil && u.GetMember().GetUser().GetId() == bob.id && u.GetMember().GetExtension() == "101"
	})
	if got := memberExtension(t, bob, wid, bob.id); got != "101" {
		t.Fatalf("member extension %q", got)
	}
	for _, c := range []struct {
		req   *v1.CreateSipExtensionRequest
		field string
	}{
		{&v1.CreateSipExtensionRequest{Number: "101", UserId: carol.id}, "number"},
		{&v1.CreateSipExtensionRequest{Number: "105", UserId: bob.id}, "userId"},
	} {
		st, e := o.apiErrBody("POST", base+"/extensions", c.req)
		if st != 409 || e.GetCode() != v1.ErrorCode_ERROR_CODE_SIP_EXTENSION_TAKEN || e.GetField() != c.field {
			t.Fatalf("%v: %d %v", c.req, st, e)
		}
	}
	// The same number in another workspace is fine (one numbering plan per workspace).
	setPlan(t, other.GetId(), &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_ENTERPRISE})
	var foreign v1.SipExtensionResponse
	o.must(201, "POST", "/api/workspaces/"+other.GetId()+"/sip/extensions", &v1.CreateSipExtensionRequest{Number: "101", UserId: outsider.id}, &foreign)

	// A bot gets a number like a person; a bot manages the exchange only with MANAGE_INTEGRATIONS.
	bt := createBot(t, o, wid, "operator")
	var botExt, carolExt v1.SipExtensionResponse
	o.must(201, "POST", base+"/extensions", &v1.CreateSipExtensionRequest{Number: "102", UserId: bt.id}, &botExt)
	if botExt.GetExtension().GetKind() != v1.SipExtensionKind_SIP_EXTENSION_KIND_BOT {
		t.Fatalf("bot number: %v", botExt.GetExtension())
	}
	wantHandler403(t, bt, bt.do("POST", base+"/extensions", &v1.CreateSipExtensionRequest{Number: "103", UserId: carol.id}, nil), "POST extensions")
	wantHandler403(t, bt, bt.do("GET", base+"/groups", nil, nil), "GET groups")
	giveBot(t, o, wid, bt, "Telephony", perm.ManageIntegrations)
	bt.must(201, "POST", base+"/extensions", &v1.CreateSipExtensionRequest{Number: "0103", UserId: carol.id}, &carolExt)

	// PATCH: number and description; unassign and reassign.
	num, desc := "100", "Касса"
	o.must(200, "PATCH", base+"/extensions/"+bobExt.GetExtension().GetId(), &v1.UpdateSipExtensionRequest{Number: &num, Description: &desc}, &bobExt)
	if bobExt.GetExtension().GetNumber() != "100" || memberExtension(t, o, wid, bob.id) != "100" {
		t.Fatalf("renumbered: %v", bobExt.GetExtension())
	}
	taken := "102"
	if st, e := o.apiErrBody("PATCH", base+"/extensions/"+bobExt.GetExtension().GetId(), &v1.UpdateSipExtensionRequest{Number: &taken}); st != 409 || e.GetField() != "number" {
		t.Fatalf("PATCH to a taken number: %d %v", st, e)
	}
	o.must(404, "PATCH", base+"/extensions/"+foreign.GetExtension().GetId(), &v1.UpdateSipExtensionRequest{Number: &num}, nil)
	o.must(404, "DELETE", base+"/extensions/"+foreign.GetExtension().GetId(), nil, nil)

	// Groups: members are numbers of people / bots of this workspace, each once.
	ids := func(exts ...*v1.SipExtensionResponse) *v1.SipGroupMembers {
		m := &v1.SipGroupMembers{}
		for _, e := range exts {
			m.ExtensionIds = append(m.ExtensionIds, e.GetExtension().GetId())
		}
		return m
	}
	group := func(number string, members *v1.SipGroupMembers) *v1.CreateSipGroupRequest {
		return &v1.CreateSipGroupRequest{Name: "Продажи", Number: number, Strategy: v1.SipGroupStrategy_SIP_GROUP_STRATEGY_ROUND_ROBIN, Members: members}
	}
	for _, c := range []struct {
		req   *v1.CreateSipGroupRequest
		code  v1.ErrorCode
		field string
	}{
		{group("100", ids(&botExt)), v1.ErrorCode_ERROR_CODE_SIP_EXTENSION_TAKEN, "number"},
		{group("1001", ids(&botExt, &botExt)), v1.ErrorCode_ERROR_CODE_VALIDATION, "members"},
		{group("1001", ids(&foreign)), v1.ErrorCode_ERROR_CODE_VALIDATION, "members"},
		{&v1.CreateSipGroupRequest{Name: " ", Number: "1001"}, v1.ErrorCode_ERROR_CODE_VALIDATION, "name"},
		{&v1.CreateSipGroupRequest{Name: "x", Number: "1001", RingSec: 5}, v1.ErrorCode_ERROR_CODE_VALIDATION, "ringSec"},
		{&v1.CreateSipGroupRequest{Name: "x", Number: "1001", FallbackEnabled: true, FallbackSec: 4}, v1.ErrorCode_ERROR_CODE_VALIDATION, "fallbackSec"},
		{&v1.CreateSipGroupRequest{Name: "x", Number: "1001", FallbackSec: 601}, v1.ErrorCode_ERROR_CODE_VALIDATION, "fallbackSec"},
		{&v1.CreateSipGroupRequest{Name: "x", Number: "1001", OnFail: routeTo(v1.SipRouteKind_SIP_ROUTE_KIND_REPEAT, "")}, v1.ErrorCode_ERROR_CODE_VALIDATION, "onFail"},
		{&v1.CreateSipGroupRequest{Name: "x", Number: "1001", OnFail: routeTo(v1.SipRouteKind_SIP_ROUTE_KIND_EXTENSION, foreign.GetExtension().GetId())}, v1.ErrorCode_ERROR_CODE_VALIDATION, "onFail"},
	} {
		st, e := o.apiErrBody("POST", base+"/groups", c.req)
		if st/100 != 4 || e.GetCode() != c.code || e.GetField() != c.field {
			t.Fatalf("%v: %d %v", c.req, st, e)
		}
	}
	var sales v1.SipGroupResponse
	req := group("1001", ids(&carolExt, &bobExt, &botExt))
	req.OnFail = routeTo(v1.SipRouteKind_SIP_ROUTE_KIND_EXTENSION, bobExt.GetExtension().GetId())
	o.must(201, "POST", base+"/groups", req, &sales)
	sg := sales.GetGroup()
	if sg.GetExtension().GetNumber() != "1001" || sg.GetExtension().GetKind() != v1.SipExtensionKind_SIP_EXTENSION_KIND_GROUP ||
		len(sg.GetMembers()) != 3 || sg.GetMembers()[0].GetExtensionId() != carolExt.GetExtension().GetId() || sg.GetMembers()[2].GetPosition() != 2 ||
		sg.GetRingSec() != 30 || sg.GetMemberRingSec() != 15 || sg.GetOnFail().GetKind() != v1.SipRouteKind_SIP_ROUTE_KIND_EXTENSION {
		t.Fatalf("group: %v", sg)
	}
	// A group's number is not a member, cannot be given to a person and goes only with the group.
	if st, e := o.apiErrBody("POST", base+"/groups", group("1002", &v1.SipGroupMembers{ExtensionIds: []string{sg.GetExtension().GetId()}})); st != 422 || e.GetField() != "members" {
		t.Fatalf("group number as a member: %d %v", st, e)
	}
	o.must(422, "PATCH", base+"/extensions/"+sg.GetExtension().GetId(), &v1.UpdateSipExtensionRequest{UserId: &bob.id}, nil)
	o.must(422, "DELETE", base+"/extensions/"+sg.GetExtension().GetId(), nil, nil)
	// PATCH: the order is replaced as a whole; the group's number changes.
	n2 := "2001"
	o.must(200, "PATCH", base+"/groups/"+sg.GetId(), &v1.UpdateSipGroupRequest{Number: &n2, Members: ids(&botExt, &carolExt)}, &sales)
	if sales.GetGroup().GetExtension().GetNumber() != "2001" || len(sales.GetGroup().GetMembers()) != 2 ||
		sales.GetGroup().GetMembers()[0].GetExtensionId() != botExt.GetExtension().GetId() {
		t.Fatalf("patched group: %v", sales.GetGroup())
	}
	// The fallback (ADR-0124): off by default, 30 s; switched on with its time; never the group
	// itself or its own number.
	if sales.GetGroup().GetFallbackEnabled() || sales.GetGroup().GetFallbackSec() != 30 {
		t.Fatalf("fallback default: %v", sales.GetGroup())
	}
	on, sec := true, uint32(45)
	o.must(200, "PATCH", base+"/groups/"+sg.GetId(), &v1.UpdateSipGroupRequest{FallbackEnabled: &on, FallbackSec: &sec}, &sales)
	if !sales.GetGroup().GetFallbackEnabled() || sales.GetGroup().GetFallbackSec() != 45 || sales.GetGroup().GetOnFail().GetId() != bobExt.GetExtension().GetId() {
		t.Fatalf("fallback on: %v", sales.GetGroup())
	}
	for _, self := range []*v1.SipRouteTarget{routeTo(v1.SipRouteKind_SIP_ROUTE_KIND_GROUP, sg.GetId()), routeTo(v1.SipRouteKind_SIP_ROUTE_KIND_EXTENSION, sg.GetExtension().GetId())} {
		if st, e := o.apiErrBody("PATCH", base+"/groups/"+sg.GetId(), &v1.UpdateSipGroupRequest{OnFail: self}); st != 422 || e.GetField() != "onFail" {
			t.Fatalf("fallback to itself: %d %v", st, e)
		}
	}
	bad := uint32(700)
	if st, e := o.apiErrBody("PATCH", base+"/groups/"+sg.GetId(), &v1.UpdateSipGroupRequest{FallbackSec: &bad}); st != 422 || e.GetField() != "fallbackSec" {
		t.Fatalf("fallback seconds: %d %v", st, e)
	}

	// Menus: keys 0-9 * #, each once; REPEAT only on keys; targets of this workspace; a group's
	// number is stored as the group.
	menuReq := func() *v1.CreateSipIvrMenuRequest {
		return &v1.CreateSipIvrMenuRequest{Name: "Главное", Items: &v1.SipIvrItems{Items: []*v1.SipIvrItem{
			{Digit: "1", Action: routeTo(v1.SipRouteKind_SIP_ROUTE_KIND_GROUP, sg.GetId())},
			{Digit: "2", Action: routeTo(v1.SipRouteKind_SIP_ROUTE_KIND_EXTENSION, sg.GetExtension().GetId())},
			{Digit: "3", Action: routeTo(v1.SipRouteKind_SIP_ROUTE_KIND_EXTENSION, bobExt.GetExtension().GetId())},
			{Digit: "4", Action: routeTo(v1.SipRouteKind_SIP_ROUTE_KIND_EXTENSION, carolExt.GetExtension().GetId())},
			{Digit: "*", Action: routeTo(v1.SipRouteKind_SIP_ROUTE_KIND_REPEAT, "")},
			{Digit: "0", Action: routeTo(v1.SipRouteKind_SIP_ROUTE_KIND_HANGUP, "")},
		}}}
	}
	for field, mut := range map[string]func(*v1.CreateSipIvrMenuRequest){
		"digit":  func(r *v1.CreateSipIvrMenuRequest) { r.Items.Items[0].Digit = "a" },
		"digit ": func(r *v1.CreateSipIvrMenuRequest) { r.Items.Items[1].Digit = "1" },
		"items": func(r *v1.CreateSipIvrMenuRequest) {
			r.Items.Items[0].Action = routeTo(v1.SipRouteKind_SIP_ROUTE_KIND_MENU, uuid.NewString())
		},
		"items ": func(r *v1.CreateSipIvrMenuRequest) {
			r.Items.Items[0].Action = routeTo(v1.SipRouteKind_SIP_ROUTE_KIND_EXTENSION, foreign.GetExtension().GetId())
		},
		"onNoInput":       func(r *v1.CreateSipIvrMenuRequest) { r.OnNoInput = routeTo(v1.SipRouteKind_SIP_ROUTE_KIND_REPEAT, "") },
		"inputTimeoutSec": func(r *v1.CreateSipIvrMenuRequest) { r.InputTimeoutSec = 30 },
		"repeats":         func(r *v1.CreateSipIvrMenuRequest) { r.Repeats = 9 },
		"promptSourceFileId": func(r *v1.CreateSipIvrMenuRequest) {
			r.PromptSourceFileId = soundUpload(t, bob, wid, "bob.wav", "audio/wav", toneWav(0.5)) // someone else's upload
		},
	} {
		r := menuReq()
		mut(r)
		st, e := o.apiErrBody("POST", base+"/ivr", r)
		if st != 422 || e.GetField() != trimField(field) {
			t.Fatalf("%s: %d %v", field, st, e)
		}
	}
	var main v1.SipIvrMenuResponse
	o.must(201, "POST", base+"/ivr", menuReq(), &main)
	mm := main.GetMenu()
	if len(mm.GetItems()) != 6 || mm.GetPromptStatus() != v1.SipPromptStatus_SIP_PROMPT_STATUS_NONE || mm.GetInputTimeoutSec() != 5 || mm.GetRepeats() != 3 {
		t.Fatalf("menu: %v", mm)
	}
	item := func(m *v1.SipIvrMenu, digit string) *v1.SipRouteTarget {
		for _, it := range m.GetItems() {
			if it.GetDigit() == digit {
				return it.GetAction()
			}
		}
		t.Fatalf("no key %s in %v", digit, m)
		return nil
	}
	if a := item(mm, "2"); a.GetKind() != v1.SipRouteKind_SIP_ROUTE_KIND_GROUP || a.GetId() != sg.GetId() {
		t.Fatalf("a group's number is stored as the group: %v", a)
	}
	// A menu falls back to another menu; another workspace's menu is unknown.
	var second v1.SipIvrMenuResponse
	o.must(201, "POST", base+"/ivr", &v1.CreateSipIvrMenuRequest{Name: "Ночь", OnNoInput: routeTo(v1.SipRouteKind_SIP_ROUTE_KIND_MENU, mm.GetId())}, &second)
	o.must(404, "PATCH", "/api/workspaces/"+other.GetId()+"/sip/ivr/"+mm.GetId(), &v1.UpdateSipIvrMenuRequest{}, nil)
	o.must(404, "PATCH", base+"/ivr/"+uuid.NewString(), &v1.UpdateSipIvrMenuRequest{}, nil)

	// The prompt: the caller's own upload, converted to Ogg/Opus (needs ffmpeg on the host);
	// readable by managers of the exchange, not by other members.
	src := soundUpload(t, o, wid, "prompt.wav", "audio/wav", toneWav(2))
	var withPrompt v1.SipIvrMenuResponse
	if st := o.do("PATCH", base+"/ivr/"+mm.GetId(), &v1.UpdateSipIvrMenuRequest{PromptSourceFileId: &src}, &withPrompt); st == 503 {
		t.Log("no ffmpeg on this host: prompt conversion not tested")
	} else if st != 200 {
		t.Fatalf("prompt: %d %s", st, o.lastBody)
	} else {
		p := withPrompt.GetMenu()
		if p.GetPromptStatus() != v1.SipPromptStatus_SIP_PROMPT_STATUS_READY || p.GetPromptFileId() == "" || p.GetPromptDurationMs() < 1900 || p.GetPromptDurationMs() > 2100 {
			t.Fatalf("prompt: %v", p)
		}
		bt.must(200, "GET", "/api/files/"+p.GetPromptFileId(), nil, nil)
		if st := bob.do("GET", "/api/files/"+p.GetPromptFileId(), nil, nil); st != 403 && st != 404 {
			t.Fatalf("a member reads the prompt: %d", st)
		}
		empty := ""
		o.must(200, "PATCH", base+"/ivr/"+mm.GetId(), &v1.UpdateSipIvrMenuRequest{PromptSourceFileId: &empty}, &withPrompt)
		if withPrompt.GetMenu().GetPromptFileId() != "" {
			t.Fatalf("prompt not removed: %v", withPrompt.GetMenu())
		}
		if _, err := testDB.Q.GetFile(ctx, uuid.MustParse(p.GetPromptFileId())); err == nil {
			t.Fatal("the old prompt file is kept")
		}
	}

	// Deletes are never blocked by routes; the routes stay, missing.
	o.must(204, "DELETE", base+"/extensions/"+bobExt.GetExtension().GetId(), nil, nil)
	if got := memberExtension(t, o, wid, bob.id); got != "" {
		t.Fatalf("bob keeps %q", got)
	}
	o.must(204, "DELETE", "/api/workspaces/"+wid+"/members/"+carol.id, nil, nil) // carol leaves: 0103 stays, unassigned
	var groups v1.ListSipGroupsResponse
	o.must(200, "GET", base+"/groups", nil, &groups)
	if gr := groups.GetGroups()[0]; len(gr.GetMembers()) != 2 || !gr.GetOnFail().GetMissing() || gr.GetOnFail().GetId() != "" {
		t.Fatalf("group after deletes: %v", gr)
	}
	var menus v1.ListSipIvrMenusResponse
	o.must(200, "GET", base+"/ivr", nil, &menus)
	var got *v1.SipIvrMenu
	for _, m := range menus.GetMenus() {
		if m.GetId() == mm.GetId() {
			got = m
		}
	}
	if a := item(got, "3"); !a.GetMissing() || a.GetId() != "" {
		t.Fatalf("key 3 after its number went: %v", a)
	}
	if a := item(got, "4"); !a.GetMissing() || a.GetId() != carolExt.GetExtension().GetId() {
		t.Fatalf("key 4 after its member left: %v", a)
	}
	var exts v1.ListSipExtensionsResponse
	o.must(200, "GET", base+"/extensions", nil, &exts)
	for _, e := range exts.GetExtensions() {
		if e.GetId() == carolExt.GetExtension().GetId() && e.GetUserId() != "" {
			t.Fatalf("the number of a member who left: %v", e)
		}
	}
	o.must(204, "DELETE", base+"/groups/"+sg.GetId(), nil, nil)
	o.must(204, "DELETE", base+"/ivr/"+mm.GetId(), nil, nil)
	o.must(200, "GET", base+"/ivr", nil, &menus)
	if len(menus.GetMenus()) != 1 || !menus.GetMenus()[0].GetOnNoInput().GetMissing() {
		t.Fatalf("menus after deletes: %v", menus.GetMenus())
	}
	o.must(200, "GET", base+"/extensions", nil, &exts)
	for _, e := range exts.GetExtensions() {
		if e.GetNumber() == "2001" {
			t.Fatal("the group's number outlived the group")
		}
	}

	// A member made a guest loses the number (it stays, unassigned).
	dave := register(t, invite(t, o, wid))
	o.must(201, "POST", base+"/extensions", &v1.CreateSipExtensionRequest{Number: "104", UserId: dave.id}, nil)
	var demoted v1.UpdateMemberResponse
	o.must(200, "PATCH", "/api/workspaces/"+wid+"/members/"+dave.id, &v1.UpdateMemberRequest{Role: &guest}, &demoted)
	if demoted.GetMember().GetExtension() != "" {
		t.Fatalf("a guest shows a number: %v", demoted.GetMember())
	}
	o.must(200, "GET", base+"/extensions", nil, &exts)
	for _, e := range exts.GetExtensions() {
		if e.GetNumber() == "104" && e.GetUserId() != "" {
			t.Fatalf("a guest keeps a number: %v", e)
		}
	}

	// Routing stays off on a server without an IVR worker (the shared instance).
	if _, err := testApp.SIP.RouteInbound(ctx, uuid.MustParse(wid), sip.Target{Kind: sip.RouteHangup}, nil); !errors.Is(err, sip.ErrInboundDisabled) {
		t.Fatalf("RouteInbound without an IVR worker: %v", err)
	}
	var s v1.GetSipSettingsResponse
	o.must(200, "GET", base, nil, &s)
	if s.GetSettings().GetInboundAvailable() {
		t.Fatal("inbound_available without an IVR worker")
	}
}

// TestSIPExtensionHiddenFromGuests (ADR-0117 §3): WorkspaceMember.extension is for the members
// who are not guests — a guest who sees a colleague (REST list and member, READY, the
// WORKSPACE_MEMBER_UPDATE of the new number) never gets the colleague's number.
func TestSIPExtensionHiddenFromGuests(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	setPlan(t, wid, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_ENTERPRISE})
	rid := textRoom(t, o, wid, "general", false)
	link := roomLink(t, o, rid, &v1.CreateRoomInviteRequest{})
	other := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	carol := register(t, invite(t, o, other.GetId()))
	carol.must(200, "POST", "/api/room-invites/"+link.GetCode()+"/join", nil, nil)
	send(t, bob, rid, "привет", "") // bob becomes visible to the guest

	og, cg := dialGW(t), dialGW(t)
	og.identify(o.token)
	cg.identify(carol.token)
	o.must(201, "POST", "/api/workspaces/"+wid+"/sip/extensions", &v1.CreateSipExtensionRequest{Number: "101", UserId: bob.id}, nil)
	og.wait("member's WORKSPACE_MEMBER_UPDATE with the number", func(e *v1.DispatchEvent) bool {
		m := e.GetWorkspaceMemberUpdate().GetMember()
		return m.GetUser().GetId() == bob.id && m.GetExtension() == "101"
	})
	cg.wait("guest's WORKSPACE_MEMBER_UPDATE", func(e *v1.DispatchEvent) bool {
		m := e.GetWorkspaceMemberUpdate().GetMember()
		return m.GetUser().GetId() == bob.id && m.GetExtension() == ""
	})
	cg.quiet("guest: no copy with the number", 300*time.Millisecond, func(e *v1.DispatchEvent) bool {
		return e.GetWorkspaceMemberUpdate().GetMember().GetExtension() != ""
	})

	extOf := func(ms []*v1.WorkspaceMember) (string, bool) {
		for _, m := range ms {
			if m.GetUser().GetId() == bob.id {
				return m.GetExtension(), true
			}
		}
		return "", false
	}
	if ext, ok := extOf(listMembers(t, o.client, wid)); !ok || ext != "101" {
		t.Fatalf("member's list: %q %v", ext, ok)
	}
	if ext, ok := extOf(listMembers(t, carol.client, wid)); !ok || ext != "" {
		t.Fatalf("guest's list: %q %v", ext, ok)
	}
	if got := memberExtension(t, carol, wid, bob.id); got != "" {
		t.Fatalf("guest's GET member: %q", got)
	}
	if ext, ok := extOf(guestSnapshot(t, dialGW(t).identify(carol.token), wid).GetMembers()); !ok || ext != "" {
		t.Fatalf("guest's READY: %q %v", ext, ok)
	}
	if ext, _ := extOf(guestSnapshot(t, dialGW(t).identify(o.token), wid).GetMembers()); ext != "101" {
		t.Fatalf("member's READY: %q", ext)
	}
}

func trimField(f string) string {
	for len(f) > 0 && f[len(f)-1] == ' ' {
		f = f[:len(f)-1]
	}
	return f
}

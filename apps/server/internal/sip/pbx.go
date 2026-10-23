package sip

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"

	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/files"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
)

// The exchange of a workspace (ADR-0117 step 1): internal numbers, call groups and voice menus,
// managed with MANAGE_INTEGRATIONS (bots by the same bit, ADR-0109), never by guests. Every
// change runs under the workspace's exchange lock against a fresh copy of the whole exchange
// (a few hundred rows at most), so the checks below (unique numbers, one number per member,
// targets of this workspace, limits) cannot race; the composite FKs of the migration guard the
// same rules in the database.

// Limits of the exchange.
const (
	MaxExtensions   = 500
	MaxGroups       = 50
	MaxGroupMembers = 20
	MaxMenus        = 20
	MaxMenuItems    = 12
	maxPBXName      = 64
	maxExtDesc      = 64
	// DirectRingSec: how long a single number rings when a route leads to it (ADR-0117 §4).
	DirectRingSec = 30
)

var (
	extNumberRe = regexp.MustCompile(`^[0-9]{2,6}$`)
	digitRe     = regexp.MustCompile(`^[0-9*#]$`)
	// ErrInboundDisabled means the server does not route inbound calls (no LiveKit or no IVR
	// worker token).
	ErrInboundDisabled = errors.New("sip: inbound calls are off on this server")
)

func extTaken(field, msg string) *httpx.Error {
	e := httpx.Coded(http.StatusConflict, v1.ErrorCode_ERROR_CODE_SIP_EXTENSION_TAKEN, msg)
	e.Field = field
	return e
}

func (s *Service) pbxRoutes(mux httpx.Router, wrap func(http.Handler) http.Handler) {
	mux.Handle("GET /api/workspaces/{id}/sip/extensions", wrap(httpx.HandlerFunc(s.listExtensions)))
	mux.Handle("POST /api/workspaces/{id}/sip/extensions", wrap(httpx.HandlerFunc(s.createExtension)))
	mux.Handle("PATCH /api/workspaces/{id}/sip/extensions/{eid}", wrap(httpx.HandlerFunc(s.updateExtension)))
	mux.Handle("DELETE /api/workspaces/{id}/sip/extensions/{eid}", wrap(httpx.HandlerFunc(s.deleteExtension)))
	mux.Handle("GET /api/workspaces/{id}/sip/groups", wrap(httpx.HandlerFunc(s.listGroups)))
	mux.Handle("POST /api/workspaces/{id}/sip/groups", wrap(httpx.HandlerFunc(s.createGroup)))
	mux.Handle("PATCH /api/workspaces/{id}/sip/groups/{gid}", wrap(httpx.HandlerFunc(s.updateGroup)))
	mux.Handle("DELETE /api/workspaces/{id}/sip/groups/{gid}", wrap(httpx.HandlerFunc(s.deleteGroup)))
	mux.Handle("GET /api/workspaces/{id}/sip/ivr", wrap(httpx.HandlerFunc(s.listMenus)))
	mux.Handle("POST /api/workspaces/{id}/sip/ivr", wrap(httpx.HandlerFunc(s.createMenu)))
	mux.Handle("PATCH /api/workspaces/{id}/sip/ivr/{mid}", wrap(httpx.HandlerFunc(s.updateMenu)))
	mux.Handle("DELETE /api/workspaces/{id}/sip/ivr/{mid}", wrap(httpx.HandlerFunc(s.deleteMenu)))
}

// ---------------------------------------------------------------- the loaded exchange

// exchange is the whole exchange of one workspace.
type exchange struct {
	exts     []sqlc.SipExtension
	ext      map[uuid.UUID]sqlc.SipExtension
	byNumber map[string]uuid.UUID
	byUser   map[uuid.UUID]uuid.UUID // member → their number
	people   map[uuid.UUID]sqlc.ListSipRouteMembersRow
	groups   []sqlc.SipGroup
	group    map[uuid.UUID]sqlc.SipGroup
	groupExt map[uuid.UUID]sqlc.SipExtension // group → its number
	members  map[uuid.UUID][]sqlc.SipGroupMember
	menus    []sqlc.SipIvrMenu
	menu     map[uuid.UUID]sqlc.SipIvrMenu
	items    map[uuid.UUID][]sqlc.SipIvrItem
}

func loadExchange(ctx context.Context, q *sqlc.Queries, wsID uuid.UUID) (*exchange, error) {
	ex := &exchange{ext: map[uuid.UUID]sqlc.SipExtension{}, byNumber: map[string]uuid.UUID{}, byUser: map[uuid.UUID]uuid.UUID{},
		people: map[uuid.UUID]sqlc.ListSipRouteMembersRow{}, group: map[uuid.UUID]sqlc.SipGroup{},
		groupExt: map[uuid.UUID]sqlc.SipExtension{}, members: map[uuid.UUID][]sqlc.SipGroupMember{},
		menu: map[uuid.UUID]sqlc.SipIvrMenu{}, items: map[uuid.UUID][]sqlc.SipIvrItem{}}
	var err error
	if ex.exts, err = q.ListSipExtensions(ctx, wsID); err != nil {
		return nil, err
	}
	for _, e := range ex.exts {
		ex.ext[e.ID] = e
		ex.byNumber[e.Number] = e.ID
		if e.UserID != nil {
			ex.byUser[*e.UserID] = e.ID
		}
		if e.GroupID != nil {
			ex.groupExt[*e.GroupID] = e
		}
	}
	people, err := q.ListSipRouteMembers(ctx, wsID)
	if err != nil {
		return nil, err
	}
	for _, p := range people {
		ex.people[p.ExtensionID] = p
	}
	if ex.groups, err = q.ListSipGroups(ctx, wsID); err != nil {
		return nil, err
	}
	for _, g := range ex.groups {
		ex.group[g.ID] = g
	}
	members, err := q.ListSipGroupMembers(ctx, wsID)
	if err != nil {
		return nil, err
	}
	for _, m := range members {
		ex.members[m.GroupID] = append(ex.members[m.GroupID], m)
	}
	if ex.menus, err = q.ListSipIvrMenus(ctx, wsID); err != nil {
		return nil, err
	}
	for _, m := range ex.menus {
		ex.menu[m.ID] = m
	}
	items, err := q.ListSipIvrItems(ctx, wsID)
	if err != nil {
		return nil, err
	}
	for _, it := range items {
		ex.items[it.MenuID] = append(ex.items[it.MenuID], it)
	}
	return ex, nil
}

// ---------------------------------------------------------------- targets

// dbTarget is a route as stored: a kind and the FK column of that kind.
type dbTarget struct {
	kind             string
	menu, ext, group *uuid.UUID
}

var routeKindToDB = map[v1.SipRouteKind]string{
	v1.SipRouteKind_SIP_ROUTE_KIND_UNSPECIFIED: "hangup",
	v1.SipRouteKind_SIP_ROUTE_KIND_HANGUP:      "hangup",
	v1.SipRouteKind_SIP_ROUTE_KIND_REPEAT:      "repeat",
	v1.SipRouteKind_SIP_ROUTE_KIND_MENU:        "menu",
	v1.SipRouteKind_SIP_ROUTE_KIND_EXTENSION:   "extension",
	v1.SipRouteKind_SIP_ROUTE_KIND_GROUP:       "group",
}

var routeKindFromDB = map[string]v1.SipRouteKind{
	"hangup":    v1.SipRouteKind_SIP_ROUTE_KIND_HANGUP,
	"repeat":    v1.SipRouteKind_SIP_ROUTE_KIND_REPEAT,
	"menu":      v1.SipRouteKind_SIP_ROUTE_KIND_MENU,
	"extension": v1.SipRouteKind_SIP_ROUTE_KIND_EXTENSION,
	"group":     v1.SipRouteKind_SIP_ROUTE_KIND_GROUP,
}

// parseTarget validates a route of the request against the exchange: the object exists in
// this workspace; a group's number becomes the group; REPEAT only for keys of a menu.
func (ex *exchange) parseTarget(t *v1.SipRouteTarget, field string, allowRepeat bool) (dbTarget, error) {
	bad := httpx.Validation(field, "unknown route target")
	kind, ok := routeKindToDB[t.GetKind()]
	if !ok || (kind == "repeat" && !allowRepeat) {
		return dbTarget{}, bad
	}
	if kind == "hangup" || kind == "repeat" {
		return dbTarget{kind: kind}, nil
	}
	id, err := uuid.Parse(t.GetId())
	if err != nil {
		return dbTarget{}, bad
	}
	switch kind {
	case "menu":
		if _, ok := ex.menu[id]; !ok {
			return dbTarget{}, bad
		}
		return dbTarget{kind: kind, menu: &id}, nil
	case "extension":
		e, ok := ex.ext[id]
		if !ok {
			return dbTarget{}, bad
		}
		if e.GroupID != nil {
			g := *e.GroupID
			return dbTarget{kind: "group", group: &g}, nil
		}
		return dbTarget{kind: kind, ext: &id}, nil
	default: // group
		if _, ok := ex.group[id]; !ok {
			return dbTarget{}, bad
		}
		return dbTarget{kind: kind, group: &id}, nil
	}
}

func idOf(p *uuid.UUID) string {
	if p == nil {
		return ""
	}
	return p.String()
}

// targetPB: missing = the object of the route was deleted, or a person's number has nobody.
func (ex *exchange) targetPB(kind string, menu, ext, group *uuid.UUID) *v1.SipRouteTarget {
	out := &v1.SipRouteTarget{Kind: routeKindFromDB[kind]}
	switch kind {
	case "menu":
		out.Id, out.Missing = idOf(menu), menu == nil
	case "extension":
		out.Id, out.Missing = idOf(ext), ext == nil
		if ext != nil {
			if _, ok := ex.people[*ext]; !ok {
				out.Missing = true
			}
		}
	case "group":
		out.Id, out.Missing = idOf(group), group == nil
	}
	return out
}

// ---------------------------------------------------------------- protobuf

func (ex *exchange) extPB(e sqlc.SipExtension) *v1.SipExtension {
	out := &v1.SipExtension{Id: e.ID.String(), WorkspaceId: e.WorkspaceID.String(), Number: e.Number,
		UserId: idOf(e.UserID), GroupId: idOf(e.GroupID), Description: e.Description, CreatedAt: timestamppb.New(e.CreatedAt),
		ExternalBlocked: e.ExternalBlocked}
	switch {
	case e.Kind == "group":
		out.Kind = v1.SipExtensionKind_SIP_EXTENSION_KIND_GROUP
		if e.GroupID != nil {
			out.GroupName = ex.group[*e.GroupID].Name
		}
	case ex.people[e.ID].IsBot:
		out.Kind = v1.SipExtensionKind_SIP_EXTENSION_KIND_BOT
	default:
		out.Kind = v1.SipExtensionKind_SIP_EXTENSION_KIND_USER
	}
	return out
}

var strategyToDB = map[v1.SipGroupStrategy]string{
	v1.SipGroupStrategy_SIP_GROUP_STRATEGY_UNSPECIFIED: "ring_all",
	v1.SipGroupStrategy_SIP_GROUP_STRATEGY_RING_ALL:    "ring_all",
	v1.SipGroupStrategy_SIP_GROUP_STRATEGY_ROUND_ROBIN: "round_robin",
}

func (ex *exchange) groupPB(g sqlc.SipGroup) *v1.SipGroup {
	out := &v1.SipGroup{Id: g.ID.String(), WorkspaceId: g.WorkspaceID.String(), Name: g.Name,
		Strategy: v1.SipGroupStrategy_SIP_GROUP_STRATEGY_RING_ALL, RingSec: uint32(max(g.RingSec, 0)), //nolint:gosec // 10..60
		MemberRingSec: uint32(max(g.MemberRingSec, 0)), //nolint:gosec // 5..60
		OnFail:        ex.targetPB(g.OnFailKind, g.OnFailMenuID, g.OnFailExtensionID, g.OnFailGroupID),
		Members:       []*v1.SipGroupMember{}, UpdatedAt: timestamppb.New(g.UpdatedAt),
		FallbackEnabled: g.FallbackEnabled, FallbackSec: uint32(max(g.FallbackSec, 0))} //nolint:gosec // 5..600
	if g.Strategy == "round_robin" {
		out.Strategy = v1.SipGroupStrategy_SIP_GROUP_STRATEGY_ROUND_ROBIN
	}
	if e, ok := ex.groupExt[g.ID]; ok {
		out.Extension = ex.extPB(e)
	}
	for _, m := range ex.members[g.ID] {
		out.Members = append(out.Members, &v1.SipGroupMember{ExtensionId: m.ExtensionID.String(), Position: uint32(max(m.Position, 0))}) //nolint:gosec // 0..19
	}
	return out
}

func (ex *exchange) menuPB(m sqlc.SipIvrMenu) *v1.SipIvrMenu {
	out := &v1.SipIvrMenu{Id: m.ID.String(), WorkspaceId: m.WorkspaceID.String(), Name: m.Name, PromptFileId: idOf(m.PromptFileID),
		PromptStatus: v1.SipPromptStatus_SIP_PROMPT_STATUS_NONE, PromptDurationMs: uint32(max(m.PromptDurationMs, 0)), //nolint:gosec // ≤ 180000
		InputTimeoutSec: uint32(max(m.InputTimeoutSec, 0)), Repeats: uint32(max(m.Repeats, 0)), //nolint:gosec // small
		OnNoInput: ex.targetPB(m.NoInputKind, m.NoInputMenuID, m.NoInputExtensionID, m.NoInputGroupID),
		Items:     []*v1.SipIvrItem{}, UpdatedAt: timestamppb.New(m.UpdatedAt), UpdatedBy: idOf(m.UpdatedBy), DialExtensions: m.DialExtensions,
		NoticeFileId: idOf(m.NoticeFileID), NoticeDurationMs: uint32(max(m.NoticeDurationMs, 0))} //nolint:gosec // ≤ 180000
	if m.PromptFileID != nil {
		out.PromptStatus = v1.SipPromptStatus_SIP_PROMPT_STATUS_READY
	}
	for _, it := range ex.items[m.ID] {
		out.Items = append(out.Items, &v1.SipIvrItem{Digit: it.Digit,
			Action: ex.targetPB(it.ActionKind, it.ActionMenuID, it.ActionExtensionID, it.ActionGroupID)})
	}
	return out
}

// ---------------------------------------------------------------- access

// manageExchange is manage plus the telephony plan for changes (409 PLAN_LIMIT).
func (s *Service) manageExchange(r *http.Request) (uuid.UUID, error) {
	wsID, err := manage(r)
	if err != nil {
		return wsID, err
	}
	return wsID, s.planAllows(r.Context(), wsID)
}

// change runs fn under the exchange lock with the exchange loaded in the transaction.
func (s *Service) change(ctx context.Context, wsID uuid.UUID, fn func(q *sqlc.Queries, ex *exchange) error) error {
	return s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if err := q.LockSipPBX(ctx, wsID); err != nil {
			return err
		}
		ex, err := loadExchange(ctx, q, wsID)
		if err != nil {
			return err
		}
		return fn(q, ex)
	})
}

// reload is the exchange after a change, for the response.
func (s *Service) reload(ctx context.Context, wsID uuid.UUID) (*exchange, error) {
	return loadExchange(ctx, s.db.Q, wsID)
}

// announceMembers sends WORKSPACE_MEMBER_UPDATE for members whose number changed.
func (s *Service) announceMembers(ctx context.Context, wsID uuid.UUID, users ...*uuid.UUID) {
	seen := map[uuid.UUID]bool{}
	for _, u := range users {
		if u == nil || seen[*u] {
			continue
		}
		seen[*u] = true
		m, err := s.db.Q.GetMember(ctx, sqlc.GetMemberParams{WorkspaceID: wsID, UserID: *u})
		if err != nil {
			if !db.IsNotFound(err) {
				slog.WarnContext(ctx, "sip: member update", "workspace", wsID, "user", *u, "err", err)
			}
			continue
		}
		usr, err := s.db.Q.GetUser(ctx, *u)
		if err != nil {
			slog.WarnContext(ctx, "sip: member update", "workspace", wsID, "user", *u, "err", err)
			continue
		}
		ids, err := s.db.Q.ListMemberRoleIDs(ctx, sqlc.ListMemberRoleIDsParams{WorkspaceID: wsID, UserID: *u})
		if err != nil {
			slog.WarnContext(ctx, "sip: member update", "workspace", wsID, "user", *u, "err", err)
			continue
		}
		s.events.Workspace(ctx, wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceMemberUpdate{
			WorkspaceMemberUpdate: &v1.WorkspaceMemberUpdate{Member: pbconv.Member(m, usr, ids)}}})
	}
}

// ---------------------------------------------------------------- validation

func pbxName(raw string) (string, error) {
	n, ok := cleanText(raw, maxPBXName)
	if !ok || n == "" {
		return "", httpx.Validation("name", "name must be 1.."+strconv.Itoa(maxPBXName)+" characters without control characters")
	}
	return n, nil
}

func extNumber(raw, field string) (string, error) {
	if !extNumberRe.MatchString(raw) {
		return "", httpx.Validation(field, "a number is 2 to 6 digits")
	}
	return raw, nil
}

func extDescription(raw string) (string, error) {
	d, ok := cleanText(raw, maxExtDesc)
	if !ok {
		return "", httpx.Validation("description", "description must be up to "+strconv.Itoa(maxExtDesc)+" characters without control characters")
	}
	return d, nil
}

// numberFree: number is not taken in the exchange (except by self).
func (ex *exchange) numberFree(number string, self *uuid.UUID) error {
	if id, ok := ex.byNumber[number]; ok && (self == nil || id != *self) {
		return extTaken("number", "this number is taken")
	}
	return nil
}

// assignable checks a member for a number: a member of the workspace, not a guest, without
// another number (self = the number being changed).
func (ex *exchange) assignable(ctx context.Context, q *sqlc.Queries, wsID uuid.UUID, raw string, self *uuid.UUID) (uuid.UUID, error) {
	bad := httpx.Validation("userId", "a member of the workspace who is not a guest")
	u, err := uuid.Parse(raw)
	if err != nil {
		return u, bad
	}
	m, err := q.GetMember(ctx, sqlc.GetMemberParams{WorkspaceID: wsID, UserID: u})
	if db.IsNotFound(err) {
		return u, bad
	}
	if err != nil {
		return u, err
	}
	if perm.Role(m.Role) == perm.RoleGuest {
		return u, bad
	}
	if id, ok := ex.byUser[u]; ok && (self == nil || id != *self) {
		return u, extTaken("userId", "this member already has a number")
	}
	return u, nil
}

// Fallback timeout of a group (ADR-0124), seconds.
const (
	fallbackSecDefault = 30
	fallbackSecMin     = 5
	fallbackSecMax     = 600
)

// groupFallback validates a group's fallback action: a route of the workspace (parseTarget),
// never the group itself or its own number (it would only ring the same people again).
func (ex *exchange) groupFallback(t *v1.SipRouteTarget, self *uuid.UUID) (dbTarget, error) {
	fail, err := ex.parseTarget(t, "onFail", false)
	if err != nil {
		return fail, err
	}
	if self != nil {
		own := fail.group != nil && *fail.group == *self
		if e, ok := ex.groupExt[*self]; ok && fail.ext != nil && *fail.ext == e.ID {
			own = true
		}
		if own {
			return fail, httpx.Validation("onFail", "a group cannot fall back to itself")
		}
	}
	return fail, nil
}

func ringSec(v uint32, def, lo, hi int32, field string) (int32, error) {
	if v == 0 {
		return def, nil
	}
	if v < uint32(lo) || v > uint32(hi) { //nolint:gosec // positive constants
		return 0, httpx.Validation(field, "must be "+strconv.Itoa(int(lo))+" to "+strconv.Itoa(int(hi)))
	}
	return int32(v), nil //nolint:gosec // ≤ hi
}

// groupMembers validates the ordered member list: numbers of people or bots of this
// workspace, each once, at most MaxGroupMembers.
func (ex *exchange) groupMembers(m *v1.SipGroupMembers) ([]uuid.UUID, error) {
	bad := httpx.Validation("members", "members are up to "+strconv.Itoa(MaxGroupMembers)+" different numbers of people or bots")
	ids := m.GetExtensionIds()
	if len(ids) > MaxGroupMembers {
		return nil, bad
	}
	out := make([]uuid.UUID, 0, len(ids))
	seen := map[uuid.UUID]bool{}
	for _, raw := range ids {
		id, err := uuid.Parse(raw)
		if err != nil || seen[id] {
			return nil, bad
		}
		e, ok := ex.ext[id]
		if !ok || e.Kind != "user" {
			return nil, bad
		}
		seen[id] = true
		out = append(out, id)
	}
	return out, nil
}

// menuItems validates the keys of a menu: one item per digit 0-9 * #, REPEAT allowed.
type menuItem struct {
	digit  string
	target dbTarget
}

func (ex *exchange) menuItems(in *v1.SipIvrItems) ([]menuItem, error) {
	if len(in.GetItems()) > MaxMenuItems {
		return nil, httpx.Validation("items", "at most "+strconv.Itoa(MaxMenuItems)+" keys")
	}
	out := make([]menuItem, 0, len(in.GetItems()))
	seen := map[string]bool{}
	for _, it := range in.GetItems() {
		if !digitRe.MatchString(it.GetDigit()) || seen[it.GetDigit()] {
			return nil, httpx.Validation("digit", "a key is one of 0-9, * and #, each once")
		}
		seen[it.GetDigit()] = true
		t, err := ex.parseTarget(it.GetAction(), "items", true)
		if err != nil {
			return nil, err
		}
		out = append(out, menuItem{digit: it.GetDigit(), target: t})
	}
	return out, nil
}

// ---------------------------------------------------------------- numbers

// listExtensions: GET …/sip/extensions — every member but guests (the numbers are shown to the
// team), bots by the same rule.
func (s *Service) listExtensions(w http.ResponseWriter, r *http.Request) error {
	wsID, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return err
	}
	_, role, err := perm.FromContext(r.Context()).Workspace(r.Context(), wsID, uid(r))
	if errors.Is(err, perm.ErrNotMember) {
		return httpx.NotFound("workspace")
	}
	if err != nil {
		return err
	}
	if role == perm.RoleGuest {
		return httpx.Forbidden("guests do not see the numbers")
	}
	ex, err := s.reload(r.Context(), wsID)
	if err != nil {
		return err
	}
	out := &v1.ListSipExtensionsResponse{Extensions: make([]*v1.SipExtension, 0, len(ex.exts))}
	for _, e := range ex.exts {
		out.Extensions = append(out.Extensions, ex.extPB(e))
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

func (s *Service) createExtension(w http.ResponseWriter, r *http.Request) error {
	wsID, err := s.manageExchange(r)
	if err != nil {
		return err
	}
	var req v1.CreateSipExtensionRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	number, err := extNumber(req.GetNumber(), "number")
	if err != nil {
		return err
	}
	desc, err := extDescription(req.GetDescription())
	if err != nil {
		return err
	}
	ctx, me := r.Context(), uid(r)
	var created sqlc.SipExtension
	err = s.change(ctx, wsID, func(q *sqlc.Queries, ex *exchange) error {
		if len(ex.exts) >= MaxExtensions {
			return httpx.Conflict("a workspace has at most " + strconv.Itoa(MaxExtensions) + " numbers")
		}
		if err := ex.numberFree(number, nil); err != nil {
			return err
		}
		user, err := ex.assignable(ctx, q, wsID, req.GetUserId(), nil)
		if err != nil {
			return err
		}
		if created, err = q.InsertSipExtension(ctx, sqlc.InsertSipExtensionParams{WorkspaceID: wsID, Number: number, Kind: "user",
			UserID: &user, Description: desc, CreatedBy: &me, ExternalBlocked: req.GetExternalBlocked()}); err != nil {
			return err
		}
		_, err = q.SetMemberSipExtension(ctx, sqlc.SetMemberSipExtensionParams{WorkspaceID: wsID, UserID: user, SipExtension: number})
		return err
	})
	if err := uniqueTaken(err); err != nil {
		return err
	}
	slog.InfoContext(ctx, "sip: extension created", "workspace", wsID, "by", me, "number", created.Number, "user", idOf(created.UserID))
	s.announceMembers(ctx, wsID, created.UserID)
	return s.writeExtension(w, r, wsID, created.ID, http.StatusCreated)
}

// uniqueTaken maps a unique violation the exchange lock did not prevent (it always should) to
// the same answers as the checks.
func uniqueTaken(err error) error {
	switch db.UniqueViolation(err) {
	case "":
		return err
	case "sip_extensions_user_idx":
		return extTaken("userId", "this member already has a number")
	default:
		return extTaken("number", "this number is taken")
	}
}

func (s *Service) writeExtension(w http.ResponseWriter, r *http.Request, wsID, id uuid.UUID, status int) error {
	ex, err := s.reload(r.Context(), wsID)
	if err != nil {
		return err
	}
	e, ok := ex.ext[id]
	if !ok {
		return httpx.NotFound("extension")
	}
	httpx.Write(w, status, &v1.SipExtensionResponse{Extension: ex.extPB(e)})
	return nil
}

func (s *Service) updateExtension(w http.ResponseWriter, r *http.Request) error {
	wsID, err := s.manageExchange(r)
	if err != nil {
		return err
	}
	id, err := httpx.PathUUID(r, "eid", "extension")
	if err != nil {
		return err
	}
	var req v1.UpdateSipExtensionRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	ctx := r.Context()
	var before, after sqlc.SipExtension
	err = s.change(ctx, wsID, func(q *sqlc.Queries, ex *exchange) error {
		cur, ok := ex.ext[id]
		if !ok {
			return httpx.NotFound("extension")
		}
		before = cur
		number, desc, user, blocked := cur.Number, cur.Description, cur.UserID, cur.ExternalBlocked
		var err error
		if req.ExternalBlocked != nil {
			if cur.Kind == "group" && req.GetExternalBlocked() {
				return httpx.Validation("externalBlocked", "a group's number is always open to callers")
			}
			blocked = req.GetExternalBlocked()
		}
		if req.Number != nil {
			if number, err = extNumber(req.GetNumber(), "number"); err != nil {
				return err
			}
			if err := ex.numberFree(number, &id); err != nil {
				return err
			}
		}
		if req.Description != nil {
			if desc, err = extDescription(req.GetDescription()); err != nil {
				return err
			}
		}
		if req.UserId != nil {
			if cur.Kind == "group" {
				return httpx.Validation("userId", "a group's number has no member")
			}
			user = nil
			if req.GetUserId() != "" {
				u, err := ex.assignable(ctx, q, wsID, req.GetUserId(), &id)
				if err != nil {
					return err
				}
				user = &u
			}
		}
		if after, err = q.UpdateSipExtension(ctx, sqlc.UpdateSipExtensionParams{ID: id, WorkspaceID: wsID, Number: number,
			UserID: user, Description: desc, ExternalBlocked: blocked}); err != nil {
			return err
		}
		if before.UserID != nil && (after.UserID == nil || *after.UserID != *before.UserID) {
			if err := clearMemberNumber(ctx, q, wsID, *before.UserID); err != nil {
				return err
			}
		}
		if after.UserID != nil {
			if _, err := q.SetMemberSipExtension(ctx, sqlc.SetMemberSipExtensionParams{WorkspaceID: wsID, UserID: *after.UserID, SipExtension: after.Number}); err != nil {
				return err
			}
		}
		return nil
	})
	if err := uniqueTaken(err); err != nil {
		return err
	}
	slog.InfoContext(ctx, "sip: extension updated", "workspace", wsID, "by", uid(r), "number", after.Number, "user", idOf(after.UserID))
	if before.Number != after.Number || idOf(before.UserID) != idOf(after.UserID) {
		s.announceMembers(ctx, wsID, before.UserID, after.UserID)
	}
	return s.writeExtension(w, r, wsID, id, http.StatusOK)
}

// clearMemberNumber: the member has no number any more (a member who already left is fine).
func clearMemberNumber(ctx context.Context, q *sqlc.Queries, wsID, user uuid.UUID) error {
	_, err := q.SetMemberSipExtension(ctx, sqlc.SetMemberSipExtensionParams{WorkspaceID: wsID, UserID: user, SipExtension: ""})
	if db.IsNotFound(err) {
		return nil
	}
	return err
}

func (s *Service) deleteExtension(w http.ResponseWriter, r *http.Request) error {
	wsID, err := s.manageExchange(r)
	if err != nil {
		return err
	}
	id, err := httpx.PathUUID(r, "eid", "extension")
	if err != nil {
		return err
	}
	ctx := r.Context()
	var gone sqlc.SipExtension
	err = s.change(ctx, wsID, func(q *sqlc.Queries, ex *exchange) error {
		cur, ok := ex.ext[id]
		if !ok {
			return httpx.NotFound("extension")
		}
		if cur.Kind == "group" {
			return httpx.Validation("id", "a group's number is deleted with its group")
		}
		var err error
		if gone, err = q.DeleteSipExtension(ctx, sqlc.DeleteSipExtensionParams{ID: id, WorkspaceID: wsID}); err != nil {
			return err
		}
		if gone.UserID != nil {
			return clearMemberNumber(ctx, q, wsID, *gone.UserID)
		}
		return nil
	})
	if err != nil {
		return err
	}
	slog.InfoContext(ctx, "sip: extension deleted", "workspace", wsID, "by", uid(r), "number", gone.Number)
	s.announceMembers(ctx, wsID, gone.UserID)
	httpx.NoContent(w)
	return nil
}

// ---------------------------------------------------------------- groups

func (s *Service) listGroups(w http.ResponseWriter, r *http.Request) error {
	wsID, err := manage(r)
	if err != nil {
		return err
	}
	ex, err := s.reload(r.Context(), wsID)
	if err != nil {
		return err
	}
	out := &v1.ListSipGroupsResponse{Groups: make([]*v1.SipGroup, 0, len(ex.groups))}
	for _, g := range ex.groups {
		out.Groups = append(out.Groups, ex.groupPB(g))
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

func setGroupMembers(ctx context.Context, q *sqlc.Queries, wsID, group uuid.UUID, members []uuid.UUID) error {
	if err := q.DeleteSipGroupMembers(ctx, group); err != nil {
		return err
	}
	for i, e := range members {
		if err := q.InsertSipGroupMember(ctx, sqlc.InsertSipGroupMemberParams{WorkspaceID: wsID, GroupID: group, ExtensionID: e, Position: int32(i)}); err != nil { //nolint:gosec // ≤ 20
			return err
		}
	}
	return nil
}

func (s *Service) createGroup(w http.ResponseWriter, r *http.Request) error {
	wsID, err := s.manageExchange(r)
	if err != nil {
		return err
	}
	var req v1.CreateSipGroupRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	name, err := pbxName(req.GetName())
	if err != nil {
		return err
	}
	number, err := extNumber(req.GetNumber(), "number")
	if err != nil {
		return err
	}
	strategy, ok := strategyToDB[req.GetStrategy()]
	if !ok {
		return httpx.Validation("strategy", "ring all or round robin")
	}
	all, err := ringSec(req.GetRingSec(), 30, 10, 60, "ringSec")
	if err != nil {
		return err
	}
	each, err := ringSec(req.GetMemberRingSec(), 15, 5, 60, "memberRingSec")
	if err != nil {
		return err
	}
	fbSec, err := ringSec(req.GetFallbackSec(), fallbackSecDefault, fallbackSecMin, fallbackSecMax, "fallbackSec")
	if err != nil {
		return err
	}
	ctx, me := r.Context(), uid(r)
	var created sqlc.SipGroup
	err = s.change(ctx, wsID, func(q *sqlc.Queries, ex *exchange) error {
		if len(ex.groups) >= MaxGroups {
			return httpx.Conflict("a workspace has at most " + strconv.Itoa(MaxGroups) + " groups")
		}
		if len(ex.exts) >= MaxExtensions {
			return httpx.Conflict("a workspace has at most " + strconv.Itoa(MaxExtensions) + " numbers")
		}
		if err := ex.numberFree(number, nil); err != nil {
			return err
		}
		fail, err := ex.groupFallback(req.GetOnFail(), nil)
		if err != nil {
			return err
		}
		members, err := ex.groupMembers(req.GetMembers())
		if err != nil {
			return err
		}
		if created, err = q.InsertSipGroup(ctx, sqlc.InsertSipGroupParams{WorkspaceID: wsID, Name: name, Strategy: strategy,
			RingSec: all, MemberRingSec: each, OnFailKind: fail.kind, OnFailMenuID: fail.menu, OnFailExtensionID: fail.ext,
			OnFailGroupID: fail.group, FallbackEnabled: req.GetFallbackEnabled(), FallbackSec: fbSec}); err != nil {
			return err
		}
		if _, err := q.InsertSipExtension(ctx, sqlc.InsertSipExtensionParams{WorkspaceID: wsID, Number: number, Kind: "group",
			GroupID: &created.ID, CreatedBy: &me}); err != nil {
			return err
		}
		return setGroupMembers(ctx, q, wsID, created.ID, members)
	})
	if err := uniqueTaken(err); err != nil {
		return err
	}
	slog.InfoContext(ctx, "sip: group created", "workspace", wsID, "by", me, "group", created.ID, "number", number)
	return s.writeGroup(w, r, wsID, created.ID, http.StatusCreated)
}

func (s *Service) writeGroup(w http.ResponseWriter, r *http.Request, wsID, id uuid.UUID, status int) error {
	ex, err := s.reload(r.Context(), wsID)
	if err != nil {
		return err
	}
	g, ok := ex.group[id]
	if !ok {
		return httpx.NotFound("group")
	}
	httpx.Write(w, status, &v1.SipGroupResponse{Group: ex.groupPB(g)})
	return nil
}

func (s *Service) updateGroup(w http.ResponseWriter, r *http.Request) error {
	wsID, err := s.manageExchange(r)
	if err != nil {
		return err
	}
	id, err := httpx.PathUUID(r, "gid", "group")
	if err != nil {
		return err
	}
	var req v1.UpdateSipGroupRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	ctx := r.Context()
	err = s.change(ctx, wsID, func(q *sqlc.Queries, ex *exchange) error {
		cur, ok := ex.group[id]
		if !ok {
			return httpx.NotFound("group")
		}
		p := sqlc.UpdateSipGroupParams{ID: id, WorkspaceID: wsID, Name: cur.Name, Strategy: cur.Strategy, RingSec: cur.RingSec,
			MemberRingSec: cur.MemberRingSec, OnFailKind: cur.OnFailKind, OnFailMenuID: cur.OnFailMenuID,
			OnFailExtensionID: cur.OnFailExtensionID, OnFailGroupID: cur.OnFailGroupID,
			FallbackEnabled: cur.FallbackEnabled, FallbackSec: cur.FallbackSec}
		var err error
		if req.Name != nil {
			if p.Name, err = pbxName(req.GetName()); err != nil {
				return err
			}
		}
		if req.Strategy != nil {
			var ok bool
			if p.Strategy, ok = strategyToDB[req.GetStrategy()]; !ok {
				return httpx.Validation("strategy", "ring all or round robin")
			}
		}
		if req.RingSec != nil {
			if p.RingSec, err = ringSec(req.GetRingSec(), 30, 10, 60, "ringSec"); err != nil {
				return err
			}
		}
		if req.MemberRingSec != nil {
			if p.MemberRingSec, err = ringSec(req.GetMemberRingSec(), 15, 5, 60, "memberRingSec"); err != nil {
				return err
			}
		}
		if req.FallbackEnabled != nil {
			p.FallbackEnabled = req.GetFallbackEnabled()
		}
		if req.FallbackSec != nil {
			if p.FallbackSec, err = ringSec(req.GetFallbackSec(), fallbackSecDefault, fallbackSecMin, fallbackSecMax, "fallbackSec"); err != nil {
				return err
			}
		}
		if req.OnFail != nil {
			fail, err := ex.groupFallback(req.GetOnFail(), &id)
			if err != nil {
				return err
			}
			p.OnFailKind, p.OnFailMenuID, p.OnFailExtensionID, p.OnFailGroupID = fail.kind, fail.menu, fail.ext, fail.group
		}
		var members []uuid.UUID
		if req.Members != nil {
			if members, err = ex.groupMembers(req.GetMembers()); err != nil {
				return err
			}
			p.ResetPosition = true
		}
		if req.Number != nil {
			number, err := extNumber(req.GetNumber(), "number")
			if err != nil {
				return err
			}
			e, ok := ex.groupExt[id]
			if !ok {
				return httpx.NotFound("group")
			}
			if err := ex.numberFree(number, &e.ID); err != nil {
				return err
			}
			if _, err := q.UpdateSipExtension(ctx, sqlc.UpdateSipExtensionParams{ID: e.ID, WorkspaceID: wsID, Number: number,
				Description: e.Description}); err != nil {
				return err
			}
		}
		if _, err := q.UpdateSipGroup(ctx, p); err != nil {
			return err
		}
		if req.Members != nil {
			return setGroupMembers(ctx, q, wsID, id, members)
		}
		return nil
	})
	if err := uniqueTaken(err); err != nil {
		return err
	}
	slog.InfoContext(ctx, "sip: group updated", "workspace", wsID, "by", uid(r), "group", id)
	return s.writeGroup(w, r, wsID, id, http.StatusOK)
}

func (s *Service) deleteGroup(w http.ResponseWriter, r *http.Request) error {
	wsID, err := s.manageExchange(r)
	if err != nil {
		return err
	}
	id, err := httpx.PathUUID(r, "gid", "group")
	if err != nil {
		return err
	}
	ctx := r.Context()
	err = s.change(ctx, wsID, func(q *sqlc.Queries, _ *exchange) error {
		n, err := q.DeleteSipGroup(ctx, sqlc.DeleteSipGroupParams{ID: id, WorkspaceID: wsID})
		if err == nil && n == 0 {
			return httpx.NotFound("group")
		}
		return err
	})
	if err != nil {
		return err
	}
	slog.InfoContext(ctx, "sip: group deleted", "workspace", wsID, "by", uid(r), "group", id)
	httpx.NoContent(w)
	return nil
}

// ---------------------------------------------------------------- voice menus

func (s *Service) listMenus(w http.ResponseWriter, r *http.Request) error {
	wsID, err := manage(r)
	if err != nil {
		return err
	}
	ex, err := s.reload(r.Context(), wsID)
	if err != nil {
		return err
	}
	out := &v1.ListSipIvrMenusResponse{Menus: make([]*v1.SipIvrMenu, 0, len(ex.menus))}
	for _, m := range ex.menus {
		out.Menus = append(out.Menus, ex.menuPB(m))
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// promptSource checks the upload a prompt is made from: a file the caller uploaded to this
// workspace (at most 10 MB), not an image, not the file of a sticker, badge, background, sound,
// achievement or another prompt — the soundboard rule (ADR-0036): somebody else's file (an
// attachment of a closed room) must not become audio others can fetch.
func (s *Service) promptSource(ctx context.Context, wsID, caller uuid.UUID, raw, field string) (sqlc.File, error) {
	bad := httpx.Validation(field, "an MP3, Ogg or WAV file you uploaded to this workspace, at most 10 MB")
	id, err := uuid.Parse(raw)
	if err != nil {
		return sqlc.File{}, bad
	}
	q := s.db.Q
	f, err := q.GetFile(ctx, id)
	if db.IsNotFound(err) {
		return f, bad
	}
	if err != nil {
		return f, err
	}
	if f.WorkspaceID == nil || *f.WorkspaceID != wsID || f.UploaderID == nil || *f.UploaderID != caller ||
		f.Size > files.MaxPromptSourceBytes || f.Width != nil {
		return f, bad
	}
	if _, err := q.GetStickerFileWorkspace(ctx, id); err == nil {
		return f, bad
	} else if !db.IsNotFound(err) {
		return f, err
	}
	used := []func(context.Context, uuid.UUID) (bool, error){q.IsWorkspaceBadge, q.IsWorkspaceBackground, q.IsWorkspaceSound,
		func(ctx context.Context, id uuid.UUID) (bool, error) { return q.IsWorkspaceAchievement(ctx, &id) },
		func(ctx context.Context, id uuid.UUID) (bool, error) { return q.IsSipPromptFile(ctx, &id) }}
	for _, check := range used {
		if yes, err := check(ctx, id); err != nil {
			return f, err
		} else if yes {
			return f, bad
		}
	}
	return f, nil
}

// preparePrompt makes the prompt (or the recording notice, ADR-0131: field names the request
// field for errors) of the upload raw (before any transaction: ffmpeg is slow).
func (s *Service) preparePrompt(r *http.Request, wsID uuid.UUID, raw, field string) (*files.PreparedFile, int32, error) {
	if s.files == nil {
		return nil, 0, httpx.Unavailable(files.ErrNoFFmpeg)
	}
	src, err := s.promptSource(r.Context(), wsID, uid(r), raw, field)
	if err != nil {
		return nil, 0, err
	}
	prep, ms, err := s.files.PreparePrompt(r.Context(), src)
	switch {
	case files.IsBadAudio(err):
		return nil, 0, httpx.Validation(field, "the file could not be read as MP3, Ogg or WAV")
	case errors.Is(err, files.ErrAudioTooLong):
		return nil, 0, httpx.Validation(field, "the recording is longer than 3 minutes")
	case errors.Is(err, files.ErrNoFFmpeg):
		return nil, 0, httpx.Unavailable(err)
	}
	return prep, ms, err
}

func setMenuItems(ctx context.Context, q *sqlc.Queries, wsID, menu uuid.UUID, items []menuItem) error {
	if err := q.DeleteSipIvrItems(ctx, menu); err != nil {
		return err
	}
	for _, it := range items {
		if err := q.InsertSipIvrItem(ctx, sqlc.InsertSipIvrItemParams{WorkspaceID: wsID, MenuID: menu, Digit: it.digit,
			ActionKind: it.target.kind, ActionMenuID: it.target.menu, ActionExtensionID: it.target.ext,
			ActionGroupID: it.target.group}); err != nil {
			return err
		}
	}
	return nil
}

func menuTimeout(v uint32) (int32, error) { return ringSec(v, 5, 3, 15, "inputTimeoutSec") }

func menuRepeats(v uint32) (int32, error) { return ringSec(v, 3, 1, 5, "repeats") }

func (s *Service) createMenu(w http.ResponseWriter, r *http.Request) error {
	wsID, err := s.manageExchange(r)
	if err != nil {
		return err
	}
	var req v1.CreateSipIvrMenuRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	name, err := pbxName(req.GetName())
	if err != nil {
		return err
	}
	timeout, err := menuTimeout(req.GetInputTimeoutSec())
	if err != nil {
		return err
	}
	repeats, err := menuRepeats(req.GetRepeats())
	if err != nil {
		return err
	}
	ctx, me := r.Context(), uid(r)
	// A cheap early refusal: no conversion when the menus are full (checked again under the lock).
	if n, err := s.db.Q.CountSipIvrMenus(ctx, wsID); err != nil {
		return err
	} else if n >= MaxMenus {
		return tooManyMenus()
	}
	var prep, notice *files.PreparedFile
	var ms, noticeMs int32
	if req.GetPromptSourceFileId() != "" {
		if prep, ms, err = s.preparePrompt(r, wsID, req.GetPromptSourceFileId(), "promptSourceFileId"); err != nil {
			return err
		}
	}
	if req.GetNoticeSourceFileId() != "" {
		if notice, noticeMs, err = s.preparePrompt(r, wsID, req.GetNoticeSourceFileId(), "noticeSourceFileId"); err != nil {
			s.discard(prep)
			return err
		}
	}
	var created sqlc.SipIvrMenu
	err = s.change(ctx, wsID, func(q *sqlc.Queries, ex *exchange) error {
		if len(ex.menus) >= MaxMenus {
			return tooManyMenus()
		}
		noInput, err := ex.parseTarget(req.GetOnNoInput(), "onNoInput", false)
		if err != nil {
			return err
		}
		items, err := ex.menuItems(req.GetItems())
		if err != nil {
			return err
		}
		var prompt *uuid.UUID
		if prep != nil {
			f, err := s.files.InsertPrepared(ctx, q, prep)
			if err != nil {
				return err
			}
			prompt = &f.ID
		}
		if created, err = q.InsertSipIvrMenu(ctx, sqlc.InsertSipIvrMenuParams{WorkspaceID: wsID, Name: name, PromptFileID: prompt,
			PromptDurationMs: ms, InputTimeoutSec: timeout, Repeats: repeats, NoInputKind: noInput.kind, NoInputMenuID: noInput.menu,
			NoInputExtensionID: noInput.ext, NoInputGroupID: noInput.group, UpdatedBy: &me, DialExtensions: req.GetDialExtensions()}); err != nil {
			return err
		}
		if notice != nil {
			f, err := s.files.InsertPrepared(ctx, q, notice)
			if err != nil {
				return err
			}
			if created, err = q.SetSipIvrMenuNotice(ctx, sqlc.SetSipIvrMenuNoticeParams{ID: created.ID, WorkspaceID: wsID,
				NoticeFileID: &f.ID, NoticeDurationMs: noticeMs, UpdatedBy: &me}); err != nil {
				return err
			}
		}
		return setMenuItems(ctx, q, wsID, created.ID, items)
	})
	if err != nil {
		s.discard(prep)
		s.discard(notice)
		return err
	}
	slog.InfoContext(ctx, "sip: menu created", "workspace", wsID, "by", me, "menu", created.ID, "prompt_ms", ms)
	return s.writeMenu(w, r, wsID, created.ID, http.StatusCreated)
}

func (s *Service) discard(p *files.PreparedFile) {
	if p != nil && s.files != nil {
		s.files.Discard(p)
	}
}

func tooManyMenus() error {
	return httpx.Conflict("a workspace has at most " + strconv.Itoa(MaxMenus) + " voice menus")
}

func (s *Service) writeMenu(w http.ResponseWriter, r *http.Request, wsID, id uuid.UUID, status int) error {
	ex, err := s.reload(r.Context(), wsID)
	if err != nil {
		return err
	}
	m, ok := ex.menu[id]
	if !ok {
		return httpx.NotFound("menu")
	}
	httpx.Write(w, status, &v1.SipIvrMenuResponse{Menu: ex.menuPB(m)})
	return nil
}

func (s *Service) updateMenu(w http.ResponseWriter, r *http.Request) error {
	wsID, err := s.manageExchange(r)
	if err != nil {
		return err
	}
	id, err := httpx.PathUUID(r, "mid", "menu")
	if err != nil {
		return err
	}
	var req v1.UpdateSipIvrMenuRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	ctx, me := r.Context(), uid(r)
	if _, err := s.db.Q.GetSipIvrMenu(ctx, sqlc.GetSipIvrMenuParams{ID: id, WorkspaceID: wsID}); db.IsNotFound(err) {
		return httpx.NotFound("menu")
	} else if err != nil {
		return err
	}
	var prep, notice *files.PreparedFile
	var ms, noticeMs int32
	if req.PromptSourceFileId != nil && req.GetPromptSourceFileId() != "" {
		if prep, ms, err = s.preparePrompt(r, wsID, req.GetPromptSourceFileId(), "promptSourceFileId"); err != nil {
			return err
		}
	}
	if req.NoticeSourceFileId != nil && req.GetNoticeSourceFileId() != "" {
		if notice, noticeMs, err = s.preparePrompt(r, wsID, req.GetNoticeSourceFileId(), "noticeSourceFileId"); err != nil {
			s.discard(prep)
			return err
		}
	}
	var oldPrompt, oldNotice *uuid.UUID
	err = s.change(ctx, wsID, func(q *sqlc.Queries, ex *exchange) error {
		cur, ok := ex.menu[id]
		if !ok {
			return httpx.NotFound("menu")
		}
		p := sqlc.UpdateSipIvrMenuParams{ID: id, WorkspaceID: wsID, Name: cur.Name, PromptFileID: cur.PromptFileID,
			PromptDurationMs: cur.PromptDurationMs, InputTimeoutSec: cur.InputTimeoutSec, Repeats: cur.Repeats,
			NoInputKind: cur.NoInputKind, NoInputMenuID: cur.NoInputMenuID, NoInputExtensionID: cur.NoInputExtensionID,
			NoInputGroupID: cur.NoInputGroupID, UpdatedBy: &me, DialExtensions: cur.DialExtensions}
		if req.DialExtensions != nil {
			p.DialExtensions = req.GetDialExtensions()
		}
		var err error
		if req.Name != nil {
			if p.Name, err = pbxName(req.GetName()); err != nil {
				return err
			}
		}
		if req.InputTimeoutSec != nil {
			if p.InputTimeoutSec, err = menuTimeout(req.GetInputTimeoutSec()); err != nil {
				return err
			}
		}
		if req.Repeats != nil {
			if p.Repeats, err = menuRepeats(req.GetRepeats()); err != nil {
				return err
			}
		}
		if req.OnNoInput != nil {
			t, err := ex.parseTarget(req.GetOnNoInput(), "onNoInput", false)
			if err != nil {
				return err
			}
			p.NoInputKind, p.NoInputMenuID, p.NoInputExtensionID, p.NoInputGroupID = t.kind, t.menu, t.ext, t.group
		}
		var items []menuItem
		if req.Items != nil {
			if items, err = ex.menuItems(req.GetItems()); err != nil {
				return err
			}
		}
		if req.PromptSourceFileId != nil {
			oldPrompt, p.PromptFileID, p.PromptDurationMs = cur.PromptFileID, nil, 0
			if prep != nil {
				f, err := s.files.InsertPrepared(ctx, q, prep)
				if err != nil {
					return err
				}
				p.PromptFileID, p.PromptDurationMs = &f.ID, ms
			}
		}
		if _, err := q.UpdateSipIvrMenu(ctx, p); err != nil {
			return err
		}
		if req.NoticeSourceFileId != nil {
			np := sqlc.SetSipIvrMenuNoticeParams{ID: id, WorkspaceID: wsID, UpdatedBy: &me}
			if notice != nil {
				f, err := s.files.InsertPrepared(ctx, q, notice)
				if err != nil {
					return err
				}
				np.NoticeFileID, np.NoticeDurationMs = &f.ID, noticeMs
			}
			if _, err := q.SetSipIvrMenuNotice(ctx, np); err != nil {
				return err
			}
			oldNotice = cur.NoticeFileID
		}
		if req.Items != nil {
			return setMenuItems(ctx, q, wsID, id, items)
		}
		return nil
	})
	if err != nil {
		s.discard(prep)
		s.discard(notice)
		return err
	}
	s.dropPrompt(ctx, oldPrompt)
	s.dropPrompt(ctx, oldNotice)
	slog.InfoContext(ctx, "sip: menu updated", "workspace", wsID, "by", me, "menu", id)
	return s.writeMenu(w, r, wsID, id, http.StatusOK)
}

// dropPrompt deletes a prompt file no menu holds any more (its quota is released); a failure
// leaves it to the orphan cleanup.
func (s *Service) dropPrompt(ctx context.Context, id *uuid.UUID) {
	if id == nil || s.files == nil {
		return
	}
	if err := s.files.DeleteFile(context.WithoutCancel(ctx), *id); err != nil {
		slog.WarnContext(ctx, "sip: delete prompt", "file", *id, "err", err)
	}
}

func (s *Service) deleteMenu(w http.ResponseWriter, r *http.Request) error {
	wsID, err := s.manageExchange(r)
	if err != nil {
		return err
	}
	id, err := httpx.PathUUID(r, "mid", "menu")
	if err != nil {
		return err
	}
	ctx := r.Context()
	var gone sqlc.SipIvrMenu
	err = s.change(ctx, wsID, func(q *sqlc.Queries, _ *exchange) error {
		var err error
		gone, err = q.DeleteSipIvrMenu(ctx, sqlc.DeleteSipIvrMenuParams{ID: id, WorkspaceID: wsID})
		if db.IsNotFound(err) {
			return httpx.NotFound("menu")
		}
		return err
	})
	if err != nil {
		return err
	}
	s.dropPrompt(ctx, gone.PromptFileID)
	s.dropPrompt(ctx, gone.NoticeFileID)
	slog.InfoContext(ctx, "sip: menu deleted", "workspace", wsID, "by", uid(r), "menu", id)
	httpx.NoContent(w)
	return nil
}

// ---------------------------------------------------------------- routing (inbound calls)

// routing is the exchange of a workspace for Route: guests never ring (a number of a member who
// became a guest behaves like one without a member).
func (ex *exchange) routing() *PBX {
	p := &PBX{Extensions: map[uuid.UUID]Ext{}, Groups: map[uuid.UUID]Group{}, Menus: map[uuid.UUID]Menu{}}
	for _, e := range ex.exts {
		x := Ext{ID: e.ID, Group: e.GroupID, Number: e.Number, NoExternal: e.ExternalBlocked}
		if who, ok := ex.people[e.ID]; ok && perm.Role(who.Role) != perm.RoleGuest {
			u := who.UserID
			x.User = &u
		}
		p.Extensions[e.ID] = x
	}
	for _, g := range ex.groups {
		grp := Group{ID: g.ID, Name: g.Name, RoundRobin: g.Strategy == "round_robin", RingSec: int(g.RingSec), MemberRingSec: int(g.MemberRingSec),
			NextPosition: int(g.NextPosition), OnFail: routeTarget(g.OnFailKind, g.OnFailMenuID, g.OnFailExtensionID, g.OnFailGroupID),
			Fallback: g.FallbackEnabled, FallbackSec: int(g.FallbackSec)}
		for _, m := range ex.members[g.ID] {
			grp.Members = append(grp.Members, GroupMember{Extension: m.ExtensionID, Position: int(m.Position)})
		}
		p.Groups[g.ID] = grp
	}
	for _, m := range ex.menus {
		mn := Menu{ID: m.ID, Name: m.Name, HasPrompt: m.PromptFileID != nil, PromptMs: int(m.PromptDurationMs), InputTimeoutSec: int(m.InputTimeoutSec), Repeats: int(m.Repeats),
			OnNoInput: routeTarget(m.NoInputKind, m.NoInputMenuID, m.NoInputExtensionID, m.NoInputGroupID), Items: map[byte]Target{},
			DialExtensions: m.DialExtensions}
		if m.PromptFileID != nil {
			mn.Prompt = *m.PromptFileID
		}
		if m.NoticeFileID != nil {
			mn.Notice, mn.NoticeMs = *m.NoticeFileID, int(m.NoticeDurationMs)
		}
		for _, it := range ex.items[m.ID] {
			mn.Items[it.Digit[0]] = routeTarget(it.ActionKind, it.ActionMenuID, it.ActionExtensionID, it.ActionGroupID)
		}
		p.Menus[m.ID] = mn
	}
	return p
}

func routeTarget(kind string, menu, ext, group *uuid.UUID) Target {
	switch kind {
	case "repeat":
		return Target{Kind: RouteRepeat}
	case "menu":
		return Target{Kind: RouteMenu, ID: menu}
	case "extension":
		return Target{Kind: RouteExtension, ID: ext}
	case "group":
		return Target{Kind: RouteGroup, ID: group}
	default:
		return Target{Kind: RouteHangup}
	}
}

// RouteInbound is where the route t of the workspace's exchange leads now (ADR-0117 §4). Only
// when the server takes inbound calls (ErrInboundDisabled otherwise).
func (s *Service) RouteInbound(ctx context.Context, wsID uuid.UUID, t Target, a Availability) (Decision, error) {
	if !s.inboundReady() {
		return Decision{}, ErrInboundDisabled
	}
	ex, err := loadExchange(ctx, s.db.Q, wsID)
	if err != nil {
		return Decision{}, err
	}
	return Route(ex.routing(), t, a, DirectRingSec), nil
}

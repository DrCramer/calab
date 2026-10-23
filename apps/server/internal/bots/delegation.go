package bots

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/delegation"
	"github.com/calaba/calaba/server/internal/dms"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/messages"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/redisx"
)

// A member lets a bot act on their behalf (ADR-0111): «Делегировать права» in the bot's menu.
// The consent is the member's own: PUT / DELETE …/delegations/{userId} take only the caller's id;
// anyone (not a guest) may suggest it to others, and the bot then DMs each of them the
// suggestion with «Принять» / «Отказаться» (messages.delegationClick handles the click). The bot
// itself may ask too (ADR-0119): only for its own consent, the same DM naming the bot; it gets
// BOT_DELEGATION when a member grants, revokes or declines — never the power to decide.

// MaxDelegationInvites bounds the members of one invitation request.
const MaxDelegationInvites = 20

// errInvited rolls back a DM whose invitation a concurrent request already created.
var errInvited = errors.New("already invited")

func (s *Service) delegationRoutes(handle func(string, httpx.HandlerFunc)) {
	handle("GET /api/workspaces/{id}/bots/{botId}", s.getBot)
	handle("PUT /api/workspaces/{id}/bots/{botId}/delegations/{userId}", s.grant)
	handle("DELETE /api/workspaces/{id}/bots/{botId}/delegations/{userId}", s.revokeDelegation)
	handle("POST /api/workspaces/{id}/bots/{botId}/delegation-invites", s.inviteDelegation)
	handle("DELETE /api/workspaces/{id}/bots/{botId}/delegation-invites/{userId}", s.cancelInvite)
}

// callerMode: what a delegation route lets the bot itself do.
type callerMode int

const (
	callerRead   callerMode = iota + 1 // GET: the bot reads its own card
	callerWrite                        // a person's own decision: never a bot
	callerInvite                       // POST …/delegation-invites: the bot asks for itself (ADR-0119)
)

// delegationCaller: the bot {botId} of the workspace {id} and the caller's role there. People
// with a non-guest role; the bot itself only to read (callerRead) or to ask for its own
// consent (callerInvite, with a non-guest role there); others get 403.
func (s *Service) delegationCaller(r *http.Request, mode callerMode) (uuid.UUID, sqlc.Bot, bool, error) {
	b, err := s.botInPath(r)
	if err != nil {
		return uuid.Nil, b, false, err
	}
	wsID, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return uuid.Nil, b, false, err
	}
	me := identity(r)
	if me.IsBot {
		// Only the bot {botId} itself: no bot asks for, or reads, another bot's consents.
		if mode == callerWrite || me.UserID != b.UserID {
			return uuid.Nil, b, false, auth.ErrBotNotAllowed
		}
		if mode == callerInvite { // the same role rule as for people
			if _, role, err := perm.FromContext(r.Context()).Workspace(r.Context(), wsID, me.UserID); err != nil {
				return uuid.Nil, b, false, err
			} else if role == perm.RoleGuest {
				return uuid.Nil, b, false, delegation.ErrNotEligible
			}
		}
		// The workspace of the path (botInPath: the bot is a member there), not its home: a
		// consent is per workspace, and a bot added elsewhere reads whom it may act for there.
		return wsID, b, true, nil
	}
	if me.OnBehalf() { // the routes are closed on behalf (botroutes.go); never a consent by a bot
		return uuid.Nil, b, false, auth.ErrOnBehalfRoute
	}
	bits, role, err := perm.FromContext(r.Context()).Workspace(r.Context(), wsID, me.UserID)
	if errors.Is(err, perm.ErrNotMember) {
		return uuid.Nil, b, false, httpx.NotFound("workspace")
	}
	if err != nil {
		return uuid.Nil, b, false, err
	}
	if role == perm.RoleGuest {
		return uuid.Nil, b, false, delegation.ErrNotEligible
	}
	manage := b.OwnerUserID == me.UserID || (wsID == b.WorkspaceID && bits.Has(perm.ManageBots))
	return wsID, b, manage, nil
}

// delegationState is GetBotResponse: the card and who the bot may act for in ws.
func (s *Service) delegationState(ctx context.Context, ws uuid.UUID, b sqlc.Bot, manage bool) (*v1.GetBotResponse, error) {
	pb, err := s.pb(ctx, b.UserID, manage)
	if err != nil {
		return nil, err
	}
	if !manage { // like the public card: where the bot lives and who owns it are the managers'
		pb.OwnerUserId, pb.WorkspaceId = "", ""
	}
	out := &v1.GetBotResponse{Bot: pb, OnBehalfUserIds: []string{}, Delegations: []*v1.BotDelegation{}, Invites: []*v1.BotDelegationInvite{}}
	ds, err := s.db.Q.ListBotDelegations(ctx, sqlc.ListBotDelegationsParams{WorkspaceID: ws, BotID: b.UserID})
	if err != nil {
		return nil, err
	}
	for _, d := range ds {
		out.OnBehalfUserIds = append(out.OnBehalfUserIds, d.UserID.String())
		out.Delegations = append(out.Delegations, &v1.BotDelegation{UserId: d.UserID.String(), Since: timestamppb.New(d.Since)})
	}
	invs, err := s.db.Q.ListBotDelegationInvites(ctx, sqlc.ListBotDelegationInvitesParams{WorkspaceID: ws, BotID: b.UserID})
	if err != nil {
		return nil, err
	}
	for _, inv := range invs {
		out.Invites = append(out.Invites, &v1.BotDelegationInvite{UserId: inv.UserID.String(), InvitedBy: inv.InvitedBy.String(), CreatedAt: timestamppb.New(inv.CreatedAt)})
	}
	return out, nil
}

func (s *Service) writeState(w http.ResponseWriter, r *http.Request, ws uuid.UUID, b sqlc.Bot, manage bool) error {
	out, err := s.delegationState(r.Context(), ws, b, manage)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// getBot: GET /api/workspaces/{id}/bots/{botId}.
func (s *Service) getBot(w http.ResponseWriter, r *http.Request) error {
	ws, b, manage, err := s.delegationCaller(r, callerRead)
	if err != nil {
		return err
	}
	return s.writeState(w, r, ws, b, manage)
}

// publishChange sends BOT_DELEGATION to the bot's gateway after the commit (its webhook
// delivery was queued in the transaction, delegation.Change); nil: nothing changed.
func (s *Service) publishChange(ctx context.Context, bot uuid.UUID, ev *v1.DispatchEvent) {
	if ev != nil {
		s.events.User(ctx, bot, ev)
	}
}

// selfOnly parses {userId}: the caller's own id, or 403 ON_BEHALF_SELF_ONLY.
func selfOnly(r *http.Request) (uuid.UUID, error) {
	id, err := httpx.PathUUID(r, "userId", "user")
	if err != nil {
		return uuid.Nil, err
	}
	if id != identity(r).UserID {
		return uuid.Nil, auth.ErrOnBehalfSelfOnly
	}
	return id, nil
}

// grant: PUT …/delegations/{userId}, the caller's own consent.
func (s *Service) grant(w http.ResponseWriter, r *http.Request) error {
	ws, b, manage, err := s.delegationCaller(r, callerWrite)
	if err != nil {
		return err
	}
	me, err := selfOnly(r)
	if err != nil {
		return err
	}
	var inv *sqlc.BotDelegationInvite
	var ev *v1.DispatchEvent
	err = s.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		var err error
		inv, ev, err = delegation.Grant(r.Context(), q, ws, b.UserID, me)
		return err
	})
	if err != nil {
		return err
	}
	slog.InfoContext(r.Context(), "bot delegation", "workspace_id", ws, "bot_id", b.UserID, "member_id", me, "on", true)
	s.publishChange(r.Context(), b.UserID, ev)
	s.closeInvite(r.Context(), inv, me, delegation.Accepted)
	return s.writeState(w, r, ws, b, manage)
}

// revokeDelegation: DELETE …/delegations/{userId}, the caller's own revocation (at once: every
// request on their behalf reads the consent, and a mutation locks it, auth.lockDelegation).
func (s *Service) revokeDelegation(w http.ResponseWriter, r *http.Request) error {
	b, err := s.botInPath(r)
	if err != nil {
		return err
	}
	if identity(r).Machine() {
		return auth.ErrBotNotAllowed
	}
	me, err := selfOnly(r)
	if err != nil {
		return err
	}
	ws, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return err
	}
	var ev *v1.DispatchEvent
	if err := s.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		n, err := q.DeleteBotDelegation(r.Context(), sqlc.DeleteBotDelegationParams{WorkspaceID: ws, BotID: b.UserID, UserID: me})
		if err != nil || n == 0 {
			return err
		}
		ev, err = delegation.Change(r.Context(), q, ws, b.UserID, me, delegation.StateRevoked)
		return err
	}); err != nil {
		return err
	}
	slog.InfoContext(r.Context(), "bot delegation", "workspace_id", ws, "bot_id", b.UserID, "member_id", me, "on", false)
	s.publishChange(r.Context(), b.UserID, ev)
	// A guest (a member demoted after consenting) may still revoke; the state is the managers'
	// view only for the owner or MANAGE_BOTS.
	manage := b.OwnerUserID == me
	return s.writeState(w, r, ws, b, manage)
}

// DelegationDeclineCooldown is how long, after the member's «Отказаться», nobody invites them to
// the same bot in the same workspace again (ADR-0119).
const DelegationDeclineCooldown = 7 * 24 * time.Hour

// ReasonInviteDeclined marks POST …/delegation-invites when every listed member declined an
// invitation to this bot here within DelegationDeclineCooldown (409, Retry-After).
const ReasonInviteDeclined = "DELEGATION_INVITE_DECLINED"

// inviteDelegation: POST …/delegation-invites. The bot DMs each listed member a suggestion naming
// the caller — or, when the caller is the bot itself (ADR-0119), asking for itself; members who
// already consented, are invited or declined recently are skipped. The answer lists the DM
// messages of the invitations (sent): the bot hands their links to the member elsewhere.
func (s *Service) inviteDelegation(w http.ResponseWriter, r *http.Request) error {
	ws, b, manage, err := s.delegationCaller(r, callerInvite)
	if err != nil {
		return err
	}
	var req v1.InviteBotDelegationRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	me := identity(r).UserID
	byBot := me == b.UserID // delegationCaller: a bot caller is this bot
	if len(req.GetUserIds()) == 0 || len(req.GetUserIds()) > MaxDelegationInvites {
		return httpx.Validation("userIds", "1..20 members")
	}
	reason, ok := delegation.CleanReason(req.GetReason())
	if !ok {
		return httpx.Validation("reason", "at most 200 characters")
	}
	ctx := r.Context()
	seen := map[uuid.UUID]bool{}
	var targets []uuid.UUID
	var sent []*v1.BotDelegationInviteMessage
	counted, err := s.db.Q.ListBotDelegations(ctx, sqlc.ListBotDelegationsParams{WorkspaceID: ws, BotID: b.UserID})
	if err != nil {
		return err
	}
	for _, d := range counted {
		seen[d.UserID] = true
	}
	invs, err := s.db.Q.ListBotDelegationInvites(ctx, sqlc.ListBotDelegationInvitesParams{WorkspaceID: ws, BotID: b.UserID})
	if err != nil {
		return err
	}
	pending := map[uuid.UUID]sqlc.BotDelegationInvite{}
	for _, inv := range invs {
		seen[inv.UserID] = true
		pending[inv.UserID] = inv
	}
	declines, err := s.db.Q.ListBotDelegationDeclines(ctx, sqlc.ListBotDelegationDeclinesParams{WorkspaceID: ws, BotID: b.UserID, Since: now().Add(-DelegationDeclineCooldown)})
	if err != nil {
		return err
	}
	declined := map[uuid.UUID]time.Time{}
	for _, d := range declines {
		declined[d.UserID] = d.DeclinedAt
	}
	requested, cooled, cooling := map[uuid.UUID]bool{}, map[uuid.UUID]bool{}, time.Duration(0)
	for _, raw := range req.GetUserIds() {
		id, err := uuid.Parse(raw)
		if err != nil {
			return httpx.Validation("userIds", "invalid user id")
		}
		if id == me {
			return httpx.Validation("userIds", "give your own consent directly")
		}
		requested[id] = true
		if seen[id] {
			if inv, ok := pending[id]; ok && byBot && inv.MessageID != nil {
				sent = append(sent, s.inviteMessage(ctx, b.UserID, id, *inv.MessageID, uuid.Nil, false))
				delete(pending, id)
			}
			continue
		}
		seen[id] = true
		if at, ok := declined[id]; ok {
			left := at.Add(DelegationDeclineCooldown).Sub(now())
			if cooling == 0 || left < cooling {
				cooling = left
			}
			cooled[id] = true
			continue
		}
		if err := delegation.Check(ctx, s.db.Q, ws, b.UserID, id); errors.Is(err, delegation.ErrNotEligible) {
			return httpx.Validation("userIds", "only members with a non-guest role can be invited").WithDetails(delegation.ReasonNotEligible, 0, 0)
		} else if err != nil {
			return err
		}
		targets = append(targets, id)
	}
	if len(cooled) > 0 && len(cooled) == len(requested) {
		left := max(cooling.Round(time.Second), time.Second)
		e := httpx.Conflict("the member declined this bot's invitation recently").WithDetails(ReasonInviteDeclined, uint64(left/time.Second), uint64(DelegationDeclineCooldown/time.Second))
		e.RetryAfter = left
		return e
	}
	names, err := s.db.Q.ListMemberNames(ctx, sqlc.ListMemberNamesParams{WorkspaceID: ws, UserIds: []uuid.UUID{me, b.UserID}})
	if err != nil {
		return err
	}
	name := map[uuid.UUID]string{}
	for _, n := range names {
		name[n.UserID], _ = n.Name.(string)
	}
	wsRow, err := s.db.Q.GetWorkspace(ctx, ws)
	if err != nil {
		return err
	}
	sys := messages.NewSystem(s.db, s.events)
	for _, id := range targets {
		if s.redis != nil {
			if err := redisx.NewRateLimiter(s.redis, "rl:bot-delegation-invite:", 20, 0.5).Take(ctx, me.String()); err != nil {
				return err
			}
		}
		u, err := s.db.Q.GetUser(ctx, id)
		if err != nil {
			return err
		}
		text, kb := delegation.Invite(u.Locale, name[me], name[b.UserID], wsRow.Name, id.String(), byBot, reason)
		m, err := sys.SendBotDM(ctx, b.UserID, id, text, kb, func(q *sqlc.Queries, m sqlc.Message) error {
			if _, err := q.InsertBotDelegationInvite(ctx, sqlc.InsertBotDelegationInviteParams{WorkspaceID: ws, BotID: b.UserID, UserID: id, InvitedBy: me}); db.IsNotFound(err) {
				return errInvited
			} else if err != nil {
				return err
			}
			return q.SetBotDelegationInviteMessage(ctx, sqlc.SetBotDelegationInviteMessageParams{
				MessageID: &m.ID, KeyboardRevision: m.KeyboardRevision, WorkspaceID: ws, BotID: b.UserID, UserID: id,
			})
		})
		if errors.Is(err, errInvited) {
			continue
		}
		if err != nil {
			return err
		}
		slog.InfoContext(ctx, "bot delegation invite", "workspace_id", ws, "bot_id", b.UserID, "member_id", id, "invited_by", me, "by_bot", byBot)
		sent = append(sent, s.inviteMessage(ctx, b.UserID, id, m.ID, m.RoomID, true))
	}
	out, err := s.delegationState(ctx, ws, b, manage)
	if err != nil {
		return err
	}
	out.Sent = sent
	if out.Sent == nil {
		out.Sent = []*v1.BotDelegationInviteMessage{}
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// inviteMessage describes the bot's DM to user that carries an invitation; room = Nil: looked
// up by the DM's key. url: PublicURL/m/<room>/<message> (no token; only the DM's members open it).
func (s *Service) inviteMessage(ctx context.Context, bot, user, message, room uuid.UUID, created bool) *v1.BotDelegationInviteMessage {
	if room == uuid.Nil {
		key := dms.Key(bot, user)
		if dm, err := s.db.Q.GetDMByKey(ctx, &key); err == nil {
			room = dm.ID
		}
	}
	out := &v1.BotDelegationInviteMessage{UserId: user.String(), MessageId: message.String(), Created: created}
	if room != uuid.Nil {
		out.RoomId = room.String()
		if s.PublicURL != "" {
			out.Url = strings.TrimRight(s.PublicURL, "/") + "/m/" + room.String() + "/" + message.String()
		}
	}
	return out
}

// cancelInvite: DELETE …/delegation-invites/{userId}, by the inviter (cancel) or the invitee
// (decline); anyone else gets 403.
func (s *Service) cancelInvite(w http.ResponseWriter, r *http.Request) error {
	b, err := s.botInPath(r)
	if err != nil {
		return err
	}
	if identity(r).Machine() {
		return auth.ErrBotNotAllowed
	}
	ws, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return err
	}
	target, err := httpx.PathUUID(r, "userId", "user")
	if err != nil {
		return err
	}
	me := identity(r).UserID
	var inv *sqlc.BotDelegationInvite
	var ev *v1.DispatchEvent
	err = s.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		var cur *sqlc.BotDelegationInvite
		var err error
		if target == me { // the invitee's own decline: remembered, and the bot is told
			cur, ev, err = delegation.Decline(r.Context(), q, ws, b.UserID, target)
		} else {
			cur, err = delegation.DropInvite(r.Context(), q, ws, b.UserID, target)
		}
		if err != nil {
			return err
		}
		if cur != nil && cur.InvitedBy != me && target != me { // rolled back
			return httpx.Forbidden("only the inviter or the invitee cancels an invitation").WithDetails(auth.ReasonOnBehalfSelfOnly, 0, 0)
		}
		inv = cur
		return nil
	})
	if err != nil {
		return err
	}
	s.publishChange(r.Context(), b.UserID, ev)
	outcome := delegation.Cancelled
	if target == me {
		outcome = delegation.Declined
	}
	s.closeInvite(r.Context(), inv, target, outcome)
	return s.writeState(w, r, ws, b, b.OwnerUserID == me)
}

// closeInvite ends the DM of a removed invitation in the invitee's language (best effort).
func (s *Service) closeInvite(ctx context.Context, inv *sqlc.BotDelegationInvite, invitee uuid.UUID, o delegation.Outcome) {
	if inv == nil || inv.MessageID == nil {
		return
	}
	u, err := s.db.Q.GetUser(ctx, invitee)
	if err != nil {
		return
	}
	if err := messages.NewSystem(s.db, s.events).CloseBotPrompt(ctx, *inv.MessageID, delegation.OutcomeText(u.Locale, o)); err != nil {
		slog.WarnContext(ctx, "bot delegation: close invitation", "message_id", *inv.MessageID, "err", err)
	}
}

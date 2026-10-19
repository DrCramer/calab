package bots

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/delegation"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/messages"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/redisx"
)

// A member lets a bot act on their behalf (ADR-0111): «Делегировать права» in the bot's menu.
// The consent is the member's own: PUT / DELETE …/delegations/{userId} take only the caller's id;
// anyone (not a guest) may suggest it to others, and the bot then DMs each of them the
// suggestion with «Принять» / «Отказаться» (messages.delegationClick handles the click).

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

// delegationCaller: the bot {botId} of the workspace {id} and the caller's role there. People
// with a non-guest role, or (read only) the bot itself; others get 403.
func (s *Service) delegationCaller(r *http.Request, write bool) (uuid.UUID, sqlc.Bot, bool, error) {
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
		if write || me.UserID != b.UserID {
			return uuid.Nil, b, false, auth.ErrBotNotAllowed
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
	ws, b, manage, err := s.delegationCaller(r, false)
	if err != nil {
		return err
	}
	return s.writeState(w, r, ws, b, manage)
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
	ws, b, manage, err := s.delegationCaller(r, true)
	if err != nil {
		return err
	}
	me, err := selfOnly(r)
	if err != nil {
		return err
	}
	var inv *sqlc.BotDelegationInvite
	err = s.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		var err error
		inv, err = delegation.Grant(r.Context(), q, ws, b.UserID, me)
		return err
	})
	if err != nil {
		return err
	}
	slog.InfoContext(r.Context(), "bot delegation", "workspace_id", ws, "bot_id", b.UserID, "member_id", me, "on", true)
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
	if _, err := db.GuardValue(r.Context(), s.db, func(q *sqlc.Queries) (int64, error) {
		return q.DeleteBotDelegation(r.Context(), sqlc.DeleteBotDelegationParams{WorkspaceID: ws, BotID: b.UserID, UserID: me})
	}); err != nil {
		return err
	}
	slog.InfoContext(r.Context(), "bot delegation", "workspace_id", ws, "bot_id", b.UserID, "member_id", me, "on", false)
	// A guest (a member demoted after consenting) may still revoke; the state is the managers'
	// view only for the owner or MANAGE_BOTS.
	manage := b.OwnerUserID == me
	return s.writeState(w, r, ws, b, manage)
}

// inviteDelegation: POST …/delegation-invites. The bot DMs each listed member a suggestion naming
// the caller; members who already consented or are invited are skipped.
func (s *Service) inviteDelegation(w http.ResponseWriter, r *http.Request) error {
	ws, b, manage, err := s.delegationCaller(r, true)
	if err != nil {
		return err
	}
	var req v1.InviteBotDelegationRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	me := identity(r).UserID
	if len(req.GetUserIds()) == 0 || len(req.GetUserIds()) > MaxDelegationInvites {
		return httpx.Validation("userIds", "1..20 members")
	}
	ctx := r.Context()
	seen := map[uuid.UUID]bool{}
	var targets []uuid.UUID
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
	for _, inv := range invs {
		seen[inv.UserID] = true
	}
	for _, raw := range req.GetUserIds() {
		id, err := uuid.Parse(raw)
		if err != nil {
			return httpx.Validation("userIds", "invalid user id")
		}
		if id == me {
			return httpx.Validation("userIds", "give your own consent directly")
		}
		if seen[id] {
			continue
		}
		seen[id] = true
		if err := delegation.Check(ctx, s.db.Q, ws, b.UserID, id); errors.Is(err, delegation.ErrNotEligible) {
			return httpx.Validation("userIds", "only members with a non-guest role can be invited").WithDetails(delegation.ReasonNotEligible, 0, 0)
		} else if err != nil {
			return err
		}
		targets = append(targets, id)
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
		text, kb := delegation.Invite(u.Locale, name[me], name[b.UserID], wsRow.Name, id.String())
		_, err = sys.SendBotDM(ctx, b.UserID, id, text, kb, func(q *sqlc.Queries, m sqlc.Message) error {
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
		slog.InfoContext(ctx, "bot delegation invite", "workspace_id", ws, "bot_id", b.UserID, "member_id", id, "invited_by", me)
	}
	return s.writeState(w, r, ws, b, manage)
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
	err = s.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		cur, err := delegation.DropInvite(r.Context(), q, ws, b.UserID, target)
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

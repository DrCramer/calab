// Package delegation is a member's own consent for a bot to act on their behalf (ADR-0111):
// who may give it, recording it, and the texts of the bot's DM that suggests it. The request
// side (header Calab-On-Behalf: <user id>) is in internal/auth; the routes are in internal/bots
// (the «Делегировать права» dialog) and internal/messages (the invitee's click in the DM).
package delegation

import (
	"context"
	"net/http"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
)

// ReasonNotEligible marks a member who cannot consent here (a guest role or account, a bot, a
// disabled account, banned or suspended by the directory).
const ReasonNotEligible = "ON_BEHALF_NOT_ELIGIBLE"

// ErrNotEligible means the member cannot let a bot act on their behalf in this workspace.
var ErrNotEligible = httpx.Forbidden("this member cannot let a bot act on their behalf here").WithDetails(ReasonNotEligible, 0, 0)

// Button ids of the invitation the bot sends (ADR-0047 callback buttons, handled by the server).
const (
	ButtonAccept  = "delegation_accept"
	ButtonDecline = "delegation_decline"
)

// Check reports whether user may consent to bot acting on their behalf in ws now: a live person
// with a non-guest role there, neither banned nor suspended by the directory; bot is a live bot
// member of ws; ws is not suspended and does not require the person's own sign-in (enforced SSO,
// or a directory that is not current for them: ADR-0106 §2, as at request time).
func Check(ctx context.Context, q *sqlc.Queries, ws, bot, user uuid.UUID) error {
	u, err := q.GetUser(ctx, user)
	if db.IsNotFound(err) {
		return ErrNotEligible
	}
	if err != nil {
		return err
	}
	if u.IsBot || u.IsGuest || u.DisabledAt != nil {
		return ErrNotEligible
	}
	m, err := q.GetMember(ctx, sqlc.GetMemberParams{WorkspaceID: ws, UserID: user})
	if db.IsNotFound(err) {
		return ErrNotEligible
	}
	if err != nil {
		return err
	}
	if m.Role == "guest" {
		return ErrNotEligible
	}
	b, err := q.GetBotWithUser(ctx, bot)
	if db.IsNotFound(err) || (err == nil && b.User.DisabledAt != nil) {
		return httpx.NotFound("bot")
	}
	if err != nil {
		return err
	}
	st, err := q.GetOnBehalfWorkspaceState(ctx, sqlc.GetOnBehalfWorkspaceStateParams{WorkspaceID: ws, OwnerID: user, BotID: bot})
	if db.IsNotFound(err) {
		return httpx.NotFound("workspace")
	}
	if err != nil {
		return err
	}
	if !st.BotMember {
		return httpx.NotFound("bot")
	}
	if st.WorkspaceSuspended {
		return httpx.Coded(http.StatusForbidden, v1.ErrorCode_ERROR_CODE_WORKSPACE_SUSPENDED, "workspace suspended")
	}
	if !st.OwnerMember || st.OwnerSuspended {
		return ErrNotEligible
	}
	if st.PolicyMode == "enforced" || (st.DirectoryRequired && (!st.DirectoryActive || !st.DirectoryFresh)) {
		return auth.ErrOnBehalfIdentity
	}
	return nil
}

// Grant records user's own consent for bot in ws (Check first) and removes a pending invitation
// for it, returned (nil when there was none) so the caller can close its DM. A consent that
// already counts keeps its since. The caller has verified that user is the person asking.
func Grant(ctx context.Context, q *sqlc.Queries, ws, bot, user uuid.UUID) (*sqlc.BotDelegationInvite, error) {
	if err := Check(ctx, q, ws, bot, user); err != nil {
		return nil, err
	}
	counts, err := q.BotDelegationCounts(ctx, sqlc.BotDelegationCountsParams{WorkspaceID: ws, BotID: bot, UserID: user})
	if err != nil {
		return nil, err
	}
	if !counts {
		if _, err := q.UpsertBotDelegation(ctx, sqlc.UpsertBotDelegationParams{WorkspaceID: ws, BotID: bot, UserID: user}); err != nil {
			return nil, err
		}
	}
	return DropInvite(ctx, q, ws, bot, user)
}

// DropInvite deletes the pending invitation of user for bot in ws; nil when there is none.
func DropInvite(ctx context.Context, q *sqlc.Queries, ws, bot, user uuid.UUID) (*sqlc.BotDelegationInvite, error) {
	inv, err := q.DeleteBotDelegationInvite(ctx, sqlc.DeleteBotDelegationInviteParams{WorkspaceID: ws, BotID: bot, UserID: user})
	if db.IsNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &inv, nil
}

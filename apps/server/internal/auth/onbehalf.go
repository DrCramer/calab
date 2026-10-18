package auth

import (
	"context"
	"net/http"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/google/uuid"
)

// A bot acts on behalf of its owner (ADR-0106): a REST request with a bot token and the header
// "Calab-On-Behalf: owner", when the owner turned bots.acts_as_owner on, runs as the owner
// (Identity.ViaBot = the bot). Any refusal is an error: never a silent fallback to the bot.
const (
	// OnBehalfHeader asks for the request to run on behalf of the bot's owner.
	OnBehalfHeader = "Calab-On-Behalf"
	// OnBehalfOwner is the only value of OnBehalfHeader.
	OnBehalfOwner = "owner"
)

// Reasons (ApiError.reason) of the refusals of a request on behalf of the owner.
const (
	ReasonOnBehalfInvalid        = "ON_BEHALF_INVALID"
	ReasonOnBehalfNotBot         = "ON_BEHALF_NOT_BOT"
	ReasonOnBehalfDisabled       = "ON_BEHALF_DISABLED"
	ReasonOnBehalfOwnerInactive  = "ON_BEHALF_OWNER_INACTIVE"
	ReasonOnBehalfOwnerNotMember = "ON_BEHALF_OWNER_NOT_MEMBER"
	ReasonOnBehalfIdentity       = "ON_BEHALF_IDENTITY_POLICY"
	ReasonOnBehalfRoute          = "ON_BEHALF_ROUTE"
	ReasonOnBehalfOwnerOnly      = "ON_BEHALF_OWNER_ONLY"
)

// Errors of requests on behalf of the owner (ADR-0106).
var (
	ErrOnBehalfInvalid        = httpx.BadRequest(OnBehalfHeader+` must be "owner"`).WithDetails(ReasonOnBehalfInvalid, 0, 0)
	ErrOnBehalfNotBot         = httpx.Forbidden(OnBehalfHeader+" needs a bot token").WithDetails(ReasonOnBehalfNotBot, 0, 0)
	ErrOnBehalfDisabled       = httpx.Forbidden("the bot may not act on behalf of its owner").WithDetails(ReasonOnBehalfDisabled, 0, 0)
	ErrOnBehalfOwnerInactive  = httpx.Forbidden("the bot's owner cannot act").WithDetails(ReasonOnBehalfOwnerInactive, 0, 0)
	ErrOnBehalfOwnerNotMember = httpx.Forbidden("the bot's owner is not an active member of the workspace").WithDetails(ReasonOnBehalfOwnerNotMember, 0, 0)
	ErrOnBehalfIdentity       = httpx.Forbidden("the workspace identity policy needs the person's own sign-in").WithDetails(ReasonOnBehalfIdentity, 0, 0)
	ErrOnBehalfRoute          = httpx.Forbidden("not available on behalf of the owner").WithDetails(ReasonOnBehalfRoute, 0, 0)
	// ErrOnBehalfOwnerOnly: only the bot's owner turns acts_as_owner on or off.
	ErrOnBehalfOwnerOnly = httpx.Forbidden("only the bot's owner changes this").WithDetails(ReasonOnBehalfOwnerOnly, 0, 0)
)

// onBehalf turns the authenticated bot identity of r into its owner's when r asks for it
// (OnBehalfHeader). Without the header it returns id unchanged.
func (s *Service) onBehalf(r *http.Request, id Identity) (Identity, error) {
	vals := r.Header.Values(OnBehalfHeader)
	if len(vals) == 0 {
		return id, nil
	}
	if len(vals) != 1 || vals[0] != OnBehalfOwner {
		return Identity{}, ErrOnBehalfInvalid
	}
	if !id.IsBot {
		return Identity{}, ErrOnBehalfNotBot
	}
	return s.delegate(r.Context(), s.db.Q, id)
}

// delegate checks that bot may act on behalf of its owner now and returns the owner's identity.
func (s *Service) delegate(ctx context.Context, q *sqlc.Queries, bot Identity) (Identity, error) {
	d, err := q.GetOnBehalfDelegation(ctx, bot.UserID)
	if db.IsNotFound(err) {
		return Identity{}, httpx.Unauthenticated("session revoked")
	}
	if err != nil {
		return Identity{}, httpx.Unavailable(err)
	}
	if err := checkDelegation(d.ActsAsOwner, d.Revoked, d.BotDisabled, d.OwnerActive, d.TokenID, bot); err != nil {
		return Identity{}, err
	}
	return Identity{UserID: d.OwnerUserID, SessionID: bot.SessionID, ViaBot: bot.UserID}, nil
}

// checkDelegation: the bot's current token is the one of the request (a replaced or revoked
// token is 401, like any bot request), the owner turned the switch on, the owner is a live
// person. Shared by the gate (delegate) and the commit admission (WithMutation).
func checkDelegation(actsAsOwner, revoked, botDisabled, ownerActive bool, tokenID *uuid.UUID, bot Identity) error {
	if revoked || botDisabled || tokenID == nil || *tokenID != bot.SessionID {
		return httpx.Unauthenticated("session revoked")
	}
	if !actsAsOwner {
		return ErrOnBehalfDisabled
	}
	if !ownerActive {
		return ErrOnBehalfOwnerInactive
	}
	return nil
}

// checkOnBehalfWorkspace is CheckWorkspace of a request on behalf of the owner: the bot is a
// member of ws (else 404, as for any non-member: no existence oracle), ws is neither suspended
// nor closed for debt, the owner is a member there and neither banned nor suspended by the
// directory, and the workspace does not require a person's own sign-in (enforced SSO, or a
// directory-managed owner whose directory is not current).
func (s *Service) checkOnBehalfWorkspace(ctx context.Context, q *sqlc.Queries, id Identity, ws uuid.UUID) error {
	st, err := q.GetOnBehalfWorkspaceState(ctx, sqlc.GetOnBehalfWorkspaceStateParams{WorkspaceID: ws, OwnerID: id.UserID, BotID: id.ViaBot})
	if db.IsNotFound(err) {
		return httpx.NotFound("workspace")
	}
	if err != nil {
		return httpx.Unavailable(err)
	}
	if !st.BotMember {
		return httpx.NotFound("workspace")
	}
	if st.WorkspaceSuspended {
		return httpx.Coded(http.StatusForbidden, v1.ErrorCode_ERROR_CODE_WORKSPACE_SUSPENDED, "workspace suspended")
	}
	if err := s.CheckBillingOpen(ctx, q, ws); err != nil {
		return err
	}
	if !st.OwnerMember || st.OwnerSuspended {
		return ErrOnBehalfOwnerNotMember
	}
	if st.PolicyMode == "enforced" || (st.DirectoryRequired && (!st.DirectoryActive || !st.DirectoryFresh)) {
		return ErrOnBehalfIdentity
	}
	return nil
}

// ViaBot returns the bot of a request on behalf of its owner (ADR-0106), nil otherwise: what
// via_bot_id of the owner's message or journal entry records.
func ViaBot(ctx context.Context) *uuid.UUID {
	if id, ok := FromContext(ctx); ok && id.OnBehalf() {
		v := id.ViaBot
		return &v
	}
	return nil
}

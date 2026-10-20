package plans

import (
	"context"
	"fmt"
	"net/http"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
)

// Kind is a counted resource of a workspace the plan limits (Check).
type Kind int

const (
	// KindMembers counts members without guests; bots count (a bot takes a seat like a person).
	KindMembers Kind = iota + 1
	// KindBots counts bots that are members of the workspace (created here or added from elsewhere).
	KindBots
	// KindStickerPacks counts live sticker packs of the workspace.
	KindStickerPacks
	// KindBoards counts the task boards of the workspace, live and archived (ADR-0042).
	KindBoards
	// KindWikiPages counts the live (not trashed) Wiki pages of the workspace (ADR-0096).
	KindWikiPages
)

// what names a kind in the error message; the client tells the limits apart by it.
var what = map[Kind]string{KindMembers: "members", KindBots: "bots", KindStickerPacks: "sticker packs", KindBoards: "boards", KindWikiPages: "wiki pages"}

// LimitError is the plan-limit error of every counted kind (ADR-0024): 409 CONFLICT, reason
// PLAN_LIMIT, with the counter and the limit.
func LimitError(what string, used, limit uint64) *httpx.Error {
	return httpx.Coded(http.StatusConflict, v1.ErrorCode_ERROR_CODE_CONFLICT, fmt.Sprintf("the workspace plan allows %d %s", limit, what)).
		WithDetails(httpx.ReasonPlanLimit, used, limit)
}

func (k Kind) limit(l Limits) uint32 {
	switch k {
	case KindMembers:
		return l.Members
	case KindBots:
		return l.Bots
	case KindStickerPacks:
		return l.StickerPacks
	case KindBoards:
		return l.Boards
	case KindWikiPages:
		return l.WikiPages
	}
	return 0
}

func (k Kind) lock(ctx context.Context, q *sqlc.Queries, wsID uuid.UUID) error {
	switch k {
	case KindMembers:
		return q.LockWorkspaceMembers(ctx, wsID)
	case KindBots:
		return q.LockWorkspaceBots(ctx, wsID.String())
	case KindStickerPacks:
		return q.LockWorkspaceStickers(ctx, wsID)
	case KindBoards:
		return q.LockBoards(ctx, wsID.String())
	case KindWikiPages:
		return q.LockWikiTree(ctx, wsID)
	}
	return nil
}

func (k Kind) count(ctx context.Context, q *sqlc.Queries, wsID uuid.UUID) (int64, error) {
	switch k {
	case KindMembers:
		n, err := q.CountWorkspaceMembers(ctx, wsID)
		return int64(n), err
	case KindBots:
		return q.CountWorkspaceBots(ctx, wsID)
	case KindStickerPacks:
		n, err := q.CountWorkspaceStickerPacks(ctx, &wsID)
		return int64(n), err
	case KindBoards:
		n, err := q.CountAllBoards(ctx, wsID)
		return int64(n), err
	case KindWikiPages:
		return q.CountLiveWikiPages(ctx, wsID)
	}
	return 0, nil
}

// Check refuses one more item of kind in wsID above the plan limit (LimitError). Called inside
// the transaction that adds the item, it first takes the kind's advisory lock, so concurrent
// additions cannot both pass the count. Pass lock=false outside a transaction (a pre-check such
// as creating an invite link, which adds nobody yet). A nil service allows everything.
func (s *Service) Check(ctx context.Context, q *sqlc.Queries, wsID uuid.UUID, kind Kind, lock bool) error {
	if s == nil {
		return nil
	}
	if lock {
		if err := kind.lock(ctx, q, wsID); err != nil {
			return err
		}
	}
	lim, err := s.Effective(ctx, wsID)
	if err != nil {
		return err
	}
	limit := kind.limit(lim)
	if limit == 0 {
		return nil
	}
	n, err := kind.count(ctx, q, wsID)
	if err != nil {
		return err
	}
	if n >= int64(limit) {
		return LimitError(what[kind], uint64(max(n, 0)), uint64(limit))
	}
	return nil
}

// CheckAudio refuses setting a room / the workspace default to kbps above the plan's voice
// tier cap, unless it is the value already stored (rows written before the cap stay editable
// in their other fields; the effective tier is capped at join anyway).
func (s *Service) CheckAudio(ctx context.Context, wsID uuid.UUID, kbps, stored uint32) error {
	if s == nil || kbps == stored {
		return nil
	}
	lim, err := s.Effective(ctx, wsID)
	if err != nil {
		return err
	}
	if lim.AudioAllowed(kbps) {
		return nil
	}
	return LimitError("kbps of voice quality", uint64(kbps), uint64(lim.AudioMaxKbps))
}

// FeatureError is the refusal of a feature the plan does not include (CalDAV on Free): the same
// 409 PLAN_LIMIT as the counted limits, with used = limit = 0; the client tells the feature
// apart by the message.
func FeatureError(feature string) *httpx.Error {
	return httpx.Coded(http.StatusConflict, v1.ErrorCode_ERROR_CODE_CONFLICT, feature+" is not included in the plan").
		WithDetails(httpx.ReasonPlanLimit, 0, 0)
}

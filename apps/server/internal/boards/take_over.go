package boards

import (
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"

	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/perm"
)

// reasonOwnerOnly (ApiError.reason, 403): only the workspace owner may do this (rooms.ReasonOwnerOnly).
const reasonOwnerOnly = "OWNER_ONLY"

// takeOver: POST /api/boards/{id}/take-over — «Сделать меня владельцем» (ADR-0058 addendum
// 2026-10-14). The workspace owner with «Владелец видит приватное» on takes over a private board
// whose creator is not a member of the workspace any more (or unknown): created_by = the owner,
// a personal allow of every board bit, a TAKE_OVER entry in the workspace journal, BOARD_UPDATE.
// 403 OWNER_ONLY for the owner with the setting off and for anyone else who sees the board (404
// for those who do not), 409 while the creator is still a member or on a public board.
func (s *Service) takeOver(w http.ResponseWriter, r *http.Request) error {
	if isBot(r) {
		return auth.ErrBotNotAllowed
	}
	id, err := httpx.PathUUID(r, "id", "board")
	if err != nil {
		return err
	}
	acc, err := perm.FromContext(r.Context()).Board(r.Context(), id, uid(r))
	if errors.Is(err, perm.ErrNoBoard) {
		return httpx.NotFound("board")
	}
	if err != nil {
		return err
	}
	if acc.Member.Role != perm.RoleOwner {
		if !acc.Bits.Has(perm.ViewBoard) {
			return httpx.NotFound("board")
		}
		return httpx.Forbidden("only the workspace owner takes over a board").WithDetails(reasonOwnerOnly, 0, 0)
	}
	if !acc.Member.SeesPrivate() {
		return httpx.Forbidden("turn on «Владелец видит приватное» first").WithDetails(reasonOwnerOnly, 0, 0)
	}
	if err := writable(acc); err != nil {
		return err
	}
	me := uid(r)
	err = s.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		cur, err := q.GetBoardForUpdate(r.Context(), id)
		if db.IsNotFound(err) {
			return httpx.NotFound("board")
		}
		if err != nil {
			return err
		}
		if !cur.IsPrivate && !cur.Restricted {
			return httpx.Conflict("only a private board is taken over")
		}
		if cur.CreatedBy != nil {
			if *cur.CreatedBy == me {
				return httpx.Conflict("the board is already yours")
			}
			_, err := q.GetMemberAccess(r.Context(), sqlc.GetMemberAccessParams{WorkspaceID: cur.WorkspaceID, UserID: *cur.CreatedBy})
			if err == nil {
				return httpx.Conflict("the board's creator is still a member of the workspace")
			}
			if !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
		}
		if _, err := q.SetBoardCreator(r.Context(), sqlc.SetBoardCreatorParams{ID: id, CreatedBy: &me}); err != nil {
			return err
		}
		if err := q.GrantBoardUserOverride(r.Context(), sqlc.GrantBoardUserOverrideParams{
			BoardID: id, UserID: me.String(), Allow: int64(perm.BoardOnly),
		}); err != nil {
			return err
		}
		subject, kind := "board", "take_over"
		return q.InsertWorkspaceAudit(r.Context(), sqlc.InsertWorkspaceAuditParams{
			WorkspaceID: cur.WorkspaceID, ActorID: &me, Kind: kind, SubjectType: &subject, SubjectID: &id,
			PreviousOwnerID: cur.CreatedBy,
		})
	})
	if err != nil {
		return err
	}
	return s.respondBoard(w, r, id, acc, http.StatusOK)
}

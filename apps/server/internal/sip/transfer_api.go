package sip

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/rtc"
)

// Transfer of an answered inbound call (ADR-0132): POST / DELETE
// /api/workspaces/{id}/sip/calls/{cid}/transfer (sip.proto TransferSipCallRequest). The state
// machine's part is transfer.go; here the caller, the target and the effects the machine does
// not know about (the released member's busy key, presence and LiveKit seat).

func (s *Service) transferRoutes(mux httpx.Router, wrap func(http.Handler) http.Handler) {
	mux.Handle("POST /api/workspaces/{id}/sip/calls/{cid}/transfer", wrap(httpx.HandlerFunc(s.transferCall)))
	mux.Handle("DELETE /api/workspaces/{id}/sip/calls/{cid}/transfer", wrap(httpx.HandlerFunc(s.cancelTransfer)))
}

// transferable resolves {id}/{cid}: an inbound call of this workspace for one of its members
// (404 otherwise), and whether the caller may hand it over without being on it.
func (s *Service) transferable(r *http.Request) (id uuid.UUID, admin bool, err error) {
	wsID, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return uuid.Nil, false, err
	}
	call, bits, err := s.inboundCall(r)
	if err != nil {
		return uuid.Nil, false, err
	}
	if call.WorkspaceID != wsID || !s.inboundReady() {
		return uuid.Nil, false, httpx.NotFound("call")
	}
	if !pbconv.SipCallLive(call.Status) {
		return uuid.Nil, false, errCallOver()
	}
	return call.ID, bits.Has(perm.ManageIntegrations), nil
}

// onCallOrAdmin: only the member on the call (Answered) or MANAGE_INTEGRATIONS hands it over.
func onCallOrAdmin(rec *inRec, me uuid.UUID, admin bool) error {
	if admin || (rec.Answered != nil && *rec.Answered == me) {
		return nil
	}
	return httpx.Forbidden("only the member on the call or MANAGE_INTEGRATIONS may transfer it")
}

// transferTarget resolves the request's one target against the workspace's exchange.
func (s *Service) transferTarget(ctx context.Context, wsID uuid.UUID, req *v1.TransferSipCallRequest) (TransferTo, string, error) {
	n := 0
	for _, v := range []string{req.GetUserId(), req.GetExtensionId(), req.GetNumber()} {
		if strings.TrimSpace(v) != "" {
			n++
		}
	}
	if n != 1 {
		return TransferTo{}, "", httpx.Validation("target", "choose one target: a member, an internal number or a group")
	}
	ex, err := loadExchange(ctx, s.db.Q, wsID)
	if err != nil {
		return TransferTo{}, "", err
	}
	bad := httpx.Validation("target", "unknown transfer target")
	ext := func(id uuid.UUID) TransferTo { return TransferTo{Target: Target{Kind: RouteExtension, ID: &id}} }
	switch {
	case req.GetUserId() != "":
		u, err := uuid.Parse(req.GetUserId())
		if err != nil {
			return TransferTo{}, "", bad
		}
		_, role, err := perm.FromContext(ctx).Workspace(ctx, wsID, u)
		if errors.Is(err, perm.ErrNotMember) {
			return TransferTo{}, "", bad
		}
		if err != nil {
			return TransferTo{}, "", err
		}
		if role == perm.RoleGuest {
			return TransferTo{}, "", httpx.Validation("target", "guests do not take phone calls")
		}
		if id, ok := ex.byUser[u]; ok { // their number: the same ringing as a call to it
			return ext(id), "user:" + u.String(), nil
		}
		return TransferTo{User: &u}, "user:" + u.String(), nil
	case req.GetExtensionId() != "":
		id, err := uuid.Parse(req.GetExtensionId())
		if err != nil {
			return TransferTo{}, "", bad
		}
		if _, ok := ex.ext[id]; !ok {
			return TransferTo{}, "", bad
		}
		return ext(id), "ext:" + id.String(), nil
	default:
		id, ok := ex.byNumber[strings.TrimSpace(req.GetNumber())]
		if !ok {
			return TransferTo{}, "", httpx.Validation("target", "no such internal number")
		}
		return ext(id), "ext:" + id.String(), nil
	}
}

// transferError maps the machine's refusals to the API's.
func transferError(err error) error {
	var te *TransferError
	switch {
	case errors.As(err, &te) && te.Reason == ReasonBusy:
		return httpx.Coded(http.StatusConflict, v1.ErrorCode_ERROR_CODE_BUSY, "the target is in another call or nobody of the group is free")
	case errors.As(err, &te) && te.Reason == ReasonLoop:
		return httpx.Conflict("the call was routed too many times")
	case errors.As(err, &te):
		return httpx.Validation("target", "nobody takes calls on this number")
	case errors.Is(err, ErrTransferSelf):
		return httpx.Validation("target", "the call is already with this member")
	case errors.Is(err, ErrTransferring):
		return httpx.Conflict("a transfer of this call already rings")
	case errors.Is(err, ErrNoTransfer):
		return httpx.Conflict("no transfer of this call rings")
	case errors.Is(err, ErrNotAnswered):
		return httpx.Conflict("the call is not answered yet")
	}
	return err
}

func (s *Service) transferCall(w http.ResponseWriter, r *http.Request) error {
	id, admin, err := s.transferable(r)
	if err != nil {
		return err
	}
	var req v1.TransferSipCallRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	ctx, me := r.Context(), uid(r)
	wsID, _ := httpx.PathUUID(r, "id", "workspace")
	to, label, err := s.transferTarget(ctx, wsID, &req)
	if err != nil {
		return err
	}
	var from uuid.UUID
	err = s.withCall(ctx, id, func(rec *inRec, e Env, fx *Effects) error {
		if err := onCallOrAdmin(rec, me, admin); err != nil {
			return err
		}
		if rec.Handover != nil { // the last transfer's target is still connecting
			return transferError(ErrTransferring)
		}
		if err := rec.Transfer(e, to, fx); err != nil {
			return transferError(err)
		}
		from = *rec.Answered
		return nil
	})
	if errors.Is(err, errNoCall) {
		return errCallOver()
	}
	if err != nil {
		return err
	}
	slog.InfoContext(ctx, "sip: inbound call transfer", "call", id, "by", me, "from", from, "to", label)
	return s.writeCall(w, r, id)
}

func (s *Service) cancelTransfer(w http.ResponseWriter, r *http.Request) error {
	id, admin, err := s.transferable(r)
	if err != nil {
		return err
	}
	ctx, me := r.Context(), uid(r)
	err = s.withCall(ctx, id, func(rec *inRec, e Env, fx *Effects) error {
		if err := onCallOrAdmin(rec, me, admin); err != nil {
			return err
		}
		return transferError(rec.CancelTransfer(e, fx))
	})
	if errors.Is(err, errNoCall) {
		return errCallOver()
	}
	if err != nil {
		return err
	}
	slog.InfoContext(ctx, "sip: inbound call transfer cancelled", "call", id, "by", me)
	return s.writeCall(w, r, id)
}

func (s *Service) writeCall(w http.ResponseWriter, r *http.Request, id uuid.UUID) error {
	row, err := s.db.Q.GetSipCall(r.Context(), id)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.SipCallResponse{Call: pbconv.SipCall(row)})
	return nil
}

// handoverGrace: how long the target who answered a transfer has to connect to the call's room
// before the call goes back to the member who handed it over (still with the caller).
const handoverGrace = 15 * time.Second

// applyTransfer carries out what a transfer's transition means outside the machine: the target
// answered — the member who handed the call over stays with the caller until the target is in
// the room (Handover; finishHandover releases them, handBack returns the call when the target
// never connects); the call came back to a member who left the room while it rang — the usual
// grace to come back starts.
func (s *Service) applyTransfer(_ context.Context, r *inRec, fx *Effects) {
	if u := fx.Released; u != nil {
		from := *u
		r.Handover = &from
		now := time.Now()
		r.AnswerLeft, r.Deadline = now.UnixMilli(), now.Add(handoverGrace).UnixMilli() // the target is not in the room yet
		return
	}
	if fx.Xfer && r.Phase == PhaseActive && r.AnswerLeft != 0 {
		r.Deadline = time.Now().Add(answerGrace).UnixMilli()
	}
}

// finishHandover: the target of a transfer connected to the room — the member who handed the
// call over is released (busy key, «on a call»), told the call is the target's, and taken out
// of the room (their client leaves on that news; the removal is the backstop).
func (s *Service) finishHandover(ctx context.Context, r *inRec) {
	if r.Handover == nil {
		return
	}
	ctx = context.WithoutCancel(ctx)
	u := *r.Handover
	r.Handover = nil
	_ = unlockScript.Exec(ctx, s.redis, []string{inUserKey(u)}, []string{r.ID.String()}).Error()
	s.onCall(ctx, u, r.ID, false)
	if row, err := s.db.Q.GetSipCall(ctx, r.ID); err == nil {
		s.events.User(ctx, u, &v1.DispatchEvent{Event: &v1.DispatchEvent_SipCallUpdate{SipCallUpdate: &v1.SipCallUpdate{Call: pbconv.SipCall(row)}}})
	}
	if s.lk != nil {
		if err := s.lk.RemoveParticipant(ctx, r.Room, rtc.AnswerIdentity(u)); err != nil && !rtc.IsNotFound(err) {
			slog.WarnContext(ctx, "sip: remove the member who transferred", "call", r.ID, "err", err)
		}
	}
	slog.InfoContext(ctx, "sip: inbound call transferred", "call", r.ID, "from", u, "to", r.Answered)
}

// handBack: the target answered a transfer but did not connect within handoverGrace — the call
// is again the member's who handed it over, when they are still in the room (false: they are
// not, the caller has nobody).
func (s *Service) handBack(ctx context.Context, r *inRec, fx *Effects) bool {
	if r.Handover == nil || r.Answered == nil {
		return false
	}
	from, target := *r.Handover, *r.Answered
	if _, err := s.lk.GetParticipant(ctx, r.Room, rtc.AnswerIdentity(from)); err != nil {
		return false
	}
	ctx = context.WithoutCancel(ctx)
	r.Handover, r.Answered, r.AnswerLeft, r.Deadline = nil, &from, 0, 0
	r.step("transfer:not_connected")
	_ = unlockScript.Exec(ctx, s.redis, []string{inUserKey(target)}, []string{r.ID.String()}).Error()
	s.onCall(ctx, target, r.ID, false)
	row, err := db.GuardValue(ctx, s.db, func(q *sqlc.Queries) (sqlc.SipCall, error) {
		return q.ReturnSipInboundTransfer(ctx, sqlc.ReturnSipInboundTransferParams{ID: r.ID, UserID: from, Route: clip(strings.Join(r.Route, " → "), 500)})
	})
	if err != nil {
		slog.WarnContext(ctx, "sip: inbound journal row", "call", r.ID, "err", err)
	} else {
		pb := pbconv.SipCall(row)
		for _, u := range []uuid.UUID{from, target} {
			s.events.User(ctx, u, &v1.DispatchEvent{Event: &v1.DispatchEvent_SipCallUpdate{SipCallUpdate: &v1.SipCallUpdate{Call: pb}}})
		}
	}
	if s.lk != nil { // a late connect of the target must not take the call over
		if err := s.lk.RemoveParticipant(ctx, r.Room, rtc.AnswerIdentity(target)); err != nil && !rtc.IsNotFound(err) {
			slog.WarnContext(ctx, "sip: remove the target who did not connect", "call", r.ID, "err", err)
		}
	}
	fx.Changed = true // «Активные звонки»
	slog.InfoContext(ctx, "sip: inbound transfer not connected, back", "call", r.ID, "to", from, "target", target)
	return true
}

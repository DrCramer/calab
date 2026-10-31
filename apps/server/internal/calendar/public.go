package calendar

import (
	"errors"
	"net/http"

	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
)

// Answers without an account (ADR-0038 «Дополнение»): the invitation mail of an external
// attendee links to the web page /e/<id>/rsvp?t=<token>; the page shows the meeting
// (GET /api/event-rsvp?t=…) and stores the answer (POST /api/event-rsvp). Not a GET that
// changes state: mail scanners open links in mail, they would answer for the attendee.
// The meeting link of that mail is /e/<id>?t=<view token> («Диплинки для приглашённых»): the
// same page, which answers with the answer tokens of the response.

var errEventOver = httpx.Coded(http.StatusGone, v1.ErrorCode_ERROR_CODE_EVENT_OVER, "the meeting is over")

// claimsOf verifies a token and loads its event and attendee row.
func (s *Service) claimsOf(r *http.Request, tok string) (*bundle, sqlc.EventAttendee, rsvpClaims, error) {
	var none sqlc.EventAttendee
	if auth.IsBotRequest(r) {
		return nil, none, rsvpClaims{}, auth.ErrBotNotAllowed
	}
	if err := s.public.Take(r.Context(), httpx.ClientIP(r.Context())); err != nil {
		return nil, none, rsvpClaims{}, err
	}
	c, err := verifyRSVP(s.key, tok, s.Now())
	if errors.Is(err, errTokenExpired) {
		return nil, none, c, errEventOver
	}
	if err != nil {
		return nil, none, c, httpx.NotFound("invitation")
	}
	ev, err := s.db.Q.GetEvent(r.Context(), c.Event)
	if db.IsNotFound(err) {
		return nil, none, c, httpx.NotFound("invitation")
	}
	if err != nil {
		return nil, none, c, err
	}
	if err := auth.CheckPublicCapability(r.Context(), s.db.Q, ev.WorkspaceID); err != nil {
		return nil, none, c, err
	}
	b, err := loadOne(r.Context(), s.db.Q, ev)
	if err != nil {
		return nil, none, c, err
	}
	for _, a := range b.att {
		if a.Email != nil && *a.Email == c.Email {
			return b, a, c, nil
		}
	}
	return nil, none, c, httpx.NotFound("invitation") // no longer invited
}

var errViewToken = httpx.BadRequest("a view token cannot answer: use an answer token")

// rsvpResponse describes b to the external attendee a (ADR-0038 «Диплинки для приглашённых»):
// the meeting, its own stored answer, fresh answer tokens and its guest link. No other
// attendee is listed.
func (s *Service) rsvpResponse(r *http.Request, b *bundle, a sqlc.EventAttendee, c rsvpClaims) *v1.EventRsvpTokenResponse {
	ctx := r.Context()
	now := s.Now()
	out := &v1.EventRsvpTokenResponse{
		EventId: b.ev.ID.String(), Title: b.ev.Title, AllDay: b.ev.AllDay, Tz: b.ev.Tz, Email: c.Email,
		Cancelled: b.ev.CancelledAt != nil, Description: b.ev.Description, MyStatus: statusProto(a.Status),
		Repeat: b.series.Rule.Repeat, HolidayCalendar: b.series.Rule.Holidays,
	}
	if c.Status != statusView {
		out.Status = statusProto(c.Status)
	}
	if u := b.series.Rule.Until; u != nil {
		out.RepeatUntil = timestamppb.New(*u)
	}
	occ, ok := b.series.Next(now, lookAhead)
	if !ok {
		occ = Occurrence{b.series.Start, b.series.End}
	}
	out.StartsAt, out.EndsAt = timestamppb.New(occ.Start), timestamppb.New(occ.End)
	if exp := s.tokenExpiry(b); b.ev.CancelledAt == nil && now.Before(exp) {
		sign := func(st string) string {
			return signRSVP(s.key, rsvpClaims{Event: b.ev.ID, Status: st, Email: c.Email, Exp: exp})
		}
		out.AcceptToken, out.MaybeToken, out.DeclineToken = sign(StatusAccepted), sign(StatusMaybe), sign(StatusDeclined)
	}
	if u, err := s.db.Q.GetUser(ctx, b.ev.OrganizerID); err == nil {
		out.OrganizerName = u.DisplayName
		if u.Email != nil && u.EmailVerifiedAt != nil { // already in its invite.ics / Reply-To
			out.OrganizerEmail = *u.Email
		}
	}
	if ws, err := s.db.Q.GetWorkspace(ctx, b.ev.WorkspaceID); err == nil {
		out.WorkspaceName = ws.Name
	}
	if b.ev.RoomID != nil {
		if room, err := s.db.Q.GetRoom(ctx, *b.ev.RoomID); err == nil {
			out.RoomName = room.Name
		}
		if inv, ok := s.usableLink(ctx, b, a); ok {
			out.GuestUrl = s.guestURL(inv.Code)
			if inv.NotBefore != nil {
				out.GuestFrom = timestamppb.New(*inv.NotBefore)
			}
			if inv.ExpiresAt != nil {
				out.GuestUntil = timestamppb.New(*inv.ExpiresAt)
			}
		}
	}
	return out
}

// publicPreview: GET /api/event-rsvp?t=<token>.
func (s *Service) publicPreview(w http.ResponseWriter, r *http.Request) error {
	b, a, c, err := s.claimsOf(r, r.URL.Query().Get("t"))
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, s.rsvpResponse(r, b, a, c))
	return nil
}

// publicAnswer: POST /api/event-rsvp {token} — stores the answer of the link (idempotent).
func (s *Service) publicAnswer(w http.ResponseWriter, r *http.Request) error {
	var req v1.EventRsvpTokenRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	b, a, c, err := s.claimsOf(r, req.GetToken())
	if err != nil {
		return err
	}
	if c.Status == statusView {
		return errViewToken
	}
	if b.ev.CancelledAt != nil {
		return errEventOver
	}
	if a.Status != c.Status {
		upd, err := db.GuardValue(r.Context(), s.db, func(guarded *sqlc.Queries) (sqlc.EventAttendee, error) {
			return guarded.SetExternalAttendeeStatus(r.Context(), sqlc.SetExternalAttendeeStatusParams{EventID: b.ev.ID, Email: a.Email, Status: c.Status})
		})
		if err != nil {
			return err
		}
		if b, err = loadOne(r.Context(), s.db.Q, b.ev); err != nil {
			return err
		}
		s.publishRSVP(r.Context(), b, upd)
		a = upd
	}
	httpx.Write(w, http.StatusOK, s.rsvpResponse(r, b, a, c))
	return nil
}

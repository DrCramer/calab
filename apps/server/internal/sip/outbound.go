package sip

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/redis/rueidis"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/calls"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/redisx"
	"github.com/calaba/calaba/server/internal/rtc"
)

// The personal call (ADR-0137 §3): a member calls a number from the telephony section — the
// mirror of an answered inbound call. The call gets a LiveKit room of its own
// («sipout_<workspace>_<call id>»), the member a token for it (microphone and listening), and
// the number is dialed only once the member is in the room (participant_joined), so a callee
// who answers never meets an empty room. The member not in the room within 15 s fails the
// call («not_connected»); gone for 30 s ends it («lost»). While it lasts the member is busy
// (the inbound busy key: groups skip them, a one-to-one call to them is BUSY).
//
// Valkey keys (inside the namespace):
//
//	sipout:dial:<call id>  set once: "dial" (the member joined, the number is being dialed) or
//	                       "expired" (the 15 s passed first) — whichever comes first wins
//	sipout:left:<call id>  unix ms when the member left the room (the 30 s grace)

const (
	callerJoinWait   = 15 * time.Second
	personalRoomSize = 6 // the member, the line, the recording egress, a reconnect
	personalTokenTTL = 10 * time.Minute
	reasonNotJoined  = "not_connected"
)

var errBusy = httpx.Coded(http.StatusConflict, v1.ErrorCode_ERROR_CODE_SIP_BUSY, "you are in another call")

func outDialKey(id uuid.UUID) string { return redisx.Key("sipout:dial:" + id.String()) }
func outLeftKey(id uuid.UUID) string { return redisx.Key("sipout:left:" + id.String()) }

func (s *Service) personalRoutes(mux httpx.Router, wrap func(http.Handler) http.Handler) {
	mux.Handle("POST /api/workspaces/{id}/sip/calls", wrap(httpx.HandlerFunc(s.placePersonal)))
	mux.Handle("DELETE /api/workspaces/{id}/sip/calls/{cid}", wrap(httpx.HandlerFunc(s.hangupPersonal)))
}

// personalReady: the server can place personal calls (LiveKit with SIP, the token key).
func (s *Service) personalReady() bool { return s.sip != nil && s.lk != nil && s.media.Secret != "" }

// claimDial takes the call's one dial decision (what: "dial" or "expired"); false = taken.
func (s *Service) claimDial(ctx context.Context, id uuid.UUID, what string) (bool, error) {
	err := s.redis.Do(ctx, s.redis.B().Set().Key(outDialKey(id)).Value(what).Nx().Ex(inboundTTL).Build()).Error()
	if rueidis.IsRedisNil(err) {
		return false, nil
	}
	return err == nil, err
}

func (s *Service) placePersonal(w http.ResponseWriter, r *http.Request) error {
	wsID, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return err
	}
	ctx := r.Context()
	id := auth.MustFromContext(ctx)
	me := id.UserID
	bits, role, err := perm.FromContext(ctx).Workspace(ctx, wsID, me)
	if errors.Is(err, perm.ErrNotMember) {
		return httpx.NotFound("workspace")
	}
	if err != nil {
		return err
	}
	switch {
	case role == perm.RoleGuest:
		return httpx.Forbidden("guests cannot place phone calls")
	case id.IsBot || id.ViaBot != uuid.Nil:
		// v1: a bot has no LiveKit client of its own in the call's room — it calls from a
		// voice room (POST /api/rooms/{id}/calls).
		return httpx.Forbidden("bots place phone calls from a voice room")
	case !bits.Has(perm.PlaceCalls):
		// The workspace's own bit: a personal call has no room, so room overrides never count.
		return httpx.Forbidden("PLACE_CALLS required")
	}
	if err := s.planAllows(ctx, wsID); err != nil {
		return err
	}
	var req v1.PlaceSipPersonalCallRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	a, _, err := s.account(ctx, s.db.Q, wsID)
	if err != nil {
		return err
	}
	if !a.Enabled || a.TrunkID == "" || !s.personalReady() {
		return errDisabled
	}
	number, ok := NormalizeContactNumber(req.GetNumber(), a.CallerID)
	if !ok {
		return httpx.Validation("number", "not a phone number: use the international format, e.g. +7 916 123-45-67")
	}
	if req.GetContactId() != "" {
		if err := s.contactHas(ctx, wsID, req.GetContactId(), number); err != nil {
			return err
		}
	}
	if !Allowed(number, a.AllowedPrefixes) {
		return numberNotAllowed()
	}
	// Busy: a one-to-one call (ADR-0034), then the phone busy key, claimed for this call.
	if _, inCall, err := (calls.Store{C: s.redis}).Current(ctx, me); err != nil {
		return httpx.Unavailable(err)
	} else if inCall {
		return errBusy
	}
	callID, err := uuid.NewV7()
	if err != nil {
		return err
	}
	if err := s.redis.Do(ctx, s.redis.B().Set().Key(inUserKey(me)).Value(callID.String()).Nx().Ex(inboundTTL).Build()).Error(); rueidis.IsRedisNil(err) {
		return errBusy
	} else if err != nil {
		return httpx.Unavailable(err)
	}
	release := func() {
		_ = unlockScript.Exec(context.WithoutCancel(ctx), s.redis, []string{inUserKey(me)}, []string{callID.String()}).Error()
	}
	if err := s.takeOutbound(ctx, a, me); err != nil {
		release()
		return err
	}
	lkRoom := rtc.OutboundRoomName(wsID, callID)
	if err := s.lk.CreateRoom(ctx, lkRoom, 30, personalRoomSize); err != nil {
		release()
		return httpx.Unavailable(err)
	}
	call, err := s.journalOutside(ctx, callID, func(q *sqlc.Queries) (sqlc.SipCall, error) {
		return q.InsertSipPersonalCall(ctx, sqlc.InsertSipPersonalCallParams{ID: callID, WorkspaceID: wsID, Number: number,
			StartedBy: &me, ParticipantIdentity: rtc.SIPIdentity(callID), LkRoom: lkRoom})
	}, Event{Kind: EvStarted, User: &me})
	if err != nil {
		release()
		s.closeRoom(context.WithoutCancel(ctx), lkRoom)
		return err
	}
	join, err := s.personalJoin(ctx, lkRoom, me)
	if err != nil {
		s.finish(context.WithoutCancel(ctx), callID, pbconv.SipFailed, reasonError, nil)
		return err
	}
	s.onCall(ctx, me, callID, true)
	slog.InfoContext(ctx, "sip: personal call placed", "workspace", wsID, "call", callID, "by", me)
	s.publish(ctx, call)
	time.AfterFunc(s.opts.PersonalJoinWait, func() {
		ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer cancel()
		s.joinDeadline(ctx, callID)
	})
	pb := FillCaller(pbconv.SipCall(call), s.callerOf(ctx, wsID, number))
	httpx.Write(w, http.StatusCreated, &v1.PlaceSipPersonalCallResponse{Call: pb, Join: join})
	return nil
}

// contactHas checks that number is one of contact raw's numbers in the workspace (422 contactId).
func (s *Service) contactHas(ctx context.Context, ws uuid.UUID, raw, number string) error {
	cid, err := uuid.Parse(raw)
	if err != nil {
		return httpx.Validation("contactId", "contactId is a contact id")
	}
	owners, err := s.db.Q.SipContactNumberOwners(ctx, sqlc.SipContactNumberOwnersParams{WorkspaceID: ws, Numbers: []string{number}})
	if err != nil {
		return err
	}
	if len(owners) != 1 || owners[0].ID != cid {
		return httpx.Validation("contactId", "the number is not this contact's")
	}
	return nil
}

// personalJoin is the member's token for their personal call's room: microphone, listening and
// data (DTMF tones go to the line as data, ADR-0137 §3.7); no camera or screen.
func (s *Service) personalJoin(ctx context.Context, room string, user uuid.UUID) (*v1.JoinVoiceResponse, error) {
	u, err := s.db.Q.GetUser(ctx, user)
	if err != nil {
		return nil, err
	}
	identity := rtc.CallerIdentity(user)
	tok, err := rtc.JoinToken(s.media.APIKey, s.media.Secret, room, identity, u.DisplayName,
		rtc.Permission{CanSubscribe: true, CanPublish: true, CanPublishData: true, CanPublishSources: []rtc.TrackSource{rtc.SourceMicrophone}},
		personalTokenTTL)
	if err != nil {
		return nil, err
	}
	return &v1.JoinVoiceResponse{Url: s.media.PublicURL, Token: tok, Identity: identity, CanSpeak: true}, nil
}

// joinDeadline fails a personal call whose member did not get into its room in time.
func (s *Service) joinDeadline(ctx context.Context, id uuid.UUID) {
	ok, err := s.claimDial(ctx, id, "expired")
	if err != nil || !ok {
		return // the member joined (the dial goes on), or Valkey is down (the sweep decides)
	}
	row, err := s.db.Q.GetSipCall(ctx, id)
	if err != nil || !pbconv.SipCallLive(row.Status) {
		return
	}
	slog.InfoContext(ctx, "sip: personal call not connected", "call", id)
	s.finish(ctx, id, pbconv.SipFailed, reasonNotJoined, nil)
}

// personalEnded cleans up after a personal call's end (finish): the member is free again, the
// line and the room go.
func (s *Service) personalEnded(ctx context.Context, row sqlc.SipCall) {
	ctx = context.WithoutCancel(ctx)
	if row.StartedBy != nil {
		_ = unlockScript.Exec(ctx, s.redis, []string{inUserKey(*row.StartedBy)}, []string{row.ID.String()}).Error()
		s.onCall(ctx, *row.StartedBy, row.ID, false)
	}
	_ = s.redis.Do(ctx, s.redis.B().Del().Key(outLeftKey(row.ID)).Build()).Error()
	s.removeLine(ctx, row.LkRoom, row.ParticipantIdentity)
	s.closeRoom(ctx, row.LkRoom)
}

func (s *Service) hangupPersonal(w http.ResponseWriter, r *http.Request) error {
	wsID, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return err
	}
	cid, err := httpx.PathUUID(r, "cid", "call")
	if err != nil {
		return err
	}
	ctx, me := r.Context(), uid(r)
	bits, role, err := perm.FromContext(ctx).Workspace(ctx, wsID, me)
	if errors.Is(err, perm.ErrNotMember) || (err == nil && role == perm.RoleGuest) {
		return httpx.NotFound("call")
	}
	if err != nil {
		return err
	}
	row, err := s.db.Q.GetSipCall(ctx, cid)
	if db.IsNotFound(err) || (err == nil && (row.WorkspaceID != wsID || row.Origin != OriginPersonal)) {
		return httpx.NotFound("call")
	}
	if err != nil {
		return err
	}
	mine := row.StartedBy != nil && *row.StartedBy == me
	if !mine && !bits.Has(perm.ManageIntegrations) {
		return httpx.Forbidden("only the caller or MANAGE_INTEGRATIONS may end this call")
	}
	if !pbconv.SipCallLive(row.Status) {
		return httpx.Conflict("the call is over")
	}
	reason := reasonHangup
	switch {
	case !mine:
		reason = reasonModerator
	case row.Status != pbconv.SipActive:
		reason = reasonCancelled
	}
	s.removeLine(ctx, row.LkRoom, row.ParticipantIdentity)
	out, ok := s.finish(ctx, cid, pbconv.SipEnded, reason, &me)
	if !ok {
		if out, err = s.db.Q.GetSipCall(ctx, cid); err != nil {
			return err
		}
		if pbconv.SipCallLive(out.Status) {
			return httpx.Conflict("the call changed meanwhile")
		}
	}
	slog.InfoContext(ctx, "sip: personal call ended", "call", cid, "by", me, "reason", out.Reason)
	pb := FillCaller(pbconv.SipCall(out), s.callerOf(ctx, wsID, out.PeerE164))
	if auth.MustFromContext(ctx).IsBot { // a bot never learns whose phone a number is (ADR-0077)
		pb = forBot(pb)
	}
	httpx.Write(w, http.StatusOK, &v1.SipCallResponse{Call: pb})
	return nil
}

// ---------------------------------------------------------------- LiveKit webhooks

// Outbound implements rtc.SIPHook: events of a personal call's own LiveKit room.
func (s *Service) Outbound(ctx context.Context, event, room string, p *rtc.Participant) error {
	wid, cid, ok := rtc.ParseOutboundRoom(room)
	if !ok {
		return nil
	}
	row, err := s.db.Q.GetSipCall(ctx, cid)
	if db.IsNotFound(err) || (err == nil && (row.WorkspaceID != wid || row.Origin != OriginPersonal || row.LkRoom != room)) {
		return nil // not a call of ours
	}
	if err != nil {
		return err
	}
	live := pbconv.SipCallLive(row.Status)
	if event == rtc.EventRoomFinished {
		if live {
			s.finish(ctx, cid, pbconv.SipEnded, reasonRoomClosed, nil)
		}
		return nil
	}
	if p == nil {
		return nil
	}
	gone := event == rtc.EventParticipantLeft || event == rtc.EventParticipantAborted
	if user, ok := rtc.ParseCallerIdentity(p.Identity); ok {
		if row.StartedBy == nil || *row.StartedBy != user {
			return nil // a token is only ever issued to the caller
		}
		switch {
		case event == rtc.EventParticipantJoined && !live:
			s.closeRoom(ctx, room) // the call ended before the member got in
		case event == rtc.EventParticipantJoined:
			return s.callerJoined(ctx, row)
		case gone && live:
			now := time.Now()
			if err := s.redis.Do(ctx, s.redis.B().Set().Key(outLeftKey(cid)).Value(strconv.FormatInt(now.UnixMilli(), 10)).
				Ex(10*time.Minute).Build()).Error(); err != nil {
				return err
			}
			time.AfterFunc(s.opts.PersonalGrace+100*time.Millisecond, func() {
				ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
				defer cancel()
				s.callerGone(ctx, cid)
			})
		}
		return nil
	}
	if id, ok := rtc.ParseSIPIdentity(p.Identity); ok && id == cid {
		switch {
		case event == rtc.EventParticipantJoined && live:
			return s.lineJoined(ctx, row, p)
		case gone && row.Status == pbconv.SipActive:
			s.finish(ctx, cid, pbconv.SipEnded, reasonRemote, nil) // the callee hung up
		}
	}
	return nil
}

// callerJoined: the member is in the call's room — dial the number (once), or they came back.
func (s *Service) callerJoined(ctx context.Context, row sqlc.SipCall) error {
	if err := s.redis.Do(ctx, s.redis.B().Del().Key(outLeftKey(row.ID)).Build()).Error(); err != nil {
		return err
	}
	ok, err := s.claimDial(ctx, row.ID, "dial")
	if err != nil {
		return err
	}
	if !ok {
		return nil // a reconnect, a redelivered event, or the 15 s passed (the call failed)
	}
	a, _, err := s.account(ctx, s.db.Q, row.WorkspaceID)
	if err != nil {
		return err
	}
	if !a.Enabled || a.TrunkID == "" || s.sip == nil {
		s.finish(ctx, row.ID, pbconv.SipFailed, reasonDisabled, nil)
		return nil
	}
	slog.InfoContext(ctx, "sip: personal call dialing", "call", row.ID)
	// The dial waits for the answer: detached from the webhook, with its own publish budget.
	go s.dial(events.WithBudget(context.WithoutCancel(ctx), events.RequestBudget), row, a, row.LkRoom)
	return nil
}

// lineJoined: the phone line is in the room — the far end rings, or it answered.
func (s *Service) lineJoined(ctx context.Context, row sqlc.SipCall, p *rtc.Participant) error {
	var out sqlc.SipCall
	var err error
	switch p.Attributes[rtc.AttrSIPCallStatus] {
	case "active":
		out, err = s.journalOutside(ctx, row.ID, func(q *sqlc.Queries) (sqlc.SipCall, error) {
			return q.MarkSipCallActive(ctx, sqlc.MarkSipCallActiveParams{ID: row.ID, SipCallID: p.Attributes[rtc.AttrSIPCallID]})
		}, Event{Kind: EvAnswered})
	case "ringing":
		out, err = s.journalOutside(ctx, row.ID, func(q *sqlc.Queries) (sqlc.SipCall, error) { return q.MarkSipCallRinging(ctx, row.ID) },
			Event{Kind: EvProviderRinging})
	default:
		return nil
	}
	if db.IsNotFound(err) {
		return nil // already there (the dial's own answer, a redelivered event)
	}
	if err != nil {
		return err
	}
	s.publish(ctx, out)
	if out.Status == pbconv.SipActive {
		s.recConnected(ctx, out.ID)
	}
	return nil
}

// callerGone ends a personal call whose member left its room more than the grace ago and is
// not back.
func (s *Service) callerGone(ctx context.Context, id uuid.UUID) {
	v, err := s.redis.Do(ctx, s.redis.B().Get().Key(outLeftKey(id)).Build()).AsInt64()
	if err != nil {
		return // back (no key) or Valkey is down (the sweep looks again)
	}
	if time.Since(time.UnixMilli(v)) < s.opts.PersonalGrace {
		return
	}
	row, err := s.db.Q.GetSipCall(ctx, id)
	if err != nil || !pbconv.SipCallLive(row.Status) || row.StartedBy == nil {
		return
	}
	if s.lk != nil {
		if _, err := s.lk.GetParticipant(ctx, row.LkRoom, rtc.CallerIdentity(*row.StartedBy)); err == nil {
			_ = s.redis.Do(ctx, s.redis.B().Del().Key(outLeftKey(id)).Build()).Error()
			return // reconnected; its joined event is late
		} else if !rtc.IsNotFound(err) {
			return
		}
	}
	slog.InfoContext(ctx, "sip: personal call lost its caller", "call", id)
	s.finish(ctx, id, pbconv.SipEnded, reasonLost, nil)
}

// sweepPersonal (Sweep, one instance per period; calls older than 30 s): the 15 s to join, a
// line that never answered or outlived the 2 h cap, a line or a member gone without an event.
func (s *Service) sweepPersonal(ctx context.Context, c sqlc.SipCall, now time.Time, ringDeadline time.Time) {
	if c.Status == pbconv.SipDialing {
		if ok, err := s.claimDial(ctx, c.ID, "expired"); err == nil && ok {
			s.finish(ctx, c.ID, pbconv.SipFailed, reasonNotJoined, nil)
			return
		}
	}
	if c.Status != pbconv.SipActive {
		if c.StartedAt.Before(ringDeadline) {
			s.finish(ctx, c.ID, pbconv.SipFailed, reasonLost, nil)
		}
		return
	}
	answered := c.StartedAt
	if c.AnsweredAt != nil {
		answered = *c.AnsweredAt
	}
	if now.Sub(answered) > s.opts.MaxCallTime+time.Minute {
		s.finish(ctx, c.ID, pbconv.SipEnded, reasonRemote, nil)
		return
	}
	if s.lk == nil || c.StartedBy == nil {
		return
	}
	if _, err := s.lk.GetParticipant(ctx, c.LkRoom, c.ParticipantIdentity); rtc.IsNotFound(err) {
		s.finish(ctx, c.ID, pbconv.SipEnded, reasonLost, nil)
		return
	}
	if _, err := s.lk.GetParticipant(ctx, c.LkRoom, rtc.CallerIdentity(*c.StartedBy)); rtc.IsNotFound(err) {
		// The member is not in the room: start the grace if no event did, end it once it passed.
		set := s.redis.B().Set().Key(outLeftKey(c.ID)).Value(strconv.FormatInt(now.UnixMilli(), 10)).Nx().Ex(10 * time.Minute).Build()
		_ = s.redis.Do(ctx, set).Error()
		s.callerGone(ctx, c.ID)
	}
}

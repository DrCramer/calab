package rtc

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/plans"
	"github.com/calaba/calaba/server/internal/voice"
)

// One-to-one calls (ADR-0034): the voice session of a DM room. It reuses the voice machinery
// of workspace rooms with the DM room id as its scope (voice package: workspace id = room id,
// LiveKit room "dm:<room_id>"): optimistic /join with the pending state and its 15 s
// confirmation, webhooks, reconcile, streams and cameras. What differs:
//   - /join is allowed only to a participant of the DM's ACTIVE call (CallGate), else 409
//     CALL_NOT_ACTIVE; participant_joined re-checks it (a token lives 10 min);
//   - the grant is fixed (dmGrant: microphone, camera, screen share, subscribe), no plan or
//     room limits beyond dmMedia, no moderation;
//   - voice events go to the two participants' user channels only (empty workspace_id), not
//     to any workspace; there is no ROOM_UPDATE call timer (the call has answered_at);
//   - each time a participant's first device enters or last device leaves the session,
//     CallGate.VoiceChanged tells the call service, which ends a call lost for 30 s.

// CallGate is the call service as the voice code needs it (internal/calls).
type CallGate interface {
	// ActiveParticipant reports whether u takes part in the DM's ACTIVE call.
	ActiveParticipant(ctx context.Context, dmRoomID, u uuid.UUID) (bool, error)
	// VoiceChanged reports u's first device in (present) / last device out of the session.
	VoiceChanged(ctx context.Context, dmRoomID, u uuid.UUID, present bool)
}

// Tunables of a DM session: two people, a few devices each; LiveKit closes an empty room
// after a minute (the call service ends a lost call after 30 s anyway).
const (
	dmEmptyTimeout    = 60
	dmMaxParticipants = 8
)

// dmBits: what a call participant may do in the session.
const dmBits = perm.ViewRoom | perm.Connect | perm.Speak | perm.Stream | perm.Video

// dmGrant is the LiveKit grant of a call participant: every source from the start.
func dmGrant() Permission { return Grant(dmBits, true, true) }

// dmMedia: media settings of a call (no workspace defaults, no plan).
func dmMedia() *v1.RoomMediaSettings {
	return &v1.RoomMediaSettings{
		AudioBitrateKbps: 48,
		MaxStreamPreset:  v1.ScreenSharePreset_SCREEN_SHARE_PRESET_ORIGINAL_60,
		MaxStreams:       4,
		CameraLimit:      4,
	}
}

var errCallNotActive = httpx.Coded(http.StatusConflict, v1.ErrorCode_ERROR_CODE_CALL_NOT_ACTIVE,
	"there is no active call of yours in this direct message")

// inCall reports whether u takes part in the ACTIVE call of the DM (false without calls).
func (s *Service) inCall(ctx context.Context, dmRoomID, u uuid.UUID) (bool, error) {
	if s.Calls == nil {
		return false, nil
	}
	return s.Calls.ActiveParticipant(ctx, dmRoomID, u)
}

// joinDM is POST /api/rooms/{id}/join of a DM room (acc: the caller is a participant).
func (s *Service) joinDM(w http.ResponseWriter, r *http.Request, roomID uuid.UUID) error {
	ctx := r.Context()
	id := auth.MustFromContext(ctx)
	if id.IsBot {
		return auth.ErrBotNotAllowed
	}
	ok, err := s.inCall(ctx, roomID, id.UserID)
	if err != nil {
		return err
	}
	if !ok {
		return errCallNotActive
	}
	row, err := s.db.Q.GetRoom(ctx, roomID)
	if err != nil {
		return err
	}
	me, err := s.db.Q.GetUser(ctx, id.UserID)
	if err != nil {
		return err
	}
	name := voice.DMRoomName(roomID)
	if err := s.lk.CreateRoom(ctx, name, dmEmptyTimeout, dmMaxParticipants); err != nil {
		return httpx.Unavailable(err)
	}
	identity := voice.Identity(id.UserID, id.SessionID)
	tok, err := JoinToken(s.cfg.APIKey, s.cfg.Secret, name, identity, me.DisplayName, dmGrant(), TokenTTL)
	if err != nil {
		return err
	}
	var (
		pending  bool
		joinedAt int64
	)
	if err := s.joinExclusive(ctx, id.UserID, id.SessionID, func() (err error) {
		pending, joinedAt, err = s.recordPending(ctx, wsRoom{Room: row, WorkspaceID: roomID}, id.UserID, id.SessionID, admission{})
		return err
	}); err != nil {
		return err
	}
	if pending {
		s.expectConnect(roomID, roomID, id.UserID, id.SessionID, joinedAt)
	}
	httpx.Write(w, http.StatusOK, &v1.JoinVoiceResponse{
		Url: s.cfg.PublicURL, Token: tok, Identity: identity, Media: dmMedia(),
		CanSpeak: true, CanStream: true, CanVideo: true, Pending: pending,
	})
	return nil
}

// dmParticipantJoined admits a device connected to a DM session if its user still takes part
// in the DM's ACTIVE call (and the session is not revoked); otherwise it is removed.
func (s *Service) dmParticipantJoined(ctx context.Context, rid, uid, sid uuid.UUID, lkRoom string, p *Participant) error {
	reason := ""
	if err := s.checkIdentity(ctx, rid, rid, uid, sid); err != nil {
		reason = "identity access denied"
	}
	if s.Revoked != nil {
		if revoked, err := s.Revoked(ctx, sid); err != nil {
			return err
		} else if revoked {
			reason = "session revoked"
		}
	}
	if reason == "" && s.superseded(ctx, rid, rid, sid) {
		reason = "the user joined voice from another device"
	}
	if reason == "" {
		ok, err := s.inCall(ctx, rid, uid)
		if err != nil {
			return err
		}
		if !ok {
			reason = "no active call"
		}
	}
	if reason != "" {
		slog.InfoContext(ctx, "call join rejected", "identity", p.Identity, "reason", reason)
		s.removeIdentities(ctx, lkRoom, []string{p.Identity})
		return s.update(ctx, rid, uid, sid, func(cur *voice.SessionState) *voice.SessionState {
			if cur == nil || cur.RoomID != rid {
				return cur
			}
			return nil
		})
	}
	muted := micMuted(p)
	return s.update(ctx, rid, uid, sid, func(cur *voice.SessionState) *voice.SessionState {
		n := voice.SessionState{RoomID: rid, Muted: muted}
		if cur != nil && cur.RoomID == rid {
			n = *cur
			n.Muted, n.Pending = muted, false
		}
		return &n
	})
}

// scopeInfo is roomInfo for either kind of voice scope: a DM session gets dmMedia.
func (s *Service) scopeInfo(ctx context.Context, wid, rid uuid.UUID) (wsRoom, *v1.RoomMediaSettings, error) {
	if voice.IsDM(wid, rid) {
		row, err := s.db.Q.GetRoom(ctx, rid)
		return wsRoom{Room: row, WorkspaceID: rid}, dmMedia(), err
	}
	return s.roomInfo(ctx, rid)
}

// scopeBits: the voice permissions of uid in a scope's room (dmBits in a DM session).
func (s *Service) scopeBits(ctx context.Context, wid, rid, uid uuid.UUID) (perm.Bits, error) {
	if voice.IsDM(wid, rid) {
		return dmBits, nil
	}
	acc, err := perm.NewResolver(s.db.Q).Room(ctx, rid, uid)
	return acc.Bits, err
}

// publishScope sends a voice event of a room: to the workspace, or for a DM session to the
// two participants' user channels (the event's workspace_id must be empty then).
func (s *Service) publishScope(ctx context.Context, wid, rid uuid.UUID, ev *v1.DispatchEvent) {
	if !voice.IsDM(wid, rid) {
		s.events.Workspace(ctx, wid, ev)
		return
	}
	for _, u := range s.dmMembers(ctx, rid) {
		s.events.User(ctx, u, ev)
	}
}

// scopeWS is the workspace_id of a voice event: empty for a DM session.
func scopeWS(wid, rid uuid.UUID) string {
	if voice.IsDM(wid, rid) {
		return ""
	}
	return wid.String()
}

func (s *Service) dmMembers(ctx context.Context, rid uuid.UUID) []uuid.UUID {
	aud, err := s.db.Q.RoomAudience(ctx, rid)
	if err != nil || !aud.Dm {
		slog.WarnContext(ctx, "participants of a DM call", "room", rid, "err", err)
		return nil
	}
	return aud.DmMembers
}

// publishDMVoice publishes a DM session's VOICE_STATE_UPDATE to both participants and tells
// the call service when the user entered or left the session.
func (s *Service) publishDMVoice(ctx context.Context, rid uuid.UUID, c voice.Change) {
	st := proto.CloneOf(c.After)
	st.WorkspaceId = ""
	s.publishScope(ctx, rid, rid, &v1.DispatchEvent{Event: &v1.DispatchEvent_VoiceStateUpdate{VoiceStateUpdate: &v1.VoiceStateUpdate{State: st}}})
	was, is := c.Before.GetRoomId() == rid.String(), c.After.GetRoomId() == rid.String()
	if was != is && s.Calls != nil {
		if uid, err := uuid.Parse(c.After.GetUserId()); err == nil {
			s.Calls.VoiceChanged(ctx, rid, uid, is)
		}
	}
}

// InCall reports whether u has a device (connected or still connecting) in the DM's session
// (calls.Media).
func (s *Service) InCall(ctx context.Context, dmRoomID, u uuid.UUID) (bool, error) {
	states, err := s.voice.List(ctx, dmRoomID)
	if err != nil {
		return false, err
	}
	for _, st := range states {
		if st.UserID == u && st.RoomID == dmRoomID {
			return true, nil
		}
	}
	return false, nil
}

// EndCall closes the DM's session: LiveKit disconnects everyone, voice state goes (calls.Media).
func (s *Service) EndCall(ctx context.Context, dmRoomID uuid.UUID) {
	s.closeRoom(ctx, dmRoomID, dmRoomID)
	if err := s.voice.Forget(ctx, dmRoomID); err != nil {
		slog.WarnContext(ctx, "forget a DM voice scope", "room", dmRoomID, "err", err)
	}
}

// requestDMMedia answers /stream/request and /camera/request in a DM session: the grant
// already has every source, so it only checks the call and reserves the stream preset.
func (s *Service) requestDMMedia(w http.ResponseWriter, r *http.Request, roomID uuid.UUID, stream bool) error {
	ctx := r.Context()
	id := auth.MustFromContext(ctx)
	ok, err := s.inCall(ctx, roomID, id.UserID)
	if err != nil {
		return err
	}
	if !ok {
		return errCallNotActive
	}
	identity := voice.Identity(id.UserID, id.SessionID)
	if stream {
		var req v1.RequestStreamRequest
		if err := httpx.Decode(w, r, &req); err != nil {
			return err
		}
		preset := ClampPreset(req.GetPreset(), dmMedia().GetMaxStreamPreset())
		if err := s.voice.ReserveStream(ctx, identity, preset); err != nil {
			return err
		}
		httpx.Write(w, http.StatusOK, &v1.RequestStreamResponse{Preset: preset, Fps: plans.Limits{}.StreamFPS(preset, req.GetFps())})
		return nil
	}
	var req v1.RequestCameraRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	preset := req.GetPreset()
	if preset == v1.ScreenSharePreset_SCREEN_SHARE_PRESET_UNSPECIFIED || !plans.IsCameraPreset(preset) || preset == v1.ScreenSharePreset_SCREEN_SHARE_PRESET_ORIGINAL {
		preset = v1.ScreenSharePreset_SCREEN_SHARE_PRESET_H720
	}
	httpx.Write(w, http.StatusOK, &v1.RequestCameraResponse{Preset: preset, Fps: req.GetFps()})
	return nil
}

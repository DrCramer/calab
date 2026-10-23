package sip

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
)

// Call recording (ADR-0131, CBF-81): the admin's two switches and the hooks the calls fire. The
// recording itself (the egress, the Disk) is recording.Service.

// CallRecorder records calls (recording.Service). Both return at once: a call never waits for
// the recorder, and a recorder failure never touches the call.
type CallRecorder interface {
	// CallConnected: the call reached a person or a bot (inbound: answered; outbound: picked up).
	CallConnected(ctx context.Context, call uuid.UUID)
	// CallEnded: the call is over.
	CallEnded(ctx context.Context, call uuid.UUID)
	// PhoneAvailable: the server can record (LiveKit Egress is configured).
	PhoneAvailable() bool
}

// SetRecorder gives the service its call recorder (nil = calls are not recorded).
func (s *Service) SetRecorder(r CallRecorder) { s.recorder = r }

func (s *Service) recConnected(ctx context.Context, call uuid.UUID) {
	if s.recorder != nil {
		s.recorder.CallConnected(ctx, call)
	}
}

func (s *Service) recEnded(ctx context.Context, call uuid.UUID) {
	if s.recorder != nil {
		s.recorder.CallEnded(ctx, call)
	}
}

// fillRecording puts the switches and whether the server records into out.
func (s *Service) fillRecording(out *v1.SipSettings, a sqlc.SipAccount) {
	out.RecordInbound, out.RecordOutbound = a.RecordInbound, a.RecordOutbound
	out.RecordingAvailable = s.recorder != nil && s.recorder.PhoneAvailable()
}

// putRecording: PUT /api/workspaces/{id}/sip/recording (MANAGE_INTEGRATIONS, the telephony plan).
func (s *Service) putRecording(w http.ResponseWriter, r *http.Request) error {
	wsID, err := manage(r)
	if err != nil {
		return err
	}
	if err := s.planAllows(r.Context(), wsID); err != nil {
		return err
	}
	var req v1.PutSipRecordingRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	ctx := r.Context()
	if _, saved, err := s.account(ctx, s.db.Q, wsID); err != nil {
		return err
	} else if !saved {
		return httpx.Conflict("save the provider settings first")
	}
	a, err := db.GuardValue(ctx, s.db, func(q *sqlc.Queries) (sqlc.SipAccount, error) {
		return q.SetSipRecording(ctx, sqlc.SetSipRecordingParams{WorkspaceID: wsID, RecordInbound: req.GetRecordInbound(), RecordOutbound: req.GetRecordOutbound()})
	})
	if err != nil {
		return err
	}
	slog.InfoContext(ctx, "sip: call recording switched", "workspace", wsID, "by", uid(r), "inbound", a.RecordInbound, "outbound", a.RecordOutbound)
	out := settingsPB(a, true)
	out.InboundAvailable = s.inboundReady()
	s.fillRecording(out, a)
	if ex, err := loadExchange(ctx, s.db.Q, wsID); err == nil {
		fillInbound(out, a, ex)
	} else {
		fillInbound(out, a, nil)
	}
	s.fillRegistration(ctx, out, a)
	httpx.Write(w, http.StatusOK, &v1.PutSipRecordingResponse{Settings: out})
	return nil
}

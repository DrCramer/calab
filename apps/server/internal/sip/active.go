package sip

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/redis/rueidis"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
)

// Active calls (ADR-0128): GET /api/workspaces/{id}/sip/calls lists the workspace's calls going
// on now for the telephony settings' «Активные звонки» — the live journal rows, inbound ones
// with the step of their Valkey state (a menu, a group ringing, answered); SIP_CALLS_CHANGED on
// the workspace channel (gateway: MANAGE_INTEGRATIONS sessions only) says when to read it again.

// activeCutoff: live rows older than this are lost calls (a call lasts 2 h, the inbound state
// 3 h); the sweepers close them, the list leaves them out.
const activeCutoff = inboundTTL

// callsChanged tells the workspace's telephony admins that its live calls changed.
func (s *Service) callsChanged(ctx context.Context, wsID uuid.UUID) {
	s.events.Workspace(context.WithoutCancel(ctx), wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_SipCallsChanged{
		SipCallsChanged: &v1.SipCallsChanged{WorkspaceId: wsID.String()},
	}})
}

func (s *Service) activeCalls(w http.ResponseWriter, r *http.Request) error {
	wsID, err := manage(r)
	if err != nil {
		return err
	}
	ctx, me := r.Context(), uid(r)
	res := perm.FromContext(ctx)
	bits, _, err := res.Workspace(ctx, wsID, me)
	if err != nil {
		return err
	}
	full := bits.Has(perm.ViewJournals)
	rows, err := s.db.Q.ListActiveSipCalls(ctx, sqlc.ListActiveSipCallsParams{WorkspaceID: wsID, StartedAt: time.Now().Add(-activeCutoff)})
	if err != nil {
		return err
	}
	recs, err := s.inboundRecs(ctx, rows)
	if err != nil {
		return err
	}
	var ex *exchange
	if len(recs) > 0 {
		if ex, err = loadExchange(ctx, s.db.Q, wsID); err != nil {
			return err
		}
	}
	out := &v1.ListSipActiveCallsResponse{Calls: make([]*v1.SipActiveCall, 0, len(rows))}
	for _, c := range rows {
		if c.RoomID != nil {
			acc, err := res.ReadRoom(ctx, *c.RoomID, me)
			if errors.Is(err, perm.ErrNoRoom) || (err == nil && !acc.Bits.Has(perm.ViewRoom)) {
				continue // as the journal: calls of rooms I cannot see are not mine to see
			}
			if err != nil {
				return err
			}
		}
		var rec *inRec
		if c.Direction == "in" {
			if rec = recs[c.ID]; rec == nil {
				continue // its state is gone: a lost call the sweep closes
			}
		}
		a := activeCall(c, rec, ex)
		if !full {
			maskCall(a)
		}
		out.Calls = append(out.Calls, a)
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// inboundRecs reads the live Valkey states of the inbound rows in one MGET.
func (s *Service) inboundRecs(ctx context.Context, rows []sqlc.SipCall) (map[uuid.UUID]*inRec, error) {
	var keys []string
	for _, c := range rows {
		if c.Direction == "in" {
			keys = append(keys, inKey(c.ID))
		}
	}
	out := map[uuid.UUID]*inRec{}
	if len(keys) == 0 {
		return out, nil
	}
	vals, err := s.redis.Do(ctx, s.redis.B().Mget().Key(keys...).Build()).ToArray()
	if err != nil {
		return nil, err
	}
	for _, v := range vals {
		raw, err := v.ToString()
		if rueidis.IsRedisNil(err) {
			continue
		}
		if err != nil {
			return nil, err
		}
		var rec inRec
		if json.Unmarshal([]byte(raw), &rec) != nil || !rec.Live() {
			continue
		}
		out[rec.ID] = &rec
	}
	return out, nil
}

// activeCall is one live call with its step. Pure: rec is the inbound call's state (nil for
// outbound), ex the exchange (names of menus and groups; nil when no inbound call is live).
func activeCall(c sqlc.SipCall, rec *inRec, ex *exchange) *v1.SipActiveCall {
	a := &v1.SipActiveCall{Call: pbconv.SipCall(c)}
	if rec == nil {
		a.Step = v1.SipActiveStep_SIP_ACTIVE_STEP_DIALING
		if c.Status == pbconv.SipActive {
			a.Step = v1.SipActiveStep_SIP_ACTIVE_STEP_CONNECTED
		}
		return a
	}
	switch {
	case rec.Transferring(): // ADR-0132: still with the member while the target rings
		a.Step = v1.SipActiveStep_SIP_ACTIVE_STEP_CONNECTED
		a.Call.AnsweredBy = rec.Answered.String()
		a.Call.RingingUserIds = make([]string, 0, len(rec.Ringing))
		for _, u := range rec.Ringing {
			a.Call.RingingUserIds = append(a.Call.RingingUserIds, u.String())
		}
	case rec.Phase == PhaseMenu:
		a.Step = v1.SipActiveStep_SIP_ACTIVE_STEP_MENU
		if rec.Menu != nil {
			a.StepId = rec.Menu.String()
			if ex != nil {
				a.StepName = ex.menu[*rec.Menu].Name
			}
		}
	case rec.Phase == PhaseRing:
		a.Step = v1.SipActiveStep_SIP_ACTIVE_STEP_RINGING
		a.Call.RingingUserIds = make([]string, 0, len(rec.Ringing))
		for _, u := range rec.Ringing {
			a.Call.RingingUserIds = append(a.Call.RingingUserIds, u.String())
		}
		if rec.Group != nil {
			a.StepId = rec.Group.String()
			if ex != nil {
				a.StepName = ex.group[*rec.Group].Name
			}
		}
	default:
		a.Step = v1.SipActiveStep_SIP_ACTIVE_STEP_CONNECTED
		if rec.Answered != nil {
			a.Call.AnsweredBy = rec.Answered.String()
		}
	}
	return a
}

// maskCall hides the caller from a viewer without VIEW_JOURNALS: the number masked and the
// fields that carry it otherwise cleared — an inbound line's LiveKit identity is «sip_<number>»
// and the provider's Call-ID may hold it too.
func maskCall(a *v1.SipActiveCall) {
	a.Call.Number, a.NumberMasked = maskNumber(a.Call.GetNumber()), true
	a.Call.ParticipantIdentity, a.Call.ProviderCallId = "", ""
}

// maskNumber hides the middle of a phone number for a viewer without VIEW_JOURNALS: the
// country and operator code and the last two digits stay («+7916*****67»). Anything that is not
// a plain number (a SIP URI or user name, «anonymous») and numbers too short to keep a hidden
// middle are starred whole.
func maskNumber(n string) string {
	digits := 0
	for i, r := range n {
		switch {
		case r >= '0' && r <= '9':
			digits++
		case r == '+' && i == 0:
		default:
			return strings.Repeat("*", utf8.RuneCountInString(n))
		}
	}
	if digits < 7 {
		return strings.Repeat("*", len(n))
	}
	keepHead := min(4, digits-5)
	var b strings.Builder
	i := 0
	for _, r := range n {
		if r < '0' || r > '9' {
			b.WriteRune(r)
			continue
		}
		if i < keepHead || i >= digits-2 {
			b.WriteRune(r)
		} else {
			b.WriteByte('*')
		}
		i++
	}
	return b.String()
}

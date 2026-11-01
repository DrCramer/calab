package sip

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"
	_ "time/tzdata" // IANA zones of schedules: the distroless image has no zoneinfo

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/files"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/prodcal"
)

// The working-hours schedule of the entry point (ADR-0138): PUT …/sip/schedule, the settings'
// SipSchedule and the Schedule a new inbound call is checked against. The workspace has one
// entry point (sip_accounts.inbound_*), so the schedule lives on the same row.

// hourJSON is an interval as stored in sip_accounts.schedule_hours (weekday 1 = Monday … 7).
type hourJSON struct {
	Weekday int `json:"weekday"`
	Start   int `json:"start"`
	End     int `json:"end"`
}

func weekdayOf(iso int) time.Weekday { return time.Weekday(iso % 7) }

// storedHours reads schedule_hours (a broken value reads as none).
func storedHours(raw []byte) []hourJSON {
	var hs []hourJSON
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &hs); err != nil {
			return nil
		}
	}
	return hs
}

// scheduleLoc is the zone of a stored schedule (unknown or empty: Moscow).
func scheduleLoc(name string) *time.Location {
	if name == "" {
		name = DefaultScheduleTZ
	}
	if loc, err := time.LoadLocation(name); err == nil {
		return loc
	}
	loc, _ := time.LoadLocation(DefaultScheduleTZ)
	return loc
}

// scheduleOf is the schedule a new call of account a is checked against.
func scheduleOf(a sqlc.SipAccount) *Schedule {
	s := &Schedule{Enabled: a.ScheduleEnabled, Loc: scheduleLoc(a.ScheduleTz), Holidays: a.ScheduleHolidays,
		OffHours: routeTarget(a.OffHoursKind, a.OffHoursMenuID, a.OffHoursExtensionID, a.OffHoursGroupID)}
	for _, h := range storedHours(a.ScheduleHours) {
		s.Hours = append(s.Hours, Interval{Weekday: weekdayOf(h.Weekday), Start: h.Start, End: h.End})
	}
	if a.OffHoursNoticeFileID != nil {
		s.Notice, s.NoticeMs = *a.OffHoursNoticeFileID, int(a.OffHoursNoticeMs)
	}
	return s
}

// fillSchedule adds the schedule to the settings (targets resolved against ex when loaded).
func fillSchedule(out *v1.SipSettings, a sqlc.SipAccount, ex *exchange) {
	tz := a.ScheduleTz
	if tz == "" {
		tz = DefaultScheduleTZ
	}
	kind := a.OffHoursKind
	if kind == "" {
		kind = "hangup"
	}
	sc := &v1.SipSchedule{Enabled: a.ScheduleEnabled, TimeZone: tz, Hours: []*v1.SipScheduleInterval{},
		ProductionCalendarRu: a.ScheduleHolidays == prodcal.RU, NoticeFileId: idOf(a.OffHoursNoticeFileID),
		NoticeDurationMs: uint32(max(a.OffHoursNoticeMs, 0))} //nolint:gosec // ≤ 180000
	for _, h := range storedHours(a.ScheduleHours) {
		sc.Hours = append(sc.Hours, &v1.SipScheduleInterval{Weekday: uint32(max(h.Weekday, 0)), //nolint:gosec // 1..7
			StartMin: uint32(max(h.Start, 0)), EndMin: uint32(max(h.End, 0))}) //nolint:gosec // 0..1440
	}
	if ex != nil {
		sc.OffHours = ex.targetPB(kind, a.OffHoursMenuID, a.OffHoursExtensionID, a.OffHoursGroupID)
	} else {
		sc.OffHours = &v1.SipRouteTarget{Kind: routeKindFromDB[kind]}
	}
	out.Schedule = sc
}

// parseHours validates the request's working hours into what is stored.
func parseHours(in []*v1.SipScheduleInterval, enabled bool) ([]hourJSON, error) {
	if len(in) > 7*MaxScheduleIntervals {
		return nil, httpx.Validation("hours", "at most 6 intervals a day")
	}
	out := make([]hourJSON, 0, len(in))
	ivs := make([]Interval, 0, len(in))
	for _, h := range in {
		wd, start, end := h.GetWeekday(), h.GetStartMin(), h.GetEndMin()
		if wd < 1 || wd > 7 {
			return nil, httpx.Validation("hours", "a weekday is 1 (Monday) to 7 (Sunday)")
		}
		if start >= minutesPerDay || end < 1 || end > minutesPerDay || start == end {
			return nil, httpx.Validation("hours", "an interval starts at 0..1439 and ends at 1..1440 minutes, not where it starts")
		}
		o := hourJSON{Weekday: int(wd), Start: int(start), End: int(end)}
		out = append(out, o)
		ivs = append(ivs, Interval{Weekday: weekdayOf(o.Weekday), Start: o.Start, End: o.End})
	}
	if err := CheckIntervals(ivs); err != nil {
		return nil, httpx.Validation("hours", err.Error())
	}
	if enabled && len(out) == 0 {
		return nil, httpx.Validation("hours", "add the working hours")
	}
	return out, nil
}

// putSchedule: PUT /api/workspaces/{id}/sip/schedule (sip.proto).
func (s *Service) putSchedule(w http.ResponseWriter, r *http.Request) error {
	wsID, err := manage(r)
	if err != nil {
		return err
	}
	ctx, me := r.Context(), uid(r)
	if err := s.planAllows(ctx, wsID); err != nil {
		return err
	}
	var req v1.PutSipScheduleRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	sc := req.GetSchedule()
	tz := sc.GetTimeZone()
	if tz == "" {
		tz = DefaultScheduleTZ
	}
	if _, err := time.LoadLocation(tz); err != nil || len(tz) > 64 || tz == "Local" {
		return httpx.Validation("timeZone", "an IANA time zone, e.g. Europe/Moscow")
	}
	hours, err := parseHours(sc.GetHours(), sc.GetEnabled())
	if err != nil {
		return err
	}
	raw, err := json.Marshal(hours)
	if err != nil {
		return err
	}
	holidays := ""
	if sc.GetProductionCalendarRu() {
		holidays = prodcal.RU
	}
	if _, saved, err := s.account(ctx, s.db.Q, wsID); err != nil {
		return err
	} else if !saved {
		return httpx.Conflict("save the provider settings first")
	}
	var notice *files.PreparedFile
	var noticeMs int32
	if req.NoticeSourceFileId != nil && req.GetNoticeSourceFileId() != "" {
		if notice, noticeMs, err = s.preparePrompt(r, wsID, req.GetNoticeSourceFileId(), "noticeSourceFileId"); err != nil {
			return err
		}
	}
	var saved sqlc.SipAccount
	var oldNotice *uuid.UUID
	var ex *exchange
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if err := q.LockSipAccount(ctx, wsID); err != nil {
			return err
		}
		cur, ok, err := s.account(ctx, q, wsID)
		if err != nil {
			return err
		}
		if !ok {
			return httpx.Conflict("save the provider settings first")
		}
		if ex, err = loadExchange(ctx, q, wsID); err != nil {
			return err
		}
		t := dbTarget{kind: "hangup"}
		if sc.GetOffHours() != nil {
			if t, err = ex.parseTarget(sc.GetOffHours(), "offHours", false); err != nil {
				return err
			}
		}
		if saved, err = q.SetSipSchedule(ctx, sqlc.SetSipScheduleParams{WorkspaceID: wsID, ScheduleEnabled: sc.GetEnabled(),
			ScheduleTz: tz, ScheduleHours: raw, ScheduleHolidays: holidays, OffHoursKind: t.kind, OffHoursMenuID: t.menu,
			OffHoursExtensionID: t.ext, OffHoursGroupID: t.group}); err != nil {
			return err
		}
		if req.NoticeSourceFileId == nil {
			return nil
		}
		p := sqlc.SetSipScheduleNoticeParams{WorkspaceID: wsID}
		if notice != nil {
			f, err := s.files.InsertPrepared(ctx, q, notice)
			if err != nil {
				return err
			}
			p.OffHoursNoticeFileID, p.OffHoursNoticeMs = &f.ID, noticeMs
		}
		oldNotice = cur.OffHoursNoticeFileID
		saved, err = q.SetSipScheduleNotice(ctx, p)
		return err
	})
	if err != nil {
		s.discard(notice)
		return err
	}
	s.dropPrompt(context.WithoutCancel(ctx), oldNotice)
	slog.InfoContext(ctx, "sip: schedule saved", "workspace", wsID, "by", me, "enabled", saved.ScheduleEnabled, "tz", saved.ScheduleTz,
		"intervals", len(hours), "holidays", saved.ScheduleHolidays, "off_hours", saved.OffHoursKind)
	out := settingsPB(saved, true)
	out.InboundAvailable = s.inboundReady()
	s.fillRecording(out, saved)
	fillInbound(out, saved, ex)
	s.fillRegistration(ctx, out, saved)
	httpx.Write(w, http.StatusOK, &v1.PutSipScheduleResponse{Settings: out})
	return nil
}

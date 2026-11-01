//go:build integration

package app_test

import (
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

func setCalendarZones(t *testing.T, u musty, want int, zones ...*v1.CalendarZone) *v1.Me {
	t.Helper()
	var r v1.UpdateMeResponse
	u.must(want, "PATCH", "/api/me", &v1.UpdateMeRequest{CalendarZones: &v1.CalendarZones{Zones: zones}}, &r)
	return r.GetMe()
}

// TestCalendarZones (board #85): the extra zones of the calendar's hour axis are the user's own,
// validated (known IANA zones, ≤ 2, distinct, short labels), kept by a `settings` replace, read
// back by GET /api/me, cleared by an empty list; bots may not set them.
func TestCalendarZones(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)

	me := setCalendarZones(t, bob, 200, &v1.CalendarZone{Zone: "Asia/Kolkata", Label: "  Дели "}, &v1.CalendarZone{Zone: "America/New_York"})
	got := me.GetSettings().GetCalendarZones()
	if len(got) != 2 || got[0].GetZone() != "Asia/Kolkata" || got[0].GetLabel() != "Дели" || got[1].GetZone() != "America/New_York" || got[1].GetLabel() != "" {
		t.Fatalf("calendar_zones %v", got)
	}
	setCalendarZones(t, bob, 422, &v1.CalendarZone{Zone: "Mars/Olympus"})
	setCalendarZones(t, bob, 422, &v1.CalendarZone{Zone: "Local"})
	setCalendarZones(t, bob, 422, &v1.CalendarZone{Zone: "Asia/Tokyo"}, &v1.CalendarZone{Zone: "Asia/Tokyo"})
	setCalendarZones(t, bob, 422, &v1.CalendarZone{Zone: "Asia/Tokyo"}, &v1.CalendarZone{Zone: "Europe/Paris"}, &v1.CalendarZone{Zone: "UTC"})
	setCalendarZones(t, bob, 422, &v1.CalendarZone{Zone: "Asia/Tokyo", Label: "семнадцать знаков"})

	// A `settings` replace (the audio settings) leaves them; GET /api/me returns them.
	var mr v1.UpdateMeResponse
	bob.must(200, "PATCH", "/api/me", &v1.UpdateMeRequest{Settings: &v1.UserSettings{MicMode: v1.MicMode_MIC_MODE_VAD}}, &mr)
	if n := len(mr.GetMe().GetSettings().GetCalendarZones()); n != 2 {
		t.Fatalf("a settings replace changed calendar_zones: %d", n)
	}
	var gm v1.GetMeResponse
	bob.must(200, "GET", "/api/me", nil, &gm)
	if n := len(gm.GetMe().GetSettings().GetCalendarZones()); n != 2 {
		t.Fatalf("GET /api/me calendar_zones: %d", n)
	}
	// Per user: the owner's own list is untouched.
	var om v1.GetMeResponse
	o.must(200, "GET", "/api/me", nil, &om)
	if n := len(om.GetMe().GetSettings().GetCalendarZones()); n != 0 {
		t.Fatalf("another user's calendar_zones: %d", n)
	}

	bt := createBot(t, o, ws.GetId(), "zonebot")
	setCalendarZones(t, bt, 403, &v1.CalendarZone{Zone: "Asia/Tokyo"})
	if n := len(setCalendarZones(t, bob, 200).GetSettings().GetCalendarZones()); n != 0 {
		t.Fatalf("cleared calendar_zones: %d", n)
	}
}

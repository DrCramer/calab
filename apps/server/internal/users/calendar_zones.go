package users

import (
	"encoding/json"
	"strings"
	"unicode/utf8"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/httpx"
)

// Extra time zones of the calendar's hour axis (board #85), users.calendar_zones.
const (
	MaxCalendarZones     = 2
	maxCalendarZoneLabel = 16
	calendarZonesField   = "calendarZones.zones"
)

// calendarZones validates a requested list and returns the column value: at most
// MaxCalendarZones distinct known IANA zones, labels trimmed and ≤ maxCalendarZoneLabel runes.
func calendarZones(in []*v1.CalendarZone) ([]byte, error) {
	if len(in) > MaxCalendarZones {
		return nil, httpx.Validation(calendarZonesField, "at most 2 extra time zones")
	}
	type row struct {
		Zone  string `json:"zone"`
		Label string `json:"label"`
	}
	out := make([]row, 0, len(in))
	for _, z := range in {
		zone := strings.TrimSpace(z.GetZone())
		if err := ValidateTimezone(zone); err != nil {
			return nil, httpx.Validation(calendarZonesField, "zones must be IANA time zone names, e.g. Asia/Kolkata")
		}
		for _, r := range out {
			if r.Zone == zone {
				return nil, httpx.Validation(calendarZonesField, "time zones must be distinct")
			}
		}
		label := strings.TrimSpace(z.GetLabel())
		if utf8.RuneCountInString(label) > maxCalendarZoneLabel || !utf8.ValidString(label) {
			return nil, httpx.Validation(calendarZonesField, "a label is at most 16 characters")
		}
		out = append(out, row{Zone: zone, Label: label})
	}
	return json.Marshal(out)
}

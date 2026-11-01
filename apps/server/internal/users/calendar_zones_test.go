package users

import (
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

func TestCalendarZones(t *testing.T) {
	z := func(zone, label string) *v1.CalendarZone { return &v1.CalendarZone{Zone: zone, Label: label} }
	got, err := calendarZones([]*v1.CalendarZone{z(" Asia/Kolkata ", " Дели "), z("UTC", "")})
	if err != nil || string(got) != `[{"zone":"Asia/Kolkata","label":"Дели"},{"zone":"UTC","label":""}]` {
		t.Fatalf("got %s, %v", got, err)
	}
	if got, err := calendarZones(nil); err != nil || string(got) != "[]" {
		t.Fatalf("empty: %s, %v", got, err)
	}
	for name, in := range map[string][]*v1.CalendarZone{
		"unknown":   {z("Mars/Base", "")},
		"local":     {z("Local", "")},
		"empty":     {z("", "")},
		"lowercase": {z("asia/kolkata", "")},
		"duplicate": {z("Asia/Tokyo", ""), z("Asia/Tokyo", "x")},
		"three":     {z("Asia/Tokyo", ""), z("UTC", ""), z("Europe/Paris", "")},
		"label":     {z("Asia/Tokyo", "12345678901234567")},
	} {
		if _, err := calendarZones(in); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

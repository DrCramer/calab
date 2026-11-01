package caldav

import (
	"testing"
	"time"
)

func TestBusyPreservesSourceDates(t *testing.T) {
	data := ics("BEGIN:VEVENT\r\nUID:dates\r\nDTSTART;VALUE=DATE:20261024\r\nDTEND;VALUE=DATE:20261026\r\nRRULE:FREQ=DAILY;COUNT=3\r\nEND:VEVENT\r\n")
	for _, zone := range []string{"Europe/Berlin", "Pacific/Auckland", "America/Los_Angeles"} {
		t.Run(zone, func(t *testing.T) {
			loc := mustLoc(t, zone)
			got := BusyFromICS(data, utc("2026-10-20T00:00:00Z"), utc("2026-11-01T00:00:00Z"), loc)
			if len(got) != 3 {
				t.Fatalf("got %d occurrences", len(got))
			}
			for i, b := range got {
				start := time.Date(2026, 10, 24+i, 0, 0, 0, 0, loc)
				end := start.AddDate(0, 0, 2)
				if !b.AllDay || b.StartDate != start.Format(time.DateOnly) || b.EndDate != end.Format(time.DateOnly) {
					t.Fatalf("occurrence %d lost exclusive source dates: %+v", i, b)
				}
				if !b.Start.Equal(start) || !b.End.Equal(end) {
					t.Fatalf("occurrence %d changed the existing instant interval: %+v", i, b)
				}
			}
		})
	}
	timed := BusyFromICS(ics("BEGIN:VEVENT\r\nUID:timed\r\nDTSTART:20261024T090000Z\r\nDTEND:20261024T100000Z\r\nEND:VEVENT\r\n"), utc("2026-10-20T00:00:00Z"), utc("2026-11-01T00:00:00Z"), time.UTC)
	if len(timed) != 1 || timed[0].StartDate != "" || timed[0].EndDate != "" {
		t.Fatalf("timed event acquired DATE fields: %+v", timed)
	}
	params, err := insertParams([16]byte{1}, append(BusyFromICS(data, utc("2026-10-20T00:00:00Z"), utc("2026-11-01T00:00:00Z"), time.UTC), timed...))
	if err != nil {
		t.Fatal(err)
	}
	if len(params.StartDates) != 4 || len(params.EndDates) != 4 || params.StartDates[0] != "2026-10-24" || params.EndDates[2] != "2026-10-28" || params.StartDates[3] != "" || params.EndDates[3] != "" {
		t.Fatalf("batch date arrays lost alignment: %+v", params)
	}
}

// Some zones start DST at midnight, so that calendar day has no 00:00: the all-day event must
// still begin on its own date (at the end of the gap), not on the previous evening.
func TestAllDayDatesWhereDSTSkipsMidnight(t *testing.T) {
	from, to := utc("2026-02-01T00:00:00Z"), utc("2026-10-01T00:00:00Z")
	type occ struct{ start, end string }
	for _, c := range []struct {
		name, zone, event string
		want              []occ
	}{
		{"daily series from the gap day", "America/Santiago",
			"DTSTART;VALUE=DATE:20260906\r\nRRULE:FREQ=DAILY;COUNT=3",
			[]occ{{"2026-09-06", "2026-09-07"}, {"2026-09-07", "2026-09-08"}, {"2026-09-08", "2026-09-09"}}},
		{"weekly series through the gap day", "America/Santiago",
			"DTSTART;VALUE=DATE:20260830\r\nDTEND;VALUE=DATE:20260831\r\nRRULE:FREQ=WEEKLY;BYDAY=SU;COUNT=3",
			[]occ{{"2026-08-30", "2026-08-31"}, {"2026-09-06", "2026-09-07"}, {"2026-09-13", "2026-09-14"}}},
		{"excluded gap day", "America/Santiago",
			"DTSTART;VALUE=DATE:20260905\r\nRRULE:FREQ=DAILY;COUNT=3\r\nEXDATE;VALUE=DATE:20260906",
			[]occ{{"2026-09-05", "2026-09-06"}, {"2026-09-07", "2026-09-08"}}},
		{"ends on the gap day", "America/Havana",
			"DTSTART;VALUE=DATE:20260306\r\nDTEND;VALUE=DATE:20260308",
			[]occ{{"2026-03-06", "2026-03-08"}}},
		{"UTC+14", "Pacific/Kiritimati", "DTSTART;VALUE=DATE:20260906", []occ{{"2026-09-06", "2026-09-07"}}},
		{"UTC-12", "Etc/GMT+12", "DTSTART;VALUE=DATE:20260906", []occ{{"2026-09-06", "2026-09-07"}}},
	} {
		t.Run(c.name, func(t *testing.T) {
			loc := mustLoc(t, c.zone)
			got := BusyFromICS(ics("BEGIN:VEVENT\r\nUID:gap\r\n"+c.event+"\r\nEND:VEVENT\r\n"), from, to, loc)
			if len(got) != len(c.want) {
				t.Fatalf("got %d occurrences, want %d: %+v", len(got), len(c.want), got)
			}
			for i, b := range got {
				if b.StartDate != c.want[i].start || b.EndDate != c.want[i].end {
					t.Fatalf("occurrence %d: %s..%s, want %s..%s", i, b.StartDate, b.EndDate, c.want[i].start, c.want[i].end)
				}
				// The instants agree with the dates and the interval is not empty.
				s, e := b.Start.In(loc), b.End.In(loc)
				if s.Format(time.DateOnly) != b.StartDate || e.Format(time.DateOnly) != b.EndDate || !e.After(s) {
					t.Fatalf("occurrence %d: instants %s..%s disagree with %s..%s", i, s, e, b.StartDate, b.EndDate)
				}
			}
		})
	}
}

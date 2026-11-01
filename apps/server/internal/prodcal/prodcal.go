// Package prodcal is the Russian production calendar shared by meeting series (ADR-0136) and
// the telephony working-hours schedule (ADR-0138).
package prodcal

import (
	"log/slog"
	"sync"
	"time"
)

// The Russian production calendar (ADR-0136): the weekdays that are not working days (public
// holidays of the Labour Code art. 112 and the days off moved by art. 112 or by the yearly
// government decree) and the Saturdays / Sundays that are working days. Pre-holiday short days
// do not matter to a meeting series and are not kept.
//
// Sources (checked against the decree texts):
//   - 2025: Government Decree of 04.10.2024 No. 1335 — Jan 4 → May 2, Jan 5 → Dec 31,
//     Feb 23 → May 8, Mar 8 → Jun 13, Sat Nov 1 → Mon Nov 3 (Nov 1 is a working Saturday).
//   - 2026: Government Decree of 24.09.2025 No. 1466 — Jan 3 → Jan 9, Jan 4 → Dec 31; by
//     art. 112: Mar 8 (Sun) → Mar 9, May 9 (Sat) → May 11.
//   - 2027: Government Decree of 17.09.2026 No. 1187 — Jan 2 → Nov 5, Jan 3 → Dec 31,
//     Sat Feb 20 → Mon Feb 22 (Feb 20 is a working Saturday); by art. 112: May 1 (Sat) → May 3,
//     May 9 (Sun) → May 10, Jun 12 (Sat) → Jun 14.
//
// A year missing here falls back to Mon–Fri (logged once). Add the next year when its decree is
// out (usually in September–October; docs/12-tech-backlog.md).

// RU is the holiday calendar id of the Russian production calendar.
const RU = "ru"

type prodYear struct {
	off     []string // MM-DD: weekdays that are not working days
	working []string // MM-DD: Saturdays / Sundays that are working days
}

var prodcalRU = map[int]prodYear{
	2025: {
		off: []string{"01-01", "01-02", "01-03", "01-06", "01-07", "01-08",
			"05-01", "05-02", "05-08", "05-09", "06-12", "06-13", "11-03", "11-04", "12-31"},
		working: []string{"11-01"},
	},
	2026: {
		off: []string{"01-01", "01-02", "01-05", "01-06", "01-07", "01-08", "01-09",
			"02-23", "03-09", "05-01", "05-11", "06-12", "11-04", "12-31"},
	},
	2027: {
		off: []string{"01-01", "01-04", "01-05", "01-06", "01-07", "01-08",
			"02-22", "02-23", "03-08", "05-03", "05-10", "06-14", "11-04", "11-05", "12-31"},
		working: []string{"02-20"},
	},
}

type civilDate struct {
	y int
	m time.Month
	d int
}

// prodRU indexes prodcalRU: date → true for a working weekend day, false for a weekday off.
var prodRU = func() map[civilDate]bool {
	out := map[civilDate]bool{}
	add := func(y int, days []string, working bool) {
		for _, s := range days {
			t, err := time.Parse("2006-01-02", time.Date(y, 1, 1, 0, 0, 0, 0, time.UTC).Format("2006-")+s)
			if err != nil {
				panic("prodcal: bad date " + s)
			}
			wd := t.Weekday()
			if working != (wd == time.Saturday || wd == time.Sunday) {
				panic("prodcal: " + t.Format("2006-01-02") + " is on the wrong side of the week")
			}
			out[civilDate{y, t.Month(), t.Day()}] = working
		}
	}
	for y, py := range prodcalRU {
		add(y, py.off, false)
		add(y, py.working, true)
	}
	return out
}()

// FirstYear is the first year the table covers.
var FirstYear = func() int {
	lo := 0
	for y := range prodcalRU {
		if lo == 0 || y < lo {
			lo = y
		}
	}
	return lo
}()

// LastYear is the last year the table covers.
var LastYear = func() int {
	hi := 0
	for y := range prodcalRU {
		hi = max(hi, y)
	}
	return hi
}()

var prodRUFallback sync.Once

// IsWorkday reports whether the civil date y-m-d is a working day of calendar cal ("" = Mon–Fri;
// a year the table does not cover: Mon–Fri, logged once). Used by meeting series (ADR-0136) and
// the telephony schedule (ADR-0138).
func IsWorkday(cal string, y int, m time.Month, d int) bool {
	wd := time.Date(y, m, d, 0, 0, 0, 0, time.UTC).Weekday()
	weekday := wd != time.Saturday && wd != time.Sunday
	if cal != RU {
		return weekday
	}
	if _, ok := prodcalRU[y]; !ok {
		prodRUFallback.Do(func() {
			slog.Warn("prodcal: no Russian production calendar for the year, working days are Mon–Fri",
				"year", y, "covered", []int{FirstYear, LastYear})
		})
		return weekday
	}
	if working, ok := prodRU[civilDate{y, m, d}]; ok {
		return working
	}
	return weekday
}

// ChangesRU lists the dates of [from, to] (civil dates, inclusive) that differ from Mon–Fri
// in the Russian calendar: off = weekdays that are not working days, working = working weekend
// days, both in date order (UTC midnights). Years without data contribute nothing.
func ChangesRU(from, to time.Time) (off, working []time.Time) {
	fy, fm, fd := from.Date()
	ty, tm, td := to.Date()
	start := time.Date(max(fy, FirstYear), fm, fd, 0, 0, 0, 0, time.UTC)
	if fy < FirstYear {
		start = time.Date(FirstYear, 1, 1, 0, 0, 0, 0, time.UTC)
	}
	end := time.Date(ty, tm, td, 0, 0, 0, 0, time.UTC)
	if ty > LastYear {
		end = time.Date(LastYear, 12, 31, 0, 0, 0, 0, time.UTC)
	}
	for t := start; !t.After(end); t = t.AddDate(0, 0, 1) {
		w, ok := prodRU[civilDate{t.Year(), t.Month(), t.Day()}]
		switch {
		case !ok:
		case w:
			working = append(working, t)
		default:
			off = append(off, t)
		}
	}
	return off, working
}

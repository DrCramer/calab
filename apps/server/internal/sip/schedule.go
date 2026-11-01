package sip

import (
	"fmt"
	"slices"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/prodcal"
)

// The working-hours schedule of the inbound entry point (ADR-0138), the pure part: when the
// company works, and what a call outside those hours does. Evaluated once, when a call comes in
// (the entry point is entered); a call that came in working hours stays on its route when they
// end.

// Schedule limits.
const (
	MaxScheduleIntervals = 6 // per weekday
	minutesPerDay        = 24 * 60
	minutesPerWeek       = 7 * minutesPerDay
	// DefaultScheduleTZ is the zone of a schedule that names none.
	DefaultScheduleTZ = "Europe/Moscow"
)

// ReasonOffHours is SipCall.reason when the schedule's off-hours route is «hang up».
const ReasonOffHours = "off_hours"

// Interval is a span of working time that starts on Weekday (time.Sunday … time.Saturday) at
// Start minutes after midnight and ends End minutes after midnight (1..1440) — the same day when
// End > Start, the next day when End < Start (a night shift: 22:00–02:00).
type Interval struct {
	Weekday    time.Weekday
	Start, End int
}

// crosses: the interval ends the next day.
func (iv Interval) crosses() bool { return iv.End < iv.Start }

// Schedule is the working-hours schedule of the entry point. Off: every call follows the entry
// point. On: outside Hours a call follows OffHours, after Notice (uuid.Nil = none) when set.
type Schedule struct {
	Enabled bool
	Loc     *time.Location
	Hours   []Interval
	// Holidays: prodcal.RU — the Russian production calendar: a weekday off (a holiday or a
	// moved day off) has no working hours, a working Saturday / Sunday works by its own hours
	// when it has some, else by the first weekday Monday–Friday that has hours.
	Holidays string
	OffHours Target
	Notice   uuid.UUID
	NoticeMs int
}

// Open reports whether t is in working hours (always when the schedule is off).
func (s *Schedule) Open(t time.Time) bool {
	if s == nil || !s.Enabled {
		return true
	}
	loc := s.Loc
	if loc == nil {
		loc = time.UTC
	}
	lt := t.In(loc)
	y, m, d := lt.Date()
	minute := lt.Hour()*60 + lt.Minute()
	for _, iv := range s.dayHours(y, m, d) {
		if minute >= iv.Start && (iv.crosses() || minute < iv.End) {
			return true
		}
	}
	py, pm, pd := lt.AddDate(0, 0, -1).Date() // yesterday's night shift reaching into today
	for _, iv := range s.dayHours(py, pm, pd) {
		if iv.crosses() && minute < iv.End {
			return true
		}
	}
	return false
}

// dayHours are the intervals that start on the civil date y-m-d.
func (s *Schedule) dayHours(y int, m time.Month, d int) []Interval {
	wd := time.Date(y, m, d, 0, 0, 0, 0, time.UTC).Weekday()
	own := s.weekday(wd)
	if s.Holidays == "" {
		return own
	}
	weekend := wd == time.Saturday || wd == time.Sunday
	working := prodcal.IsWorkday(s.Holidays, y, m, d)
	switch {
	case !weekend && !working: // a holiday or a moved day off
		return nil
	case weekend && working && len(own) == 0: // a working Saturday / Sunday
		for w := time.Monday; w <= time.Friday; w++ {
			if hs := s.weekday(w); len(hs) > 0 {
				return hs
			}
		}
	}
	return own
}

func (s *Schedule) weekday(wd time.Weekday) []Interval {
	var out []Interval
	for _, iv := range s.Hours {
		if iv.Weekday == wd {
			out = append(out, iv)
		}
	}
	return out
}

// CheckIntervals validates a week of working hours: minutes in range, no empty interval, at most
// MaxScheduleIntervals starting on one weekday, and no two intervals overlapping — a night
// shift counts into the next day, Sunday's into Monday. The error text names the problem.
func CheckIntervals(hours []Interval) error {
	type span struct{ from, to int }
	var spans []span
	per := map[time.Weekday]int{}
	for _, iv := range hours {
		if iv.Weekday < time.Sunday || iv.Weekday > time.Saturday {
			return fmt.Errorf("a weekday is 1 (Monday) to 7 (Sunday)")
		}
		if iv.Start < 0 || iv.Start >= minutesPerDay || iv.End < 1 || iv.End > minutesPerDay || iv.Start == iv.End {
			return fmt.Errorf("an interval starts at 0..1439 and ends at 1..1440 minutes, not where it starts")
		}
		per[iv.Weekday]++
		if per[iv.Weekday] > MaxScheduleIntervals {
			return fmt.Errorf("at most %d intervals a day", MaxScheduleIntervals)
		}
		day := (int(iv.Weekday) + 6) % 7 // Monday = 0 … Sunday = 6
		from, to := day*minutesPerDay+iv.Start, day*minutesPerDay+iv.End
		if iv.crosses() {
			to += minutesPerDay
		}
		if to > minutesPerWeek { // Sunday's night shift: the rest falls on Monday morning
			spans = append(spans, span{0, to - minutesPerWeek})
			to = minutesPerWeek
		}
		spans = append(spans, span{from, to})
	}
	slices.SortFunc(spans, func(a, b span) int { return a.from - b.from })
	for i := 1; i < len(spans); i++ {
		if spans[i].from < spans[i-1].to {
			return fmt.Errorf("working hours overlap")
		}
	}
	return nil
}

// enterOffHours follows the schedule's off-hours route (ADR-0138): the journal's SCHEDULE step,
// the notice when there is one, then the route — «hang up» ends the call with ReasonOffHours.
func (c *InCall) enterOffHours(e Env, s *Schedule, fx *Effects) {
	c.OffHours = true
	t := s.OffHours
	c.step("off_hours")
	c.log(e, withTarget(e.PBX, t, Event{Kind: EvSchedule, Reason: ReasonOffHours}), fx)
	if s.Notice != uuid.Nil {
		pending := t
		c.Phase, c.Notice, c.NoticeAt, c.Played = PhaseMenu, &pending, e.Now.UnixMilli(), true
		c.Deadline = e.ms(time.Duration(s.NoticeMs)*time.Millisecond + promptSlack)
		c.log(e, Event{Kind: EvNotice, Reason: ReasonOffHours}, fx)
		fx.Play, fx.Changed = &Play{File: s.Notice}, true
		return
	}
	c.offHoursRoute(e, t, fx)
}

// offHoursRoute: the off-hours route itself.
func (c *InCall) offHoursRoute(e Env, t Target, fx *Effects) {
	if t.Kind == RouteHangup || t.Kind == RouteRepeat {
		c.hangup(e, ReasonOffHours, fx)
		return
	}
	c.Enter(e, t, fx)
}

// EnterEntry enters the entry point of a new call: its route, or — outside the schedule's
// working hours — the off-hours route.
func (c *InCall) EnterEntry(e Env, entry Target, s *Schedule, fx *Effects) {
	if !s.Open(e.Now) {
		c.enterOffHours(e, s, fx)
		return
	}
	c.Enter(e, entry, fx)
}

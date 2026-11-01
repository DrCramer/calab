package sip

import (
	"slices"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/prodcal"
)

func msk(t *testing.T) *time.Location {
	t.Helper()
	loc, err := time.LoadLocation("Europe/Moscow")
	if err != nil {
		t.Fatal(err)
	}
	return loc
}

// weekdays9to18: Monday–Friday 09:00–18:00.
func weekdays9to18() []Interval {
	var out []Interval
	for wd := time.Monday; wd <= time.Friday; wd++ {
		out = append(out, Interval{Weekday: wd, Start: 9 * 60, End: 18 * 60})
	}
	return out
}

func TestScheduleOpenTimeZone(t *testing.T) {
	s := &Schedule{Enabled: true, Loc: msk(t), Hours: weekdays9to18()}
	for _, c := range []struct {
		at   time.Time
		open bool
	}{
		{time.Date(2026, 10, 27, 5, 59, 0, 0, time.UTC), false}, // Tue 08:59 MSK
		{time.Date(2026, 10, 27, 6, 0, 0, 0, time.UTC), true},   // Tue 09:00 MSK
		{time.Date(2026, 10, 27, 14, 59, 0, 0, time.UTC), true}, // Tue 17:59 MSK
		{time.Date(2026, 10, 27, 15, 0, 0, 0, time.UTC), false}, // Tue 18:00 MSK: the end is not working time
		// MSK is UTC+3 all year (no DST): the same in January and in July.
		{time.Date(2026, 1, 20, 6, 30, 0, 0, time.UTC), true},
		{time.Date(2026, 7, 21, 5, 30, 0, 0, time.UTC), false},
		{time.Date(2026, 7, 21, 6, 30, 0, 0, time.UTC), true},
		{time.Date(2026, 10, 31, 9, 0, 0, 0, time.UTC), false}, // Saturday
	} {
		if got := s.Open(c.at); got != c.open {
			t.Errorf("%v (%v MSK): open %v, want %v", c.at, c.at.In(s.Loc), got, c.open)
		}
	}
	// The same instant in another zone: 06:30 UTC is 09:30 in Moscow, 08:30 in Berlin (CEST).
	berlin, err := time.LoadLocation("Europe/Berlin")
	if err != nil {
		t.Fatal(err)
	}
	b := &Schedule{Enabled: true, Loc: berlin, Hours: weekdays9to18()}
	if at := time.Date(2026, 7, 21, 6, 30, 0, 0, time.UTC); b.Open(at) || !s.Open(at) {
		t.Errorf("zones: berlin %v moscow %v", b.Open(at), s.Open(at))
	}
	// Off, or no schedule: always open.
	if !(&Schedule{Loc: msk(t)}).Open(time.Date(2026, 10, 31, 3, 0, 0, 0, time.UTC)) || !(*Schedule)(nil).Open(t0) {
		t.Error("an off schedule closes")
	}
}

func TestScheduleNightShiftCrossesMidnight(t *testing.T) {
	loc := msk(t)
	// Friday 22:00 – Saturday 02:00, Sunday 23:00 – Monday 01:00.
	s := &Schedule{Enabled: true, Loc: loc, Hours: []Interval{
		{Weekday: time.Friday, Start: 22 * 60, End: 2 * 60},
		{Weekday: time.Sunday, Start: 23 * 60, End: 60},
	}}
	at := func(d, h, m int) time.Time { return time.Date(2026, 10, d, h, m, 0, 0, loc) } // Oct 30 = Friday
	for _, c := range []struct {
		at   time.Time
		open bool
	}{
		{at(30, 21, 59), false}, {at(30, 22, 0), true}, {at(30, 23, 59), true},
		{at(31, 0, 0), true}, {at(31, 1, 59), true}, {at(31, 2, 0), false},
		{at(31, 22, 30), false}, // Saturday has no shift of its own
		{at(29, 23, 0), false},  // Thursday
		{at(29, 1, 0), false},   // Thursday morning: Wednesday has no shift
		{at(25, 23, 30), true},  // Sunday 23:30
		{at(26, 0, 30), true},   // Monday 00:30, Sunday's shift
		{at(26, 1, 0), false},
	} {
		if got := s.Open(c.at); got != c.open {
			t.Errorf("%v: open %v, want %v", c.at, got, c.open)
		}
	}
	// 1440 is midnight: 20:00–24:00 ends the same day.
	m := &Schedule{Enabled: true, Loc: loc, Hours: []Interval{{Weekday: time.Monday, Start: 20 * 60, End: 1440}}}
	if !m.Open(at(26, 23, 59)) || m.Open(at(27, 0, 0)) {
		t.Error("an interval to midnight")
	}
}

func TestScheduleProductionCalendarRU(t *testing.T) {
	loc := msk(t)
	s := &Schedule{Enabled: true, Loc: loc, Hours: weekdays9to18(), Holidays: prodcal.RU}
	noon := func(y int, m time.Month, d int) time.Time { return time.Date(y, m, d, 12, 0, 0, 0, loc) }
	for _, c := range []struct {
		at   time.Time
		open bool
	}{
		{noon(2026, 1, 8), false},  // Thursday, the New Year holidays
		{noon(2026, 3, 9), false},  // Monday, Mar 8 moved
		{noon(2026, 11, 4), false}, // Wednesday, Unity Day
		{noon(2026, 11, 3), true},  // an ordinary Tuesday
		{noon(2025, 11, 1), true},  // a working Saturday: by Monday's hours
		{noon(2027, 2, 20), true},  // a working Saturday
		{noon(2027, 2, 22), false}, // the Monday it moved to
		{noon(2026, 10, 31), false},
		{noon(2030, 1, 1), true}, // a year the table lacks: Mon–Fri
	} {
		if got := s.Open(c.at); got != c.open {
			t.Errorf("%v: open %v, want %v", c.at, got, c.open)
		}
	}
	// Without the calendar the holidays are ordinary weekdays and the Saturday is off.
	plain := &Schedule{Enabled: true, Loc: loc, Hours: weekdays9to18()}
	if !plain.Open(noon(2026, 1, 8)) || plain.Open(noon(2025, 11, 1)) {
		t.Error("without the calendar")
	}
	// A working Saturday with hours of its own keeps them.
	own := &Schedule{Enabled: true, Loc: loc, Holidays: prodcal.RU,
		Hours: append(weekdays9to18(), Interval{Weekday: time.Saturday, Start: 10 * 60, End: 11 * 60})}
	if own.Open(time.Date(2025, 11, 1, 12, 0, 0, 0, loc)) || !own.Open(time.Date(2025, 11, 1, 10, 30, 0, 0, loc)) {
		t.Error("a working Saturday with own hours")
	}
	// A night shift begun on the day before a holiday still runs into its morning.
	night := &Schedule{Enabled: true, Loc: loc, Holidays: prodcal.RU, Hours: []Interval{{Weekday: time.Tuesday, Start: 22 * 60, End: 6 * 60}}}
	if !night.Open(time.Date(2026, 11, 4, 3, 0, 0, 0, loc)) { // Tue Nov 3 22:00 → Wed Nov 4 (holiday) 06:00
		t.Error("the shift into a holiday")
	}
}

func TestCheckIntervals(t *testing.T) {
	ok := [][]Interval{
		nil,
		weekdays9to18(),
		{{Weekday: time.Monday, Start: 9 * 60, End: 13 * 60}, {Weekday: time.Monday, Start: 13 * 60, End: 18 * 60}}, // touching
		{{Weekday: time.Friday, Start: 22 * 60, End: 2 * 60}, {Weekday: time.Saturday, Start: 2 * 60, End: 4 * 60}},
		{{Weekday: time.Sunday, Start: 23 * 60, End: 60}, {Weekday: time.Monday, Start: 60, End: 120}},
		{{Weekday: time.Monday, Start: 0, End: 1440}},
	}
	for i, hs := range ok {
		if err := CheckIntervals(hs); err != nil {
			t.Errorf("ok %d: %v", i, err)
		}
	}
	bad := [][]Interval{
		{{Weekday: time.Monday, Start: 9 * 60, End: 13 * 60}, {Weekday: time.Monday, Start: 12 * 60, End: 18 * 60}},
		{{Weekday: time.Friday, Start: 22 * 60, End: 3 * 60}, {Weekday: time.Saturday, Start: 2 * 60, End: 4 * 60}},
		{{Weekday: time.Sunday, Start: 23 * 60, End: 2 * 60}, {Weekday: time.Monday, Start: 60, End: 120}}, // Sunday into Monday
		{{Weekday: time.Monday, Start: 600, End: 600}},
		{{Weekday: time.Monday, Start: 1440, End: 60}},
		{{Weekday: time.Monday, Start: 0, End: 0}},
		{{Weekday: time.Monday, Start: 0, End: 1441}},
		{{Weekday: 9, Start: 0, End: 60}},
	}
	for i, hs := range bad {
		if err := CheckIntervals(hs); err == nil {
			t.Errorf("bad %d passed", i)
		}
	}
	var many []Interval
	for i := range MaxScheduleIntervals + 1 {
		many = append(many, Interval{Weekday: time.Tuesday, Start: i * 60, End: i*60 + 30})
	}
	if err := CheckIntervals(many); err == nil {
		t.Error("7 intervals a day passed")
	}
}

// offHoursAt: 03:00 MSK on a Tuesday, outside Monday–Friday 09–18.
var offHoursAt = time.Date(2026, 10, 27, 0, 0, 0, 0, time.UTC)

func TestInboundOffHoursToExtension(t *testing.T) {
	f := newFixture(false, 0).withPrompt()
	s := &Schedule{Enabled: true, Loc: msk(t), Hours: weekdays9to18(), OffHours: Target{Kind: RouteExtension, ID: ptr(f.e2)}}
	entry := Target{Kind: RouteMenu, ID: ptr(f.menu)}
	var c InCall
	var fx Effects
	c.EnterEntry(Env{PBX: f.p, Avail: avail{}, Now: offHoursAt}, entry, s, &fx)
	if c.Phase != PhaseRing || !slices.Equal(fx.Rings, []uuid.UUID{f.u2}) || !c.OffHours || c.ViaFallback {
		t.Fatalf("off hours: %+v %+v", c, fx)
	}
	if fx.Events[0].Kind != EvSchedule || fx.Events[0].Reason != ReasonOffHours || fx.Events[0].TargetKind != TkExtension ||
		*fx.Events[0].TargetID != f.e2 || fx.Events[1].Kind != EvRing {
		t.Fatalf("events: %+v", fx.Events)
	}
	// In working hours the entry point.
	c, fx = InCall{}, Effects{}
	c.EnterEntry(Env{PBX: f.p, Avail: avail{}, Now: offHoursAt.Add(8 * time.Hour)}, entry, s, &fx)
	if c.Phase != PhaseMenu || c.OffHours || slices.ContainsFunc(fx.Events, func(ev Event) bool { return ev.Kind == EvSchedule }) {
		t.Fatalf("working hours: %+v %+v", c, fx)
	}
}

func TestInboundOffHoursHangupWithNotice(t *testing.T) {
	f := newFixture(false, 0)
	notice := uuid.New()
	s := &Schedule{Enabled: true, Loc: msk(t), Hours: weekdays9to18(), Notice: notice, NoticeMs: 5000}
	var c InCall
	var fx Effects
	e := Env{PBX: f.p, Avail: avail{}, Now: offHoursAt}
	c.EnterEntry(e, Target{Kind: RouteGroup, ID: ptr(f.group)}, s, &fx)
	if c.Phase != PhaseMenu || fx.Play == nil || fx.Play.File != notice || fx.Hangup != "" || len(fx.Rings) != 0 {
		t.Fatalf("notice: %+v %+v", c, fx)
	}
	if len(fx.Events) != 2 || fx.Events[0].Kind != EvSchedule || fx.Events[0].TargetKind != "" || fx.Events[1].Kind != EvNotice {
		t.Fatalf("events: %+v", fx.Events)
	}
	// Keys are not taken while it plays.
	fx = Effects{}
	c.Digit(e, '1', &fx)
	if c.Phase != PhaseMenu || c.Early != "" || fx.Hangup != "" {
		t.Fatalf("key: %+v", c)
	}
	// The worker's «played»: the call ends «off_hours».
	fx = Effects{}
	e.Now = e.Now.Add(5 * time.Second)
	c.WorkerPlayed(e, &fx)
	if c.Phase != PhaseEnded || fx.Hangup != ReasonOffHours || c.Reason != ReasonOffHours {
		t.Fatalf("hangup: %+v %+v", c, fx)
	}
	// Without a notice at once; a lost «played» ends it by the deadline.
	c, fx = InCall{}, Effects{}
	plain := *s
	plain.Notice = uuid.Nil
	c.EnterEntry(Env{PBX: f.p, Avail: avail{}, Now: offHoursAt}, Target{Kind: RouteGroup, ID: ptr(f.group)}, &plain, &fx)
	if fx.Hangup != ReasonOffHours {
		t.Fatalf("no notice: %+v", fx)
	}
	c, fx = InCall{}, Effects{}
	c.EnterEntry(Env{PBX: f.p, Avail: avail{}, Now: offHoursAt}, Target{Kind: RouteGroup, ID: ptr(f.group)}, s, &fx)
	fx = Effects{}
	c.Expire(Env{PBX: f.p, Avail: avail{}, Now: offHoursAt.Add(9 * time.Second)}, &fx)
	if fx.Hangup != ReasonOffHours {
		t.Fatalf("lost played: %+v %+v", c, fx)
	}
}

func TestInboundOffHoursNoticeThenGroupFallback(t *testing.T) {
	f := newFixture(false, 0)
	s := &Schedule{Enabled: true, Loc: msk(t), Hours: weekdays9to18(), Notice: uuid.New(), NoticeMs: 1000,
		OffHours: Target{Kind: RouteGroup, ID: ptr(f.group)}}
	var c InCall
	var fx Effects
	c.EnterEntry(Env{PBX: f.p, Avail: avail{}, Now: offHoursAt}, Target{Kind: RouteHangup}, s, &fx)
	fx = Effects{}
	c.WorkerPlayed(Env{PBX: f.p, Avail: avail{}, Now: offHoursAt.Add(time.Second)}, &fx)
	if c.Phase != PhaseRing || len(fx.Rings) != 3 || !c.OffHours || c.ViaFallback {
		t.Fatalf("group: %+v %+v", c, fx)
	}
	// Nobody answers in 30 s: the group's fallback (101, u1) — the bot / person sees both flags.
	fx = Effects{}
	c.Expire(Env{PBX: f.p, Avail: avail{}, Now: offHoursAt.Add(31 * time.Second)}, &fx)
	if c.Phase != PhaseRing || !slices.Equal(c.Ringing, []uuid.UUID{f.u1}) || !c.OffHours || !c.ViaFallback {
		t.Fatalf("fallback: %+v %+v", c, fx)
	}
}

func TestInboundViaFallbackFlag(t *testing.T) {
	f := newFixture(false, 0)
	var c InCall
	var fx Effects
	// Working hours, a group whose members are all busy: its fallback (u1) rings at once.
	c.Enter(envAt(f, avail{busy: set(f.u2, f.u3)}, 0), Target{Kind: RouteGroup, ID: ptr(f.group)}, &fx)
	if c.OffHours {
		t.Fatal("off hours in working hours")
	}
	g := f.p.Groups[f.group]
	g.Members = g.Members[:1] // only u3
	f.p.Groups[f.group] = g
	c, fx = InCall{}, Effects{}
	c.Enter(envAt(f, avail{busy: set(f.u3)}, 0), Target{Kind: RouteGroup, ID: ptr(f.group)}, &fx)
	if !slices.Equal(c.Ringing, []uuid.UUID{f.u1}) || !c.ViaFallback {
		t.Fatalf("busy group: %+v", c)
	}
	// A direct route: no flag.
	c, fx = InCall{}, Effects{}
	c.Enter(envAt(f, avail{}, 0), Target{Kind: RouteExtension, ID: ptr(f.e2)}, &fx)
	if c.ViaFallback || c.OffHours {
		t.Fatalf("direct: %+v", c)
	}
}

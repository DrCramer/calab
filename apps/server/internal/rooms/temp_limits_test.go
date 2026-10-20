package rooms

import (
	"testing"
	"time"

	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/plans"
)

func TestTempLimitsDefaults(t *testing.T) {
	l := TempLimits{}.norm()
	if l.MaxTTL != 30*24*time.Hour || l.PerWorkspace != 50 {
		t.Fatalf("defaults = %+v", l)
	}
	if got := l.ttlText(); got != "15 minutes .. 30 days" {
		t.Errorf("ttlText = %q", got)
	}
}

func TestTempLimitsCheckCount(t *testing.T) {
	l := TempLimits{PerWorkspace: 50}
	cases := []struct {
		name        string
		total, mine int32
		userCap     uint32
		fail        bool
	}{
		{"empty", 0, 0, 3, false},
		{"workspace one below", 49, 0, 3, false},
		{"workspace at the cap", 50, 0, 3, true},
		{"no plan cap", 10, 999, 0, false},
		// Per creator, the plan's cap: Free 3, Team 10, Business 50.
		{"free below", 3, 2, 3, false},
		{"free at the cap", 3, 3, 3, true},
		{"team below", 20, 9, 10, false},
		{"team at the cap", 20, 10, 10, true},
		{"business below", 49, 49, 50, false},
		{"business at the cap", 49, 50, 50, true},
	}
	for _, c := range cases {
		err := l.checkCount(sqlc.CountLiveTempRoomsRow{Total: c.total, Mine: c.mine}, c.userCap)
		if (err != nil) != c.fail {
			t.Errorf("%s: err = %v, want failure %v", c.name, err, c.fail)
		}
	}
}

func TestPlanTempRooms(t *testing.T) {
	for name, c := range map[string]struct{ got, want uint32 }{
		"free":     {plans.DefaultFree.TempRooms, 3},
		"team":     {plans.DefaultTeam.TempRooms, 10},
		"business": {plans.DefaultBusiness.TempRooms, 50},
	} {
		if c.got != c.want {
			t.Errorf("%s: TempRooms = %d, want %d", name, c.got, c.want)
		}
	}
}

func TestRestoreTTLBound(t *testing.T) {
	created := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	maxTTL := 30 * 24 * time.Hour
	if got := restoreTTL(created, created.Add(maxTTL), maxTTL); got != maxTTL {
		t.Errorf("at the bound: %v", got)
	}
	if got := restoreTTL(created, created.Add(maxTTL+time.Second), maxTTL); got != DefaultTempTTL {
		t.Errorf("past the bound: %v", got)
	}
}

func TestMeetingRoomEndBound(t *testing.T) {
	now := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	maxTTL := 30 * 24 * time.Hour
	if got := meetingRoomEnd(now.Add(maxTTL+time.Hour), now, maxTTL); !got.Equal(now.Add(maxTTL)) {
		t.Errorf("clamped to the max: %v", got)
	}
	if got := meetingRoomEnd(now.Add(maxTTL), now, maxTTL); !got.Equal(now.Add(maxTTL)) {
		t.Errorf("at the max: %v", got)
	}
	if got := meetingRoomEnd(now, now, maxTTL); !got.Equal(now.Add(MinTempTTL)) {
		t.Errorf("raised to the min: %v", got)
	}
}

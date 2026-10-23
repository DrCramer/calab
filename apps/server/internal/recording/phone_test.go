package recording

import (
	"testing"
	"time"

	"github.com/google/uuid"
)

// The Disk names of a phone recording (ADR-0131): a folder per day, the minute, the number's
// digits and the direction, in the configured zone.
func TestPhoneName(t *testing.T) {
	at := time.Date(2026, 6, 15, 21, 30, 59, 0, time.UTC)
	msk, err := time.LoadLocation("Europe/Moscow")
	if err != nil {
		t.Skip("no tzdata:", err)
	}
	for _, c := range []struct {
		loc       *time.Location
		number    string
		in        bool
		day, name string
	}{
		{nil, "+7 (495) 555-55-55", true, "2026_06_15", "202606152130_74955555555_IN.ogg"},
		{time.UTC, "+74955555555", false, "2026_06_15", "202606152130_74955555555_OUT.ogg"},
		{msk, "+74955555555", true, "2026_06_16", "202606160030_74955555555_IN.ogg"}, // past midnight in Moscow
		{time.UTC, "anonymous", true, "2026_06_15", "202606152130_unknown_IN.ogg"},
		{time.UTC, "", false, "2026_06_15", "202606152130_unknown_OUT.ogg"},
	} {
		day, name := PhoneName(at, c.loc, c.number, c.in)
		if day != c.day || name != c.name {
			t.Errorf("%v %q %v: %s/%s, want %s/%s", c.loc, c.number, c.in, day, name, c.day, c.name)
		}
	}
	ws, id := uuid.New(), uuid.New()
	if f := phoneFile(ws, id); f != "phone/"+ws.String()+"/"+id.String()+".ogg" {
		t.Fatalf("raw file: %s", f)
	}
}

package db

import (
	"bytes"
	"testing"
	"time"

	"github.com/google/uuid"
)

// TestUUIDv7Floor: ids generated at or after t compare ≥ the floor, ids of the previous
// millisecond compare below it (ADR-0140 §5: messages before read receipts get no ticks).
func TestUUIDv7Floor(t *testing.T) {
	at := time.Date(2026, 10, 28, 9, 0, 0, 0, time.UTC)
	floor := UUIDv7Floor(at)
	if got := floor.String(); got != "01a181bc-da80-0000-0000-000000000000" { // 0x1a181bcda80 ms
		t.Fatalf("floor %s: wrong timestamp bits", got)
	}
	gen := func(ts time.Time) uuid.UUID {
		id, err := uuid.NewV7FromReader(bytes.NewReader(make([]byte, 16)))
		if err != nil {
			t.Fatal(err)
		}
		f := UUIDv7Floor(ts)
		copy(id[:6], f[:6])
		return id
	}
	if same := gen(at); bytes.Compare(same[:], floor[:]) < 0 {
		t.Fatalf("an id of the same millisecond %s is below the floor %s", same, floor)
	}
	if before := gen(at.Add(-time.Millisecond)); bytes.Compare(before[:], floor[:]) >= 0 {
		t.Fatalf("an id of the millisecond before %s is not below the floor %s", before, floor)
	}
}

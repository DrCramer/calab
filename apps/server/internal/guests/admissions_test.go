package guests

import (
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/perm"
)

func TestRequiresApprovalInheritance(t *testing.T) {
	on, off := true, false
	for _, c := range []struct {
		room bool
		link *bool
		want bool
	}{
		{false, nil, false}, // NULL inherits the room
		{true, nil, true},
		{false, &on, true}, // the link overrides the room either way
		{true, &off, false},
		{true, &on, true},
		{false, &off, false},
	} {
		if got := RequiresApproval(c.room, c.link); got != c.want {
			t.Errorf("RequiresApproval(%v, %v) = %v, want %v", c.room, c.link, got, c.want)
		}
	}
}

func TestSweepCutoffs(t *testing.T) {
	now := time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)
	if got := staleBefore(now); !got.Equal(now.Add(-30 * time.Minute)) {
		t.Fatalf("staleBefore = %v", got)
	}
	if got := expiredBefore(now); !got.Equal(now.Add(-10 * time.Minute)) {
		t.Fatalf("expiredBefore = %v", got)
	}
	// A knock of 29:59 ago stays pending, one of 30:01 ago is declined (requested_at < cutoff).
	if young := now.Add(-PendingTTL + time.Second); young.Before(staleBefore(now)) {
		t.Fatal("a knock under 30 min is stale")
	}
	if old := now.Add(-PendingTTL - time.Second); !old.Before(staleBefore(now)) {
		t.Fatal("a knock over 30 min is not stale")
	}
}

func TestDeclineHolds(t *testing.T) {
	now := time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)
	by := uuid.New()
	at := func(ago time.Duration) *time.Time { v := now.Add(-ago); return &v }
	for _, c := range []struct {
		name string
		a    sqlc.RoomAdmission
		want bool
	}{
		{"declined by a person 5 min ago", sqlc.RoomAdmission{Status: statusDeclined, DecidedBy: &by, DecidedAt: at(5 * time.Minute)}, true},
		{"declined by a person 11 min ago", sqlc.RoomAdmission{Status: statusDeclined, DecidedBy: &by, DecidedAt: at(11 * time.Minute)}, false},
		{"nobody answered", sqlc.RoomAdmission{Status: statusDeclined, DecidedAt: at(time.Minute)}, false},
		{"pending", sqlc.RoomAdmission{Status: statusPending}, false},
	} {
		if got := declineHolds(c.a, now); got != c.want {
			t.Errorf("%s: %v, want %v", c.name, got, c.want)
		}
	}
}

func TestGuestName(t *testing.T) {
	if n, err := guestName("  Анна из «Ромашки»  "); err != nil || n != "Анна из «Ромашки»" {
		t.Fatalf("trimmed name: %q %v", n, err)
	}
	if _, err := guestName(strings.Repeat("я", 40)); err != nil {
		t.Fatalf("40 characters: %v", err)
	}
	for _, bad := range []string{"", "   ", strings.Repeat("я", 41)} {
		if _, err := guestName(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestEditBitsKeepsUnnamedBits(t *testing.T) {
	on, off := true, false
	cur := perm.ViewRoom | perm.Connect | perm.Speak | perm.Video | perm.SendMessages
	got := editBits(&v1.UpdateRoomInviteRequest{AllowMessages: &off, AllowStream: &on}, cur)
	want := perm.ViewRoom | perm.Connect | perm.Speak | perm.Video | perm.Stream
	if got != want {
		t.Fatalf("editBits = %b, want %b", got, want)
	}
	if editBits(&v1.UpdateRoomInviteRequest{}, cur) != cur {
		t.Fatal("no allow_* keeps the bits")
	}
}

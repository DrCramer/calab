package rooms

import (
	"testing"
	"time"

	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/perm"
)

func TestRevivedExpiry(t *testing.T) {
	now := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	oldEnd := now.Add(-time.Hour)
	newEnd := now.Add(2 * time.Hour)
	at := func(d time.Duration) *time.Time { v := now.Add(d); return &v }
	cases := []struct {
		name       string
		link, want *time.Time
		newEnd     *time.Time
	}{
		{"never stays never", nil, nil, &newEnd},
		{"bound to the room follows its new end", &oldEnd, &newEnd, &newEnd},
		{"shorter than the room follows its new end", at(-2 * time.Hour), &newEnd, &newEnd},
		{"own end ahead stays", at(48 * time.Hour), at(48 * time.Hour), &newEnd},
		{"own end after the room's but passed", at(-time.Minute), &newEnd, &newEnd},
		{"permanent: bound never expires", &oldEnd, nil, nil},
		{"permanent: own end ahead stays", at(48 * time.Hour), at(48 * time.Hour), nil},
	}
	for _, c := range cases {
		got := revivedExpiry(c.link, oldEnd, c.newEnd, now)
		if (got == nil) != (c.want == nil) || (got != nil && !got.Equal(*c.want)) {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}

func TestLinkPolicyMayRevive(t *testing.T) {
	member := perm.ViewRoom | perm.Connect | perm.Speak | perm.SendMessages
	guestLink := sqlc.RoomInvite{AllowGuests: true, AllowBits: int64(member)}
	membersLink := sqlc.RoomInvite{MembersOnly: true, AllowBits: int64(member)}
	streamLink := sqlc.RoomInvite{MembersOnly: true, AllowBits: int64(member | perm.Stream)} //nolint:gosec // bit mask
	if (linkPolicy{bits: member}).mayRevive(guestLink) {
		t.Error("a guest link needs INVITE_GUESTS")
	}
	if !(linkPolicy{bits: member, guests: true}).mayRevive(guestLink) {
		t.Error("a guest link with INVITE_GUESTS")
	}
	if !(linkPolicy{bits: member}).mayRevive(membersLink) {
		t.Error("a members-only link without INVITE_GUESTS")
	}
	if (linkPolicy{bits: member, guests: true}).mayRevive(streamLink) {
		t.Error("no link with bits the caller does not hold")
	}
	if !(linkPolicy{bits: member, admin: true}).mayRevive(streamLink) {
		t.Error("an administrator holds every bit")
	}
}

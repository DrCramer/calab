package files

import (
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/db/sqlc"
)

func TestMaybeImage(t *testing.T) {
	ms := int32(1000)
	for _, c := range []struct {
		f    sqlc.File
		want bool
	}{
		{sqlc.File{Name: "a.png", Mime: "image/png"}, true},
		{sqlc.File{Name: "photo", Mime: "image/jpeg"}, true},
		{sqlc.File{Name: "image.png", Mime: "application/octet-stream"}, true}, // stored with a wrong type
		{sqlc.File{Name: "IMG.JPG", Mime: ""}, true},
		{sqlc.File{Name: "a.bin", Mime: "application/octet-stream"}, false},
		{sqlc.File{Name: "a.svg", Mime: "application/octet-stream"}, false}, // never thumbnailed
		{sqlc.File{Name: "a.png", Mime: "application/pdf"}, false},          // a known other type
		{sqlc.File{Name: "a.avif", Mime: "image/avif"}, false},              // no decoder: the client shows the file
		{sqlc.File{Name: "v.ogg", Mime: "image/png", VoiceDurationMs: &ms}, false},
	} {
		if got := MaybeImage(c.f); got != c.want {
			t.Errorf("%s %q: got %v", c.f.Name, c.f.Mime, got)
		}
	}
}

func TestMissCache(t *testing.T) {
	c := &missCache{m: map[uuid.UUID]time.Time{}}
	id, now := uuid.New(), time.Now()
	if c.recent(id, now) {
		t.Fatal("empty cache")
	}
	c.add(id, now)
	if !c.recent(id, now.Add(thumbRetry-time.Second)) || c.recent(id, now.Add(thumbRetry)) {
		t.Fatal("retry window")
	}
	for range maxMisses {
		c.add(uuid.New(), now)
	}
	if len(c.m) > maxMisses {
		t.Fatalf("unbounded: %d", len(c.m))
	}
}

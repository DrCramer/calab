package files

import (
	"context"
	"io"
	"log/slog"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/pbconv"
)

// Lazy thumbnails. The upload makes an image's thumbnail best-effort: a failed read of the
// stored blob, a cancelled request or a busy decode slot leave an image file without one, and
// clients show such a file as a plain file chip. GET /api/files/{id}/thumbnail makes the
// missing thumbnail on first request, re-sniffs the stored type (a file stored as
// application/octet-stream that is a PNG becomes image/png) and saves both in the row, so the
// next listing carries thumbnail_url. A picture that cannot be thumbnailed (over MaxPixels,
// undecodable) is retried at most once per thumbRetry per process.

const (
	thumbRetry = time.Hour
	maxMisses  = 4096
)

// imageExts are the names of the thumbnailable types (pbconv.IsImage).
var imageExts = map[string]bool{".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".webp": true}

// MaybeImage reports whether a stored file may be a thumbnailable picture: its stored type says
// so, or the type is unknown (application/octet-stream) and the name has an image extension.
// Only the content decides (backfillThumb sniffs it).
func MaybeImage(f sqlc.File) bool {
	if f.VoiceDurationMs != nil {
		return false
	}
	if pbconv.IsImage(f.Mime) {
		return true
	}
	switch f.Mime {
	case "", "application/octet-stream", "binary/octet-stream":
		return imageExts[strings.ToLower(path.Ext(f.Name))]
	}
	return false
}

// missCache remembers the files whose lazy thumbnail failed (bounded: cleared when full).
type missCache struct {
	mu sync.Mutex
	m  map[uuid.UUID]time.Time
}

func (c *missCache) recent(id uuid.UUID, now time.Time) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	at, ok := c.m[id]
	return ok && now.Sub(at) < thumbRetry
}

func (c *missCache) add(id uuid.UUID, now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.m) >= maxMisses {
		clear(c.m)
	}
	c.m[id] = now
}

var thumbMisses = &missCache{m: map[uuid.UUID]time.Time{}}

// backfillThumb makes the missing thumbnail of f (see above) and returns the updated row;
// ok = the row has a thumbnail now.
func (s *Service) backfillThumb(ctx context.Context, f sqlc.File) (sqlc.File, bool) {
	if f.ThumbnailKey != nil {
		return f, true
	}
	now := time.Now()
	if !MaybeImage(f) || thumbMisses.recent(f.ID, now) {
		return f, false
	}
	rc, _, err := s.store.Get(ctx, f.Key)
	if err != nil {
		slog.InfoContext(ctx, "lazy thumbnail: read", "file_id", f.ID, "err", err)
		return f, false
	}
	head := make([]byte, 512)
	n, _ := io.ReadFull(rc, head)
	_ = rc.Close()
	mt := DetectMime(head[:n], "")
	if !pbconv.IsImage(mt) {
		thumbMisses.add(f.ID, now)
		return f, false
	}
	st := &stored{id: f.ID, key: f.Key, mime: mt}
	s.makeThumbnail(ctx, st)
	if st.thumbKey == nil {
		thumbMisses.add(f.ID, now)
	}
	if st.width == nil || st.height == nil {
		st.width, st.height = f.Width, f.Height
	}
	if st.thumbKey == nil && mt == f.Mime && sameDim(st.width, f.Width) && sameDim(st.height, f.Height) {
		return f, false
	}
	// The same commit admission as other writes: a request-born repair is admitted for the
	// requesting user, a background one carries none.
	row, err := db.GuardValue(ctx, s.db, func(q *sqlc.Queries) (sqlc.File, error) {
		return q.SetFileImage(ctx, sqlc.SetFileImageParams{
			ID: f.ID, Mime: mt, Width: st.width, Height: st.height, ThumbnailKey: st.thumbKey,
		})
	})
	if err != nil {
		// The thumbnail blob stays: its key is fixed, the next attempt overwrites it, and a
		// concurrent request that saved the row may already serve it.
		slog.WarnContext(ctx, "lazy thumbnail: save", "file_id", f.ID, "err", err)
		return f, false
	}
	return row, row.ThumbnailKey != nil
}

func sameDim(a, b *int32) bool { return (a == nil) == (b == nil) && (a == nil || *a == *b) }

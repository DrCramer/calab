package files

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/blob"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// UploadStaged stores the multipart "file" of r in the quota of workspace wsID without an
// uploader: a staged upload of a board form's FILE field (ADR-0064 v2), readable only once it
// is attached to a task. limit bounds the file (never above MAX_FILE_SIZE_MB); check (nil =
// none) refuses a detected type or name before anything is stored; attach runs in the
// transaction that reserves the quota and inserts the row, its error discards the upload.
// The caller rate-limits: there is no per-user budget here.
func (s *Service) UploadStaged(w http.ResponseWriter, r *http.Request, wsID uuid.UUID, limit int64,
	check func(mime, name string) error, attach func(q *sqlc.Queries, f sqlc.File) error) (sqlc.File, error) {
	if s.maxBytes > 0 {
		limit = min(limit, s.maxBytes)
	}
	ws, err := s.db.Q.GetWorkspace(r.Context(), wsID)
	if err != nil {
		return sqlc.File{}, err
	}
	quota, planQuota, err := s.quota(r.Context(), s.db.Q, ws)
	if err != nil {
		return sqlc.File{}, err
	}
	if r.ContentLength > 0 && ws.StorageUsedBytes+r.ContentLength-(1<<20) > quota.limit {
		return sqlc.File{}, quota.err(ws.StorageUsedBytes)
	}
	st, err := s.receiveChecked(w, r, limit, func(id uuid.UUID) string { return blob.FileKey(wsID, id) }, acceptAny, check)
	if err != nil {
		return sqlc.File{}, err
	}
	var f sqlc.File
	err = s.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		if err := s.checkTotal(r.Context(), q, st.size); err != nil {
			return err
		}
		if _, err := q.ReserveQuota(r.Context(), sqlc.ReserveQuotaParams{ID: wsID, Size: st.size, PlanQuota: planQuota}); err != nil {
			if db.IsNotFound(err) {
				if cur, err := q.GetWorkspace(r.Context(), wsID); err == nil {
					return quota.err(cur.StorageUsedBytes)
				}
				return quota.err(ws.StorageUsedBytes)
			}
			return err
		}
		if f, err = q.InsertFile(r.Context(), s.row(st, &wsID, nil)); err != nil {
			return err
		}
		if attach != nil {
			return attach(q, f)
		}
		return nil
	})
	if err != nil {
		s.discard(st)
		return sqlc.File{}, err
	}
	return f, nil
}

// StagedAge is how long a staged form upload waits for its submission (ADR-0064 v2).
const StagedAge = time.Hour

// CleanupStaged deletes the staged form uploads older than StagedAge that no submission took:
// rows and quota in one transaction, blobs after the commit. Returns how many.
func (s *Service) CleanupStaged(ctx context.Context, now time.Time) (int, error) {
	var gone []sqlc.File
	err := s.db.Tx(ctx, func(q *sqlc.Queries) error {
		ids, err := q.DeleteExpiredBoardFormUploads(ctx, now.Add(-StagedAge))
		if err != nil {
			return err
		}
		for _, id := range ids {
			f, err := q.GetFile(ctx, id)
			if db.IsNotFound(err) {
				continue
			}
			if err != nil {
				return err
			}
			n, err := q.DeleteFile(ctx, id)
			if err != nil {
				return err
			}
			if n == 0 {
				continue
			}
			if f.WorkspaceID != nil {
				if err := q.ReleaseQuota(ctx, sqlc.ReleaseQuotaParams{ID: *f.WorkspaceID, Size: f.Size}); err != nil {
					return err
				}
			}
			gone = append(gone, f)
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	ctx = context.WithoutCancel(ctx)
	for _, f := range gone {
		_ = s.store.Delete(ctx, f.Key)
		blob.DeleteThumbs(ctx, s.store, f.Key, f.ThumbnailKey)
	}
	return len(gone), nil
}

// RunStagedCleanup runs CleanupStaged every interval until ctx is done.
func (s *Service) RunStagedCleanup(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if n, err := s.CleanupStaged(ctx, time.Now()); err != nil && ctx.Err() == nil {
				slog.WarnContext(ctx, "staged form uploads cleanup", "err", err)
			} else if n > 0 {
				slog.InfoContext(ctx, "staged form uploads deleted", "count", n)
			}
		}
	}
}

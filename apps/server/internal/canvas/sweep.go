package canvas

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/canvasacl"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/perm"
)

// SweepInterval is how often TrashSweep runs (like the Disk's).
const SweepInterval = time.Hour

// revokedLinkDays: revoked public links are dropped this long after the revoke.
const revokedLinkDays = 30

// sweepBatch: trash roots deleted per transaction. Few: the transaction holds the workspace's
// tree lock (creating and moving items there wait for it), and one root may carry MaxVersions
// versions of up to MaxState each; the lock is free between batches.
const sweepBatch = 5

// TrashSweep deletes forever, once, the trash roots older than their workspace's
// canvas_trash_days (NULL = never), through the delete-forever path. Per workspace, batches of
// sweepBatch roots, each in a transaction holding the workspace's sweep advisory lock: another
// instance sweeping the same workspace skips it. A workspace that fails is left for the next run
// and the others are still swept: the error names every failed workspace. Returns the number of
// roots deleted.
func (s *Service) TrashSweep(ctx context.Context) (int, error) {
	now := s.Now()
	wss, err := s.db.Q.ListCanvasSweepWorkspaces(ctx, now)
	if err != nil {
		return 0, err
	}
	total := 0
	var errs []error
	for _, w := range wss {
		if err := ctx.Err(); err != nil {
			return total, errors.Join(append(errs, err)...)
		}
		cutoff := now.Add(-time.Duration(w.Days) * 24 * time.Hour)
		for {
			n, more, err := s.sweepBatch(ctx, w.ID, cutoff)
			total += n
			if err != nil {
				errs = append(errs, fmt.Errorf("workspace %s: %w", w.ID, err))
				break
			}
			if !more {
				break
			}
		}
	}
	return total, errors.Join(errs...)
}

func (s *Service) sweepBatch(ctx context.Context, ws uuid.UUID, cutoff time.Time) (int, bool, error) {
	var done []deleted
	now := s.Now()
	more := false
	err := s.db.Tx(ctx, func(q *sqlc.Queries) error {
		ok, err := q.TryAdvisoryXactLock(ctx, "calaba.canvas.sweep."+ws.String())
		if err != nil || !ok {
			return err
		}
		roots, err := q.ListCanvasTrashRootsBefore(ctx, sqlc.ListCanvasTrashRootsBeforeParams{WorkspaceID: ws, Cutoff: cutoff, Lim: sweepBatch})
		if err != nil {
			return err
		}
		more = len(roots) == sweepBatch
		if len(roots) > 0 {
			if err := q.LockCanvasTree(ctx, ws); err != nil {
				return err
			}
		}
		ids := make([]uuid.UUID, len(roots))
		for i, p := range roots {
			ids[i] = p.ID
		}
		ch, err := canvasacl.Load(ctx, q, ids)
		if err != nil {
			return err
		}
		for _, p := range roots {
			// Re-read under the row lock: skip a root deleted or restored since the listing.
			cur, err := q.GetCanvasItemForUpdate(ctx, p.ID)
			if db.IsNotFound(err) {
				continue
			}
			if err != nil {
				return err
			}
			if !cur.TrashedRoot || cur.TrashedAt == nil || !cur.TrashedAt.Before(cutoff) {
				continue
			}
			// The sweeper deletes what the root's deleter saw: a private item swept in from
			// someone else's item is detached as a trash root of its own, with its own retention
			// from now (addendum 2026-10-14 of ADR-0096 §2, ADR-0115 §2).
			v, err := s.sweepViewer(ctx, q, cur, ch.Nodes(p.ID))
			if err != nil {
				return err
			}
			d, err := s.deleteTree(ctx, q, cur, ch.Nodes(p.ID), nil, v, nil, &now)
			if err != nil {
				return err
			}
			done = append(done, d)
		}
		return nil
	})
	if err != nil {
		return 0, false, err
	}
	s.finish(ctx, done)
	return len(done), more, nil
}

// sweepViewer is what the deleter of trash root p (chain: its chain) sees; when they are no
// longer a member, everything below it but restricted items.
func (s *Service) sweepViewer(ctx context.Context, q *sqlc.Queries, p sqlc.CanvasItemHead, chain []perm.TreeNode) (viewer, error) {
	if p.TrashedBy != nil {
		m, ok, err := perm.LoadMember(ctx, q, p.WorkspaceID, *p.TrashedBy)
		if err != nil {
			return nil, err
		}
		if ok {
			return sees(m), nil
		}
	}
	depth := len(chain)
	return func(c []perm.TreeNode) bool { return len(c) < depth || !perm.RestrictedIn(c[depth:]) }, nil
}

// RunTrashSweep runs TrashSweep every interval until ctx is done.
func (s *Service) RunTrashSweep(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			n, err := s.TrashSweep(ctx)
			if err != nil {
				slog.ErrorContext(ctx, "canvas trash sweep", "deleted", n, "err", err)
			} else if n > 0 {
				slog.InfoContext(ctx, "canvas trash swept", "deleted", n)
			}
			// Through Tx like every other write (identity admission covers writes, not s.db.Q).
			if err := s.db.Tx(ctx, func(q *sqlc.Queries) error {
				_, err := q.PurgeRevokedCanvasLinks(ctx, s.Now().Add(-revokedLinkDays*24*time.Hour))
				return err
			}); err != nil {
				slog.WarnContext(ctx, "canvas: purge revoked links", "err", err)
			}
		}
	}
}

package sip

import (
	"context"
	"log/slog"
	"time"

	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/redisx"
)

// Retention of the call journal (ADR-0137 §1, owner 27.10): each workspace keeps its calls
// sip_accounts.retention_months (1, 3, 6, 12, 24 or 36; 12 by default); once an hour one
// replica deletes older finished calls — their events and parties cascade — in batches of 1000.
// A call whose recording still has its raw file waits for the recording's janitor; the Disk
// file of a stored recording is the workspace's and stays (ADR-0131).
//
// Contacts (T2): the same period applies to sip_contacts — a contact none of whose numbers
// called or was called within the period and that nobody edited within it (updated_at) is
// deleted here too, after the calls (purgeContacts).

const (
	retentionEvery = time.Hour
	retentionBatch = 1000
	// retentionBatches bounds one workspace's work per run (a first run after rollout may find
	// years of calls): the next run continues.
	retentionBatches = 50
)

// RunRetention deletes expired calls every hour until ctx ends (the first run a minute after
// the start).
func (s *Service) RunRetention(ctx context.Context) {
	t := time.NewTimer(time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.Retention(ctx, time.Now())
			t.Reset(retentionEvery)
		}
	}
}

// Retention deletes the calls older than each workspace's period at now — one replica per run
// (a Valkey lock).
func (s *Service) Retention(ctx context.Context, now time.Time) {
	lock := s.redis.B().Set().Key(redisx.Key("sip:retention")).Value("1").Nx().Ex(retentionEvery - time.Minute).Build()
	if err := s.redis.Do(ctx, lock).Error(); err != nil {
		return // another replica runs it (or Valkey is down)
	}
	s.PurgeExpired(ctx, now)
}

// PurgeExpired deletes the calls older than each workspace's period at now and returns how
// many went (Retention without its lock; tests call it).
func (s *Service) PurgeExpired(ctx context.Context, now time.Time) int64 {
	ctx = db.WithoutAdmission(ctx)
	accounts, err := s.db.Q.ListSipRetention(ctx)
	if err != nil {
		slog.WarnContext(ctx, "sip: retention", "err", err)
		return 0
	}
	var total int64
	for _, a := range accounts {
		months := int(a.RetentionMonths)
		if months <= 0 {
			months = DefaultRetentionMonths
		}
		before := now.AddDate(0, -months, 0)
		for range retentionBatches {
			n, err := db.GuardValue(ctx, s.db, func(q *sqlc.Queries) (int64, error) {
				return q.DeleteOldSipCalls(ctx, sqlc.DeleteOldSipCallsParams{WorkspaceID: a.WorkspaceID, Before: before})
			})
			if err != nil {
				slog.WarnContext(ctx, "sip: retention", "workspace", a.WorkspaceID, "err", err)
				break
			}
			total += n
			if n < retentionBatch || ctx.Err() != nil {
				break
			}
		}
	}
	if total > 0 {
		slog.InfoContext(ctx, "sip: retention deleted old calls", "calls", total)
	}
	s.purgeContacts(ctx, now)
	return total
}

// purgeContacts deletes, per workspace, the contacts nobody edited within its period and none
// of whose numbers called or was called within it (after the calls: a deleted call no longer
// keeps its contact). Workspaces with contacts but no telephony account keep them 12 months.
func (s *Service) purgeContacts(ctx context.Context, now time.Time) int64 {
	list, err := s.db.Q.ListSipContactRetention(ctx)
	if err != nil {
		slog.WarnContext(ctx, "sip: contact retention", "err", err)
		return 0
	}
	var total int64
	for _, w := range list {
		months := int(w.RetentionMonths)
		if months <= 0 {
			months = DefaultRetentionMonths
		}
		before := now.AddDate(0, -months, 0)
		for range retentionBatches {
			n, err := db.GuardValue(ctx, s.db, func(q *sqlc.Queries) (int64, error) {
				return q.DeleteOldSipContacts(ctx, sqlc.DeleteOldSipContactsParams{WorkspaceID: w.WorkspaceID, Before: before})
			})
			if err != nil {
				slog.WarnContext(ctx, "sip: contact retention", "workspace", w.WorkspaceID, "err", err)
				break
			}
			total += n
			if n < retentionBatch || ctx.Err() != nil {
				break
			}
		}
	}
	if total > 0 {
		slog.InfoContext(ctx, "sip: retention deleted old contacts", "contacts", total)
	}
	return total
}

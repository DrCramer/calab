package wiki

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/wikiacl"
	"github.com/calaba/calaba/server/internal/ysync"
)

// The sync socket GET /api/wiki/pages/{id}/sync (ADR-0096 §4, docs/05 «Сокет синхронизации») is
// internal/ysync, shared with the Canvas; this file is the Wiki's side of it (wikiBackend): its
// storage, the access rule of a socket and what a posted snapshot also changes — the text,
// preview and size of the page, its title and its versions.

// Limits of the protocol (ADR-0096 §4).
const (
	MaxUpdate = ysync.MaxUpdate
	MaxState  = 2 << 20 // bytes of a snapshot's state
	MaxMeta   = ysync.MaxMeta
	MaxText   = 256 << 10

	headerPost = 13 // type + u64 + u32 (SNAPSHOT_POST)
)

// Names of ysync used by the Wiki and its tests.
const (
	frameSnapshot     = ysync.FrameSnapshot
	frameUpdate       = ysync.FrameUpdate
	frameAwareness    = ysync.FrameAwareness
	frameCompact      = ysync.FrameCompact
	frameSnapshotPost = ysync.FrameSnapshotPost

	closeTryAgain  = ysync.CloseTryAgain
	closeBadFrame  = ysync.CloseBadFrame
	closeForbidden = ysync.CloseForbidden
	closeAuth      = ysync.CloseAuth
	closeRate      = ysync.CloseRate
	closeIdle      = ysync.CloseIdle
	closeRevoked   = ysync.CloseRevoked
	closeNotFound  = ysync.CloseNotFound
)

var (
	emptyState    = ysync.EmptyState
	snapshotFrame = ysync.SnapshotFrame
	updateFrame   = ysync.UpdateFrame
	frameSeq      = ysync.FrameSeq
)

// SyncConfig tunes the sync socket; the zero value is production (tests shorten it).
type SyncConfig = ysync.Config

// Authenticator is what the socket needs of auth.Service.
type Authenticator = ysync.Authenticator

// defaultVersionEvery: a version at most this often per page.
const defaultVersionEvery = 5 * time.Minute

// wikiBackend is the Wiki's ysync.Backend.
type wikiBackend struct {
	s    *Service
	auth Authenticator
}

func (wikiBackend) Name() string  { return "wiki" }
func (wikiBackend) MaxState() int { return MaxState }

func (b wikiBackend) GetSnapshot(ctx context.Context, q *sqlc.Queries, doc uuid.UUID) (int64, []byte, error) {
	s, err := q.GetWikiSnapshot(ctx, doc)
	if err != nil {
		return 0, nil, err
	}
	return s.ThroughSeq, s.State, nil
}

func (b wikiBackend) GetSnapshotSeq(ctx context.Context, q *sqlc.Queries, doc uuid.UUID) (int64, error) {
	return q.GetWikiSnapshotSeq(ctx, doc)
}

func (b wikiBackend) ListUpdates(ctx context.Context, q *sqlc.Queries, doc uuid.UUID, after int64, lim int32) ([]ysync.Update, error) {
	rows, err := q.ListWikiUpdatesSince(ctx, sqlc.ListWikiUpdatesSinceParams{PageID: doc, AfterSeq: after, Lim: lim})
	if err != nil {
		return nil, err
	}
	out := make([]ysync.Update, len(rows))
	for i, u := range rows {
		out[i] = ysync.Update{Seq: u.Seq, Data: u.Data}
	}
	return out, nil
}

func (b wikiBackend) AppendUpdate(ctx context.Context, q *sqlc.Queries, doc uuid.UUID, data []byte, author *uuid.UUID) (int64, error) {
	row, err := q.AppendWikiUpdate(ctx, sqlc.AppendWikiUpdateParams{PageID: doc, Data: data, AuthorID: author})
	return row.Seq, err
}

func (b wikiBackend) UpdatesSince(ctx context.Context, q *sqlc.Queries, doc uuid.UUID, after int64) (ysync.Stats, error) {
	st, err := q.WikiUpdatesSince(ctx, sqlc.WikiUpdatesSinceParams{PageID: doc, AfterSeq: after})
	return ysync.Stats{Updates: st.Updates, Bytes: st.Bytes, Authors: st.Authors}, err
}

func (b wikiBackend) UpsertSnapshot(ctx context.Context, q *sqlc.Queries, doc uuid.UUID, state []byte, through int64, by *uuid.UUID) (int64, error) {
	return q.UpsertWikiSnapshot(ctx, sqlc.UpsertWikiSnapshotParams{PageID: doc, State: state, ThroughSeq: through, SavedBy: by})
}

func (b wikiBackend) DeleteUpdatesThrough(ctx context.Context, q *sqlc.Queries, doc uuid.UUID, through int64) error {
	_, err := q.DeleteWikiUpdatesThrough(ctx, sqlc.DeleteWikiUpdatesThroughParams{PageID: doc, ThroughSeq: through})
	return err
}

// Authorize resolves the caller's access to the page (as at connect, and on every recheck):
// a fresh permission resolver every time.
func (b wikiBackend) Authorize(ctx context.Context, id auth.Identity, page uuid.UUID) (bool, int, string) {
	q := b.s.db.Q
	ctx = b.auth.WithPolicy(ctx, id, identitypolicy.WorkspaceRead)
	ctx = perm.WithResolver(ctx, q)
	ch, err := wikiacl.Load(ctx, q, []uuid.UUID{page})
	if err != nil {
		return false, ysync.CloseTryAgain, "try again"
	}
	if !ch.Has(page) {
		return false, ysync.CloseNotFound, "no such page"
	}
	p := ch.Page(page)
	if p.TrashedAt != nil {
		return false, ysync.CloseNotFound, "the page is in the trash"
	}
	m, err := perm.FromContext(ctx).Member(ctx, p.WorkspaceID, id.UserID)
	switch {
	case errors.Is(err, perm.ErrNotMember):
		return false, ysync.CloseForbidden, "no access"
	case ysync.IsRefusal(err):
		return false, ysync.CloseForbidden, "access policy"
	case err != nil:
		return false, ysync.CloseTryAgain, "try again"
	}
	if err := b.auth.CheckWorkspace(ctx, id, p.WorkspaceID, identitypolicy.WorkspaceRead); err != nil {
		if ysync.IsRefusal(err) {
			return false, ysync.CloseForbidden, "access policy"
		}
		return false, ysync.CloseTryAgain, "try again"
	}
	bits := ch.Bits(m, &page)
	if !bits.Has(perm.WikiView) {
		return false, ysync.CloseForbidden, "no access"
	}
	write := bits.Has(perm.WikiWrite) &&
		b.auth.CheckWorkspace(ctx, id, p.WorkspaceID, identitypolicy.WorkspaceWrite) == nil &&
		writable(ctx, q, p.WorkspaceID) == nil
	return write, 0, ""
}

// snapshotMeta is the JSON of a SNAPSHOT_POST.
type snapshotMeta struct {
	PlainText string `json:"plain_text"`
	Title     string `json:"title"`
	Preview   string `json:"preview"`
	// Broadcast: the state holds an edit no UPDATE carried (a transaction too big for a frame):
	// the other sockets of the page get it as a SNAPSHOT. Otherwise the post is a silent
	// compaction.
	Broadcast bool `json:"broadcast,omitempty"`
}

func (wikiBackend) DecodeMeta(raw []byte) (any, bool, error) {
	var meta snapshotMeta
	if err := json.Unmarshal(raw, &meta); err != nil {
		return nil, false, ysync.ErrBadMeta
	}
	return meta, meta.Broadcast, nil
}

// PostSnapshot stores a snapshot (ADR-0096 §4): in one transaction it checks through_seq against
// the stored snapshot and the page's counter, saves it, drops the updates it contains, updates
// the page's text, preview, size and (a non-empty title) title, and writes a version when due.
func (b wikiBackend) PostSnapshot(ctx context.Context, p ysync.Post) (ysync.Result, error) {
	s, uid, page, state := b.s, p.By, p.Doc, p.State
	meta := p.Meta.(snapshotMeta)
	text := clipBytes(meta.PlainText, MaxText)
	preview := clip(strings.Join(strings.Fields(meta.Preview), " "), 200)
	title := clip(strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return ' '
		}
		return r
	}, strings.TrimSpace(meta.Title)), MaxTitle)
	stored, renamed := false, false
	err := s.db.Tx(ctx, func(q *sqlc.Queries) error {
		cur, err := q.GetWikiPageForUpdate(ctx, page)
		if db.IsNotFound(err) {
			return ysync.ErrGone
		}
		if err != nil {
			return err
		}
		if cur.TrashedAt != nil {
			return ysync.ErrGone
		}
		ok, authors, err := ysync.StoreSnapshot(ctx, b, q, page, cur.NextSeq, p.Through, state, &uid)
		if err != nil || !ok {
			return err
		}
		row, err := q.SetWikiPageContent(ctx, sqlc.SetWikiPageContentParams{ID: page, PlainText: text, Preview: preview,
			DocSize: int32(len(state)), UpdatedBy: &uid}) //nolint:gosec // ≤ MaxState
		if err != nil {
			return err
		}
		pg := head(row)
		if title != "" && title != pg.Title {
			old := pg.Title
			if row, err = q.UpdateWikiPage(ctx, sqlc.UpdateWikiPageParams{ID: page, Title: &title, UpdatedBy: &uid}); err != nil {
				return err
			}
			pg, renamed = head(row), true
			if err := s.journal(ctx, q, pg, &uid, "rename", snap{"title": old}, snap{"title": pg.Title}); err != nil {
				return err
			}
		}
		stored = true
		return b.version(ctx, q, p, pg, text, authors)
	})
	if err != nil {
		return ysync.Result{}, err
	}
	res := ysync.Result{Stored: stored}
	if renamed {
		res.After = func() { s.upserted(ctx, page, nil) }
	}
	return res, nil
}

// version writes a version of the page when due (ADR-0096 §1): at most one per VersionEvery,
// only when the text or the title changed since the last one; then thins the history.
func (b wikiBackend) version(ctx context.Context, q *sqlc.Queries, p ysync.Post, pg sqlc.WikiPageHead, text string, authors []uuid.UUID) error {
	s, now := b.s, b.s.Now()
	every := p.VersionEvery
	if every == 0 {
		every = defaultVersionEvery
	}
	last, err := q.LastWikiVersion(ctx, p.Doc)
	switch {
	case db.IsNotFound(err):
		if text == "" && pg.Title == "" {
			return nil
		}
	case err != nil:
		return err
	default:
		if now.Sub(last.CreatedAt) < every || (last.PlainText == text && last.Title == pg.Title) {
			return nil
		}
	}
	uid := p.By
	if !containsID(authors, uid) {
		authors = append(authors, uid)
	}
	v, err := q.InsertWikiVersion(ctx, sqlc.InsertWikiVersionParams{PageID: p.Doc, State: p.State, PlainText: text, Title: pg.Title, Authors: authors})
	if err != nil {
		return err
	}
	if err := s.journal(ctx, q, pg, &uid, "version", nil, snap{"version_id": v.ID.String(), "size": float64(v.Size)}); err != nil {
		return err
	}
	_, err = q.PruneWikiVersions(ctx, sqlc.PruneWikiVersionsParams{PageID: p.Doc, Now: now})
	return err
}

func containsID(ids []uuid.UUID, id uuid.UUID) bool {
	for _, x := range ids {
		if x == id {
			return true
		}
	}
	return false
}

// loadSnapshot is the page's snapshot (through_seq 0 and the empty document when none).
func loadSnapshot(ctx context.Context, q *sqlc.Queries, page uuid.UUID) (int64, []byte, error) {
	return ysync.LoadSnapshot(ctx, wikiBackend{}, q, page)
}

// eachUpdate calls fn for every stored update after seq after, in order.
func eachUpdate(ctx context.Context, q *sqlc.Queries, page uuid.UUID, after int64, fn func(seq int64, data []byte) error) error {
	return ysync.EachUpdate(ctx, wikiBackend{}, q, page, after, fn)
}

// kick makes every socket of the pages (on every instance) check its access now: after a
// trash, a change of overrides or of restricted.
func (s *Service) kick(ctx context.Context, pages []uuid.UUID) {
	if s.sync == nil {
		return
	}
	s.sync.Kick(ctx, pages)
}

// recheck is kick of one page.
func (s *Service) recheck(ctx context.Context, page uuid.UUID) { s.kick(ctx, []uuid.UUID{page}) }

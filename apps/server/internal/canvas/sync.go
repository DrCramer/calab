package canvas

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/canvasacl"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/ysync"
)

// The sync socket GET /api/canvas/items/{id}/sync (ADR-0126 §3, docs/05 «Сокет синхронизации») is
// internal/ysync, shared with the Wiki; this file is the Canvas's side of it (canvasBackend): its
// storage, the access rule of a socket and what a posted snapshot also changes — the text and
// preview for search, the size and the versions.

// Limits of the protocol (ADR-0126 §3).
const (
	// MaxState is the largest snapshot state in bytes (the CHECK of canvas_snapshots).
	MaxState = 4 << 20
	// MaxText caps the plain_text of a snapshot meta (the CHECK of canvas_items).
	MaxText = 256 << 10
	// MaxVersions per canvas (PruneCanvasVersions).
	MaxVersions = 50
)

// defaultVersionEvery: a version at most this often per canvas (ADR-0126 §1).
const defaultVersionEvery = 10 * time.Minute

// canvasBackend is the Canvas's ysync.Backend.
type canvasBackend struct {
	s    *Service
	auth ysync.Authenticator
}

func (canvasBackend) Name() string   { return "canvas" }
func (canvasBackend) LogKey() string { return "doc_id" }
func (canvasBackend) Noun() string   { return "document" }
func (canvasBackend) MaxState() int  { return MaxState }

// Profile: every behaviour built for the Canvas on top of the Wiki's relay (docs/05 «Лимиты»).
func (canvasBackend) Profile() ysync.Profile {
	return ysync.Profile{
		Ceiling:           true,
		ByteBudget:        true,
		CoalesceAwareness: true,
		RecheckJitter:     true,
		PublishBackoff:    true,
		RetryPublish:      true,
		BatchAwareness:    true,
	}
}

func (canvasBackend) GetSnapshot(ctx context.Context, q *sqlc.Queries, doc uuid.UUID) (int64, []byte, error) {
	s, err := q.GetCanvasSnapshot(ctx, doc)
	if err != nil {
		return 0, nil, err
	}
	return s.ThroughSeq, s.State, nil
}

func (canvasBackend) GetSnapshotSeq(ctx context.Context, q *sqlc.Queries, doc uuid.UUID) (int64, error) {
	return q.GetCanvasSnapshotSeq(ctx, doc)
}

func (canvasBackend) ListUpdates(ctx context.Context, q *sqlc.Queries, doc uuid.UUID, after int64, lim int32) ([]ysync.Update, error) {
	rows, err := q.ListCanvasUpdatesSince(ctx, sqlc.ListCanvasUpdatesSinceParams{CanvasID: doc, AfterSeq: after, Lim: lim})
	if err != nil {
		return nil, err
	}
	out := make([]ysync.Update, len(rows))
	for i, u := range rows {
		out[i] = ysync.Update{Seq: u.Seq, Data: u.Data}
	}
	return out, nil
}

func (canvasBackend) AppendUpdate(ctx context.Context, q *sqlc.Queries, doc uuid.UUID, data []byte, author *uuid.UUID) (int64, error) {
	row, err := q.AppendCanvasUpdate(ctx, sqlc.AppendCanvasUpdateParams{CanvasID: doc, Data: data, AuthorID: author})
	return row.Seq, err
}

func (canvasBackend) UpdatesSince(ctx context.Context, q *sqlc.Queries, doc uuid.UUID, after int64) (ysync.Stats, error) {
	st, err := q.CanvasUpdatesSince(ctx, sqlc.CanvasUpdatesSinceParams{CanvasID: doc, AfterSeq: after})
	return ysync.Stats{Updates: st.Updates, Bytes: st.Bytes, Authors: st.Authors}, err
}

func (canvasBackend) UpsertSnapshot(ctx context.Context, q *sqlc.Queries, doc uuid.UUID, state []byte, through int64, by *uuid.UUID) (int64, error) {
	return q.UpsertCanvasSnapshot(ctx, sqlc.UpsertCanvasSnapshotParams{CanvasID: doc, State: state, ThroughSeq: through, SavedBy: by})
}

func (canvasBackend) DeleteUpdatesThrough(ctx context.Context, q *sqlc.Queries, doc uuid.UUID, through int64) error {
	_, err := q.DeleteCanvasUpdatesThrough(ctx, sqlc.DeleteCanvasUpdatesThroughParams{CanvasID: doc, ThroughSeq: through})
	return err
}

// Authorize resolves the caller's access to the canvas (as at connect, and on every recheck): a
// fresh permission resolver every time. Only a live canvas has a socket: a folder, a missing or
// a trashed item closes 4404, no CANVAS_VIEW 4003, no CANVAS_WRITE (or a suspended workspace, or
// the write policy) makes the socket read-only.
func (b canvasBackend) Authorize(ctx context.Context, id auth.Identity, item uuid.UUID) (bool, int, string) {
	if id.IsBot {
		return false, ysync.CloseForbidden, "bots have no access to the Canvas yet" // v2 (ADR-0126)
	}
	q := b.s.db.Q
	ctx = b.auth.WithPolicy(ctx, id, identitypolicy.WorkspaceRead)
	ctx = perm.WithResolver(ctx, q)
	ch, err := canvasacl.Load(ctx, q, []uuid.UUID{item})
	if err != nil {
		return false, ysync.CloseTryAgain, "try again"
	}
	if !ch.Has(item) {
		return false, ysync.CloseNotFound, "no such canvas"
	}
	p := ch.Item(item)
	if p.TrashedAt != nil {
		return false, ysync.CloseNotFound, "the canvas is in the trash"
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
	bits := ch.Bits(m, &item)
	if !bits.Has(perm.CanvasView) {
		return false, ysync.CloseForbidden, "no access"
	}
	if p.Kind != kindCanvas {
		return false, ysync.CloseNotFound, "not a canvas"
	}
	if !bits.Has(perm.CanvasWrite) {
		return false, 0, ""
	}
	return writeVerdict(
		b.auth.CheckWorkspace(ctx, id, p.WorkspaceID, identitypolicy.WorkspaceWrite),
		func() error { return writable(ctx, q, p.WorkspaceID) },
	)
}

// writeVerdict turns the write checks into the socket mode: only a refusal makes the socket
// read-only; any other error (a database hiccup) is "try again", never a silent downgrade.
func writeVerdict(policyErr error, writableFn func() error) (bool, int, string) {
	if policyErr != nil {
		if ysync.IsRefusal(policyErr) {
			return false, 0, ""
		}
		return false, ysync.CloseTryAgain, "try again"
	}
	if err := writableFn(); err != nil {
		if ysync.IsRefusal(err) {
			return false, 0, ""
		}
		return false, ysync.CloseTryAgain, "try again"
	}
	return true, 0, ""
}

// snapshotMeta is the JSON of a SNAPSHOT_POST: the text on the canvas for search and the preview
// (the first characters of the objects' text); both come from the client.
type snapshotMeta struct {
	PlainText string `json:"plain_text"`
	Preview   string `json:"preview"`
	// Broadcast: the state holds an edit no UPDATE carried (a transaction too big for a frame):
	// the other sockets of the canvas get it as a SNAPSHOT. Otherwise the post is a silent
	// compaction.
	Broadcast bool `json:"broadcast,omitempty"`
	// Objects is the number of objects in the document (the server does not parse Yjs). An
	// explicit 0 stores the snapshot but writes no version: an empty canvas is no history. Absent
	// (an older client): the version rule is the same as for any state.
	Objects *int `json:"objects,omitempty"`
}

func (canvasBackend) DecodeMeta(raw []byte) (any, bool, error) {
	var meta snapshotMeta
	if err := json.Unmarshal(raw, &meta); err != nil {
		return nil, false, ysync.ErrBadMeta
	}
	return meta, meta.Broadcast, nil
}

// PostSnapshot stores a snapshot (ADR-0126 §3): in one transaction it checks through_seq against
// the stored snapshot and the canvas's counter, saves it, drops the updates it contains, updates
// the canvas's text, preview and size, and writes a version when due.
func (b canvasBackend) PostSnapshot(ctx context.Context, p ysync.Post) (ysync.Result, error) {
	s, uid, id, state := b.s, p.By, p.Doc, p.State
	meta := p.Meta.(snapshotMeta)
	// Postgres text holds no NUL: one in a pasted text would fail every compaction of the canvas.
	text := clipBytes(noNUL(meta.PlainText), MaxText)
	preview := clip(strings.Join(strings.Fields(noNUL(meta.Preview)), " "), 200)
	stored, previewChanged := false, false
	var through int64
	err := s.db.Tx(ctx, func(q *sqlc.Queries) error {
		cur, err := q.GetCanvasItemForUpdate(ctx, id)
		if db.IsNotFound(err) {
			return ysync.ErrGone
		}
		if err != nil {
			return err
		}
		if cur.TrashedAt != nil || cur.Kind != kindCanvas {
			return ysync.ErrGone
		}
		ok, seq, authors, err := ysync.StoreSnapshot(ctx, b, q, p, cur.NextSeq)
		if err != nil || !ok {
			return err
		}
		through = seq
		row, err := q.SetCanvasContent(ctx, sqlc.SetCanvasContentParams{ID: id, PlainText: text, Preview: preview,
			DocSize: int32(len(state)), UpdatedBy: &uid}) //nolint:gosec // ≤ MaxState
		if err != nil {
			return err
		}
		stored, previewChanged = true, cur.Preview != preview
		return b.version(ctx, q, p, sqlc.CanvasItemHead(row), authors)
	})
	if err != nil {
		return ysync.Result{}, err
	}
	res := ysync.Result{Stored: stored, Through: through}
	if previewChanged {
		// The tree shows the preview: whoever sees the canvas gets the new one.
		res.After = func() { s.upserted(ctx, id, nil) }
	}
	return res, nil
}

// version writes a version of the canvas when due (ADR-0126 §1): at most one per VersionEvery,
// only when the state changed since the last one (compared by its sha256, kept with the version)
// and the document has objects (meta.objects ≠ 0); then thins the history to MaxVersions.
func (b canvasBackend) version(ctx context.Context, q *sqlc.Queries, p ysync.Post, it sqlc.CanvasItemHead, authors []uuid.UUID) error {
	if o := p.Meta.(snapshotMeta).Objects; o != nil && *o == 0 {
		return nil // the client says the document is empty: no version (the snapshot itself is kept)
	}
	s, now := b.s, b.s.Now()
	every := p.VersionEvery
	if every == 0 {
		every = defaultVersionEvery
	}
	last, err := q.LastCanvasVersion(ctx, p.Doc)
	switch {
	case db.IsNotFound(err):
		if bytes.Equal(p.State, ysync.EmptyState) {
			return nil // an empty document is no history
		}
	case err != nil:
		return err
	default:
		// The interval first: inside the canvas's row lock nothing is hashed until a version is due.
		if now.Sub(last.CreatedAt) < every {
			return nil
		}
		prev := last.StateHash
		if prev == nil { // stored before the column (00021)
			if prev, err = q.SetCanvasVersionHash(ctx, last.ID); err != nil {
				return err
			}
		}
		if sum := sha256.Sum256(p.State); bytes.Equal(prev, sum[:]) {
			return nil
		}
	}
	uid := p.By
	if !containsID(authors, uid) {
		authors = append(authors, uid)
	}
	v, err := q.InsertCanvasVersion(ctx, sqlc.InsertCanvasVersionParams{CanvasID: p.Doc, State: p.State, Authors: authors})
	if err != nil {
		return err
	}
	if err := s.journal(ctx, q, it, &uid, "version", nil, snap{"version_id": v.ID.String(), "size": float64(v.Size)}); err != nil {
		return err
	}
	_, err = q.PruneCanvasVersions(ctx, p.Doc)
	return err
}

func noNUL(s string) string { return strings.ReplaceAll(s, "\x00", "") }

func containsID(ids []uuid.UUID, id uuid.UUID) bool {
	for _, x := range ids {
		if x == id {
			return true
		}
	}
	return false
}

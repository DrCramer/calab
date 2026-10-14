// Package stickers implements the sticker packs of a workspace (ADR-0030): pack CRUD with
// MANAGE_STICKERS, batch uploads of validated WebP files (stored as workspace files, counted in
// the storage quota), the user's installed packs and their order.
package stickers

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/blob"
	"github.com/calaba/calaba/server/internal/builtinstickers"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/files"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/messages"
	"github.com/calaba/calaba/server/internal/moderation"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/plans"
	"github.com/calaba/calaba/server/internal/redisx"
)

// Limits besides the WebP ones (ADR-0030 §6).
const (
	MaxPerPack    = 120 // live stickers in one pack
	MaxBatch      = 50  // stickers in one upload request
	MaxInstalled  = 50  // packs a user may install
	maxEmojiField = 64  // bytes of an "emoji" multipart field
)

// uploadDeadline replaces the server's ReadTimeout for batch uploads.
const uploadDeadline = 5 * time.Minute

// Handlers serves the sticker endpoints.
type Handlers struct {
	db      *db.DB
	events  events.Publisher
	files   *files.Service
	plans   *plans.Service
	limiter *redisx.RateLimiter // uploads per workspace and user; nil = none
}

// NewHandlers creates the sticker handlers. plans may be nil (no plan limits).
func NewHandlers(d *db.DB, ev events.Publisher, fs *files.Service, ps *plans.Service, limiter *redisx.RateLimiter) *Handlers {
	return &Handlers{db: d, events: ev, files: fs, plans: ps, limiter: limiter}
}

// Routes registers authenticated pack routes and public built-in artwork.
// wrap must apply auth + perm resolver.
func (h *Handlers) Routes(mux httpx.Router, wrap func(http.Handler) http.Handler) {
	mux.Handle("GET /api/stickers/builtin/{name}", http.HandlerFunc(builtinstickers.ServeHTTP))
	handle := func(p string, f httpx.HandlerFunc) { mux.Handle(p, wrap(f)) }
	handle("GET /api/workspaces/{id}/sticker-packs", h.list)
	handle("POST /api/workspaces/{id}/sticker-packs", h.create)
	handle("GET /api/sticker-packs/{id}", h.get)
	handle("PATCH /api/sticker-packs/{id}", h.update)
	handle("DELETE /api/sticker-packs/{id}", h.delete)
	handle("POST /api/sticker-packs/{id}/stickers", h.upload)
	handle("PUT /api/sticker-packs/{id}/stickers/{sid}", h.replaceSticker)
	handle("PATCH /api/stickers/{id}", h.updateSticker)
	handle("DELETE /api/stickers/{id}", h.deleteSticker)
	handle("GET /api/me/sticker-packs", h.mine)
	handle("PUT /api/me/sticker-packs/order", h.order)
	handle("PUT /api/me/sticker-packs/{id}", h.install)
	handle("DELETE /api/me/sticker-packs/{id}", h.uninstall)
}

func uid(r *http.Request) uuid.UUID { return auth.MustFromContext(r.Context()).UserID }

// member resolves the caller in the workspace: 404 for non-members (the workspace stays hidden).
func member(r *http.Request, wsID uuid.UUID) (perm.Member, error) {
	m, err := perm.FromContext(r.Context()).Member(r.Context(), wsID, uid(r))
	if errors.Is(err, perm.ErrNotMember) {
		return m, httpx.NotFound("workspace")
	}
	return m, err
}

// manager checks MANAGE_STICKERS in the workspace (and that it is not suspended).
func (h *Handlers) manager(r *http.Request, wsID uuid.UUID) error {
	m, err := member(r, wsID)
	if err != nil {
		return err
	}
	if !m.Workspace().Has(perm.ManageStickers) {
		return httpx.Forbidden("MANAGE_STICKERS required")
	}
	return moderation.CheckSuspended(r.Context(), h.db.Q, wsID)
}

// loadPack returns a live pack after checking that the caller manages its workspace.
func (h *Handlers) loadPack(r *http.Request) (sqlc.StickerPack, error) {
	id, err := httpx.PathUUID(r, "id", "sticker pack")
	if err != nil {
		return sqlc.StickerPack{}, err
	}
	p, err := h.db.Q.GetStickerPack(r.Context(), id)
	if db.IsNotFound(err) {
		return p, httpx.NotFound("sticker pack")
	}
	if err != nil {
		return p, err
	}
	if p.WorkspaceID == nil {
		return p, httpx.Forbidden("built-in sticker pack is read-only")
	}
	if _, err := member(r, *p.WorkspaceID); err != nil {
		return p, httpx.NotFound("sticker pack")
	}
	return p, h.manager(r, *p.WorkspaceID)
}

// withStickers converts packs, loading the live stickers of all of them in one query.
func withStickers(ctx context.Context, q *sqlc.Queries, packs []sqlc.StickerPack) ([]*v1.StickerPack, error) {
	ids := make([]uuid.UUID, len(packs))
	for i, p := range packs {
		ids[i] = p.ID
	}
	by := map[uuid.UUID][]*v1.Sticker{}
	if len(ids) > 0 {
		rows, err := q.ListPackStickers(ctx, ids)
		if err != nil {
			return nil, err
		}
		for _, row := range rows {
			by[row.Sticker.PackID] = append(by[row.Sticker.PackID], pbconv.Sticker(row.Sticker, row.FileSize))
		}
	}
	out := make([]*v1.StickerPack, len(packs))
	for i, p := range packs {
		out[i] = pbconv.StickerPack(p, by[p.ID])
	}
	return out, nil
}

func (h *Handlers) packProto(ctx context.Context, p sqlc.StickerPack) (*v1.StickerPack, error) {
	out, err := withStickers(ctx, h.db.Q, []sqlc.StickerPack{p})
	if err != nil {
		return nil, err
	}
	return out[0], nil
}

// publishUpdate re-reads the pack and sends STICKER_PACK_UPDATE; returns the pack.
func (h *Handlers) publishUpdate(r *http.Request, packID uuid.UUID) (*v1.StickerPack, error) {
	p, err := h.db.Q.GetStickerPack(r.Context(), packID)
	if err != nil {
		return nil, err
	}
	pb, err := h.packProto(r.Context(), p)
	if err != nil {
		return nil, err
	}
	h.events.Workspace(r.Context(), *p.WorkspaceID, &v1.DispatchEvent{Event: &v1.DispatchEvent_StickerPackUpdate{
		StickerPackUpdate: &v1.StickerPackUpdate{Pack: pb}}})
	return pb, nil
}

// ---- validation

var shortNameRe = regexp.MustCompile(`^[a-z0-9_]{1,32}$`)

func validName(s string) (string, error) {
	s = strings.TrimSpace(s)
	if n := utf8.RuneCountInString(s); n < 1 || n > 64 {
		return "", httpx.Validation("name", "name must be 1..64 characters")
	}
	if strings.IndexFunc(s, unicode.IsControl) >= 0 {
		return "", httpx.Validation("name", "name must not contain control characters")
	}
	return s, nil
}

func validShortName(s string) (string, error) {
	s = strings.ToLower(strings.TrimSpace(s))
	if !shortNameRe.MatchString(s) {
		return "", httpx.Validation("shortName", "short name must be 1..32 characters a-z, 0-9 or _")
	}
	return s, nil
}

func validEmoji(field, s string) (string, error) {
	s = strings.TrimSpace(s)
	if !messages.ValidEmoji(s) {
		return "", httpx.Validation(field, "must be one emoji")
	}
	return s, nil
}

// planLimit is 409 CONFLICT reason PLAN_LIMIT with the counter and the limit.
func planLimit(what string, used, limit uint32) error {
	return plans.LimitError(what, uint64(used), uint64(limit))
}

func (h *Handlers) limits(ctx context.Context, wsID uuid.UUID) (plans.Limits, error) {
	if h.plans == nil {
		return plans.Limits{}, nil
	}
	return h.plans.Effective(ctx, wsID)
}

// ---- packs

func (h *Handlers) list(w http.ResponseWriter, r *http.Request) error {
	wsID, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return err
	}
	if _, err := member(r, wsID); err != nil {
		return err
	}
	packs, err := h.db.Q.ListWorkspaceStickerPacks(r.Context(), &wsID)
	if err != nil {
		return err
	}
	out, err := withStickers(r.Context(), h.db.Q, packs)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.ListStickerPacksResponse{Packs: out})
	return nil
}

// get: GET /api/sticker-packs/{id} — a live pack for any member of its workspace (the
// «Добавить пак» card of a sticker in the feed); 404 otherwise.
func (h *Handlers) get(w http.ResponseWriter, r *http.Request) error {
	id, err := httpx.PathUUID(r, "id", "sticker pack")
	if err != nil {
		return err
	}
	if id.String() == builtinstickers.PackID() {
		httpx.Write(w, http.StatusOK, &v1.StickerPackResponse{Pack: builtinstickers.Pack()})
		return nil
	}
	p, err := h.db.Q.GetStickerPack(r.Context(), id)
	if db.IsNotFound(err) {
		return httpx.NotFound("sticker pack")
	}
	if err != nil {
		return err
	}
	if p.WorkspaceID == nil {
		return httpx.Forbidden("built-in sticker pack is read-only")
	}
	if _, err := member(r, *p.WorkspaceID); err != nil {
		return httpx.NotFound("sticker pack")
	}
	pb, err := h.packProto(r.Context(), p)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.StickerPackResponse{Pack: pb})
	return nil
}

func (h *Handlers) create(w http.ResponseWriter, r *http.Request) error {
	wsID, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return err
	}
	if err := h.manager(r, wsID); err != nil {
		return err
	}
	var req v1.CreateStickerPackRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	name, err := validName(req.GetName())
	if err != nil {
		return err
	}
	short := req.GetShortName()
	if strings.TrimSpace(short) == "" {
		short = "p_" + strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	}
	if short, err = validShortName(short); err != nil {
		return err
	}
	me := uid(r)
	var p sqlc.StickerPack
	err = h.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		if err := h.plans.Check(r.Context(), q, wsID, plans.KindStickerPacks, true); err != nil {
			return err
		}
		var err error
		p, err = q.InsertStickerPack(r.Context(), sqlc.InsertStickerPackParams{WorkspaceID: &wsID, Name: name, ShortName: short, CreatedBy: &me})
		if db.IsNotFound(err) {
			return httpx.Conflict("short name is taken in this workspace")
		}
		if err != nil {
			return err
		}
		// The creator gets the pack installed (when there is room for it).
		if n, err := q.CountUserStickerPacks(r.Context(), me); err != nil {
			return err
		} else if n < MaxInstalled {
			_, err = q.InstallStickerPack(r.Context(), sqlc.InstallStickerPackParams{UserID: me, PackID: p.ID})
			return err
		}
		return nil
	})
	if err != nil {
		return err
	}
	pb := pbconv.StickerPack(p, nil)
	h.events.Workspace(r.Context(), wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_StickerPackCreate{
		StickerPackCreate: &v1.StickerPackCreate{Pack: pb}}})
	httpx.Write(w, http.StatusCreated, &v1.StickerPackResponse{Pack: pb})
	return nil
}

func (h *Handlers) update(w http.ResponseWriter, r *http.Request) error {
	p, err := h.loadPack(r)
	if err != nil {
		return err
	}
	var req v1.UpdateStickerPackRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	params := sqlc.UpdateStickerPackParams{ID: p.ID}
	if req.Name != nil {
		n, err := validName(req.GetName())
		if err != nil {
			return err
		}
		params.Name = &n
	}
	if req.ShortName != nil {
		s, err := validShortName(req.GetShortName())
		if err != nil {
			return err
		}
		params.ShortName = &s
	}
	live, err := h.db.Q.ListPackStickers(r.Context(), []uuid.UUID{p.ID})
	if err != nil {
		return err
	}
	inPack := map[uuid.UUID]bool{}
	for _, s := range live {
		inPack[s.Sticker.ID] = true
	}
	if req.CoverStickerId != nil {
		params.SetCover = true
		if c := req.GetCoverStickerId(); c != "" {
			id, err := uuid.Parse(c)
			if err != nil || !inPack[id] {
				return httpx.Validation("coverStickerId", "not a sticker of this pack")
			}
			params.CoverStickerID = &id
		}
	}
	var order []uuid.UUID
	if ids := req.GetStickerIds(); len(ids) > 0 {
		seen := map[uuid.UUID]bool{}
		for _, s := range ids {
			id, err := uuid.Parse(s)
			if err != nil || !inPack[id] || seen[id] {
				return httpx.Validation("stickerIds", "must list every sticker of the pack once")
			}
			seen[id] = true
			order = append(order, id)
		}
		if len(order) != len(inPack) {
			return httpx.Validation("stickerIds", "must list every sticker of the pack once")
		}
	}
	err = h.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		if _, err := q.UpdateStickerPack(r.Context(), params); err != nil {
			if db.IsNotFound(err) {
				return httpx.NotFound("sticker pack")
			}
			if db.UniqueViolation(err) != "" {
				return httpx.Conflict("short name is taken in this workspace")
			}
			return err
		}
		if len(order) > 0 {
			return q.SetStickerPositions(r.Context(), sqlc.SetStickerPositionsParams{Ids: order, PackID: p.ID})
		}
		return nil
	})
	if err != nil {
		return err
	}
	pb, err := h.publishUpdate(r, p.ID)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.StickerPackResponse{Pack: pb})
	return nil
}

func (h *Handlers) delete(w http.ResponseWriter, r *http.Request) error {
	p, err := h.loadPack(r)
	if err != nil {
		return err
	}
	err = h.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		n, err := q.SoftDeleteStickerPack(r.Context(), p.ID)
		if err != nil {
			return err
		}
		if n == 0 {
			return httpx.NotFound("sticker pack")
		}
		// Stickers no message shows go now (their files with the orphan cleanup); the rest stay
		// for the history, hidden from pickers.
		if err := q.DeleteUnreferencedPackStickers(r.Context(), p.ID); err != nil {
			return err
		}
		if err := q.SoftDeletePackStickers(r.Context(), p.ID); err != nil {
			return err
		}
		if err := q.UninstallStickerPackForAll(r.Context(), p.ID); err != nil {
			return err
		}
		return q.DeleteStickerPackIfEmpty(r.Context(), p.ID)
	})
	if err != nil {
		return err
	}
	h.events.Workspace(r.Context(), *p.WorkspaceID, &v1.DispatchEvent{Event: &v1.DispatchEvent_StickerPackDelete{
		StickerPackDelete: &v1.StickerPackDelete{WorkspaceId: p.WorkspaceID.String(), PackId: p.ID.String()}}})
	httpx.NoContent(w)
	return nil
}

// ---- stickers

// received is a validated sticker file already in the blob store.
type received struct {
	id    uuid.UUID
	key   string
	name  string
	emoji string
	size  int64
	sha   string
	info  WebPInfo
}

// readBatch streams the multipart body: each "file" part (preceded by an "emoji" field) is
// read into memory (≤ MaxAnimatedBytes), validated and stored. Stored blobs are returned even
// on error, for the caller to remove.
func (h *Handlers) readBatch(w http.ResponseWriter, r *http.Request, wsID uuid.UUID) ([]received, error) {
	_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(uploadDeadline))
	r.Body = http.MaxBytesReader(w, r.Body, int64(MaxBatch)*(MaxAnimatedBytes+4<<10)+1<<20)
	mr, err := r.MultipartReader()
	if err != nil {
		return nil, httpx.BadRequest(`expected multipart/form-data with "emoji" and "file" fields`)
	}
	var (
		out   []received
		emoji string
	)
	for {
		part, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return out, httpx.BadRequest("malformed multipart body")
		}
		switch part.FormName() {
		case "emoji":
			b, _ := io.ReadAll(io.LimitReader(part, maxEmojiField+1))
			emoji = string(b)
		case "file":
			i := len(out)
			if i >= MaxBatch {
				_ = part.Close()
				return out, httpx.Validation("file", fmt.Sprintf("at most %d stickers per upload", MaxBatch))
			}
			rec, err := h.receive(r.Context(), part, wsID, i, emoji)
			_ = part.Close()
			if err != nil {
				return out, err
			}
			out = append(out, rec)
			emoji = ""
		}
		_ = part.Close()
	}
	if len(out) == 0 {
		return out, httpx.Validation("file", "no sticker files")
	}
	return out, nil
}

func (h *Handlers) receive(ctx context.Context, part *multipart.Part, wsID uuid.UUID, i int, rawEmoji string) (received, error) {
	em, err := validEmoji(fmt.Sprintf("emoji[%d]", i), rawEmoji)
	if err != nil {
		return received{}, err
	}
	rec, err := h.storeFile(ctx, part, wsID, fmt.Sprintf("file[%d]", i))
	rec.emoji = em
	return rec, err
}

// storeFile reads one sticker file part, validates it (422 on `field`) and puts it in the blob store.
func (h *Handlers) storeFile(ctx context.Context, part *multipart.Part, wsID uuid.UUID, field string) (received, error) {
	data, err := io.ReadAll(io.LimitReader(part, MaxAnimatedBytes+1))
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			return received{}, httpx.Coded(http.StatusRequestEntityTooLarge, v1.ErrorCode_ERROR_CODE_PAYLOAD_TOO_LARGE, "upload too large")
		}
		return received{}, httpx.BadRequest("malformed multipart body")
	}
	info, err := ValidateWebP(data)
	if err != nil {
		if IsInvalidWebP(err) {
			return received{}, httpx.Validation(field, err.Error())
		}
		return received{}, err
	}
	id, err := uuid.NewV7()
	if err != nil {
		return received{}, err
	}
	rec := received{id: id, key: blob.FileKey(wsID, id), name: files.SanitizeName(part.FileName()),
		size: int64(len(data)), sha: sha256Hex(data), info: info}
	if !strings.HasSuffix(strings.ToLower(rec.name), ".webp") {
		rec.name = "sticker.webp"
	}
	if err := h.files.Store().Put(ctx, rec.key, bytes.NewReader(data), rec.size, "image/webp"); err != nil {
		return received{}, fmt.Errorf("store sticker: %w", err)
	}
	return rec, nil
}

func (h *Handlers) discard(recs []received) {
	ctx := context.Background()
	for _, rec := range recs {
		if err := h.files.Store().Delete(ctx, rec.key); err != nil {
			slog.WarnContext(ctx, "delete sticker blob", "key", rec.key, "err", err)
		}
	}
}

func (h *Handlers) upload(w http.ResponseWriter, r *http.Request) error {
	p, err := h.loadPack(r)
	if err != nil {
		return err
	}
	if h.limiter != nil {
		if err := h.limiter.Take(r.Context(), p.WorkspaceID.String()+":"+uid(r).String()); err != nil {
			return err
		}
	}
	lim, err := h.limits(r.Context(), *p.WorkspaceID)
	if err != nil {
		return err
	}
	recs, err := h.readBatch(w, r, *p.WorkspaceID)
	if err != nil {
		h.discard(recs)
		return err
	}
	me := uid(r)
	added := make([]*v1.Sticker, 0, len(recs))
	err = h.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		if err := q.LockWorkspaceStickers(r.Context(), *p.WorkspaceID); err != nil {
			return err
		}
		if _, err := q.GetStickerPack(r.Context(), p.ID); err != nil {
			if db.IsNotFound(err) {
				return httpx.NotFound("sticker pack")
			}
			return err
		}
		inPack, err := q.CountPackStickers(r.Context(), p.ID)
		if err != nil {
			return err
		}
		if int(inPack)+len(recs) > MaxPerPack {
			return httpx.Validation("file", fmt.Sprintf("a pack holds at most %d stickers", MaxPerPack))
		}
		if lim.Stickers > 0 {
			n, err := q.CountWorkspaceStickers(r.Context(), p.WorkspaceID)
			if err != nil {
				return err
			}
			if used := uint32(max(n, 0)); used+uint32(len(recs)) > lim.Stickers { //nolint:gosec // counts ≥ 0, ≤ 50
				return planLimit("stickers", used, lim.Stickers)
			}
		}
		var total int64
		for _, rec := range recs {
			total += rec.size
		}
		if err := h.files.ReserveWorkspace(r.Context(), q, *p.WorkspaceID, total); err != nil {
			return err
		}
		pos, err := q.NextStickerPosition(r.Context(), p.ID)
		if err != nil {
			return err
		}
		ws := *p.WorkspaceID
		for i, rec := range recs {
			wd, ht := int32(rec.info.Width), int32(rec.info.Height) //nolint:gosec // 1..512
			if _, err := q.InsertFile(r.Context(), sqlc.InsertFileParams{
				ID: rec.id, WorkspaceID: &ws, UploaderID: &me, Key: rec.key, Name: rec.name, Mime: "image/webp",
				Size: rec.size, Width: &wd, Height: &ht, Sha256: rec.sha,
			}); err != nil {
				return err
			}
			s, err := q.InsertSticker(r.Context(), sqlc.InsertStickerParams{
				PackID: p.ID, FileID: &rec.id, Emoji: rec.emoji, Position: pos + int32(i), //nolint:gosec // ≤ 50
				Width: wd, Height: ht, Animated: rec.info.Animated,
			})
			if err != nil {
				return err
			}
			added = append(added, pbconv.Sticker(s, rec.size))
		}
		return q.TouchStickerPack(r.Context(), p.ID)
	})
	if err != nil {
		h.discard(recs)
		return err
	}
	pb, err := h.publishUpdate(r, p.ID)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusCreated, &v1.UploadStickersResponse{Pack: pb, Added: added})
	return nil
}

// replaceSticker: PUT /api/sticker-packs/{id}/stickers/{sid} — multipart with a new "file" (the
// same checks as an upload) and / or "emoji". The sticker keeps its id and position, so messages
// that show it show the new picture; the old file is deleted once no sticker uses it.
func (h *Handlers) replaceSticker(w http.ResponseWriter, r *http.Request) error {
	p, err := h.loadPack(r)
	if err != nil {
		return err
	}
	sid, err := httpx.PathUUID(r, "sid", "sticker")
	if err != nil {
		return err
	}
	old, err := h.db.Q.GetSticker(r.Context(), sid)
	if db.IsNotFound(err) || (err == nil && old.Sticker.PackID != p.ID) {
		return httpx.NotFound("sticker")
	}
	if err != nil {
		return err
	}
	if h.limiter != nil {
		if err := h.limiter.Take(r.Context(), p.WorkspaceID.String()+":"+uid(r).String()); err != nil {
			return err
		}
	}
	rec, rawEmoji, err := h.readReplacement(w, r, *p.WorkspaceID)
	var recs []received
	if rec != nil {
		recs = []received{*rec}
	}
	if err != nil {
		h.discard(recs)
		return err
	}
	var em string
	if rawEmoji != nil {
		if em, err = validEmoji("emoji", *rawEmoji); err != nil {
			h.discard(recs)
			return err
		}
	}
	if rec == nil && rawEmoji == nil {
		return httpx.Validation("file", `expected a "file" and / or an "emoji" field`)
	}
	me := uid(r)
	err = h.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		if err := q.LockWorkspaceStickers(r.Context(), *p.WorkspaceID); err != nil {
			return err
		}
		cur, err := q.GetSticker(r.Context(), sid)
		if db.IsNotFound(err) || (err == nil && cur.Sticker.PackID != p.ID) {
			return httpx.NotFound("sticker")
		}
		if err != nil {
			return err
		}
		if rec != nil {
			if err := h.files.ReserveWorkspace(r.Context(), q, *p.WorkspaceID, rec.size); err != nil {
				return err
			}
			ws := *p.WorkspaceID
			wd, ht := int32(rec.info.Width), int32(rec.info.Height) //nolint:gosec // 1..512
			if _, err := q.InsertFile(r.Context(), sqlc.InsertFileParams{
				ID: rec.id, WorkspaceID: &ws, UploaderID: &me, Key: rec.key, Name: rec.name, Mime: "image/webp",
				Size: rec.size, Width: &wd, Height: &ht, Sha256: rec.sha,
			}); err != nil {
				return err
			}
			if _, err := q.ReplaceStickerFile(r.Context(), sqlc.ReplaceStickerFileParams{
				ID: sid, FileID: &rec.id, Width: wd, Height: ht, Animated: rec.info.Animated,
			}); err != nil {
				return err
			}
		}
		if rawEmoji != nil {
			if err := q.UpdateStickerEmoji(r.Context(), sqlc.UpdateStickerEmojiParams{ID: sid, Emoji: em}); err != nil {
				return err
			}
		}
		return q.TouchStickerPack(r.Context(), p.ID)
	})
	if err != nil {
		h.discard(recs)
		return err
	}
	if rec != nil {
		h.dropStickerFile(r.Context(), *old.Sticker.FileID)
	}
	pb, err := h.publishUpdate(r, p.ID)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.StickerPackResponse{Pack: pb})
	return nil
}

// readReplacement reads the multipart body of a replacement: at most one "file" (validated and
// stored) and an "emoji" field (returned raw, nil when absent).
func (h *Handlers) readReplacement(w http.ResponseWriter, r *http.Request, wsID uuid.UUID) (*received, *string, error) {
	_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(uploadDeadline))
	r.Body = http.MaxBytesReader(w, r.Body, MaxAnimatedBytes+64<<10)
	mr, err := r.MultipartReader()
	if err != nil {
		return nil, nil, httpx.BadRequest(`expected multipart/form-data with "file" and / or "emoji" fields`)
	}
	var (
		rec   *received
		emoji *string
	)
	for {
		part, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return rec, nil, httpx.BadRequest("malformed multipart body")
		}
		switch part.FormName() {
		case "emoji":
			b, _ := io.ReadAll(io.LimitReader(part, maxEmojiField+1))
			e := string(b)
			emoji = &e
		case "file":
			if rec != nil {
				_ = part.Close()
				return rec, nil, httpx.Validation("file", "one file per replacement")
			}
			got, err := h.storeFile(r.Context(), part, wsID, "file")
			_ = part.Close()
			if err != nil {
				return rec, nil, err
			}
			rec = &got
		}
		_ = part.Close()
	}
	return rec, emoji, nil
}

// dropStickerFile deletes a replaced sticker's file when no sticker uses it any more (messages
// point at stickers, not files). A failure only leaves it to the orphan cleanup.
func (h *Handlers) dropStickerFile(ctx context.Context, fileID uuid.UUID) {
	if _, err := h.db.Q.GetStickerFileWorkspace(ctx, fileID); !db.IsNotFound(err) {
		return
	}
	if err := h.files.DeleteFile(ctx, fileID); err != nil {
		slog.WarnContext(ctx, "delete replaced sticker file", "file", fileID, "err", err)
	}
}

// loadSticker returns a live sticker after checking that the caller manages its workspace.
func (h *Handlers) loadSticker(r *http.Request) (sqlc.GetStickerRow, error) {
	id, err := httpx.PathUUID(r, "id", "sticker")
	if err != nil {
		return sqlc.GetStickerRow{}, err
	}
	s, err := h.db.Q.GetSticker(r.Context(), id)
	if db.IsNotFound(err) {
		return s, httpx.NotFound("sticker")
	}
	if err != nil {
		return s, err
	}
	if s.WorkspaceID == uuid.Nil {
		return s, httpx.Forbidden("built-in sticker is read-only")
	}
	if _, err := member(r, s.WorkspaceID); err != nil {
		return s, httpx.NotFound("sticker")
	}
	return s, h.manager(r, s.WorkspaceID)
}

func (h *Handlers) updateSticker(w http.ResponseWriter, r *http.Request) error {
	s, err := h.loadSticker(r)
	if err != nil {
		return err
	}
	var req v1.UpdateStickerRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	em, err := validEmoji("emoji", req.GetEmoji())
	if err != nil {
		return err
	}
	err = h.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		if err := q.UpdateStickerEmoji(r.Context(), sqlc.UpdateStickerEmojiParams{ID: s.Sticker.ID, Emoji: em}); err != nil {
			return err
		}
		return q.TouchStickerPack(r.Context(), s.Sticker.PackID)
	})
	if err != nil {
		return err
	}
	pb, err := h.publishUpdate(r, s.Sticker.PackID)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.StickerPackResponse{Pack: pb})
	return nil
}

func (h *Handlers) deleteSticker(w http.ResponseWriter, r *http.Request) error {
	s, err := h.loadSticker(r)
	if err != nil {
		return err
	}
	err = h.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		n, err := q.DeleteStickerIfUnreferenced(r.Context(), s.Sticker.ID)
		if err != nil {
			return err
		}
		if n == 0 { // messages show it: keep it for the history
			if err := q.SoftDeleteSticker(r.Context(), s.Sticker.ID); err != nil {
				return err
			}
			p, err := q.GetStickerPack(r.Context(), s.Sticker.PackID)
			if err != nil {
				return err
			}
			if p.CoverStickerID != nil && *p.CoverStickerID == s.Sticker.ID {
				if _, err := q.UpdateStickerPack(r.Context(), sqlc.UpdateStickerPackParams{ID: p.ID, SetCover: true}); err != nil {
					return err
				}
			}
		}
		return q.TouchStickerPack(r.Context(), s.Sticker.PackID)
	})
	if err != nil {
		return err
	}
	pb, err := h.publishUpdate(r, s.Sticker.PackID)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.StickerPackResponse{Pack: pb})
	return nil
}

// ---- the caller's installed packs

func (h *Handlers) myPacks(ctx context.Context, user uuid.UUID) (*v1.MyStickerPacksResponse, error) {
	inst, err := h.db.Q.ListUserStickerPacks(ctx, user)
	if err != nil {
		return nil, err
	}
	avail, err := h.db.Q.ListAvailableStickerPacks(ctx, user)
	if err != nil {
		return nil, err
	}
	filter := func(rows []sqlc.StickerPack) ([]sqlc.StickerPack, error) {
		visible := rows[:0]
		for _, row := range rows {
			if row.WorkspaceID == nil {
				continue
			}
			if err := perm.CheckAccess(ctx, *row.WorkspaceID, user); err == nil {
				visible = append(visible, row)
			} else if httpx.AsError(err).Status >= 500 {
				return nil, err
			}
		}
		return visible, nil
	}
	if inst, err = filter(inst); err != nil {
		return nil, err
	}
	if avail, err = filter(avail); err != nil {
		return nil, err
	}
	all, err := withStickers(ctx, h.db.Q, append(append([]sqlc.StickerPack{}, inst...), avail...))
	if err != nil {
		return nil, err
	}
	return &v1.MyStickerPacksResponse{Installed: append([]*v1.StickerPack{builtinstickers.Pack()}, all[:len(inst)]...), Available: all[len(inst):]}, nil
}

func (h *Handlers) writeMine(w http.ResponseWriter, r *http.Request) error {
	out, err := h.myPacks(r.Context(), uid(r))
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

func (h *Handlers) mine(w http.ResponseWriter, r *http.Request) error { return h.writeMine(w, r) }

func (h *Handlers) install(w http.ResponseWriter, r *http.Request) error {
	id, err := httpx.PathUUID(r, "id", "sticker pack")
	if err != nil {
		return err
	}
	p, err := h.db.Q.GetStickerPack(r.Context(), id)
	if db.IsNotFound(err) {
		return httpx.NotFound("sticker pack")
	}
	if err != nil {
		return err
	}
	if p.WorkspaceID == nil {
		return httpx.Forbidden("built-in sticker pack is already available")
	}
	// Guests only look at stickers (ADR-0030 §4); a pack of a foreign workspace stays hidden.
	m, err := perm.FromContext(r.Context()).Member(r.Context(), *p.WorkspaceID, uid(r))
	if errors.Is(err, perm.ErrNotMember) || (err == nil && m.Role == perm.RoleGuest) {
		return httpx.NotFound("sticker pack")
	}
	if err != nil {
		return err
	}
	n, err := h.db.Q.CountUserStickerPacks(r.Context(), uid(r))
	if err != nil {
		return err
	}
	if n >= MaxInstalled {
		return httpx.Validation("id", fmt.Sprintf("at most %d installed sticker packs", MaxInstalled))
	}
	if _, err := db.GuardValue(r.Context(), h.db, func(guarded *sqlc.Queries) (int64, error) {
		return guarded.InstallStickerPack(r.Context(), sqlc.InstallStickerPackParams{UserID: uid(r), PackID: p.ID})
	}); err != nil {
		return err
	}
	return h.writeMine(w, r)
}

func (h *Handlers) uninstall(w http.ResponseWriter, r *http.Request) error {
	id, err := httpx.PathUUID(r, "id", "sticker pack")
	if err != nil {
		return err
	}
	if id.String() == builtinstickers.PackID() {
		return httpx.Forbidden("built-in sticker pack cannot be removed")
	}
	if _, err := db.GuardValue(r.Context(), h.db, func(guarded *sqlc.Queries) (int64, error) {
		return guarded.UninstallStickerPack(r.Context(), sqlc.UninstallStickerPackParams{UserID: uid(r), PackID: id})
	}); err != nil {
		return err
	}
	return h.writeMine(w, r)
}

func (h *Handlers) order(w http.ResponseWriter, r *http.Request) error {
	var req v1.SetStickerPackOrderRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	have, err := h.db.Q.ListUserStickerPackIDs(r.Context(), uid(r))
	if err != nil {
		return err
	}
	mine := map[uuid.UUID]bool{}
	for _, id := range have {
		mine[id] = true
	}
	seen := map[uuid.UUID]bool{}
	ids := make([]uuid.UUID, 0, len(req.GetPackIds()))
	for _, s := range req.GetPackIds() {
		id, err := uuid.Parse(s)
		// Clients before ADR-0057 list the built-in pack they received in installed; it has
		// a fixed place, so it is skipped rather than failing their reorder.
		if err == nil && id.String() == builtinstickers.PackID() && !seen[id] {
			seen[id] = true
			continue
		}
		if err != nil || !mine[id] || seen[id] {
			return httpx.Validation("packIds", "must list every installed pack once")
		}
		seen[id] = true
		ids = append(ids, id)
	}
	if len(ids) != len(have) {
		return httpx.Validation("packIds", "must list every installed pack once")
	}
	if err := db.GuardExec(r.Context(), h.db, func(guarded *sqlc.Queries) error {
		return guarded.SetUserStickerPackOrder(r.Context(), sqlc.SetUserStickerPackOrderParams{UserID: uid(r), PackIds: ids})
	}); err != nil {
		return err
	}
	return h.writeMine(w, r)
}

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

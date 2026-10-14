package workspaces

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/files"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/pbconv"
)

// Camera backgrounds of a workspace (ADR-0035, addendum 2026-09-29): pictures an admin adds for
// everyone's camera preview. The model follows the badges (badges.go) but with MANAGE_WORKSPACE (appearance, ADR-0048), the
// picture from the caller's own upload; the server makes the 1280×720 WebP itself.
const (
	MaxBackgrounds       = 20
	maxBackgroundNameLen = 40
)

// WithFiles sets the file service the camera backgrounds store their pictures with.
func (h *Handlers) WithFiles(fs *files.Service) *Handlers {
	h.files = fs
	return h
}

func (h *Handlers) backgroundRoutes(handle func(string, httpx.HandlerFunc)) {
	handle("GET /api/workspaces/{id}/backgrounds", h.listBackgrounds)
	handle("POST /api/workspaces/{id}/backgrounds", h.createBackground)
	handle("PATCH /api/workspaces/{id}/backgrounds/{bgId}", h.updateBackground)
	handle("DELETE /api/workspaces/{id}/backgrounds/{bgId}", h.deleteBackground)
}

// backgroundName: 1..40 characters after trimming, no control characters.
func backgroundName(s string) (string, error) {
	s = strings.TrimSpace(s)
	if n := utf8.RuneCountInString(s); n < 1 || n > maxBackgroundNameLen || strings.IndexFunc(s, unicode.IsControl) >= 0 {
		return "", httpx.Validation("name", "name must be 1.."+strconv.Itoa(maxBackgroundNameLen)+" characters without control characters")
	}
	return s, nil
}

// backgroundSource checks the upload a background is made from: an image the caller uploaded to
// this workspace (JPEG / PNG / WebP, ≤ 10 MB, dimensions known at upload), not a sticker's file
// (the badge rule: a file of someone else — e.g. an attachment of a restricted room — must not
// be copied into a picture every member reads).
func backgroundSource(ctx context.Context, q *sqlc.Queries, wsID, caller uuid.UUID, raw string) (sqlc.File, error) {
	bad := httpx.Validation("fileId", "a JPEG, PNG or WebP image you uploaded to this workspace, at most 10 MB")
	id, err := uuid.Parse(raw)
	if err != nil {
		return sqlc.File{}, bad
	}
	f, err := q.GetFile(ctx, id)
	if db.IsNotFound(err) {
		return f, bad
	}
	if err != nil {
		return f, err
	}
	switch {
	case f.WorkspaceID == nil || *f.WorkspaceID != wsID || (f.UploaderID == nil || *f.UploaderID != caller):
		return f, bad
	case f.Mime != "image/png" && f.Mime != "image/webp" && f.Mime != "image/jpeg":
		return f, bad
	case f.Size > files.MaxBackgroundSourceBytes:
		return f, bad
	case f.Width == nil || f.Height == nil || *f.Width < 1 || *f.Height < 1 || int64(*f.Width)*int64(*f.Height) > files.MaxPixels:
		return f, bad
	}
	if _, err := q.GetStickerFileWorkspace(ctx, id); err == nil {
		return f, bad
	} else if !db.IsNotFound(err) {
		return f, err
	}
	return f, nil
}

func loadBackground(r *http.Request, q *sqlc.Queries, wsID uuid.UUID) (sqlc.WorkspaceBackground, error) {
	id, err := httpx.PathUUID(r, "bgId", "background")
	if err != nil {
		return sqlc.WorkspaceBackground{}, err
	}
	b, err := q.GetWorkspaceBackground(r.Context(), sqlc.GetWorkspaceBackgroundParams{ID: id, WorkspaceID: wsID})
	if db.IsNotFound(err) {
		return b, httpx.NotFound("background")
	}
	return b, err
}

func tooManyBackgrounds() error {
	return httpx.Conflict("a workspace has at most " + strconv.Itoa(MaxBackgrounds) + " camera backgrounds")
}

// listBackgrounds: GET /api/workspaces/{id}/backgrounds (any member, guests too).
func (h *Handlers) listBackgrounds(w http.ResponseWriter, r *http.Request) error {
	wsID, _, _, err := access(r)
	if err != nil {
		return err
	}
	rows, err := h.db.Q.ListWorkspaceBackgrounds(r.Context(), wsID)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.ListBackgroundsResponse{Backgrounds: pbconv.Backgrounds(rows)})
	return nil
}

// createBackground: POST /api/workspaces/{id}/backgrounds (MANAGE_WORKSPACE): the picture is made
// from the caller's upload before the transaction (decoding is slow), then counted in the quota.
func (h *Handlers) createBackground(w http.ResponseWriter, r *http.Request) error {
	wsID, _, err := requireManage(r)
	if err != nil {
		return err
	}
	if h.files == nil {
		return errors.New("workspaces: no file service for camera backgrounds")
	}
	var req v1.CreateBackgroundRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	name, err := backgroundName(req.GetName())
	if err != nil {
		return err
	}
	// A cheap early refusal: no decoding when the list is full (checked again under the lock).
	if n, err := h.db.Q.CountWorkspaceBackgrounds(r.Context(), wsID); err != nil {
		return err
	} else if n >= MaxBackgrounds {
		return tooManyBackgrounds()
	}
	src, err := backgroundSource(r.Context(), h.db.Q, wsID, uid(r), req.GetFileId())
	if err != nil {
		return err
	}
	prep, err := h.files.PrepareBackground(r.Context(), src)
	if files.IsBadImage(err) {
		return httpx.Validation("fileId", "the picture could not be read as an image")
	}
	if err != nil {
		return err
	}
	var created sqlc.WorkspaceBackground
	err = h.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		if err := q.LockWorkspaceBackgrounds(r.Context(), wsID); err != nil {
			return err
		}
		n, err := q.CountWorkspaceBackgrounds(r.Context(), wsID)
		if err != nil {
			return err
		}
		if n >= MaxBackgrounds {
			return tooManyBackgrounds()
		}
		f, err := h.files.InsertPrepared(r.Context(), q, prep)
		if err != nil {
			return err
		}
		created, err = q.InsertWorkspaceBackground(r.Context(), sqlc.InsertWorkspaceBackgroundParams{WorkspaceID: wsID, Name: name, FileID: f.ID})
		return err
	})
	if err != nil {
		h.files.Discard(prep)
		return err
	}
	// The upload it was made from stays unattached and goes with the orphan cleanup.
	h.events.Workspace(r.Context(), wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_BackgroundCreate{
		BackgroundCreate: &v1.BackgroundCreate{Background: pbconv.Background(created)},
	}})
	httpx.Write(w, http.StatusCreated, &v1.CreateBackgroundResponse{Background: pbconv.Background(created)})
	return nil
}

// updateBackground: PATCH /api/workspaces/{id}/backgrounds/{bgId} (MANAGE_WORKSPACE): rename.
func (h *Handlers) updateBackground(w http.ResponseWriter, r *http.Request) error {
	wsID, _, err := requireManage(r)
	if err != nil {
		return err
	}
	var req v1.UpdateBackgroundRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	cur, err := loadBackground(r, h.db.Q, wsID)
	if err != nil {
		return err
	}
	if req.Name == nil {
		httpx.Write(w, http.StatusOK, &v1.UpdateBackgroundResponse{Background: pbconv.Background(cur)})
		return nil
	}
	name, err := backgroundName(req.GetName())
	if err != nil {
		return err
	}
	updated, err := db.GuardValue(r.Context(), h.db, func(guarded *sqlc.Queries) (sqlc.WorkspaceBackground, error) {
		return guarded.RenameWorkspaceBackground(r.Context(), sqlc.RenameWorkspaceBackgroundParams{ID: cur.ID, WorkspaceID: wsID, Name: name})
	})
	if db.IsNotFound(err) {
		return httpx.NotFound("background")
	}
	if err != nil {
		return err
	}
	h.events.Workspace(r.Context(), wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_BackgroundUpdate{
		BackgroundUpdate: &v1.BackgroundUpdate{Background: pbconv.Background(updated)},
	}})
	httpx.Write(w, http.StatusOK, &v1.UpdateBackgroundResponse{Background: pbconv.Background(updated)})
	return nil
}

// deleteBackground: DELETE /api/workspaces/{id}/backgrounds/{bgId} (MANAGE_WORKSPACE): only the
// row goes; its picture is left to the orphan cleanup, clients that chose it reset to none.
func (h *Handlers) deleteBackground(w http.ResponseWriter, r *http.Request) error {
	wsID, _, err := requireManage(r)
	if err != nil {
		return err
	}
	cur, err := loadBackground(r, h.db.Q, wsID)
	if err != nil {
		return err
	}
	n, err := db.GuardValue(r.Context(), h.db, func(guarded *sqlc.Queries) (int64, error) {
		return guarded.DeleteWorkspaceBackground(r.Context(), sqlc.DeleteWorkspaceBackgroundParams{ID: cur.ID, WorkspaceID: wsID})
	})
	if err != nil {
		return err
	}
	if n == 0 {
		return httpx.NotFound("background")
	}
	h.events.Workspace(r.Context(), wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_BackgroundDelete{
		BackgroundDelete: &v1.BackgroundDelete{WorkspaceId: wsID.String(), BackgroundId: cur.ID.String()},
	}})
	httpx.NoContent(w)
	return nil
}

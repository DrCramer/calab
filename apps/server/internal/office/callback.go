package office

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/httpx"
)

// file: GET /api/office/file/{token} — the Document Server downloads the version the session
// stands on (or an attachment). Our URL token (short-lived, pinned to the file) and the
// Document Server's JWT in the Authorization header (operation "download") both have to pass.
func (s *Service) file(w http.ResponseWriter, r *http.Request) error {
	claims, err := parseInbound(s.cfg.Secret, bearer(r))
	if err != nil || checkOperation(claims, "download") != nil {
		return httpx.Unauthenticated("document server token")
	}
	raw := r.PathValue("token")
	var fileID uuid.UUID
	if t, err := parseURL(s.cfg.URLKey, opFile, raw, s.Now()); err == nil {
		if err := s.limit(r.Context(), t.Subject); err != nil {
			return err
		}
		it, err := s.store.Item(r.Context(), t.Subject)
		if errors.Is(err, ErrNotFound) {
			return httpx.NotFound("file")
		}
		if err != nil {
			return err
		}
		if it.FileID != t.FileID {
			// The item moved on (a save in between): the Document Server asks again with a fresh
			// configuration; serving the old bytes would start a session on stale content.
			return httpx.Coded(http.StatusGone, v1.ErrorCode_ERROR_CODE_FILE_GONE, "the file has a newer version")
		}
		fileID = t.FileID
	} else if t, err := parseURL(s.cfg.URLKey, opAttach, raw, s.Now()); err == nil {
		if err := s.limit(r.Context(), t.Subject); err != nil {
			return err
		}
		fileID = t.Subject
	} else {
		return httpx.NotFound("file")
	}
	rc, size, err := s.store.OpenFile(r.Context(), fileID)
	if errors.Is(err, ErrNotFound) {
		return httpx.NotFound("file")
	}
	if err != nil {
		return err
	}
	defer func() { _ = rc.Close() }()
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	w.Header().Set("Cache-Control", "no-store")
	_, err = io.Copy(w, rc)
	return err
}

// limit takes the Document Server's budget of one item (file / callback requests).
func (s *Service) limit(ctx context.Context, id uuid.UUID) error {
	if s.DocsLimit == nil {
		return nil
	}
	return s.DocsLimit.Take(ctx, id.String())
}

// Callback statuses (api.onlyoffice.com «Callback handler»).
const (
	StatusEditing     = 1 // users connected / disconnected
	StatusSave        = 2 // everyone closed, ready for saving (≈10 s after the last close)
	StatusSaveError   = 3
	StatusClosed      = 4 // closed with no changes
	StatusForceSave   = 6 // forcesave: saved while the editing continues; the key must not change
	StatusForceSaveEr = 7
)

// cbBody is the callback body (the Document Server's token payload is authoritative).
type cbBody struct {
	Key           string   `json:"key"`
	Status        int      `json:"status"`
	URL           string   `json:"url"`
	FileType      string   `json:"filetype"`
	Users         []string `json:"users"`
	ForceSaveType *int     `json:"forcesavetype"`
}

// callback: POST /api/office/callback/{token}. The answer is always {"error":0} (handled or
// nothing to do) or {"error":1} (refused: the Document Server keeps the changes and shows the
// user a save error) — never an HTTP error, which the Document Server would retry blindly.
func (s *Service) callback(w http.ResponseWriter, r *http.Request) {
	code := 0
	if !s.cfg.Enabled {
		code = 1
	} else if err := s.handleCallback(r); err != nil {
		code = 1
		slog.WarnContext(r.Context(), "office: callback refused", "err", err)
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = fmt.Fprintf(w, `{"error":%d}`, code)
}

var (
	errStaleKey  = errors.New("office: stale or unknown session key")
	errNoRight   = errors.New("office: the editor has no DISK_WRITE on the item any more")
	errBadSource = errors.New("office: the saved file is not on the Document Server")
	errFileType  = errors.New("office: the saved file changed its type")
	errTooLarge  = errors.New("office: the saved file is too large")
	errMediaType = errors.New("office: the saved file has a wrong content type")
)

func (s *Service) handleCallback(r *http.Request) error {
	ctx := r.Context()
	t, err := parseURL(s.cfg.URLKey, opCallback, r.PathValue("token"), s.Now())
	if err != nil {
		return fmt.Errorf("url token: %w", err)
	}
	itemID := t.Subject
	if err := s.limit(ctx, itemID); err != nil {
		return err
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		return err
	}
	b, err := s.verifyBody(r, raw)
	if err != nil {
		return err
	}
	if b.Key != t.Key {
		return errStaleKey // another session's URL
	}
	sess, ok, err := s.sessions.Get(ctx, itemID)
	if err != nil {
		return err
	}
	if !ok || sess.Key != b.Key {
		if b.Status == StatusSave || b.Status == StatusForceSave {
			return errStaleKey // a late save of an ended session: never over a newer version
		}
		return nil
	}
	users := userIDs(b.Users)
	slog.InfoContext(ctx, "office: callback", "item", itemID, "key", b.Key, "status", b.Status, "users", users)
	switch b.Status {
	case StatusEditing:
		changed, err := s.sessions.Online(ctx, itemID, b.Key, users)
		if err != nil {
			return err
		}
		if changed {
			s.announce(ctx, itemID)
			s.recheck(ctx, itemID) // somebody joined: their access as of now
		}
		return nil
	case StatusClosed:
		if err := s.sessions.End(ctx, itemID, b.Key); err != nil {
			return err
		}
		s.announce(ctx, itemID)
		return nil
	case StatusSaveError, StatusForceSaveEr:
		slog.WarnContext(ctx, "office: document server save error", "item", itemID, "status", b.Status)
		return nil
	case StatusSave, StatusForceSave:
		it, err := s.save(ctx, itemID, sess, b)
		if errors.Is(err, ErrNotFound) && b.Status == StatusSave {
			_ = s.sessions.End(ctx, itemID, b.Key) // deleted forever: nothing to save into
			s.announce(ctx, itemID)
		}
		if err != nil {
			return err
		}
		if b.Status == StatusForceSave {
			_, err = s.sessions.Advance(ctx, itemID, b.Key, it.FileID)
			return err
		}
		err = s.sessions.End(ctx, itemID, b.Key)
		s.announce(ctx, itemID)
		return err
	}
	return nil
}

func (s *Service) announce(ctx context.Context, item uuid.UUID) {
	if s.Announce == nil {
		return
	}
	if err := s.Announce.Announce(context.WithoutCancel(ctx), item); err != nil {
		slog.WarnContext(ctx, "office: announce", "item", item, "err", err)
	}
}

// verifyBody checks the Document Server's JWT — the Authorization header (claims.payload is the
// body) or the body's "token" (the claims are the body) — and returns the signed body.
func (s *Service) verifyBody(r *http.Request, raw []byte) (cbBody, error) {
	var b cbBody
	var claims jwt.MapClaims
	var err error
	if tok := bearer(r); tok != "" {
		if claims, err = parseInbound(s.cfg.Secret, tok); err != nil {
			return b, fmt.Errorf("header token: %w", err)
		}
		if err := checkOperation(claims, "callback"); err != nil {
			return b, err
		}
		if p := nested(claims); p != nil {
			claims = p
		}
	} else {
		var withTok struct {
			Token string `json:"token"`
		}
		if json.Unmarshal(raw, &withTok) != nil || withTok.Token == "" {
			return b, errors.New("office: callback without a token")
		}
		if claims, err = parseInbound(s.cfg.Secret, withTok.Token); err != nil {
			return b, fmt.Errorf("body token: %w", err)
		}
	}
	if err := checkOperation(claims, "callback"); err != nil {
		return b, err
	}
	signed, err := json.Marshal(claims)
	if err != nil {
		return b, err
	}
	if err := json.Unmarshal(signed, &b); err != nil {
		return b, err
	}
	if b.Key == "" {
		return b, errors.New("office: callback without a key")
	}
	return b, nil
}

// save downloads the saved file from the Document Server and stores it as the item's new
// version on the session's file: the item's current file must still be the session's
// (ErrConflict otherwise), its format still one edited in place, the bytes of that format, and
// the editor who sent the changes must still have DISK_WRITE.
func (s *Service) save(ctx context.Context, itemID uuid.UUID, sess Session, b cbBody) (Item, error) {
	cur, err := s.store.Item(ctx, itemID)
	if err != nil {
		return Item{}, err
	}
	f, ok := FormatOf(cur.Name)
	if !ok || f.Cap != capEdit {
		return Item{}, errFileType // renamed to another type meanwhile: never written in place
	}
	if b.FileType != "" && !strings.EqualFold(b.FileType, f.Ext) {
		return Item{}, errFileType
	}
	// The first user of a save is the one who sent the last changes; a save nobody can be
	// held to (no user of ours) is refused like one by a member who lost «Правка».
	ids := userIDs(b.Users)
	if len(ids) == 0 {
		return Item{}, errNoRight
	}
	actor := ids[0]
	if it, err := s.store.ItemFor(ctx, actor, itemID); err != nil || Mode(it, f, false) != v1.OfficeMode_OFFICE_MODE_EDIT {
		return Item{}, errNoRight
	}
	body, err := s.fetch(ctx, b.URL)
	if err != nil {
		return Item{}, err
	}
	if err := f.Check(body); err != nil {
		return Item{}, err
	}
	it, err := s.store.SaveVersion(ctx, itemID, sess.FileID, actor, f, body)
	if err != nil {
		return it, err
	}
	slog.InfoContext(ctx, "office: saved", "item", itemID, "actor", actor, "status", b.Status, "file", it.FileID, "size", it.Size, "sha256", it.Sha256)
	return it, nil
}

// okMedia: what the Document Server serves saved and converted files as.
func okMedia(ct string) bool {
	if ct == "" {
		return true
	}
	mt, _, err := mime.ParseMediaType(ct)
	if err != nil {
		return false
	}
	switch {
	case mt == "application/octet-stream", mt == "application/zip", mt == "application/rtf", mt == "text/rtf",
		mt == "text/plain", mt == "text/csv",
		strings.HasPrefix(mt, "application/vnd.openxmlformats-officedocument."),
		strings.HasPrefix(mt, "application/vnd.oasis.opendocument."):
		return true
	}
	return false
}

// fetch reads a file the Document Server produced: only from its configured origin (through
// DocsInternalURL), no redirects, 200 only, a file content type, at most MaxSize bytes.
func (s *Service) fetch(ctx context.Context, raw string) ([]byte, error) {
	u := s.internalURL(raw)
	if u == "" {
		return nil, errBadSource
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	res, err := s.HTTP.Do(req)
	if err != nil {
		return nil, redactURL(err)
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("office: document server answered %d", res.StatusCode)
	}
	if !okMedia(res.Header.Get("Content-Type")) {
		return nil, errMediaType
	}
	if res.ContentLength > s.cfg.MaxSize {
		return nil, errTooLarge
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, s.cfg.MaxSize+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > s.cfg.MaxSize {
		return nil, errTooLarge
	}
	return body, nil
}

// redactURL drops the URL from a transport error: the Document Server's links to saved and
// converted files are signed capabilities and do not belong in the logs.
func redactURL(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		return fmt.Errorf("office: document server request (%s): %w", ue.Op, ue.Err)
	}
	return err
}

// userIDs parses the editor ids of a callback (ours are user uuids; others are dropped).
func userIDs(users []string) []uuid.UUID {
	out := make([]uuid.UUID, 0, len(users))
	for _, u := range users {
		if id, err := uuid.Parse(u); err == nil {
			out = append(out, id)
		}
	}
	return out
}

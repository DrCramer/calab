// Package office opens Disk files and attachments in ONLYOFFICE Docs (ADR-0143, off by default:
// OFFICE_ENABLED). The editing and the recalculation run in the user's browser; this package
//
//   - answers the format map (GET /api/office/capabilities, formats.go: the only list of what
//     opens and how);
//   - signs the editor configuration (GET /api/office/config): the mode follows the format and
//     the Disk bits (DISK_WRITE edits, DISK_VIEW views); attachments (?file=) always view; the
//     co-editing key is shared by everyone who opens the item until its session ends;
//   - hands the file to the Document Server by a short-lived signed URL
//     (GET /api/office/file/{token}), pinned to the file version the session stands on;
//   - stores what the Document Server sends back (POST /api/office/callback/{token}, statuses 2
//     and 6) as a new version of the same Disk item (disk.SaveVersion): same id, path and name,
//     new file row, sha256, size and updated_at at once;
//   - converts a legacy format into a NEW item (POST …/office/convert, «Сохранить как»);
//   - keeps the live sessions in Valkey (sessions.go) and drops editors who lost access.
//
// Requests from the Document Server carry its JWT (HS256, the shared OFFICE_JWT_SECRET); the
// file and callback URLs carry our own token (a key derived from the API's JWT_SECRET), so
// neither secret alone mints the other side's requests.
package office

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/perm"
)

// Config is the env configuration (internal/config: OFFICE_*).
type Config struct {
	// Enabled is OFFICE_ENABLED: off, every route answers 404 and capabilities enabled=false.
	Enabled bool
	// DocsURL is the Document Server origin the browser loads the editor from.
	DocsURL string
	// DocsInternalURL is how the API reaches the Document Server (saved files, /converter,
	// /command); the download URL of a callback must be on DocsURL or DocsInternalURL and is
	// fetched through DocsInternalURL. Empty = DocsURL.
	DocsInternalURL string
	// APIURL is how the Document Server reaches the API: the file and callback URLs it gets.
	APIURL string
	// Secret is the Document Server's JWT secret (JWT_SECRET of its container).
	Secret []byte
	// URLKey signs our file and callback URLs (derived from the API's JWT_SECRET).
	URLKey []byte
	// ThemeDark and ThemeLight are the editor's uiTheme for the app's themes.
	ThemeDark, ThemeLight string
	// FileURLTTL bounds the file URL (the Document Server fetches it at once). 0 = 5 min.
	FileURLTTL time.Duration
	// MaxSize bounds a file that opens and a saved file. 0 = 100 MiB.
	MaxSize int64
	// SessionTTL is how long a session lives in Valkey without a callback or an open. 0 = 24 h.
	SessionTTL time.Duration
}

// Item is a Disk file as this package needs it.
type Item struct {
	ID, WorkspaceID, FileID uuid.UUID
	ParentID                *uuid.UUID
	Name                    string
	Size                    int64
	Sha256                  string
	// Bits are the caller's bits on the item (ItemFor only).
	Bits perm.Bits
	// Trashed items open read-only; ReadOnly is a workspace that takes no writes (suspended,
	// the plan's restricted mode).
	Trashed, ReadOnly bool
}

// File is an attachment (a files row the caller may read).
type File struct {
	ID          uuid.UUID
	WorkspaceID *uuid.UUID
	Name        string
	Size        int64
	Sha256      string
}

// Store is the storage side (DiskStore over internal/disk + internal/files; fakes in the tests).
type Store interface {
	// ItemFor resolves a Disk file as the member uid sees it: ErrNotFound without DISK_VIEW. ctx
	// carries the request's access policy when there is one (identity scope).
	ItemFor(ctx context.Context, uid, itemID uuid.UUID) (Item, error)
	// Item resolves a Disk file without a caller (requests of the Document Server).
	Item(ctx context.Context, itemID uuid.UUID) (Item, error)
	// FileFor resolves an attachment the caller of r may read (files.CanRead): ErrNotFound else.
	FileFor(r *http.Request, fileID uuid.UUID) (File, error)
	// OpenFile streams one stored file (a version pinned by id, or an attachment).
	OpenFile(ctx context.Context, fileID uuid.UUID) (io.ReadCloser, int64, error)
	// SaveVersion stores body (validated as format f) as the item's new file if its current
	// file is still expect (ErrConflict otherwise, ErrNotFound when the item is gone): the item
	// keeps its id, parent and name; the previous file stays as a version in «История»; actor
	// is the editor who sent the changes.
	SaveVersion(ctx context.Context, itemID, expect, actor uuid.UUID, f Format, body []byte) (Item, error)
	// AddFile stores body as a new Disk item named name in folder parent of workspace ws for the
	// caller of r (DISK_WRITE on the folder): «Сохранить как».
	AddFile(r *http.Request, ws uuid.UUID, parent *uuid.UUID, name string, f Format, body []byte) (*v1.DiskItem, error)
	// LastVersion is the file the item's current file replaced (uuid.Nil: no versions).
	LastVersion(ctx context.Context, itemID uuid.UUID) (uuid.UUID, error)
	// DisplayName is the user's name shown to co-editors.
	DisplayName(ctx context.Context, uid uuid.UUID) (string, error)
}

// Session is the live co-editing session of an item.
type Session struct {
	// Key is the Document Server's document.key: everyone who opens the item joins it.
	Key string
	// FileID is the file the session's edits stand on: the file at its start, then the one
	// each forcesave (status 6) stored.
	FileID uuid.UUID
	// Editors got an edit configuration of this session; Revoked got one too but were dropped
	// for losing «Правка» (still rechecked: the signed configuration they hold lets them rejoin
	// in edit mode until it expires); Viewers got a view configuration. Online are the
	// connected editors (status 1: the Document Server reports no viewers).
	Editors, Revoked, Viewers, Online []uuid.UUID
}

// Sessions keeps the live sessions (Valkey: sessions.go; fakes in the tests). Every method is
// atomic per item.
type Sessions interface {
	// Join returns the item's live session or starts s (set if absent); user is marked as one
	// who got an edit (edit) or a view configuration of it.
	Join(ctx context.Context, item uuid.UUID, s Session, user uuid.UUID, edit bool) (Session, error)
	// Get returns the item's live session.
	Get(ctx context.Context, item uuid.UUID) (Session, bool, error)
	// Advance moves the session with key onto fileID (after a forcesave); false if it is gone.
	Advance(ctx context.Context, item uuid.UUID, key string, fileID uuid.UUID) (bool, error)
	// Online records who is connected to the session with key (status 1); changed reports a
	// different set than before.
	Online(ctx context.Context, item uuid.UUID, key string, users []uuid.UUID) (changed bool, err error)
	// Revoke turns the edit mark of users into a revoked one (editors dropped for losing
	// «Правка»: no longer «editing», still rechecked).
	Revoke(ctx context.Context, item uuid.UUID, key string, users []uuid.UUID) error
	// Forget removes every mark of users (dropped for losing access to the item).
	Forget(ctx context.Context, item uuid.UUID, key string, users []uuid.UUID) error
	// End removes the session with key (compare and delete).
	End(ctx context.Context, item uuid.UUID, key string) error
	// Live lists the items with a session (the access sweep).
	Live(ctx context.Context) ([]uuid.UUID, error)
}

// Announcer tells the Disk listing who edits an item now (disk.Service.Announce).
type Announcer interface {
	Announce(ctx context.Context, item uuid.UUID) error
}

// Limiter is a per-key rate limit (redisx.RateLimiter): Take answers 429.
type Limiter interface {
	Take(ctx context.Context, key string) error
}

var (
	// ErrNotFound means no such Disk file, or the caller cannot see it.
	ErrNotFound = errors.New("office: not found")
	// ErrConflict means the item's file changed under the session (SaveVersion).
	ErrConflict = errors.New("office: the file changed")
)

// Service serves the office routes.
type Service struct {
	cfg      Config
	store    Store
	sessions Sessions
	// Announce is optional (the «Редактирует» label).
	Announce Announcer
	// ConfigLimit (per user), ConvertLimit (per user), DocsLimit (Document Server requests per
	// item: file and callback). nil = none.
	ConfigLimit, ConvertLimit, DocsLimit Limiter
	// HTTP fetches from the Document Server: saved and converted files, /converter, /command.
	// It never follows redirects.
	HTTP *http.Client
	// Now is the clock (tests move it).
	Now func() time.Time
	// ConvertPoll is the pause between /converter polls (tests shorten it).
	ConvertPoll time.Duration
}

// New creates the service.
func New(cfg Config, store Store, sessions Sessions) *Service {
	if cfg.FileURLTTL <= 0 {
		cfg.FileURLTTL = 5 * time.Minute
	}
	if cfg.MaxSize <= 0 {
		cfg.MaxSize = 100 << 20
	}
	if cfg.SessionTTL <= 0 {
		cfg.SessionTTL = 24 * time.Hour
	}
	if cfg.DocsInternalURL == "" {
		cfg.DocsInternalURL = cfg.DocsURL
	}
	if cfg.ThemeDark == "" {
		cfg.ThemeDark = "default-dark"
	}
	if cfg.ThemeLight == "" {
		cfg.ThemeLight = "default-light"
	}
	cfg.DocsURL = strings.TrimRight(cfg.DocsURL, "/")
	cfg.DocsInternalURL = strings.TrimRight(cfg.DocsInternalURL, "/")
	cfg.APIURL = strings.TrimRight(cfg.APIURL, "/")
	client := &http.Client{
		Timeout:       2 * time.Minute,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	return &Service{cfg: cfg, store: store, sessions: sessions, HTTP: client, Now: time.Now, ConvertPoll: time.Second}
}

// Routes registers the routes (always, so the route tables stay one; off = 404); wrap applies
// auth + the permission resolver. The file and callback routes are anonymous: our URL token and
// the Document Server's JWT authenticate them.
func (s *Service) Routes(mux httpx.Router, wrap func(http.Handler) http.Handler) {
	h := func(pattern string, f func(http.ResponseWriter, *http.Request) error) {
		mux.Handle(pattern, wrap(httpx.HandlerFunc(f)))
	}
	h("GET /api/office/capabilities", s.capabilities)
	h("GET /api/office/config", s.on(s.config))
	h("POST /api/disk/items/{id}/office/convert", s.on(s.convertItem))
	h("POST /api/workspaces/{id}/office/convert", s.on(s.convertFile))
	h("POST /api/workspaces/{id}/office/create", s.on(s.createFile))
	mux.Handle("GET /api/office/file/{token}", httpx.HandlerFunc(s.on(s.file)))
	mux.Handle("POST /api/office/callback/{token}", http.HandlerFunc(s.callback))
}

// on answers 404 while the feature is off.
func (s *Service) on(f func(http.ResponseWriter, *http.Request) error) func(http.ResponseWriter, *http.Request) error {
	return func(w http.ResponseWriter, r *http.Request) error {
		if !s.cfg.Enabled {
			return httpx.NotFound("office")
		}
		return f(w, r)
	}
}

// capabilities: GET /api/office/capabilities.
func (s *Service) capabilities(w http.ResponseWriter, _ *http.Request) error {
	out := &v1.OfficeCapabilitiesResponse{Enabled: s.cfg.Enabled}
	if s.cfg.Enabled {
		out.Formats, out.MaxSizeBytes, out.DocsUrl = Formats(), uint64(s.cfg.MaxSize), s.cfg.DocsURL //nolint:gosec // positive
		out.ThemeDark, out.ThemeLight = s.cfg.ThemeDark, s.cfg.ThemeLight
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// sameOrigin reports whether raw is an http(s) URL on the origin of base, without credentials.
func sameOrigin(raw, base string) bool {
	u, err := url.Parse(raw)
	b, err2 := url.Parse(base)
	if err != nil || err2 != nil || b.Host == "" {
		return false
	}
	return (u.Scheme == "http" || u.Scheme == "https") && u.Scheme == b.Scheme && strings.EqualFold(u.Host, b.Host) && u.User == nil
}

// internalURL maps a Document Server URL (on DocsURL or DocsInternalURL; "" otherwise) onto
// DocsInternalURL: the API never fetches anything but the configured Document Server.
func (s *Service) internalURL(raw string) string {
	var rest string
	switch {
	case sameOrigin(raw, s.cfg.DocsInternalURL):
		return raw
	case sameOrigin(raw, s.cfg.DocsURL):
		u, _ := url.Parse(raw)
		rest = u.EscapedPath()
		if u.RawQuery != "" {
			rest += "?" + u.RawQuery
		}
		base, _ := url.Parse(s.cfg.DocsInternalURL)
		return base.Scheme + "://" + base.Host + rest
	}
	return ""
}

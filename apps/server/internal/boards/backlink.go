package boards

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/boards/vcs"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/plans"
	"github.com/calaba/calaba/server/internal/webhook"
)

// The GitLab backlink (board task #101, ADR-0060 §4): when a board switches it on and keeps a
// GitLab API token, a merge request newly linked to a task by a driving key (its source branch,
// title or «Fixes KEY» — never a bare mention) gets one note «Задача Calab: KEY — title url».
// The link row remembers the note (vcs.NoteKey in seen), so a redelivery never posts again. The
// token is sealed at rest, sent only to the board's own GitLab address (https, a public address,
// no redirects: the webhook transport) and never logged; a failure lands in backlink_error.

const (
	maxAPIToken     = 256
	backlinkTimeout = 30 * time.Second // all notes of one delivery
)

// backlinkMode is what a delivery does about notes.
type backlinkMode int

const (
	backlinkOff     backlinkMode = iota // switched off (or not GitLab)
	backlinkMissing                     // switched on without a token or address: report, post nothing
	backlinkReady                       // post
)

// backlinkNote is one note to post after the delivery's transaction.
type backlinkNote struct {
	key, title string
	iid        string // the merge request's number
	mr         string // its web address
	repo       string // the project path
}

// Status texts of backlink_error.
const (
	backlinkNoToken   = "no GitLab API token: the note was not posted" //nolint:gosec // G101: a status text, not a credential
	backlinkNoURL     = "no GitLab address: the note was not posted"
	backlinkNotGitLab = "notes on merge requests work with GitLab only"
)

func (s *Service) backlinkMode(g sqlc.BoardGit) backlinkMode {
	switch {
	case !g.Backlink || g.Provider != vcs.GitLab:
		return backlinkOff
	case len(g.ApiTokenEnc) == 0 || g.GitlabUrl == "" || s.hooks == nil:
		return backlinkMissing
	}
	return backlinkReady
}

// backlinkStatus is the integration status of the backlink: why notes cannot be posted now, or
// the last failure ("" = fine or off).
func backlinkStatus(g sqlc.BoardGit) string {
	switch {
	case !g.Backlink:
		return ""
	case g.Provider != vcs.GitLab:
		return backlinkNotGitLab
	case len(g.ApiTokenEnc) == 0:
		return backlinkNoToken
	case g.GitlabUrl == "":
		return backlinkNoURL
	}
	return g.BacklinkError
}

// validGitLabURL normalizes the GitLab address of the token: an https origin, maybe with a path
// (a GitLab under /gitlab), without credentials, query or fragment; the trailing «/» dropped.
func (s *Service) validGitLabURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", nil
	}
	bad := httpx.Validation("gitlabUrl", "the https address of the GitLab («https://gitlab.com») is required")
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || len(raw) > 512 {
		return "", bad
	}
	out := "https://" + u.Host + strings.TrimRight(u.EscapedPath(), "/")
	if s.hooks != nil {
		if _, err := s.hooks.tr.CheckURL(out + "/"); err != nil {
			return "", httpx.Validation("gitlabUrl", "the GitLab address must be a public https address")
		}
	}
	return out, nil
}

// patchRepoHook: PATCH /api/boards/{id}/git — the backlink switch, token and GitLab address of
// an existing setup (MANAGE_BOARD + MANAGE_INTEGRATIONS, like the setup itself).
func (s *Service) patchRepoHook(w http.ResponseWriter, r *http.Request) error {
	id, acc, err := s.repoBoard(r, true)
	if err != nil {
		return err
	}
	ctx := r.Context()
	if ok, err := s.automationsAllowed(ctx, acc.WorkspaceID); err != nil {
		return err
	} else if !ok {
		return plans.FeatureError(repoPlanFeature)
	}
	var req v1.UpdateBoardGitRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	p := sqlc.UpdateBoardGitBacklinkParams{BoardID: id, Backlink: req.Backlink}
	if req.ApiToken != nil {
		tok := strings.TrimSpace(req.GetApiToken())
		if len(tok) > maxAPIToken || strings.ContainsFunc(tok, func(r rune) bool { return r <= ' ' || r > '~' }) {
			return httpx.Validation("apiToken", "a token of at most 256 printable characters is required")
		}
		p.SetToken = true
		if tok != "" {
			if p.ApiTokenEnc, err = s.repo.token.Seal([]byte(tok)); err != nil {
				return err
			}
		}
	}
	if req.GitlabUrl != nil {
		u, err := s.validGitLabURL(req.GetGitlabUrl())
		if err != nil {
			return err
		}
		p.GitlabUrl = &u
	}
	var g sqlc.BoardGit
	if err := s.tx(ctx, func(q *sqlc.Queries, _ pgx.Tx) error {
		g, err = q.UpdateBoardGitBacklink(ctx, p)
		if db.IsNotFound(err) {
			return httpx.NotFound("git")
		}
		return err
	}); err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.BoardGitResponse{Git: s.repoPB(g)})
	return nil
}

// noteText is the note of a task: one line; the title, written by people of the workspace, gets
// the treatment of untrusted template values (no line breaks, «@» cannot ping on GitLab).
func (s *Service) noteText(key, title string) string {
	link := ""
	if s.PublicURL != "" {
		link = " " + strings.TrimRight(s.PublicURL, "/") + "/t/" + key
	}
	return "Задача Calab: " + key + " — " + untrustedLine(title) + link
}

// postBacklinks posts the notes of a delivery in the background (the hosting waits for no one)
// and records the outcome in backlink_error.
func (s *Service) postBacklinks(ctx context.Context, g sqlc.BoardGit, mode backlinkMode, notes []backlinkNote) {
	if mode == backlinkOff || len(notes) == 0 {
		return
	}
	ctx = context.WithoutCancel(ctx)
	if mode == backlinkMissing {
		s.setBacklinkError(ctx, g, backlinkStatus(g))
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(ctx, backlinkTimeout)
		defer cancel()
		status := ""
		for _, n := range notes {
			if err := s.postNote(ctx, g, n); err != nil {
				status = err.Error()
			}
		}
		s.setBacklinkError(ctx, g, status)
	}()
}

func (s *Service) setBacklinkError(ctx context.Context, g sqlc.BoardGit, msg string) {
	if err := s.tx(ctx, func(q *sqlc.Queries, _ pgx.Tx) error {
		return q.SetBoardGitBacklinkError(ctx, sqlc.SetBoardGitBacklinkErrorParams{BoardID: g.BoardID, BacklinkError: msg})
	}); err != nil {
		slog.WarnContext(ctx, "boards: backlink status", "board", g.BoardID, "err", err)
	}
}

// postNote posts one note; the error is a status text without the token or the response.
func (s *Service) postNote(ctx context.Context, g sqlc.BoardGit, n backlinkNote) error {
	base := g.GitlabUrl
	if !strings.HasPrefix(n.mr, base+"/") {
		return fmt.Errorf("merge request !%s is not on %s: the note was not posted", n.iid, base)
	}
	if _, err := strconv.ParseUint(n.iid, 10, 63); err != nil || n.repo == "" || strings.Contains(n.repo, "..") {
		return errors.New("a merge request without a number or project: the note was not posted")
	}
	tok, err := s.repo.token.Open(g.ApiTokenEnc)
	if err != nil {
		return errors.New("the stored token cannot be read: save it again")
	}
	body, err := json.Marshal(map[string]string{"body": s.noteText(n.key, n.title)})
	if err != nil {
		return err
	}
	api := base + "/api/v4/projects/" + url.PathEscape(n.repo) + "/merge_requests/" + n.iid + "/notes"
	code, err := s.hooks.tr.Post(ctx, api, body, http.Header{"Private-Token": []string{string(tok)}})
	switch {
	case err == nil:
		return nil
	case code == http.StatusUnauthorized || code == http.StatusForbidden:
		return fmt.Errorf("GitLab refused the token (HTTP %d): it needs the api scope and access to %s", code, n.repo)
	case code == http.StatusNotFound:
		return fmt.Errorf("GitLab does not show merge request !%s of %s to the token (HTTP 404)", n.iid, n.repo)
	case errors.Is(err, webhook.ErrNotAllowed):
		return errors.New("the GitLab address is not a public https address")
	case code != 0:
		return fmt.Errorf("GitLab answered HTTP %d", code)
	}
	return errors.New("GitLab did not answer")
}

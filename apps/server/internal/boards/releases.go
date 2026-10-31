package boards

import (
	"cmp"
	"context"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/boards/vcs"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/plans"
)

// Releases (board task #101, ADR-0060 §4): CI posts a deploy of the board's repository; the live
// tasks whose Git links are among the deployed commits — and the keys it names — enter the
// release once per environment: a journal entry "release", the rule trigger `release` (e.g.
// «вошла в релиз prod → Deployed») and TASK_UPDATE with Task.releases.
//
// Calab keeps no Git history: «a commit of the release» is decided only from the list CI sends
// (git log <previous release>..<sha>) and the release sha itself, against the commit SHAs of a
// task's commit links and the merge / squash / head SHAs of its merged pull requests.

// Release limits.
const (
	MaxReleaseCommits = 5000 // commits of one call
	MaxReleaseKeys    = 500  // task_keys of one call
	MaxReleaseTasks   = 500  // tasks entering a release in one call (the rest: call again)
	MaxReleaseName    = 64
	MaxReleaseEnvs    = 10 // environments of a rule trigger
	// MaxBoardEnvs: distinct environments of a board's releases. A task enters one release per
	// environment, so this bounds task_releases, Task.releases and the release rules a task can
	// fire (an EDIT_TASKS token inventing «e1», «e2», … would otherwise re-enter every task).
	MaxBoardEnvs       = 20
	DefaultReleaseEnv  = "prod"
	defaultReleaseList = 50
	maxReleaseList     = 100
	kindRelease        = "release"
	// ReasonReleaseEnvLimit: a release of a 21st environment of the board (409).
	ReasonReleaseEnvLimit = "RELEASE_ENV_LIMIT"
)

var envRE = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,31}$`)

// ValidEnvironment reports a release environment name: «prod», «stage», «eu-1».
func ValidEnvironment(s string) bool { return envRE.MatchString(s) }

// validEnvironments checks the environments of a release trigger: lower-cased, trimmed, empty
// entries and repeats dropped, ≤ MaxReleaseEnvs of the ValidEnvironment form.
func validEnvironments(in []string) ([]string, error) {
	var out []string
	for _, e := range in {
		e = strings.ToLower(strings.TrimSpace(e))
		if e == "" || slices.Contains(out, e) {
			continue
		}
		if !ValidEnvironment(e) {
			return nil, httpx.Validation("trigger.release.environments", "an environment of a-z, 0-9, «.», «_», «-» (at most 32) is required")
		}
		out = append(out, e)
	}
	if len(out) > MaxReleaseEnvs {
		return nil, httpx.Validation("trigger.release.environments", "at most 10 environments")
	}
	return out, nil
}

func (s *Service) releaseRoutes(mux httpx.Router, wrap func(http.Handler) http.Handler) {
	h := func(pattern string, f func(http.ResponseWriter, *http.Request) error) {
		mux.Handle(pattern, wrap(httpx.HandlerFunc(f)))
	}
	h("POST /api/boards/{id}/releases", s.createRelease)
	h("GET /api/boards/{id}/releases", s.listReleases)
}

func releasePB(r sqlc.BoardRelease) *v1.BoardRelease {
	return &v1.BoardRelease{Id: r.ID.String(), BoardId: r.BoardID.String(), Name: r.Name, Environment: r.Environment, Sha: r.Sha,
		Url: r.Url, CreatedBy: idp(r.CreatedBy), CreatedAt: timestamppb.New(r.CreatedAt), UpdatedAt: timestamppb.New(r.UpdatedAt),
		TasksCount: uint32(max(r.TasksCount, 0))} //nolint:gosec // a count
}

// releaseInput is a checked CreateBoardReleaseRequest.
type releaseInput struct {
	name, sha, url, env string
	shas                []string // commits + sha, unique
	numbers             []int32  // of task_keys, unique
	keys                map[int32]string
}

// validRelease checks a release request against board key boardKey (422 on the first problem).
func validRelease(req *v1.CreateBoardReleaseRequest, boardKey string) (releaseInput, error) {
	var in releaseInput
	in.sha = strings.ToLower(strings.TrimSpace(req.GetSha()))
	if !vcs.ValidSHA(in.sha) {
		return in, httpx.Validation("sha", "the full commit id (40 or 64 hex characters) is required")
	}
	in.env = strings.ToLower(strings.TrimSpace(req.GetEnvironment()))
	if in.env == "" {
		in.env = DefaultReleaseEnv
	}
	if !ValidEnvironment(in.env) {
		return in, httpx.Validation("environment", "an environment of a-z, 0-9, «.», «_», «-» (at most 32) is required")
	}
	in.name = strings.Join(strings.Fields(strings.Map(func(r rune) rune {
		switch {
		case unicode.IsControl(r):
			return ' '
		case unicode.Is(unicode.Bidi_Control, r):
			return -1 // U+202E and kin would turn the label around in the task panel and the history
		}
		return r
	}, req.GetName())), " ")
	if in.name == "" {
		in.name = in.sha[:7]
	}
	if utf8.RuneCountInString(in.name) > MaxReleaseName {
		return in, httpx.Validation("name", "at most 64 characters")
	}
	if raw := strings.TrimSpace(req.GetUrl()); raw != "" {
		if in.url = vcs.SafeURL(raw); in.url == "" {
			return in, httpx.Validation("url", "an http(s) address of at most 2048 characters is required")
		}
	}
	if len(req.GetCommits()) > MaxReleaseCommits {
		return in, httpx.Validation("commits", "at most 5000 commits; send the rest in another call")
	}
	in.shas = make([]string, 0, len(req.GetCommits())+1)
	seen := make(map[string]bool, len(req.GetCommits())+1)
	for i, c := range append([]string{in.sha}, req.GetCommits()...) {
		c = strings.ToLower(strings.TrimSpace(c))
		if !vcs.ValidSHA(c) {
			return in, httpx.Validation("commits", "commits["+strconv.Itoa(i-1)+"]: a full commit id (40 or 64 hex characters) is required")
		}
		if !seen[c] {
			seen[c] = true
			in.shas = append(in.shas, c)
		}
	}
	if len(req.GetTaskKeys()) > MaxReleaseKeys {
		return in, httpx.Validation("taskKeys", "at most 500 task keys")
	}
	in.keys = map[int32]string{}
	for i, k := range req.GetTaskKeys() {
		ns := vcs.KeysFold(k, boardKey)
		if len(ns) != 1 || !strings.EqualFold(strings.TrimSpace(k), TaskKey(boardKey, ns[0])) {
			return in, httpx.Validation("taskKeys", "taskKeys["+strconv.Itoa(i)+"]: a key of this board («"+boardKey+"-12») is required")
		}
		if _, dup := in.keys[ns[0]]; !dup {
			in.keys[ns[0]] = TaskKey(boardKey, ns[0])
			in.numbers = append(in.numbers, ns[0])
		}
	}
	return in, nil
}

// createRelease: POST /api/boards/{id}/releases — EDIT_TASKS on the board (a CI bot by the same
// bit, ADR-0109), the plan's automations, 30 per minute per board.
func (s *Service) createRelease(w http.ResponseWriter, r *http.Request) error {
	id, acc, err := fullBoard(r, false)
	if err != nil {
		return err
	}
	if !acc.Bits.Has(perm.EditTasks) {
		return httpx.Forbidden("EDIT_TASKS required")
	}
	if err := writable(acc); err != nil {
		return err
	}
	ctx := r.Context()
	if ok, err := s.automationsAllowed(ctx, acc.WorkspaceID); err != nil {
		return err
	} else if !ok {
		return plans.FeatureError(repoPlanFeature)
	}
	if s.ReleaseLimit != nil {
		if err := s.ReleaseLimit.Take(ctx, id.String()); err != nil {
			return err
		}
	}
	var req v1.CreateBoardReleaseRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	b, err := s.db.Q.GetBoard(ctx, id)
	if err != nil {
		return err
	}
	in, err := validRelease(&req, b.Key)
	if err != nil {
		return err
	}
	me := uid(r)
	var (
		c         change
		rel       sqlc.BoardRelease
		created   bool
		added     []string
		unknown   []string
		truncated bool
		ids       []uuid.UUID
	)
	err = s.taskTx(ctx, &c, func(q *sqlc.Queries, tx pgx.Tx) error {
		c = change{}
		added, unknown, truncated, ids = nil, nil, false, nil
		up, err := q.UpsertBoardRelease(ctx, sqlc.UpsertBoardReleaseParams{BoardID: id, Environment: in.env, Sha: in.sha, Name: in.name,
			Url: in.url, CreatedBy: &me})
		if err != nil {
			return err
		}
		created = up.Created
		if created {
			envs, err := q.BoardReleaseEnvironments(ctx, id)
			if err != nil {
				return err
			}
			// envs holds in.env now: over the limit only when it is a new environment.
			if len(envs) > MaxBoardEnvs {
				return httpx.Conflict("at most 20 release environments per board").
					WithDetails(ReasonReleaseEnvLimit, uint64(len(envs)-1), MaxBoardEnvs) //nolint:gosec // a count
			}
		}
		byCommit, err := q.ReleaseTasksByCommits(ctx, sqlc.ReleaseTasksByCommitsParams{BoardID: id, Shas: in.shas, Environment: in.env,
			Lim: MaxReleaseTasks + 1})
		if err != nil {
			return err
		}
		// The candidates in task-number order: concurrent releases lock tasks in one order (no
		// deadlock), and the 500 taken are the lowest numbers — each not yet in the environment, so
		// «truncated → call again» always makes progress.
		cands := make([]sqlc.ReleaseTasksByCommitsRow, 0, len(byCommit)+len(in.numbers))
		cands = append(cands, byCommit...)
		if len(in.numbers) > 0 {
			named, err := q.LiveTasksByNumbers(ctx, sqlc.LiveTasksByNumbersParams{BoardID: id, Numbers: in.numbers, Environment: in.env})
			if err != nil {
				return err
			}
			found := map[int32]bool{}
			for _, x := range named {
				found[x.Number] = true
				if !x.Released && !slices.ContainsFunc(cands, func(c sqlc.ReleaseTasksByCommitsRow) bool { return c.ID == x.ID }) {
					cands = append(cands, sqlc.ReleaseTasksByCommitsRow{ID: x.ID, Number: x.Number})
				}
			}
			for _, n := range in.numbers {
				if !found[n] {
					unknown = append(unknown, in.keys[n])
				}
			}
		}
		slices.SortFunc(cands, func(a, b sqlc.ReleaseTasksByCommitsRow) int { return cmp.Compare(a.Number, b.Number) })
		if len(cands) > MaxReleaseTasks {
			cands, truncated = cands[:MaxReleaseTasks], true
		}
		after := map[string]any{"release_id": up.ID.String(), "name": up.Name, "environment": up.Environment, "sha": up.Sha, "url": up.Url}
		for _, cand := range cands {
			t, ok, err := taskByID(ctx, tx, cand.ID, true)
			if err != nil {
				return err
			}
			if !ok || t.BoardID != id || t.ArchivedAt != nil {
				continue
			}
			n, err := q.AddTaskRelease(ctx, sqlc.AddTaskReleaseParams{TaskID: t.ID, Environment: in.env, ReleaseID: up.ID})
			if err != nil {
				return err
			}
			if n == 0 {
				continue // already in a release of this environment
			}
			if err := c.recordAs(ctx, q, t, &me, kindRelease, nil, after); err != nil {
				return err
			}
			if err := q.TouchTask(ctx, t.ID); err != nil {
				return err
			}
			added = append(added, TaskKey(t.BoardKey, t.Number))
			ids = append(ids, t.ID)
		}
		if err := q.CountReleaseTasks(ctx, up.ID); err != nil {
			return err
		}
		rel, err = q.GetBoardRelease(ctx, up.ID)
		return err
	})
	if err != nil {
		return err
	}
	if len(ids) > 0 {
		c.tasks = ids[1:]
		s.publish(context.WithoutCancel(ctx), ids[0], &c, false)
	}
	httpx.Write(w, http.StatusOK, &v1.BoardReleaseResponse{Release: releasePB(rel), Created: created, AddedKeys: added,
		UnknownKeys: unknown, Truncated: truncated})
	return nil
}

// listReleases: GET /api/boards/{id}/releases?environment=&limit= — VIEW_BOARD, newest first.
func (s *Service) listReleases(w http.ResponseWriter, r *http.Request) error {
	id, _, err := fullBoard(r, false)
	if err != nil {
		return err
	}
	env := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("environment")))
	if env != "" && !ValidEnvironment(env) {
		return httpx.Validation("environment", "unknown environment form")
	}
	lim := defaultReleaseList
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > maxReleaseList {
			return httpx.Validation("limit", "limit must be 1..100")
		}
		lim = n
	}
	rows, err := s.db.Q.ListBoardReleases(r.Context(), sqlc.ListBoardReleasesParams{BoardID: id, Environment: env, Lim: int32(lim)}) //nolint:gosec // ≤ 100
	if err != nil && !db.IsNotFound(err) {
		return err
	}
	out := make([]*v1.BoardRelease, len(rows))
	for i, x := range rows {
		out[i] = releasePB(x)
	}
	httpx.Write(w, http.StatusOK, &v1.ListBoardReleasesResponse{Releases: out})
	return nil
}

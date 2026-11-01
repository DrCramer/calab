// Package vcs reads the webhooks of Git hostings for board Git links (ADR-0060 §4): signature
// checks of GitHub, GitLab and Gitea / Forgejo, their push and pull / merge request events in
// one Event form, and task keys («FNG-12») in branch names, titles, bodies and commit messages.
// It knows nothing of boards or the database.
package vcs

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Providers (the {provider} path segment and the stored value).
const (
	GitHub = "github"
	GitLab = "gitlab"
	Gitea  = "gitea" // Gitea and Forgejo
)

// Valid reports a known provider name.
func Valid(p string) bool { return p == GitHub || p == GitLab || p == Gitea }

// Link kinds and pull request states (task_git_links).
const (
	KindBranch = "branch"
	KindPR     = "pr"
	KindCommit = "commit"

	StateOpen   = "open"
	StateMerged = "merged"
	StateClosed = "closed"
)

// Trigger events (RuleGitEvent names without the prefix).
const (
	EventBranchCreated = "BRANCH_CREATED"
	EventPROpened      = "PR_OPENED"
	EventPRMerged      = "PR_MERGED"
	EventPRClosed      = "PR_CLOSED"
	EventCommitPushed  = "COMMIT_PUSHED"
	// Board task #101: drafts, review requests and approvals.
	EventPRDraftOpened     = "PR_DRAFT_OPENED"     // a draft opened or reopened (never PR_OPENED)
	EventPRReady           = "PR_READY"            // a draft marked ready for review
	EventPRReviewRequested = "PR_REVIEW_REQUESTED" // a reviewer was added
	EventPRApproved        = "PR_APPROVED"         // a reviewer approved
)

// Bounds of what one delivery may produce.
const (
	MaxBody     = 1 << 20 // bytes of a delivery
	MaxCommits  = 100     // commits of a push looked at
	MaxTasks    = 20      // distinct tasks one delivery may touch
	MaxTitle    = 200
	MaxURL      = 2048
	MaxAuthor   = 100
	MaxRepo     = 300
	MaxRef      = 300
	MaxSeen     = 50    // one-shot event keys remembered per link (Link.Once)
	maxKeysText = 20000 // runes of a text searched for keys
)

// Verify checks the delivery's signature with the board's secret: GitHub X-Hub-Signature-256
// "sha256=<hex HMAC-SHA256(secret, body)>"; Gitea / Forgejo X-Gitea-Signature (or
// X-Forgejo-Signature) "<hex HMAC-SHA256>"; GitLab X-Gitlab-Token equal to the secret. All
// comparisons are constant-time.
func Verify(provider string, h http.Header, body, secret []byte) bool {
	if len(secret) == 0 {
		return false
	}
	switch provider {
	case GitHub:
		sig, ok := strings.CutPrefix(h.Get("X-Hub-Signature-256"), "sha256=")
		return ok && macEqual(sig, body, secret)
	case Gitea:
		sig := h.Get("X-Gitea-Signature")
		if sig == "" {
			sig = h.Get("X-Forgejo-Signature")
		}
		return sig != "" && macEqual(sig, body, secret)
	case GitLab:
		tok := h.Get("X-Gitlab-Token")
		return tok != "" && subtle.ConstantTimeCompare([]byte(tok), secret) == 1
	}
	return false
}

func macEqual(hexSig string, body, secret []byte) bool {
	got, err := hex.DecodeString(strings.TrimSpace(hexSig))
	if err != nil {
		return false
	}
	m := hmac.New(sha256.New, secret)
	m.Write(body)
	return hmac.Equal(got, m.Sum(nil))
}

// Sign is the HMAC-SHA256 hex of body (tests and docs: what GitHub / Gitea send).
func Sign(body, secret []byte) string {
	m := hmac.New(sha256.New, secret)
	m.Write(body)
	return hex.EncodeToString(m.Sum(nil))
}

// EventName is the provider's event header: GitHub X-GitHub-Event ("push", "pull_request"),
// GitLab X-Gitlab-Event ("Push Hook", "Merge Request Hook"), Gitea X-Gitea-Event (or
// X-Forgejo-Event).
func EventName(provider string, h http.Header) string {
	switch provider {
	case GitHub:
		return h.Get("X-GitHub-Event")
	case GitLab:
		return h.Get("X-Gitlab-Event")
	case Gitea:
		if v := h.Get("X-Gitea-Event"); v != "" {
			return v
		}
		return h.Get("X-Forgejo-Event")
	}
	return ""
}

// Event is a push or a pull / merge request in a provider-neutral form.
type Event struct {
	Provider string
	Repo     string // owner/name (GitLab: the project path)
	RepoURL  string
	Author   string // who pushed / opened
	// Push.
	Push          bool
	Branch        string
	DefaultBranch string // the repository's default branch ("" = unknown: main / master are assumed)
	BranchCreated bool
	Commits       []Commit
	// Pull / merge request.
	PR *PullRequest
}

// Commit of a push.
type Commit struct {
	SHA     string
	Message string
	URL     string
	Author  string
	// Old: the host says the commit was already in the repository before this push (GitHub
	// "distinct": false); such a commit is never linked again.
	Old bool
}

// PullRequest is a pull / merge request after the event.
type PullRequest struct {
	Number int64
	Title  string
	Body   string
	URL    string
	State  string // open | merged | closed
	Branch string // the source branch
	Author string
	// Event: EventPROpened / EventPRMerged / EventPRClosed / EventPRDraftOpened / EventPRReady /
	// EventPRReviewRequested / EventPRApproved, or "" for an edit (title / body / draft flag).
	Event  string
	Draft  bool   // a draft (GitLab Draft / WIP, GitHub draft, Gitea draft or a «WIP:» title)
	Target string // the target branch
	Actor  string // who made the event (the approver, who requested a review…); "" = Author
	// Users: the reviewers added (review requested) or the approver (approved).
	Users []string
	// Once: keys of one-shot events («approved:alice», «review:bob»): the event fires only for a
	// key the link has not seen (a redelivery or a second «approved» of GitLab does nothing).
	// Forget: keys dropped (unapproved, a reviewer removed), so the event may fire again.
	Once, Forget []string
	// SHAs: the merge, squash and head commits of a merged pull request (SHAs form), matched
	// against the commits of a board release.
	SHAs []string
}

// keyRE: a task key anywhere in a text (ADR-0060 §4). Letters of any case are matched here;
// Keys keeps only the board's own key, so «v-12» or «utf-8» never become tasks.
var keyRE = regexp.MustCompile(`\b([A-Za-z0-9]{2,6})-(\d+)\b`)

// magicRE: a closing word and the keys listed right after it («Fixes DEV-1, DEV-2 and DEV-3»).
// The list is short on purpose and English only (Linear's: fix, close, resolve).
var magicRE = regexp.MustCompile(`(?i)(?:^|[^\p{L}\p{N}_])(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s*:?\s+` +
	`((?:[A-Za-z0-9]{2,6}-\d+(?:\s*(?:,|&|\band\b)\s*)?)+)`)

func clipKeysText(text string) string {
	if utf8.RuneCountInString(text) > maxKeysText {
		return string([]rune(text)[:maxKeysText])
	}
	return text
}

// Keys returns the task numbers of board key boardKey mentioned in text, in order, without
// duplicates. Keys of other boards are ignored; the board's key matches in upper case only
// (commit messages, prose). Branch names use KeysFold.
func Keys(text, boardKey string) []int32 { return keys(text, boardKey, false) }

// KeysFold is Keys without regard to case: «feature/dev-4188-new-card» is DEV-4188 (Linear's
// branch format). Only the board's own key matches, so a random «v-12» is not a task; the
// boundaries stay those of a word («xdev-4188», «dev-4188y» are not keys).
func KeysFold(text, boardKey string) []int32 { return keys(text, boardKey, true) }

func keys(text, boardKey string, fold bool) []int32 {
	var out []int32
	for _, m := range keyRE.FindAllStringSubmatch(clipKeysText(text), -1) {
		if m[1] != boardKey && (!fold || !strings.EqualFold(m[1], boardKey)) {
			continue
		}
		n, err := strconv.ParseInt(m[2], 10, 32)
		if err != nil || n < 1 {
			continue
		}
		if !slices.Contains(out, int32(n)) {
			out = append(out, int32(n))
		}
	}
	return out
}

// MagicKeys returns the numbers of keys that follow a closing word (Fixes, Closes, Resolves and
// their forms, any case) in text — the only way a description may drive the rules. The key
// itself may be in any case.
func MagicKeys(text, boardKey string) []int32 {
	var out []int32
	for _, m := range magicRE.FindAllStringSubmatch(clipKeysText(text), -1) {
		for _, n := range KeysFold(m[1], boardKey) {
			if !slices.Contains(out, n) {
				out = append(out, n)
			}
		}
	}
	return out
}

// mergeFromDefault reports a merge commit that brings the default branch into another one
// («Merge branch 'main' into feature/x», «Merge remote-tracking branch 'origin/main' into x»,
// «Merge origin/main into x»).
func mergeFromDefault(msg, def string) bool {
	first, _, _ := strings.Cut(strings.TrimSpace(msg), "\n")
	defs := []string{def}
	if def == "" {
		defs = []string{"main", "master"}
	}
	for _, d := range defs {
		re := regexp.MustCompile(`(?i)^Merge (?:remote-tracking )?(?:branch )?['"]?(?:[\w.-]+/)?` + regexp.QuoteMeta(d) +
			`['"]?(?: of \S+)?(?: into |$)`)
		if re.MatchString(first) {
			return true
		}
	}
	return false
}

// pushedCommits are the commits of a push that may be linked. Dropped: those the host calls old
// (GitHub "distinct": false), and — when the push brings the default branch into another one
// (a merge commit «Merge … main into …», see mergeFromDefault) — that merge commit and every
// commit listed before it: the payloads carry no parents, so main's commits cannot be told from
// the branch's own commits pushed together with the merge.
func pushedCommits(ev *Event) []Commit {
	cs := ev.Commits
	if len(cs) > MaxCommits {
		cs = cs[:MaxCommits]
	}
	def := ev.DefaultBranch
	cut := -1
	onDefault := ev.Branch == def || (def == "" && (ev.Branch == "main" || ev.Branch == "master"))
	if !onDefault {
		for i, c := range cs {
			if mergeFromDefault(c.Message, def) {
				cut = i
			}
		}
	}
	out := make([]Commit, 0, len(cs))
	for i, c := range cs {
		if i > cut && !c.Old {
			out = append(out, c)
		}
	}
	return out
}

// Link is one task_git_links row a delivery writes for task Number (Event: the rule trigger it
// fires, "" = none; Apply decides the final one against the stored row).
type Link struct {
	Number int32
	Kind   string
	Ref    string
	Title  string
	URL    string
	State  string
	Author string
	Event  string
	// Mention: a key named only in a pull request's description — linked, never fires.
	Mention bool
	Draft   bool
	Branch  string // the branch (a pull request's source branch, a push's branch)
	Target  string // a pull request's target branch
	Actor   string // who made the event
	Users   []string
	Once    []string
	Forget  []string
	SHAs    []string // a merged pull request's commits (PullRequest.SHAs)
}

// Links turns an event into the links of the board's tasks (key boardKey): a new branch whose
// name has a key; each commit whose message has one; a pull request whose title, body or
// source branch has one. At most MaxTasks distinct tasks.
func Links(ev *Event, boardKey string) []Link {
	var out []Link
	tasks := map[int32]bool{}
	add := func(l Link) {
		if !tasks[l.Number] && len(tasks) >= MaxTasks {
			return
		}
		tasks[l.Number] = true
		l.Title, l.Author = clip(l.Title, MaxTitle), clip(l.Author, MaxAuthor)
		l.Ref, l.URL = clip(l.Ref, MaxRef), safeURL(l.URL)
		out = append(out, l)
	}
	switch {
	case ev.PR != nil:
		pr := ev.PR
		// Driving keys: the source branch, the title, and «Fixes KEY» in the description. A bare
		// mention in the description only links the pull request (Event ""), so no rule runs for
		// a task that is merely talked about (board task #101).
		var drive []int32
		for _, n := range slices.Concat(KeysFold(pr.Branch, boardKey), KeysFold(pr.Title, boardKey), MagicKeys(pr.Body, boardKey)) {
			if !slices.Contains(drive, n) {
				drive = append(drive, n)
			}
		}
		actor := pr.Actor
		if actor == "" {
			actor = pr.Author
		}
		base := Link{Kind: KindPR, Ref: strconv.FormatInt(pr.Number, 10), Title: pr.Title, URL: pr.URL, State: pr.State,
			Author: pr.Author, Draft: pr.Draft, Branch: clip(pr.Branch, MaxRef), Target: clip(pr.Target, MaxRef), Actor: clip(actor, MaxAuthor)}
		for _, n := range drive {
			l := base
			l.Number, l.Event, l.Users, l.Once, l.Forget, l.SHAs = n, pr.Event, pr.Users, pr.Once, pr.Forget, pr.SHAs
			add(l)
		}
		for _, n := range Keys(pr.Body, boardKey) {
			if !slices.Contains(drive, n) {
				l := base
				l.Number, l.Mention = n, true
				add(l)
			}
		}
	case ev.Push:
		if ev.BranchCreated {
			for _, n := range KeysFold(ev.Branch, boardKey) {
				add(Link{Number: n, Kind: KindBranch, Ref: ev.Branch, Title: ev.Branch, URL: branchURL(ev), Author: ev.Author,
					Event: EventBranchCreated, Branch: clip(ev.Branch, MaxRef), Actor: clip(ev.Author, MaxAuthor)})
			}
		}
		for _, c := range pushedCommits(ev) {
			first, _, _ := strings.Cut(strings.TrimSpace(c.Message), "\n")
			for _, n := range Keys(c.Message, boardKey) {
				add(Link{Number: n, Kind: KindCommit, Ref: c.SHA, Title: first, URL: c.URL, Author: c.Author, Event: EventCommitPushed,
					Branch: clip(ev.Branch, MaxRef), Actor: clip(ev.Author, MaxAuthor)})
			}
		}
	}
	return out
}

// Prior is the stored row of a link before a delivery (Found false: the link is new).
type Prior struct {
	Found             bool
	State, Title, URL string
	Draft             bool
	Seen              []string
	SHAs              []string
}

// Apply decides what link l of a delivery does to its stored row p: the rule event it fires
// ("" = none), the one-shot keys to store and whether the row changes at all (false: a repeat —
// nothing is written or journaled). A redelivery changes nothing, so it fires nothing:
//   - a branch fires BRANCH_CREATED only when new;
//   - a pull request fires when its state, title, URL or draft flag changes (opened, merged…);
//   - PR_READY fires when a stored draft stops being one, also when the host sends a plain edit
//     (Gitea: «WIP:» removed from the title), and never for a pull request that was not a draft;
//   - one-shot events (approved, review requested) fire for a key of Once not yet seen.
func Apply(p Prior, l Link) (event string, seen []string, changed bool) {
	event = l.Event
	seen = slices.Clone(p.Seen)
	if len(l.Once) > 0 {
		fresh := false
		for _, k := range l.Once {
			if !slices.Contains(seen, k) {
				seen, fresh = append(seen, k), true
			}
		}
		if !fresh {
			event = ""
		}
	}
	seen = slices.DeleteFunc(seen, func(k string) bool { return slices.Contains(l.Forget, k) })
	if len(seen) > MaxSeen {
		seen = seen[len(seen)-MaxSeen:]
	}
	if seen == nil {
		seen = []string{}
	}
	switch {
	case p.Found && event == EventBranchCreated:
		event = ""
	case l.Kind != KindPR:
	case event == EventPRReady && (l.Draft || (p.Found && !p.Draft)):
		event = "" // already ready (a redelivery), or a draft again
	case event == "" && p.Found && p.Draft && !l.Draft && l.State == StateOpen:
		event = EventPRReady
	}
	changed = !p.Found || p.State != l.State || p.Title != l.Title || p.URL != l.URL || p.Draft != l.Draft || !slices.Equal(seen, p.Seen) ||
		(len(l.SHAs) > 0 && !slices.Equal(l.SHAs, p.SHAs))
	if !changed || l.Mention {
		event = ""
	}
	return event, seen, changed
}

// OnceKey is the one-shot key of event kind ("approved", "review") by user.
func OnceKey(kind, user string) string { return kind + ":" + strings.ToLower(clip(user, MaxAuthor)) }

// BranchMatch reports whether branch matches one of patterns (none = any branch): an exact name
// or a glob where «*» is any run of characters, «/» included («release/*» is release/1.2 and
// release/1.2/hotfix), and «?» one character. An empty branch matches only no patterns.
func BranchMatch(patterns []string, branch string) bool {
	if len(patterns) == 0 {
		return true
	}
	for _, p := range patterns {
		if glob(p, branch) {
			return true
		}
	}
	return false
}

// glob matches s against pattern p (* and ?), iteratively with one backtrack point: linear in
// practice, no regexp compiled per event.
func glob(p, s string) bool {
	pr, sr := []rune(p), []rune(s)
	pi, si, star, mark := 0, 0, -1, 0
	for si < len(sr) {
		switch {
		case pi < len(pr) && (pr[pi] == '?' || pr[pi] == sr[si]):
			pi++
			si++
		case pi < len(pr) && pr[pi] == '*':
			star, mark = pi, si
			pi++
		case star >= 0:
			pi, mark = star+1, mark+1
			si = mark
		default:
			return false
		}
	}
	for pi < len(pr) && pr[pi] == '*' {
		pi++
	}
	return pi == len(pr)
}

func branchURL(ev *Event) string {
	if ev.RepoURL == "" || ev.Branch == "" {
		return ""
	}
	p := "/tree/"
	switch ev.Provider {
	case GitLab:
		p = "/-/tree/"
	case Gitea:
		p = "/src/branch/"
	}
	segs := strings.Split(ev.Branch, "/")
	for i, s := range segs {
		segs[i] = url.PathEscape(s)
	}
	return strings.TrimRight(ev.RepoURL, "/") + p + strings.Join(segs, "/")
}

// safeURL keeps an http(s) address of at most MaxURL characters ("" otherwise).
func safeURL(s string) string {
	s = strings.TrimSpace(s)
	if len(s) > MaxURL {
		return ""
	}
	u, err := url.Parse(s)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		return ""
	}
	return s
}

// clip trims s and cuts it to n runes.
func clip(s string, n int) string {
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n])
}

// SafeURL is safeURL for callers outside the package: an http(s) address of at most MaxURL
// characters, else "".
func SafeURL(s string) string { return safeURL(s) }

// NoteKey is the Seen key of a pull request link whose backlink note was posted (board task
// #101): one note per merge request and task, never again on a redelivery.
const NoteKey = "note:calab"

// ValidSHA reports a full commit id: 40 (SHA-1) or 64 (SHA-256) lowercase hex characters.
func ValidSHA(s string) bool {
	if len(s) != 40 && len(s) != 64 {
		return false
	}
	for i := range len(s) {
		if c := s[i]; (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

// SHAs keeps the full commit ids of ss (lower-cased), without empties and duplicates, in order.
func SHAs(ss ...string) []string {
	var out []string
	for _, s := range ss {
		s = strings.ToLower(strings.TrimSpace(s))
		if ValidSHA(s) && !slices.Contains(out, s) {
			out = append(out, s)
		}
	}
	return out
}

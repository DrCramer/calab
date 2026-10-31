package vcs

import (
	"encoding/json"
	"errors"
	"slices"
	"strings"
)

// ErrPayload is returned for a body that is not the JSON of the event it claims to be.
var ErrPayload = errors.New("vcs: malformed payload")

// zeroSHA marks a branch that did not exist before a push (GitLab, Gitea).
const zeroSHA = "0000000000000000000000000000000000000000"

// Parse reads a delivery of provider with event header name. nil, nil = an event that is not
// used (ping, tags, branch deletion, review comments…).
func Parse(provider, name string, body []byte) (*Event, error) {
	switch provider {
	case GitHub:
		switch name {
		case "push":
			return parseHubPush(provider, body)
		case "pull_request", "pull_request_review":
			return parseHubPR(provider, name, body)
		}
	case Gitea:
		switch name {
		case "push":
			return parseHubPush(provider, body)
		case "pull_request", "pull_request_approved", "pull_request_review_approved":
			return parseHubPR(provider, name, body)
		}
	case GitLab:
		switch name {
		case "Push Hook":
			return parseLabPush(body)
		case "Merge Request Hook":
			return parseLabMR(body)
		}
	}
	return nil, nil
}

// ---- GitHub and Gitea / Forgejo (Gitea's payloads follow GitHub's shape) ----

type hubUser struct {
	Login    string `json:"login"`
	Username string `json:"username"`
	Name     string `json:"name"`
}

func (u hubUser) handle() string {
	for _, s := range []string{u.Login, u.Username, u.Name} {
		if s != "" {
			return s
		}
	}
	return ""
}

type hubRepo struct {
	FullName      string `json:"full_name"`
	HTMLURL       string `json:"html_url"`
	DefaultBranch string `json:"default_branch"`
}

type hubPush struct {
	Ref        string  `json:"ref"`
	Before     string  `json:"before"`
	Created    bool    `json:"created"`
	Deleted    bool    `json:"deleted"`
	Repository hubRepo `json:"repository"`
	Pusher     hubUser `json:"pusher"`
	Sender     hubUser `json:"sender"`
	Commits    []struct {
		ID       string  `json:"id"`
		Message  string  `json:"message"`
		URL      string  `json:"url"`
		Author   hubUser `json:"author"`
		Distinct *bool   `json:"distinct"` // GitHub: false = the commit was already in the repository
	} `json:"commits"`
}

func parseHubPush(provider string, body []byte) (*Event, error) {
	var p hubPush
	if err := json.Unmarshal(body, &p); err != nil {
		return nil, ErrPayload
	}
	branch, ok := strings.CutPrefix(p.Ref, "refs/heads/")
	if !ok || p.Deleted || p.Repository.FullName == "" {
		return nil, nil // tags, deleted branches
	}
	ev := &Event{Provider: provider, Repo: clip(p.Repository.FullName, MaxRepo), RepoURL: p.Repository.HTMLURL, Push: true,
		Branch: branch, BranchCreated: p.Created || p.Before == zeroSHA, Author: p.Pusher.handle(),
		DefaultBranch: p.Repository.DefaultBranch}
	if ev.Author == "" {
		ev.Author = p.Sender.handle()
	}
	for _, c := range p.Commits {
		if c.ID == "" {
			continue
		}
		ev.Commits = append(ev.Commits, Commit{SHA: c.ID, Message: c.Message, URL: c.URL, Author: c.Author.handle(),
			Old: c.Distinct != nil && !*c.Distinct})
	}
	return ev, nil
}

type hubPR struct {
	Action      string  `json:"action"`
	Number      int64   `json:"number"`
	Repository  hubRepo `json:"repository"`
	Sender      hubUser `json:"sender"`
	PullRequest struct {
		Number  int64   `json:"number"`
		Title   string  `json:"title"`
		Body    string  `json:"body"`
		HTMLURL string  `json:"html_url"`
		State   string  `json:"state"`
		Merged  bool    `json:"merged"`
		Draft   bool    `json:"draft"`
		User    hubUser `json:"user"`
		Head    struct {
			Ref string `json:"ref"`
			SHA string `json:"sha"`
		} `json:"head"`
		MergeCommitSHA string `json:"merge_commit_sha"`
		Base           struct {
			Ref string `json:"ref"`
		} `json:"base"`
	} `json:"pull_request"`
	RequestedReviewer *hubUser `json:"requested_reviewer"`
	RequestedTeam     *struct {
		Slug string `json:"slug"`
		Name string `json:"name"`
	} `json:"requested_team"`
	Review struct {
		State string  `json:"state"` // GitHub: approved | changes_requested | commented | dismissed
		User  hubUser `json:"user"`
	} `json:"review"`
}

// requested is the reviewer (or team) of a GitHub / Gitea review request.
func (p *hubPR) requested() string {
	if p.RequestedReviewer != nil {
		if h := p.RequestedReviewer.handle(); h != "" {
			return h
		}
	}
	if p.RequestedTeam != nil {
		if p.RequestedTeam.Slug != "" {
			return p.RequestedTeam.Slug
		}
		return p.RequestedTeam.Name
	}
	return ""
}

// wipTitle: Gitea's default work-in-progress prefixes (a draft on hosts without the draft field).
func wipTitle(title string) bool {
	t := strings.ToUpper(strings.TrimSpace(title))
	return strings.HasPrefix(t, "WIP:") || strings.HasPrefix(t, "[WIP]")
}

// parseHubPR reads a GitHub / Gitea pull request event: name "pull_request" (opened, reopened,
// closed, edited, converted_to_draft, ready_for_review, review_requested, review_request_removed),
// GitHub "pull_request_review" (submitted «approved», dismissed), Gitea "pull_request_approved"
// (the reviewer is the sender).
func parseHubPR(provider, name string, body []byte) (*Event, error) {
	var p hubPR
	if err := json.Unmarshal(body, &p); err != nil {
		return nil, ErrPayload
	}
	pr := p.PullRequest
	if p.Repository.FullName == "" || (pr.Number == 0 && p.Number == 0) {
		return nil, ErrPayload
	}
	n := pr.Number
	if n == 0 {
		n = p.Number
	}
	out := &PullRequest{Number: n, Title: pr.Title, Body: pr.Body, URL: pr.HTMLURL, Branch: pr.Head.Ref, Author: pr.User.handle(),
		State: StateOpen, Draft: pr.Draft || (provider == Gitea && wipTitle(pr.Title)), Target: pr.Base.Ref, Actor: p.Sender.handle()}
	switch {
	case pr.Merged:
		out.State = StateMerged
		// GitHub fills merge_commit_sha with a test merge while the PR is open: only once merged.
		out.SHAs = SHAs(pr.MergeCommitSHA, pr.Head.SHA)
	case pr.State == "closed":
		out.State = StateClosed
	}
	once := func(event, kind, user string) {
		if user != "" {
			out.Event, out.Users, out.Once = event, []string{user}, []string{OnceKey(kind, user)}
		}
	}
	switch name {
	case "pull_request_review": // GitHub
		switch {
		case p.Action == "submitted" && strings.EqualFold(p.Review.State, "approved"):
			once(EventPRApproved, "approved", p.Review.User.handle())
		case p.Action == "dismissed" && p.Review.User.handle() != "":
			out.Forget = []string{OnceKey("approved", p.Review.User.handle())}
		}
		if out.Event == "" && len(out.Forget) == 0 {
			return nil, nil // comments, change requests
		}
	case "pull_request_approved", "pull_request_review_approved": // Gitea / Forgejo
		once(EventPRApproved, "approved", p.Sender.handle())
		if out.Event == "" {
			return nil, nil
		}
	default:
		switch p.Action {
		case "opened", "reopened":
			out.Event = EventPROpened
			if out.Draft {
				out.Event = EventPRDraftOpened
			}
		case "closed":
			out.Event = EventPRClosed
			if pr.Merged {
				out.Event = EventPRMerged
			}
		case "ready_for_review":
			out.Event = EventPRReady
		case "review_requested":
			if once(EventPRReviewRequested, "review", p.requested()); out.Event == "" {
				return nil, nil
			}
		case "review_request_removed":
			r := p.requested()
			if r == "" {
				return nil, nil
			}
			out.Forget = []string{OnceKey("review", r)}
		case "edited", "converted_to_draft":
		default:
			return nil, nil // synchronize, labeled, assigned…
		}
	}
	return &Event{Provider: provider, Repo: clip(p.Repository.FullName, MaxRepo), RepoURL: p.Repository.HTMLURL, Author: out.Author, PR: out}, nil
}

// ---- GitLab ----

type labProject struct {
	PathWithNamespace string `json:"path_with_namespace"`
	WebURL            string `json:"web_url"`
	DefaultBranch     string `json:"default_branch"`
}

type labPush struct {
	Ref          string     `json:"ref"`
	Before       string     `json:"before"`
	After        string     `json:"after"`
	UserUsername string     `json:"user_username"`
	UserName     string     `json:"user_name"`
	Project      labProject `json:"project"`
	Commits      []struct {
		ID      string `json:"id"`
		Message string `json:"message"`
		URL     string `json:"url"`
		Author  struct {
			Name string `json:"name"`
		} `json:"author"`
	} `json:"commits"`
}

func parseLabPush(body []byte) (*Event, error) {
	var p labPush
	if err := json.Unmarshal(body, &p); err != nil {
		return nil, ErrPayload
	}
	branch, ok := strings.CutPrefix(p.Ref, "refs/heads/")
	if !ok || p.After == zeroSHA || p.Project.PathWithNamespace == "" {
		return nil, nil // tags, deleted branches
	}
	author := p.UserUsername
	if author == "" {
		author = p.UserName
	}
	ev := &Event{Provider: GitLab, Repo: clip(p.Project.PathWithNamespace, MaxRepo), RepoURL: p.Project.WebURL, Push: true,
		Branch: branch, BranchCreated: p.Before == zeroSHA, Author: author,
		DefaultBranch: p.Project.DefaultBranch}
	for _, c := range p.Commits {
		if c.ID == "" {
			continue
		}
		ev.Commits = append(ev.Commits, Commit{SHA: c.ID, Message: c.Message, URL: c.URL, Author: c.Author.Name})
	}
	return ev, nil
}

type labUser struct {
	Username string `json:"username"`
}

type labFlagChange struct {
	Previous bool `json:"previous"`
	Current  bool `json:"current"`
}

type labMR struct {
	User             labUser    `json:"user"`
	Project          labProject `json:"project"`
	ObjectAttributes struct {
		IID            int64  `json:"iid"`
		Title          string `json:"title"`
		Description    string `json:"description"`
		URL            string `json:"url"`
		State          string `json:"state"`  // opened | closed | merged | locked
		Action         string `json:"action"` // open | reopen | close | merge | update | approved | approval | unapproved | unapproval
		SourceBranch   string `json:"source_branch"`
		TargetBranch   string `json:"target_branch"`
		Draft          bool   `json:"draft"`
		WorkInProgress bool   `json:"work_in_progress"` // the name before GitLab 14 (WIP → Draft)
		MergeCommitSHA string `json:"merge_commit_sha"`
		SquashSHA      string `json:"squash_commit_sha"`
		LastCommit     struct {
			ID string `json:"id"`
		} `json:"last_commit"`
	} `json:"object_attributes"`
	Changes struct {
		Draft          *labFlagChange `json:"draft"`
		WorkInProgress *labFlagChange `json:"work_in_progress"`
		Reviewers      *struct {
			Previous []labUser `json:"previous"`
			Current  []labUser `json:"current"`
		} `json:"reviewers"`
	} `json:"changes"`
}

func usernames(us []labUser) []string {
	out := make([]string, 0, len(us))
	for _, u := range us {
		if u.Username != "" {
			out = append(out, u.Username)
		}
	}
	return out
}

func parseLabMR(body []byte) (*Event, error) {
	var p labMR
	if err := json.Unmarshal(body, &p); err != nil {
		return nil, ErrPayload
	}
	a := p.ObjectAttributes
	if p.Project.PathWithNamespace == "" || a.IID == 0 {
		return nil, ErrPayload
	}
	out := &PullRequest{Number: a.IID, Title: a.Title, Body: a.Description, URL: a.URL, Branch: a.SourceBranch,
		Author: p.User.Username, State: StateOpen, Draft: a.Draft || a.WorkInProgress, Target: a.TargetBranch, Actor: p.User.Username}
	switch a.State {
	case "merged":
		out.State = StateMerged
	case "closed":
		out.State = StateClosed
	}
	if strings.Contains(a.Action, "approv") {
		out.Author = "" // the approver is the actor, not who the link shows (an empty author keeps the stored one)
	}
	switch a.Action {
	case "open", "reopen":
		out.Event = EventPROpened
		if out.Draft {
			out.Event = EventPRDraftOpened
		}
	case "merge":
		out.Event, out.State = EventPRMerged, StateMerged
	case "close":
		out.Event, out.State = EventPRClosed, StateClosed
	case "approved", "approval":
		// GitLab sends «approval» per approver and «approved» once the approval rules are met —
		// often both for one click; the key per approver makes them one event.
		u := p.User.Username
		if u == "" {
			return nil, nil
		}
		out.Event, out.Users, out.Once = EventPRApproved, []string{u}, []string{OnceKey("approved", u)}
	case "unapproved", "unapproval":
		u := p.User.Username
		if u == "" {
			return nil, nil
		}
		out.Forget = []string{OnceKey("approved", u)}
	case "update":
		c := p.Changes
		ready := (c.Draft != nil && c.Draft.Previous && !c.Draft.Current) ||
			(c.WorkInProgress != nil && c.WorkInProgress.Previous && !c.WorkInProgress.Current)
		if c.Reviewers != nil {
			was, now := usernames(c.Reviewers.Previous), usernames(c.Reviewers.Current)
			for _, u := range now {
				if !slices.Contains(was, u) {
					out.Users, out.Once = append(out.Users, u), append(out.Once, OnceKey("review", u))
				}
			}
			for _, u := range was {
				if !slices.Contains(now, u) {
					out.Forget = append(out.Forget, OnceKey("review", u))
				}
			}
		}
		switch {
		case ready:
			// One event per delivery: the draft change wins over reviewers added in the same edit
			// (their keys stay unseen, so a later request of the same reviewer still fires).
			out.Event, out.Users, out.Once = EventPRReady, nil, nil
		case len(out.Once) > 0:
			out.Event = EventPRReviewRequested
		}
	default:
		return nil, nil
	}
	if out.State == StateMerged {
		out.SHAs = SHAs(a.MergeCommitSHA, a.SquashSHA, a.LastCommit.ID)
	}
	return &Event{Provider: GitLab, Repo: clip(p.Project.PathWithNamespace, MaxRepo), RepoURL: p.Project.WebURL, Author: out.Author, PR: out}, nil
}

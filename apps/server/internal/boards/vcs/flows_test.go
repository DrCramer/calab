package vcs

import (
	"strings"
	"testing"
)

// Board task #101: drafts, review requests, approvals and target branches.

// store is a stored link driven by deliveries through Apply, as boards.linkTask does.
type store struct{ p Prior }

func (s *store) deliver(l Link) string {
	ev, seen, changed := Apply(s.p, l)
	if changed {
		s.p = Prior{Found: true, State: l.State, Title: l.Title, URL: l.URL, Draft: l.Draft, Seen: seen}
	}
	return ev
}

func parsedLink(t *testing.T, provider, name, body string) Link {
	t.Helper()
	ev, err := Parse(provider, name, []byte(body))
	if err != nil || ev == nil {
		t.Fatalf("%s %s: %v %v", provider, name, ev, err)
	}
	ls := Links(ev, "DEV")
	if len(ls) != 1 {
		t.Fatalf("%d links", len(ls))
	}
	return ls[0]
}

func boolJSON(b bool) string {
	if b {
		return "true"
	}
	return "false"
}

func labMRBody(action string, draft bool, changes, user string) string {
	return `{"user":{"username":"` + user + `"},"project":{"path_with_namespace":"g/r","web_url":"https://gl.example/g/r"},` +
		`"object_attributes":{"iid":8,"title":"DEV-9 Filters","url":"https://gl.example/g/r/-/merge_requests/8","state":"opened",` +
		`"action":"` + action + `","source_branch":"feature/dev-9","target_branch":"main","draft":` + boolJSON(draft) + `},"changes":` + changes + `}`
}

func hubPRBody(action string, draft bool, extra string) string {
	return `{"action":"` + action + `","pull_request":{"number":43,"title":"DEV-9 Filters","html_url":"https://github.com/a/b/pull/43",` +
		`"state":"open","draft":` + boolJSON(draft) + `,"user":{"login":"octocat"},"head":{"ref":"dev-9"},"base":{"ref":"main"}},` +
		`"repository":{"full_name":"a/b"},"sender":{"login":"octocat"}` + extra + `}`
}

// The flows through Parse, Links and Apply: what each delivery fires (a repeat fires nothing).
func TestFlows(t *testing.T) {
	type step struct {
		provider, name, body string
		want                 string
	}
	lab := func(action string, draft bool, changes, user, want string) step {
		return step{GitLab, "Merge Request Hook", labMRBody(action, draft, changes, user), want}
	}
	hub := func(action string, draft bool, extra, want string) step {
		return step{GitHub, "pull_request", hubPRBody(action, draft, extra), want}
	}
	review := func(action, state, user, want string) step {
		return step{GitHub, "pull_request_review", hubPRBody(action, false, `,"review":{"state":"`+state+`","user":{"login":"`+user+`"}}`), want}
	}
	wip := func(body string) string { return strings.Replace(body, `"draft":false`, `"work_in_progress":true`, 1) }
	cases := []struct {
		name  string
		steps []step
	}{
		{"gitlab draft, then ready, each redelivered", []step{
			lab("open", true, `{}`, "root", EventPRDraftOpened),
			lab("open", true, `{}`, "root", ""),
			lab("update", false, `{"draft":{"previous":true,"current":false}}`, "root", EventPRReady),
			lab("update", false, `{"draft":{"previous":true,"current":false}}`, "root", ""),
		}},
		{"gitlab old work_in_progress flag", []step{
			{GitLab, "Merge Request Hook", wip(labMRBody("open", false, `{}`, "root")), EventPRDraftOpened},
			{GitLab, "Merge Request Hook", labMRBody("update", false, `{"work_in_progress":{"previous":true,"current":false}}`, "root"), EventPRReady},
		}},
		{"gitlab ready and a reviewer in one edit: ready wins, the request fires later", []step{
			lab("open", true, `{}`, "root", EventPRDraftOpened),
			lab("update", false, `{"draft":{"previous":true,"current":false},"reviewers":{"previous":[],"current":[{"username":"bo"}]}}`, "root", EventPRReady),
			lab("update", false, `{"reviewers":{"previous":[],"current":[{"username":"bo"}]}}`, "root", EventPRReviewRequested),
		}},
		{"gitlab back to draft is no event, ready again fires", []step{
			lab("open", false, `{}`, "root", EventPROpened),
			lab("update", true, `{"draft":{"previous":false,"current":true}}`, "root", ""),
			lab("update", false, `{"draft":{"previous":true,"current":false}}`, "root", EventPRReady),
		}},
		{"gitlab approval and approved of one click, another approver, unapproval, approval again", []step{
			lab("open", false, `{}`, "root", EventPROpened),
			lab("approval", false, `{}`, "akey", EventPRApproved),
			lab("approved", false, `{}`, "akey", ""),
			lab("approval", false, `{}`, "jo", EventPRApproved),
			lab("unapproval", false, `{}`, "akey", ""),
			lab("approval", false, `{}`, "akey", EventPRApproved),
		}},
		{"gitlab reviewer: added once, removed and added again", []step{
			lab("update", false, `{"reviewers":{"previous":[],"current":[{"username":"bo"}]}}`, "root", EventPRReviewRequested),
			lab("update", false, `{"reviewers":{"previous":[],"current":[{"username":"bo"}]}}`, "root", ""),
			lab("update", false, `{"reviewers":{"previous":[{"username":"bo"}],"current":[]}}`, "root", ""),
			lab("update", false, `{"reviewers":{"previous":[],"current":[{"username":"bo"}]}}`, "root", EventPRReviewRequested),
		}},
		{"github draft, ready, ready redelivered", []step{
			hub("opened", true, "", EventPRDraftOpened),
			hub("ready_for_review", false, "", EventPRReady),
			hub("ready_for_review", false, "", ""),
		}},
		{"github converted to draft and back", []step{
			hub("opened", false, "", EventPROpened),
			hub("converted_to_draft", true, "", ""),
			hub("ready_for_review", false, "", EventPRReady),
		}},
		{"github ready of a pull request first seen then", []step{hub("ready_for_review", false, "", EventPRReady)}},
		{"github review requested twice, approved twice, dismissed, approved again", []step{
			hub("review_requested", false, `,"requested_reviewer":{"login":"hubot"}`, EventPRReviewRequested),
			hub("review_requested", false, `,"requested_reviewer":{"login":"hubot"}`, ""),
			review("submitted", "approved", "hubot", EventPRApproved),
			review("submitted", "APPROVED", "Hubot", ""),
			review("dismissed", "dismissed", "hubot", ""),
			review("submitted", "approved", "hubot", EventPRApproved),
		}},
		{"github team review request", []step{
			hub("review_requested", false, `,"requested_team":{"slug":"core"}`, EventPRReviewRequested),
		}},
		{"gitea WIP title removed by an edit is ready; approval once", []step{
			{Gitea, "pull_request", strings.Replace(hubPRBody("opened", false, ""), "DEV-9 Filters", "WIP: DEV-9 Filters", 1), EventPRDraftOpened},
			{Gitea, "pull_request", hubPRBody("edited", false, ""), EventPRReady},
			{Gitea, "pull_request_approved", hubPRBody("reviewed", false, ""), EventPRApproved},
			{Gitea, "pull_request_approved", hubPRBody("reviewed", false, ""), ""},
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var s store
			for i, st := range c.steps {
				if got := s.deliver(parsedLink(t, st.provider, st.name, st.body)); got != st.want {
					t.Fatalf("step %d: %q, want %q", i, got, st.want)
				}
			}
		})
	}
}

func TestParseIgnored(t *testing.T) {
	for _, c := range []struct{ provider, name, body string }{
		{GitHub, "pull_request_review", hubPRBody("submitted", false, `,"review":{"state":"commented","user":{"login":"x"}}`)},
		{GitHub, "pull_request_review", hubPRBody("submitted", false, `,"review":{"state":"changes_requested","user":{"login":"x"}}`)},
		{GitHub, "pull_request", hubPRBody("review_requested", false, "")}, // no reviewer named
		{GitHub, "pull_request", hubPRBody("synchronize", false, "")},
		{GitLab, "Merge Request Hook", labMRBody("approval", false, `{}`, "")},
	} {
		if ev, err := Parse(c.provider, c.name, []byte(c.body)); ev != nil || err != nil {
			t.Errorf("%s %s: %v %v, want nothing", c.provider, c.name, ev, err)
		}
	}
}

func TestApplyBounds(t *testing.T) {
	// A key named only in the description never fires, not even a derived PR_READY.
	l := Link{Kind: KindPR, Ref: "1", State: StateOpen, Mention: true}
	if ev, _, changed := Apply(Prior{Found: true, State: StateOpen, Draft: true}, l); ev != "" || !changed {
		t.Fatalf("mention: %q %v", ev, changed)
	}
	// The one-shot keys are bounded, the newest kept.
	p := Prior{Found: true, State: StateOpen}
	for i := range MaxSeen + 5 {
		_, p.Seen, _ = Apply(p, Link{Kind: KindPR, State: StateOpen, Event: EventPRApproved, Once: []string{OnceKey("approved", itoa(i))}})
	}
	if len(p.Seen) != MaxSeen || p.Seen[len(p.Seen)-1] != "approved:"+itoa(MaxSeen+4) {
		t.Fatalf("seen %d %v", len(p.Seen), p.Seen[len(p.Seen)-1])
	}
	// Never nil: the column is NOT NULL.
	if _, seen, _ := Apply(Prior{}, Link{Kind: KindBranch}); seen == nil {
		t.Fatal("nil seen")
	}
}

func TestBranchMatch(t *testing.T) {
	cases := []struct {
		patterns []string
		branch   string
		want     bool
	}{
		{nil, "anything", true},
		{nil, "", true},
		{[]string{"main"}, "main", true},
		{[]string{"main"}, "preprod", false},
		{[]string{"main"}, "main2", false},
		{[]string{"main"}, "", false},
		{[]string{"release/*"}, "release/2.1", true},
		{[]string{"release/*"}, "release/2.1/hotfix", true},
		{[]string{"release/*"}, "release", false},
		{[]string{"release/*"}, "prerelease/1", false},
		{[]string{"*"}, "x", true},
		{[]string{"v?.x"}, "v2.x", true},
		{[]string{"v?.x"}, "v10.x", false},
		{[]string{"*-prod"}, "eu-prod", true},
		{[]string{"a*b*c"}, "aXbYbZc", true},
		{[]string{"a*b*c"}, "aXbYbZ", false},
		{[]string{"main", "release/*"}, "release/3", true},
		{[]string{"main", "release/*"}, "preprod", false},
		{[]string{"Main"}, "main", false}, // case matters, as in Git
	}
	for _, c := range cases {
		if got := BranchMatch(c.patterns, c.branch); got != c.want {
			t.Errorf("%v %q: %v, want %v", c.patterns, c.branch, got, c.want)
		}
	}
}

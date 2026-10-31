package vcs

import (
	"bytes"
	"encoding/json"
	"flag"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

var update = flag.Bool("update", false, "rewrite the golden files of testdata")

// Golden fixtures: each provider payload in testdata/<name>.json is parsed and turned into the
// links of board FNG; the result must equal testdata/<name>.golden.json (go test -update
// rewrites them after a deliberate change).
func TestParseGolden(t *testing.T) {
	cases := []struct {
		name, provider, event string
	}{
		{"github_push", GitHub, "push"},
		{"github_pr_opened", GitHub, "pull_request"},
		{"github_pr_merged", GitHub, "pull_request"},
		{"github_pr_synchronize", GitHub, "pull_request"},
		{"github_push_tag", GitHub, "push"},
		{"gitlab_push", GitLab, "Push Hook"},
		{"gitlab_mr_merged", GitLab, "Merge Request Hook"},
		{"gitea_pr_opened", Gitea, "pull_request"},
		{"gitea_push", Gitea, "push"},
		// Board task #101: drafts, review requests, approvals, target branches.
		{"github_pr_draft_opened", GitHub, "pull_request"},
		{"github_pr_ready", GitHub, "pull_request"},
		{"github_pr_review_requested", GitHub, "pull_request"},
		{"github_pr_review_approved", GitHub, "pull_request_review"},
		{"gitlab_mr_draft_opened", GitLab, "Merge Request Hook"},
		{"gitlab_mr_ready", GitLab, "Merge Request Hook"},
		{"gitlab_mr_reviewers", GitLab, "Merge Request Hook"},
		{"gitlab_mr_approval", GitLab, "Merge Request Hook"},
		{"gitea_pr_draft_opened", Gitea, "pull_request"},
		{"gitea_pr_review_requested", Gitea, "pull_request"},
		{"gitea_pr_approved", Gitea, "pull_request_approved"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			body, err := os.ReadFile(filepath.Join("testdata", c.name+".json"))
			if err != nil {
				t.Fatal(err)
			}
			ev, err := Parse(c.provider, c.event, body)
			if err != nil {
				t.Fatal(err)
			}
			out := struct {
				Event *Event
				Links []Link
			}{Event: ev}
			if ev != nil {
				out.Links = Links(ev, "FNG")
			}
			got, err := json.MarshalIndent(out, "", "  ")
			if err != nil {
				t.Fatal(err)
			}
			golden := filepath.Join("testdata", c.name+".golden.json")
			if *update {
				if err := os.WriteFile(golden, append(got, '\n'), 0o600); err != nil {
					t.Fatal(err)
				}
				return
			}
			want, err := os.ReadFile(golden) //nolint:gosec // a fixed testdata path
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(bytes.TrimSpace(want), bytes.TrimSpace(got)) {
				t.Errorf("%s differs from the golden file:\n%s", c.name, got)
			}
		})
	}
}

func TestParseMalformed(t *testing.T) {
	for _, c := range []struct{ provider, event string }{{GitHub, "push"}, {GitHub, "pull_request"}, {GitLab, "Push Hook"},
		{GitLab, "Merge Request Hook"}, {Gitea, "pull_request"}} {
		if _, err := Parse(c.provider, c.event, []byte("{not json")); err == nil {
			t.Errorf("%s %s: malformed JSON accepted", c.provider, c.event)
		}
	}
	if ev, err := Parse(GitHub, "ping", []byte(`{}`)); ev != nil || err != nil {
		t.Errorf("ping: %v %v", ev, err)
	}
	if ev, err := Parse(GitHub, "pull_request", []byte(`{"action":"opened","pull_request":{"title":"x"}}`)); ev != nil || err == nil {
		t.Errorf("a pull request without a repository: %v %v", ev, err)
	}
}

func TestVerify(t *testing.T) {
	body, secret := []byte(`{"a":1}`), []byte("s3cret-s3cret-s3cret")
	sig := Sign(body, secret)
	h := func(k, v string) http.Header { x := http.Header{}; x.Set(k, v); return x }
	cases := []struct {
		name     string
		provider string
		h        http.Header
		body     []byte
		want     bool
	}{
		{"github ok", GitHub, h("X-Hub-Signature-256", "sha256="+sig), body, true},
		{"github no prefix", GitHub, h("X-Hub-Signature-256", sig), body, false},
		{"github other body", GitHub, h("X-Hub-Signature-256", "sha256="+sig), []byte(`{"a":2}`), false},
		{"github sha1 header only", GitHub, h("X-Hub-Signature", "sha1="+sig), body, false},
		{"github bad hex", GitHub, h("X-Hub-Signature-256", "sha256=zz"), body, false},
		{"gitea ok", Gitea, h("X-Gitea-Signature", sig), body, true},
		{"forgejo ok", Gitea, h("X-Forgejo-Signature", sig), body, true},
		{"gitea missing", Gitea, http.Header{}, body, false},
		{"gitlab ok", GitLab, h("X-Gitlab-Token", string(secret)), body, true},
		{"gitlab wrong", GitLab, h("X-Gitlab-Token", "s3cret-s3cret-s3creT"), body, false},
		{"gitlab empty", GitLab, http.Header{}, body, false},
		{"unknown provider", "bitbucket", h("X-Hub-Signature-256", "sha256="+sig), body, false},
	}
	for _, c := range cases {
		if got := Verify(c.provider, c.h, c.body, secret); got != c.want {
			t.Errorf("%s: %v, want %v", c.name, got, c.want)
		}
	}
	if Verify(GitHub, h("X-Hub-Signature-256", "sha256="+Sign(body, nil)), body, nil) {
		t.Error("an empty secret verifies")
	}
}

func TestKeys(t *testing.T) {
	cases := []struct {
		text string
		want []int32
	}{
		{"FNG-12 and FNG-7, again FNG-12", []int32{12, 7}},
		{"fng-12 lower case in prose", nil},
		{"XFNG-12 is another board, FNG-0 is no task", nil},
		{"feature/FNG-3-login", []int32{3}},
		{"(FNG-4)", []int32{4}},
		{"OPS-3 BAR-1", nil},
		{"FNG-99999999999", nil},
		{"FNG-5x", nil},
	}
	for _, c := range cases {
		if got := Keys(c.text, "FNG"); !slices.Equal(got, c.want) {
			t.Errorf("%q: %v, want %v", c.text, got, c.want)
		}
	}
}

func TestLinksBounds(t *testing.T) {
	ev := &Event{Provider: GitHub, Repo: "a/b", Push: true, Branch: "main"}
	for i := range 150 {
		ev.Commits = append(ev.Commits, Commit{SHA: string(rune('a'+i%26)) + "sha", Message: "FNG-" + itoa(i+1), URL: "javascript:alert(1)"})
	}
	ls := Links(ev, "FNG")
	if len(ls) != MaxTasks {
		t.Fatalf("%d links, want %d (distinct tasks bound)", len(ls), MaxTasks)
	}
	for _, l := range ls {
		if l.URL != "" {
			t.Fatalf("an unsafe URL kept: %q", l.URL)
		}
	}
	long := &Event{Provider: GitHub, Repo: "a/b", PR: &PullRequest{Number: 1, Title: string(bytes.Repeat([]byte("я"), 300)) + " FNG-1",
		URL: "https://x.example/" + string(bytes.Repeat([]byte("a"), 3000))}}
	l := Links(long, "FNG")
	if len(l) != 1 || len([]rune(l[0].Title)) != MaxTitle || l[0].URL != "" {
		t.Fatalf("clipping: %d %d %q", len(l), len([]rune(l[0].Title)), l[0].URL)
	}
}

func itoa(n int) string {
	b, _ := json.Marshal(n)
	return string(b)
}

func TestKeysFold(t *testing.T) {
	cases := []struct {
		text string
		want []int32
	}{
		{"feature/dev-4188-novaya-kartochka", []int32{4188}},
		{"dev-4188", []int32{4188}},
		{"DEV-4188", []int32{4188}},
		{"Dev-4188", []int32{4188}},
		{"feature/xdev-4188", nil},
		{"feature/dev-4188y", nil},
		{"feature/v-12-utf-8", nil},
		{"fix/ops-3-and-dev-7", []int32{7}},
		{"release/2024-10", nil},
	}
	for _, c := range cases {
		if got := KeysFold(c.text, "DEV"); !slices.Equal(got, c.want) {
			t.Errorf("%q: %v, want %v", c.text, got, c.want)
		}
	}
}

func TestMagicKeys(t *testing.T) {
	cases := []struct {
		text string
		want []int32
	}{
		{"Fixes DEV-1", []int32{1}},
		{"closes: dev-2", []int32{2}},
		{"Resolved DEV-3, DEV-4 and DEV-5", []int32{3, 4, 5}},
		{"Related to DEV-4489", nil},
		{"see DEV-4489, the fixes DEV-9 are elsewhere", []int32{9}},
		{"prefixes DEV-8", nil},
		{"Fixes OPS-1", nil},
		{"Fixes\nDEV-6", []int32{6}},
	}
	for _, c := range cases {
		if got := MagicKeys(c.text, "DEV"); !slices.Equal(got, c.want) {
			t.Errorf("%q: %v, want %v", c.text, got, c.want)
		}
	}
}

type lk struct {
	N     int32
	Kind  string
	Event string
}

func shape(ls []Link) []lk {
	var o []lk
	for _, l := range ls {
		o = append(o, lk{l.Number, l.Kind, l.Event})
	}
	return o
}

// The real cases of board task #101.
func TestLinksPR(t *testing.T) {
	pr := func(title, branch, body string) *Event {
		return &Event{Provider: GitLab, Repo: "gptunnel/gpt", PR: &PullRequest{Number: 685, Title: title, Branch: branch, Body: body,
			State: StateMerged, Event: EventPRMerged}}
	}
	cases := []struct {
		name string
		ev   *Event
		want []lk
	}{
		{"!685: DEV-4489 only mentioned in the description links without a trigger",
			pr("DEV-4903: fix", "feature/dev-4903-fix", "Follow-up of DEV-4489"),
			[]lk{{4903, KindPR, EventPRMerged}, {4489, KindPR, ""}}},
		{"!677: mention only", pr("Cleanup", "chore/cleanup", "was DEV-2454"), []lk{{2454, KindPR, ""}}},
		{"!686: lower-case branch, mention of another task",
			pr("New card", "feature/dev-4188-novaya-kartochka", "relates to DEV-3814"),
			[]lk{{4188, KindPR, EventPRMerged}, {3814, KindPR, ""}}},
		{"magic word in the description drives", pr("Cleanup", "chore/x", "Fixes DEV-4489"), []lk{{4489, KindPR, EventPRMerged}}},
		{"title key drives", pr("DEV-12 thing", "x", ""), []lk{{12, KindPR, EventPRMerged}}},
		{"a key in the branch and a mention is one link", pr("t", "dev-5-x", "DEV-5 again"), []lk{{5, KindPR, EventPRMerged}}},
		{"other boards ignored", pr("OPS-1", "ops-1", "Fixes OPS-2"), nil},
	}
	for _, c := range cases {
		if got := shape(Links(c.ev, "DEV")); !slices.Equal(got, c.want) {
			t.Errorf("%s:\n got %v\nwant %v", c.name, got, c.want)
		}
	}
}

func TestLinksBranchCreated(t *testing.T) {
	ev := &Event{Provider: GitLab, Repo: "g/r", Push: true, Branch: "feature/dev-4188-novaya-kartochka", BranchCreated: true}
	if got, want := shape(Links(ev, "DEV")), []lk{{4188, KindBranch, EventBranchCreated}}; !slices.Equal(got, want) {
		t.Fatalf("%v, want %v", got, want)
	}
}

// Board task #101, item 3: the merge commit of main (DEV-4743, DEV-4749, DEV-4943) and the
// commits of main pushed with it are not linked to the feature branch.
func TestLinksMergeFromDefault(t *testing.T) {
	mergeMsg := "Merge origin/main into gromdiktor-preprod-feature-branch\n\nDEV-4743 DEV-4749 DEV-4943"
	cm := func(sha, msg string) Commit { return Commit{SHA: sha, Message: msg} }
	cases := []struct {
		name    string
		branch  string
		def     string
		commits []Commit
		want    []int32 // task numbers of commit links
	}{
		{"merge commit alone", "gromdiktor-preprod-feature-branch", "main", []Commit{cm("ef8ba08", mergeMsg)}, nil},
		{"main commits before the merge", "gromdiktor-preprod-feature-branch", "main",
			[]Commit{cm("a1", "DEV-4743 x"), cm("a2", "DEV-4749 y"), cm("ef8ba08", mergeMsg), cm("b1", "DEV-1 own after merge")}, []int32{1}},
		{"default message", "f", "main",
			[]Commit{cm("a1", "DEV-2 x"), cm("m", "Merge branch 'main' into f")}, nil},
		{"remote-tracking", "f", "main",
			[]Commit{cm("a1", "DEV-2 x"), cm("m", "Merge remote-tracking branch 'origin/main' into f")}, nil},
		{"default branch unknown, master", "f", "",
			[]Commit{cm("a1", "DEV-2 x"), cm("m", "Merge branch 'master' of host:g/r into f")}, nil},
		{"another branch merged is a normal push", "f", "main",
			[]Commit{cm("a1", "DEV-2 x"), cm("m", "Merge branch 'main-fix' into f")}, []int32{2}},
		{"feature merged into main keeps links", "main", "main",
			[]Commit{cm("a1", "DEV-2 x"), cm("m", "Merge branch 'dev-2' into 'main'")}, []int32{2}},
		{"push to the default branch itself", "main", "main",
			[]Commit{cm("a1", "DEV-2 x"), cm("m", "Merge branch 'main' into main")}, []int32{2}},
		{"host marks commits old", "f", "main",
			[]Commit{{SHA: "a1", Message: "DEV-2 x", Old: true}, cm("a2", "DEV-3 y")}, []int32{3}},
		{"plain push unchanged", "f", "main", []Commit{cm("a1", "DEV-2 x"), cm("a2", "DEV-3 y")}, []int32{2, 3}},
	}
	for _, c := range cases {
		ev := &Event{Provider: GitLab, Repo: "g/r", Push: true, Branch: c.branch, DefaultBranch: c.def, Commits: c.commits}
		var got []int32
		for _, l := range Links(ev, "DEV") {
			if l.Kind == KindCommit {
				got = append(got, l.Number)
			}
		}
		if !slices.Equal(got, c.want) {
			t.Errorf("%s: %v, want %v", c.name, got, c.want)
		}
	}
}

func TestParseHubDistinct(t *testing.T) {
	body := []byte(`{"ref":"refs/heads/f","repository":{"full_name":"a/b","default_branch":"main"},"commits":[
	{"id":"1","message":"DEV-1 old","distinct":false},{"id":"2","message":"DEV-2 new","distinct":true},{"id":"3","message":"DEV-3"}]}`)
	ev, err := Parse(GitHub, "push", body)
	if err != nil || ev == nil || ev.DefaultBranch != "main" {
		t.Fatalf("%v %v", ev, err)
	}
	var got []int32
	for _, l := range Links(ev, "DEV") {
		got = append(got, l.Number)
	}
	if !slices.Equal(got, []int32{2, 3}) {
		t.Fatalf("%v", got)
	}
}

// Release matching (board task #101): the merge commits of a pull request are kept full and
// lower-case; a delivery that only brings them updates the stored row without an event.
func TestMergeSHAs(t *testing.T) {
	a, b := "4929CF3A0B1C2D3E4F5A6B7C8D9E0F1A2B3C4D5E", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	if got := SHAs(a, "", "4929cf3", b, a, "zz"+b[2:]); !slices.Equal(got, []string{"4929cf3a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e", b}) {
		t.Fatalf("SHAs: %q", got)
	}
	if ValidSHA(a) || !ValidSHA(b) || ValidSHA(b[:39]) || !ValidSHA(b+b[:24]) {
		t.Fatal("ValidSHA")
	}
	l := Link{Kind: KindPR, State: StateMerged, Title: "t", SHAs: []string{b}}
	p := Prior{Found: true, State: StateMerged, Title: "t", Seen: []string{}}
	if ev, _, changed := Apply(p, l); !changed || ev != "" {
		t.Fatalf("new SHAs: %q %v", ev, changed)
	}
	p.SHAs = []string{b}
	if _, _, changed := Apply(p, l); changed {
		t.Fatal("same SHAs changed the link")
	}
	l.SHAs = nil
	if _, _, changed := Apply(p, l); changed {
		t.Fatal("an event without SHAs changed the link")
	}
}

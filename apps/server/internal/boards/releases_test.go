package boards

import (
	"slices"
	"strings"
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/boards/vcs"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// Releases and the GitLab backlink of board task #101 (stage B).

func TestValidRelease(t *testing.T) {
	full := strings.Repeat("ab", 20)
	ok := func(r *v1.CreateBoardReleaseRequest) releaseInput {
		t.Helper()
		in, err := validRelease(r, "DEV")
		if err != nil {
			t.Fatalf("%v: %v", r, err)
		}
		return in
	}
	in := ok(&v1.CreateBoardReleaseRequest{Sha: strings.ToUpper(full), Commits: []string{full, " " + strings.Repeat("c", 40)},
		TaskKeys: []string{"dev-12", "DEV-12", "DEV-7"}, Name: " line\none ", Url: "https://ci.example/p/1"})
	if in.sha != full || in.env != "prod" || in.name != "line one" || !slices.Equal(in.shas, []string{full, strings.Repeat("c", 40)}) ||
		!slices.Equal(in.numbers, []int32{12, 7}) || in.keys[12] != "DEV-12" {
		t.Fatalf("normalized: %+v", in)
	}
	if in := ok(&v1.CreateBoardReleaseRequest{Sha: full, Name: "v1\u202egnp.exe\u2066"}); in.name != "v1gnp.exe" {
		t.Fatalf("bidi controls kept: %q", in.name)
	}
	if in := ok(&v1.CreateBoardReleaseRequest{Sha: full}); in.name != full[:7] {
		t.Fatalf("default name %q", in.name)
	}
	bad := []*v1.CreateBoardReleaseRequest{
		{Sha: full[:39]},
		{Sha: full, Environment: "Prod Env"},
		{Sha: full, Environment: strings.Repeat("e", 33)},
		{Sha: full, Url: "ftp://x"},
		{Sha: full, Name: strings.Repeat("я", 65)},
		{Sha: full, Commits: []string{"4929cf3"}},
		{Sha: full, Commits: make([]string, MaxReleaseCommits+1)},
		{Sha: full, TaskKeys: []string{"OPS-1"}},
		{Sha: full, TaskKeys: []string{"DEV-1 DEV-2"}},
		{Sha: full, TaskKeys: []string{"DEV-01"}},
		{Sha: full, TaskKeys: make([]string, MaxReleaseKeys+1)},
	}
	for _, r := range bad {
		if _, err := validRelease(r, "DEV"); err == nil {
			t.Errorf("accepted %v", r)
		}
	}
}

func TestValidEnvironments(t *testing.T) {
	got, err := validEnvironments([]string{" PROD ", "", "prod", "stage-1"})
	if err != nil || !slices.Equal(got, []string{"prod", "stage-1"}) {
		t.Fatalf("%q %v", got, err)
	}
	if _, err := validEnvironments([]string{"pr od"}); err == nil {
		t.Fatal("a space accepted")
	}
	many := make([]string, MaxReleaseEnvs+1)
	for i := range many {
		many[i] = "e" + string(rune('a'+i))
	}
	if _, err := validEnvironments(many); err == nil {
		t.Fatal("11 environments accepted")
	}
}

func TestMatchReleaseTrigger(t *testing.T) {
	no := func() bool { return false }
	rel := func(envs ...string) *v1.RuleTrigger {
		return &v1.RuleTrigger{Kind: &v1.RuleTrigger_Release_{Release: &v1.RuleTrigger_Release{Environments: envs}}}
	}
	prod := act("release", "", `{"release_id":"r","name":"4929cf3","environment":"prod"}`)
	stage := act("release", "", `{"name":"1","environment":"stage"}`)
	for _, c := range []struct {
		tr   *v1.RuleTrigger
		ev   ruleEvent
		want bool
	}{
		{rel(), prod, true}, {rel(), stage, true}, {rel("prod"), prod, true}, {rel("prod"), stage, false},
		{rel("prod", "stage"), stage, true}, {rel(), act("git", "", `{"event":"PR_MERGED"}`), false},
	} {
		if got := matchTrigger(c.tr, c.ev, no); got != c.want {
			t.Errorf("%v on %s: %v", c.tr, c.ev.after, got)
		}
	}
	v := map[string]string{}
	releaseTemplateVars(act("release", "", `{"name":"@everyone\nrelease"}`), v)
	if v["release"] != "@\u2060everyone release" {
		t.Fatalf("release var %q", v["release"])
	}
	releaseTemplateVars(act("git", "", `{"name":"x"}`), v)
	if v["release"] != "" {
		t.Fatalf("release var of another event %q", v["release"])
	}
	if got := renderTemplate("in {release}", map[string]string{"release": "1287"}); got != "in 1287" {
		t.Fatal(got)
	}
}

func TestBacklinkStatus(t *testing.T) {
	s := &Service{}
	g := sqlc.BoardGit{Provider: vcs.GitLab}
	if backlinkStatus(g) != "" || s.backlinkMode(g) != backlinkOff {
		t.Fatal("off by default")
	}
	g.Backlink = true
	if backlinkStatus(g) != backlinkNoToken || s.backlinkMode(g) != backlinkMissing {
		t.Fatal("no token")
	}
	g.ApiTokenEnc = []byte{1}
	if backlinkStatus(g) != backlinkNoURL {
		t.Fatal("no address")
	}
	g.GitlabUrl, g.BacklinkError = "https://git.example", "HTTP 500"
	if backlinkStatus(g) != "HTTP 500" {
		t.Fatal("the last error")
	}
	g.Provider = vcs.GitHub
	if backlinkStatus(g) != backlinkNotGitLab || s.backlinkMode(g) != backlinkOff {
		t.Fatal("GitHub")
	}
	s.PublicURL = "https://app.calab.io/"
	if got := s.noteText("DEV-1", "Plan\n@all"); got != "Задача Calab: DEV-1 — Plan @\u2060all https://app.calab.io/t/DEV-1" {
		t.Fatalf("note %q", got)
	}
}

func TestValidGitLabURL(t *testing.T) {
	s := &Service{}
	for in, want := range map[string]string{"https://git.example/": "https://git.example", "https://h.example/gitlab/": "https://h.example/gitlab", "": ""} {
		if got, err := s.validGitLabURL(in); err != nil || got != want {
			t.Errorf("%q: %q %v", in, got, err)
		}
	}
	for _, in := range []string{"http://git.example", "https://u:p@git.example", "https://git.example/?a=1", "git.example"} {
		if _, err := s.validGitLabURL(in); err == nil {
			t.Errorf("%q accepted", in)
		}
	}
}

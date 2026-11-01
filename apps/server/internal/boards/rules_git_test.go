package boards

import (
	"strings"
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/messages"
)

// Git triggers and template variables of board task #101.

func gitTrigger(e v1.RuleGitEvent, branches ...string) *v1.RuleTrigger {
	return &v1.RuleTrigger{Kind: &v1.RuleTrigger_Git_{Git: &v1.RuleTrigger_Git{Event: e, TargetBranches: branches}}}
}

func gitEntry(event, kind, target string) ruleEvent {
	return act("git", "", `{"event":"`+event+`","kind":"`+kind+`","target_branch":"`+target+`","ref":"7"}`)
}

func TestMatchGitTrigger(t *testing.T) {
	no := func() bool { t.Fatal("checklist asked"); return false }
	const (
		anyEv    = v1.RuleGitEvent_RULE_GIT_EVENT_UNSPECIFIED
		opened   = v1.RuleGitEvent_RULE_GIT_EVENT_PR_OPENED
		draft    = v1.RuleGitEvent_RULE_GIT_EVENT_PR_DRAFT_OPENED
		ready    = v1.RuleGitEvent_RULE_GIT_EVENT_PR_READY
		review   = v1.RuleGitEvent_RULE_GIT_EVENT_PR_REVIEW_REQUESTED
		approved = v1.RuleGitEvent_RULE_GIT_EVENT_PR_APPROVED
		merged   = v1.RuleGitEvent_RULE_GIT_EVENT_PR_MERGED
		branch   = v1.RuleGitEvent_RULE_GIT_EVENT_BRANCH_CREATED
	)
	cases := []struct {
		name    string
		trigger *v1.RuleTrigger
		ev      ruleEvent
		want    bool
	}{
		{"opened fires opened", gitTrigger(opened), gitEntry("PR_OPENED", "pr", "main"), true},
		{"a draft never fires opened", gitTrigger(opened), gitEntry("PR_DRAFT_OPENED", "pr", "main"), false},
		{"draft fires draft", gitTrigger(draft), gitEntry("PR_DRAFT_OPENED", "pr", "main"), true},
		{"ready fires opened (ready for review)", gitTrigger(opened), gitEntry("PR_READY", "pr", "main"), true},
		{"ready fires ready", gitTrigger(ready), gitEntry("PR_READY", "pr", "main"), true},
		{"opened is not ready", gitTrigger(ready), gitEntry("PR_OPENED", "pr", "main"), false},
		{"review requested", gitTrigger(review), gitEntry("PR_REVIEW_REQUESTED", "pr", "main"), true},
		{"approved", gitTrigger(approved), gitEntry("PR_APPROVED", "pr", "main"), true},
		{"approved is not merged", gitTrigger(merged), gitEntry("PR_APPROVED", "pr", "main"), false},
		{"any fires approved", gitTrigger(anyEv), gitEntry("PR_APPROVED", "pr", "main"), true},
		{"no event (a mention) fires nothing", gitTrigger(anyEv), gitEntry("", "pr", "main"), false},
		// Target branches.
		{"merged into main, filter main", gitTrigger(merged, "main"), gitEntry("PR_MERGED", "pr", "main"), true},
		{"merged into preprod, filter main", gitTrigger(merged, "main"), gitEntry("PR_MERGED", "pr", "preprod"), false},
		{"merged into preprod, no filter", gitTrigger(merged), gitEntry("PR_MERGED", "pr", "preprod"), true},
		{"glob", gitTrigger(merged, "release/*"), gitEntry("PR_MERGED", "pr", "release/2.1"), true},
		{"glob other", gitTrigger(merged, "release/*"), gitEntry("PR_MERGED", "pr", "main"), false},
		{"several", gitTrigger(merged, "main", "release/*"), gitEntry("PR_MERGED", "pr", "release/2.1"), true},
		{"entry of old (no target)", gitTrigger(merged, "main"), act("git", "", `{"event":"PR_MERGED","kind":"pr"}`), false},
		{"a branch has no target", gitTrigger(anyEv, "main"), gitEntry("BRANCH_CREATED", "branch", ""), false},
		{"a branch without a filter", gitTrigger(branch), gitEntry("BRANCH_CREATED", "branch", ""), true},
	}
	for _, c := range cases {
		if got := matchTrigger(c.trigger, c.ev, no); got != c.want {
			t.Errorf("%s: %v, want %v", c.name, got, c.want)
		}
	}
}

func TestGitTemplateVars(t *testing.T) {
	pr := act("git", "", `{"event":"PR_OPENED","kind":"pr","ref":"690","url":"https://gl.example/g/r/-/merge_requests/690",`+
		`"title":"DEV-1 Fix\n@everyone look @01890000-0000-7000-8000-00000000abcd\u0007","branch":"feature/dev-1","target_branch":"main","author":"jsmith"}`)
	v := gitTemplateVars(pr)
	out := renderTemplate("Открыт MR !{pr_number}: {pr_title} ({branch} → {target_branch}, {git_author}) {pr_url} {unknown}", v)
	want := "Открыт MR !690: DEV-1 Fix @\u2060everyone look @\u206001890000-0000-7000-8000-00000000abcd (feature/dev-1 → main, jsmith) " +
		"https://gl.example/g/r/-/merge_requests/690 {unknown}"
	if out != want {
		t.Fatalf("got  %q\nwant %q", out, want)
	}
	if users, everyone := messages.ParseMentions(out); len(users) > 0 || everyone {
		t.Fatalf("an MR title mentions: %v %v", users, everyone)
	}
	// A push: the branch and the author, no pull request.
	push := gitTemplateVars(act("git", "", `{"event":"COMMIT_PUSHED","kind":"commit","ref":"dev-1","branch":"dev-1","author":"jo"}`))
	if push["branch"] != "dev-1" || push["git_author"] != "jo" || push["pr_url"] != "" || push["pr_number"] != "" || push["target_branch"] != "" {
		t.Fatalf("push: %v", push)
	}
	// Other triggers: every Git variable is there and empty (rendered as nothing, not «{pr_url}»).
	other := gitTemplateVars(act("status", "", `{"status_id":"x"}`))
	if len(other) != len(gitVars) || renderTemplate("[{pr_url}{branch}{git_author}]", other) != "[]" {
		t.Fatalf("other: %v", other)
	}
	// Long titles are cut; the whole text keeps the template limit.
	long := gitTemplateVars(act("git", "", `{"kind":"pr","title":"`+strings.Repeat("я", 500)+`"}`))
	if n := len([]rune(long["pr_title"])); n != 200 {
		t.Fatalf("title %d runes", n)
	}
	if n := len([]rune(renderTemplate(strings.Repeat("{pr_title}", 20), long))); n != MaxRuleTemplate {
		t.Fatalf("rendered %d runes", n)
	}
}

func TestValidBranchPatterns(t *testing.T) {
	got, err := validBranchPatterns([]string{" main ", "", "release/*", "main"})
	if err != nil || strings.Join(got, ",") != "main,release/*" {
		t.Fatalf("%v %v", got, err)
	}
	for _, bad := range [][]string{{"ma in"}, {"a\tb"}, {strings.Repeat("x", MaxRuleBranch+1)},
		strings.Split("a,b,c,d,e,f,g,h,i,j,k", ",")} {
		if _, err := validBranchPatterns(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

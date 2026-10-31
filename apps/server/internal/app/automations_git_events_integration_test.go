//go:build integration

package app_test

import (
	"context"
	"slices"
	"strings"
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// Board task #101 (ADR-0060 §4): draft merge requests, review requests, approvals, the target
// branch filter and the Git template variables, through GitLab deliveries.

func labMR(key, action string, draft bool, target, user, changes, pad string) []byte {
	d := "false"
	if draft {
		d = "true"
	}
	return []byte(`{"object_kind":"merge_request"` + pad + `,"user":{"username":"` + user + `"},` +
		`"project":{"path_with_namespace":"gptunnel/gpt","web_url":"https://git.example/gptunnel/gpt"},` +
		`"object_attributes":{"iid":690,"title":"` + key + ` New card @everyone","url":"https://git.example/gptunnel/gpt/-/merge_requests/690",` +
		`"state":"` + map[bool]string{true: "merged", false: "opened"}[action == "merge"] + `","action":"` + action +
		`","source_branch":"feature/` + strings.ToLower(key) + `-new-card","target_branch":"` + target + `","draft":` + d + `},"changes":` + changes + `}`)
}

func gitRule(t *testing.T, u musty, boardID, name string, e v1.RuleGitEvent, branches []string, acts ...*v1.RuleAction) {
	t.Helper()
	createRule(t, u, boardID, &v1.CreateBoardRuleRequest{Name: name,
		Trigger: &v1.RuleTrigger{Kind: &v1.RuleTrigger_Git_{Git: &v1.RuleTrigger_Git{Event: e, TargetBranches: branches}}}, Actions: acts}, 201)
}

func TestBoardGitEvents(t *testing.T) {
	o, _, ws, _ := setupTeam(t)
	b := createBoard(t, o, ws.GetId(), &v1.CreateBoardRequest{Name: "Dev", Key: "DEV"}, 201)
	doing := statusOf(b, v1.BoardStatusType_BOARD_STATUS_TYPE_STARTED)
	done := statusOf(b, v1.BoardStatusType_BOARD_STATUS_TYPE_COMPLETED)
	todo := statusOf(b, v1.BoardStatusType_BOARD_STATUS_TYPE_UNSTARTED)
	o.must(200, "PUT", "/api/boards/"+b.GetId()+"/git", &v1.SetBoardGitRequest{Provider: v1.GitProvider_GIT_PROVIDER_GITLAB, Secret: "gitlab-token-0123456789"}, nil)
	hook := "/api/git/boards/" + b.GetId() + "/gitlab"
	send := func(body []byte) {
		t.Helper()
		h := map[string]string{"X-Gitlab-Event": "Merge Request Hook", "X-Gitlab-Token": "gitlab-token-0123456789"}
		if st := hookPost(t, hook, h, body); st != 204 {
			t.Fatalf("delivery: %d", st)
		}
	}

	// The filter is validated: spaces are refused, blanks and repeats dropped.
	createRule(t, o, b.GetId(), &v1.CreateBoardRuleRequest{Name: "bad", Actions: []*v1.RuleAction{doStatus(done)},
		Trigger: &v1.RuleTrigger{Kind: &v1.RuleTrigger_Git_{Git: &v1.RuleTrigger_Git{TargetBranches: []string{"ma in"}}}}}, 422)

	gitRule(t, o, b.GetId(), "draft → doing", v1.RuleGitEvent_RULE_GIT_EVENT_PR_DRAFT_OPENED, nil, doStatus(doing))
	gitRule(t, o, b.GetId(), "opened → high", v1.RuleGitEvent_RULE_GIT_EVENT_PR_OPENED, nil, doPriority(v1.TaskPriority_TASK_PRIORITY_HIGH))
	gitRule(t, o, b.GetId(), "approved → comment", v1.RuleGitEvent_RULE_GIT_EVENT_PR_APPROVED, nil,
		doComment("Approved MR !{pr_number}: {pr_title} {pr_url} ({branch} → {target_branch}) by {git_author}"))
	gitRule(t, o, b.GetId(), "review → comment", v1.RuleGitEvent_RULE_GIT_EVENT_PR_REVIEW_REQUESTED, nil, doComment("review {git_author}"))
	gitRule(t, o, b.GetId(), "merged into main → done", v1.RuleGitEvent_RULE_GIT_EVENT_PR_MERGED, []string{" main ", "", "release/*", "main"}, doStatus(done))

	task := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "New card", StatusId: todo}, 201)
	key := task.GetKey()
	cur := func() *v1.Task { return getTask(t, o, task.GetId()).GetTask() }

	// A draft: «draft» fires, «opened» does not.
	send(labMR(key, "open", true, "preprod", "jsmith", `{}`, ""))
	if c := cur(); c.GetStatusId() != doing || c.GetPriority() == v1.TaskPriority_TASK_PRIORITY_HIGH {
		t.Fatalf("after the draft: %v %v", c.GetStatusId(), c.GetPriority())
	}
	// Ready (draft true → false): a rule on «opened» fires.
	ready := labMR(key, "update", false, "preprod", "jsmith", `{"draft":{"previous":true,"current":false}}`, "")
	send(ready)
	if c := cur(); c.GetPriority() != v1.TaskPriority_TASK_PRIORITY_HIGH {
		t.Fatalf("after ready: %v", c.GetPriority())
	}
	o.must(200, "PATCH", "/api/tasks/"+task.GetId(), &v1.UpdateTaskRequest{Priority: v1.TaskPriority_TASK_PRIORITY_LOW.Enum()}, nil)
	// The same «ready» with another body (the body-hash dedup misses it): the stored draft flag
	// makes it a repeat.
	send(labMR(key, "update", false, "preprod", "jsmith", `{"draft":{"previous":true,"current":false}}`, `,"event_type":"merge_request"`))
	if c := cur(); c.GetPriority() != v1.TaskPriority_TASK_PRIORITY_LOW {
		t.Fatalf("a repeated ready fired: %v", c.GetPriority())
	}

	// A reviewer, then approvals: «approval» and «approved» of one click are one event, a second
	// approver another one, a redelivery none.
	send(labMR(key, "update", false, "preprod", "jsmith", `{"reviewers":{"previous":[],"current":[{"username":"akey"}]}}`, ""))
	send(labMR(key, "approval", false, "preprod", "akey", `{}`, ""))
	send(labMR(key, "approved", false, "preprod", "akey", `{}`, ""))
	send(labMR(key, "approval", false, "preprod", "akey", `{}`, `,"event_type":"merge_request"`))
	send(labMR(key, "approval", false, "preprod", "jo", `{}`, ""))
	cards := automationCards(t, o, task.GetId())
	approved := slices.DeleteFunc(slices.Clone(cards), func(s string) bool { return !strings.HasPrefix(s, "Approved") })
	if len(approved) != 2 || !slices.Contains(cards, "review jsmith") {
		t.Fatalf("cards: %q", cards)
	}
	want := "Approved MR !690: " + key + " New card @\u2060everyone https://git.example/gptunnel/gpt/-/merge_requests/690 (feature/" +
		strings.ToLower(key) + "-new-card → preprod) by "
	if !slices.Contains(approved, want+"akey") || !slices.Contains(approved, want+"jo") {
		t.Fatalf("approved cards: %q", approved)
	}
	// The approver did not replace the link's author.
	if l := cur().GetGitLinks(); len(l) != 1 || l[0].GetAuthor() != "jsmith" {
		t.Fatalf("links: %v", l)
	}

	// Merged into preprod: the filter «main» keeps the task where it is; into main it moves.
	send(labMR(key, "merge", false, "preprod", "jsmith", `{}`, ""))
	if c := cur(); c.GetStatusId() != doing {
		t.Fatalf("merged into preprod moved the task: %v", c.GetStatusId())
	}
	var stored int
	if err := testDB.Pool.QueryRow(context.Background(), `SELECT cardinality(seen) FROM task_git_links WHERE task_id = $1`, task.GetId()).Scan(&stored); err != nil || stored != 3 {
		t.Fatalf("seen keys %d (%v), want review:akey, approved:akey, approved:jo", stored, err)
	}
	other := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "Other", StatusId: todo}, 201)
	send(labMR(other.GetKey(), "merge", false, "main", "jsmith", `{}`, ""))
	if c := getTask(t, o, other.GetId()).GetTask(); c.GetStatusId() != done {
		t.Fatalf("merged into main: %v", c.GetStatusId())
	}
}

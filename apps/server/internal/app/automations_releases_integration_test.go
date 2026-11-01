//go:build integration

package app_test

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/boards"
	"github.com/calaba/calaba/server/internal/perm"
)

// Board task #101, stage B (ADR-0060 §4): releases posted by CI with a bot token, the release
// trigger with its environment filter and the status condition, the RELEASE filter, and the
// GitLab backlink note.

func sha(c byte) string { return strings.Repeat(string(c), 40) }

// labMerged is a GitLab «merge» delivery of MR iid whose source branch carries key; base is the
// GitLab origin of the merge request's address.
func labMerged(base, key string, iid int, merge, head string) []byte {
	n := strconv.Itoa(iid)
	return []byte(`{"object_kind":"merge_request","user":{"username":"jsmith"},` +
		`"project":{"path_with_namespace":"gptunnel/gpt","web_url":"` + base + `/gptunnel/gpt"},` +
		`"object_attributes":{"iid":` + n + `,"title":"Feature","url":"` + base + `/gptunnel/gpt/-/merge_requests/` + n + `",` +
		`"state":"merged","action":"merge","source_branch":"feature/` + strings.ToLower(key) + `-x","target_branch":"main",` +
		`"merge_commit_sha":"` + merge + `","last_commit":{"id":"` + head + `"}}}`)
}

func labPush(key, commit string) []byte {
	return []byte(`{"object_kind":"push","before":"` + sha('1') + `","after":"` + commit + `","ref":"refs/heads/main",` +
		`"user_username":"jsmith","project":{"path_with_namespace":"gptunnel/gpt","web_url":"https://git.example/gptunnel/gpt","default_branch":"main"},` +
		`"commits":[{"id":"` + commit + `","message":"` + key + ` hotfix","url":"https://git.example/c","author":{"name":"J"}}]}`)
}

func gitlabHook(t *testing.T, boardID, secret string) func(event string, body []byte) {
	return func(event string, body []byte) {
		t.Helper()
		h := map[string]string{"X-Gitlab-Event": event, "X-Gitlab-Token": secret}
		if st := hookPost(t, "/api/git/boards/"+boardID+"/gitlab", h, body); st != 204 {
			t.Fatalf("delivery: %d", st)
		}
	}
}

func TestBoardReleases(t *testing.T) {
	o, bob, ws, room := setupTeam(t)
	wid := ws.GetId()
	setPlan(t, wid, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_ENTERPRISE})
	b := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Dev", Key: "DEV"}, 201)
	ops := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Ops", Key: "OPS"}, 201)
	todo := statusOf(b, v1.BoardStatusType_BOARD_STATUS_TYPE_UNSTARTED)
	ready := statusOf(b, v1.BoardStatusType_BOARD_STATUS_TYPE_STARTED)
	deployed := statusOf(b, v1.BoardStatusType_BOARD_STATUS_TYPE_COMPLETED)
	o.must(200, "PUT", "/api/boards/"+b.GetId()+"/git", &v1.SetBoardGitRequest{Provider: v1.GitProvider_GIT_PROVIDER_GITLAB, Secret: "gitlab-token-0123456789"}, nil)
	o.must(200, "PUT", "/api/boards/"+ops.GetId()+"/git", &v1.SetBoardGitRequest{Provider: v1.GitProvider_GIT_PROVIDER_GITLAB, Secret: "gitlab-token-ops-0123456"}, nil) //nolint:gosec // a test secret
	send := gitlabHook(t, b.GetId(), "gitlab-token-0123456789")

	// The DEV rule: «entered a prod release → Deployed» if «status = Ready to Deploy».
	createRule(t, o, b.GetId(), &v1.CreateBoardRuleRequest{Name: "bad env", Actions: []*v1.RuleAction{doStatus(deployed)},
		Trigger: &v1.RuleTrigger{Kind: &v1.RuleTrigger_Release_{Release: &v1.RuleTrigger_Release{Environments: []string{"prod env"}}}}}, 422)
	rule := createRule(t, o, b.GetId(), &v1.CreateBoardRuleRequest{Name: "prod → deployed",
		Trigger:   &v1.RuleTrigger{Kind: &v1.RuleTrigger_Release_{Release: &v1.RuleTrigger_Release{Environments: []string{" PROD ", "prod"}}}},
		Condition: &v1.TaskFilter{Conditions: []*v1.TaskCondition{{Field: v1.TaskField_TASK_FIELD_STATUS, Op: v1.TaskOp_TASK_OP_IS, Values: []string{ready}}}},
		Actions:   []*v1.RuleAction{doStatus(deployed), doComment("Deployed in {release} @everyone")}}, 201)
	if envs := rule.GetTrigger().GetRelease().GetEnvironments(); !slices.Equal(envs, []string{"prod"}) {
		t.Fatalf("environments: %q", envs)
	}

	mk := func(title, status string) *v1.Task {
		return createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: title, StatusId: status}, 201)
	}
	viaMR, viaCommit, named, notShipped := mk("Via MR", ready), mk("Via commit", ready), mk("Named", todo), mk("Not shipped", ready)
	archived := mk("Archived", ready)
	opsTask := createTask(t, o, ops.GetId(), &v1.CreateTaskRequest{Title: "Ops task"}, 201)

	send("Merge Request Hook", labMerged("https://git.example", viaMR.GetKey(), 10, sha('a'), sha('b')))
	send("Merge Request Hook", labMerged("https://git.example", notShipped.GetKey(), 11, sha('e'), sha('f')))
	send("Merge Request Hook", labMerged("https://git.example", archived.GetKey(), 12, sha('9'), sha('8')))
	send("Push Hook", labPush(viaCommit.GetKey(), sha('c')))
	gitlabHook(t, ops.GetId(), "gitlab-token-ops-0123456")("Push Hook", labPush(opsTask.GetKey(), sha('c')))
	o.must(200, "POST", "/api/tasks/"+archived.GetId()+"/archive", nil, nil)

	path := "/api/boards/" + b.GetId() + "/releases"
	req := &v1.CreateBoardReleaseRequest{Name: "4929cf3", Sha: strings.ToUpper(sha('d')), Url: "https://git.example/pipelines/1287",
		Commits: []string{sha('a'), sha('c'), sha('9'), sha('7')}, TaskKeys: []string{strings.ToLower(named.GetKey()), "DEV-99999"}}

	// Who may post: a bot of the workspace without EDIT_TASKS — 403; a guest — 404; a bot of
	// another workspace — 404; a bot with the bit on another board only — 403 here.
	bt := createBot(t, o, wid, "ci")
	bt.must(403, "POST", path, req, nil)
	var link v1.CreateRoomInviteResponse
	o.must(201, "POST", "/api/rooms/"+room.GetId()+"/invites", &v1.CreateRoomInviteRequest{}, &link)
	var gj v1.JoinRoomInviteResponse
	(&client{t: t, ip: "10.66.1.1"}).must(201, "POST", "/api/room-invites/"+link.GetInvite().GetCode()+"/join", &v1.JoinRoomInviteRequest{Nickname: "Гость"}, &gj)
	guest := &user{client: &client{t: t, token: gj.GetTokens().GetAccessToken(), ip: "10.66.1.2"}, id: gj.GetMe().GetUser().GetId()}
	guest.must(404, "POST", path, req, nil)
	o2 := owner(t)
	ws2 := createWorkspace(t, o2, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	createBot(t, o2, ws2.GetId(), "stranger").must(404, "POST", path, req, nil)
	setBoardPerms(o, ops.GetId(), 200, userOv(bt.id, perm.EditTasks, 0))
	bt.must(403, "POST", path, req, nil)
	bob.must(403, "POST", path, req, nil) // a member: CREATE_TASKS, not EDIT_TASKS
	setBoardPerms(o, b.GetId(), 200, userOv(bt.id, perm.ViewBoard|perm.EditTasks, 0))

	// Validation (422) before anything is written.
	bad := func(mut func(r *v1.CreateBoardReleaseRequest)) {
		t.Helper()
		r := &v1.CreateBoardReleaseRequest{Sha: sha('d')}
		mut(r)
		bt.must(422, "POST", path, r, nil)
	}
	bad(func(r *v1.CreateBoardReleaseRequest) { r.Sha = "4929cf3" })
	bad(func(r *v1.CreateBoardReleaseRequest) { r.Environment = "Prod Env" })
	bad(func(r *v1.CreateBoardReleaseRequest) { r.Url = "javascript:alert(1)" })
	bad(func(r *v1.CreateBoardReleaseRequest) { r.Name = strings.Repeat("x", 65) })
	bad(func(r *v1.CreateBoardReleaseRequest) { r.Commits = []string{"nope"} })
	bad(func(r *v1.CreateBoardReleaseRequest) { r.TaskKeys = []string{opsTask.GetKey()} })
	bad(func(r *v1.CreateBoardReleaseRequest) {
		r.Commits = make([]string, 5001)
		for i := range r.Commits {
			r.Commits[i] = sha('a')
		}
	})
	var none v1.ListBoardReleasesResponse
	bt.must(200, "GET", path, nil, &none)
	if len(none.GetReleases()) != 0 {
		t.Fatalf("a refused call wrote a release: %v", none.GetReleases())
	}

	// The release: the merged MR (merge sha), the commit and the named key enter it; the
	// archived task, the MR outside the range and the other board's task do not.
	var rr v1.BoardReleaseResponse
	bt.must(200, "POST", path, req, &rr)
	keys := slices.Sorted(slices.Values(rr.GetAddedKeys()))
	want := slices.Sorted(slices.Values([]string{viaMR.GetKey(), viaCommit.GetKey(), named.GetKey()}))
	if !rr.GetCreated() || !slices.Equal(keys, want) || !slices.Equal(rr.GetUnknownKeys(), []string{"DEV-99999"}) || rr.GetTruncated() ||
		rr.GetRelease().GetTasksCount() != 3 || rr.GetRelease().GetEnvironment() != "prod" || rr.GetRelease().GetSha() != sha('d') ||
		rr.GetRelease().GetCreatedBy() != bt.id {
		t.Fatalf("release: %v", &rr)
	}
	relID := rr.GetRelease().GetId()
	// The rule: only tasks in «Ready to Deploy» moved; the comment has the release name, «@» neutralised.
	for _, x := range []*v1.Task{viaMR, viaCommit} {
		got := getTask(t, o, x.GetId()).GetTask()
		if got.GetStatusId() != deployed || len(got.GetReleases()) != 1 || got.GetReleases()[0].GetName() != "4929cf3" ||
			got.GetReleases()[0].GetUrl() != "https://git.example/pipelines/1287" || got.GetReleases()[0].GetReleaseId() != relID {
			t.Fatalf("%s: %v %v", x.GetKey(), got.GetStatusId(), got.GetReleases())
		}
		if c := automationCards(t, o, x.GetId()); !slices.Contains(c, "Deployed in 4929cf3 @everyone") {
			t.Fatalf("cards %q", c)
		}
	}
	if got := getTask(t, o, named.GetId()).GetTask(); got.GetStatusId() != todo || len(got.GetReleases()) != 1 {
		t.Fatalf("named (todo) moved or has no release: %v %v", got.GetStatusId(), got.GetReleases())
	}
	for _, x := range []*v1.Task{notShipped, opsTask} {
		if got := getTask(t, o, x.GetId()).GetTask(); len(got.GetReleases()) != 0 {
			t.Fatalf("%s entered the release", x.GetKey())
		}
	}
	// The journal: «release» by the bot.
	var page v1.TaskActivityPage
	o.must(200, "GET", "/api/tasks/"+viaCommit.GetId()+"/activity?limit=100", nil, &page)
	found := false
	for _, it := range page.GetItems() {
		if a := it.GetActivity(); a.GetKind() == "release" && a.GetActorId() == bt.id && a.GetAfter().GetFields()["name"].GetStringValue() == "4929cf3" {
			found = true
		}
	}
	if !found {
		t.Fatal("no release entry in the journal")
	}

	// A repeat: the same release, updated, nothing added, the rule does not run again.
	req.Name = "1287"
	var again v1.BoardReleaseResponse
	bt.must(200, "POST", path, req, &again)
	if again.GetCreated() || len(again.GetAddedKeys()) != 0 || again.GetRelease().GetId() != relID || again.GetRelease().GetName() != "1287" ||
		again.GetRelease().GetTasksCount() != 3 {
		t.Fatalf("repeat: %v", &again)
	}
	if runs := ruleRuns(t, o, rule.GetId()); len(runs) != 2 {
		t.Fatalf("rule runs %d, want 2 (a condition miss is not a run)", len(runs))
	}
	// A later prod release with the same commits adds nothing (once per environment); stage is
	// another environment — the tasks enter it, the prod-only rule stays quiet.
	req.Sha, req.Name = sha('2'), "next"
	bt.must(200, "POST", path, req, &again)
	if !again.GetCreated() || len(again.GetAddedKeys()) != 0 {
		t.Fatalf("second prod release: %v", &again)
	}
	req.Environment = "stage"
	bt.must(200, "POST", path, req, &again)
	if len(again.GetAddedKeys()) != 3 || len(ruleRuns(t, o, rule.GetId())) != 2 {
		t.Fatalf("stage: %v", &again)
	}
	if got := getTask(t, o, viaMR.GetId()).GetTask(); len(got.GetReleases()) != 2 {
		t.Fatalf("releases of a task in two environments: %v", got.GetReleases())
	}

	// The RELEASE filter and the list.
	f := &v1.TaskFilter{Conditions: []*v1.TaskCondition{{Field: v1.TaskField_TASK_FIELD_RELEASE, Op: v1.TaskOp_TASK_OP_IS, Values: []string{relID}}}}
	if got := taskKeys(listTasks(t, bob, b.GetId(), f)); len(got) != 3 || !got[named.GetKey()] {
		t.Fatalf("filter: %v", got)
	}
	f.Conditions[0].Op = v1.TaskOp_TASK_OP_EMPTY
	if got := taskKeys(listTasks(t, bob, b.GetId(), f)); !got[notShipped.GetKey()] || got[viaMR.GetKey()] {
		t.Fatalf("filter EMPTY: %v", got)
	}
	var list v1.ListBoardReleasesResponse
	bob.must(200, "GET", path+"?environment=prod", nil, &list)
	if len(list.GetReleases()) != 2 || list.GetReleases()[1].GetId() != relID {
		t.Fatalf("list: %v", list.GetReleases())
	}
	guest.must(404, "GET", path, nil, nil)

	// At most 20 environments per board (each re-enters every task): the 21st is 409, a new
	// release of a known one still passes. Its own board: the per-board rate limit.
	envs := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Envs", Key: "ENV"}, 201)
	envPath := "/api/boards/" + envs.GetId() + "/releases"
	for i := range boards.MaxBoardEnvs {
		o.must(200, "POST", envPath, &v1.CreateBoardReleaseRequest{Sha: sha('a'), Environment: "e" + strconv.Itoa(i)}, nil)
	}
	o.must(409, "POST", envPath, &v1.CreateBoardReleaseRequest{Sha: sha('a'), Environment: "e-new"}, nil)
	o.must(200, "POST", envPath, &v1.CreateBoardReleaseRequest{Sha: sha('b'), Environment: "e0"}, nil)
	var envList v1.ListBoardReleasesResponse
	o.must(200, "GET", envPath, nil, &envList)
	if n := len(envList.GetReleases()); n != boards.MaxBoardEnvs+1 {
		t.Fatalf("releases %d, want %d (the refused one rolled back)", n, boards.MaxBoardEnvs+1)
	}
}

// gitlabStub is a TLS GitLab answering notes with status.
type gitlabStub struct {
	srv    *httptest.Server
	mu     sync.Mutex
	status int
	paths  []string
	bodies []string
	tokens []string
}

func newGitLabStub(t *testing.T) *gitlabStub {
	g := &gitlabStub{status: 201}
	g.srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		var m map[string]string
		_ = json.Unmarshal(b, &m)
		g.mu.Lock()
		defer g.mu.Unlock()
		g.paths, g.bodies, g.tokens = append(g.paths, r.URL.EscapedPath()), append(g.bodies, m["body"]), append(g.tokens, r.Header.Get("Private-Token"))
		w.WriteHeader(g.status)
	}))
	t.Cleanup(g.srv.Close)
	botHookCAs.AddCert(g.srv.Certificate())
	return g
}

func (g *gitlabStub) count() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return len(g.paths)
}

func gitStatus(t *testing.T, u musty, boardID string) *v1.BoardGit {
	t.Helper()
	var r v1.BoardGitResponse
	u.must(200, "GET", "/api/boards/"+boardID+"/git", nil, &r)
	return r.GetGit()
}

func waitFor(t *testing.T, what string, ok func() bool) {
	t.Helper()
	for range 100 {
		if ok() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func TestBoardGitBacklink(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	setPlan(t, wid, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_ENTERPRISE})
	b := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Dev", Key: "DEV"}, 201)
	gl := newGitLabStub(t)
	git := "/api/boards/" + b.GetId() + "/git"
	o.must(404, "PATCH", git, &v1.UpdateBoardGitRequest{Backlink: new(true)}, nil) // no setup yet
	o.must(200, "PUT", git, &v1.SetBoardGitRequest{Provider: v1.GitProvider_GIT_PROVIDER_GITLAB, Secret: "gitlab-token-0123456789"}, nil)
	send := gitlabHook(t, b.GetId(), "gitlab-token-0123456789")
	if g := gitStatus(t, o, b.GetId()); g.GetBacklink() || g.GetHasApiToken() {
		t.Fatalf("backlink is off by default: %v", g)
	}
	// Rights: MANAGE_BOARD without MANAGE_INTEGRATIONS, and a bot without bits — 403.
	setBoardPerms(o, b.GetId(), 200, userOv(bob.id, perm.ManageBoard, 0))
	bob.must(403, "PATCH", git, &v1.UpdateBoardGitRequest{Backlink: new(true)}, nil)
	createBot(t, o, wid, "nobits").must(403, "PATCH", git, &v1.UpdateBoardGitRequest{Backlink: new(true)}, nil)

	// On without a token: nothing is posted, the status says why.
	o.must(200, "PATCH", git, &v1.UpdateBoardGitRequest{Backlink: new(true)}, nil)
	first := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "Secret plan"}, 201)
	send("Merge Request Hook", labMerged(gl.srv.URL, first.GetKey(), 20, sha('a'), sha('b')))
	if g := gitStatus(t, o, b.GetId()); !strings.Contains(g.GetBacklinkError(), "no GitLab API token") || gl.count() != 0 {
		t.Fatalf("without a token: %q, %d notes", g.GetBacklinkError(), gl.count())
	}

	// Validation: http address, a token with spaces.
	o.must(422, "PATCH", git, &v1.UpdateBoardGitRequest{GitlabUrl: new("http://gitlab.example")}, nil)
	o.must(422, "PATCH", git, &v1.UpdateBoardGitRequest{ApiToken: new("glpat bad")}, nil)
	const token = "glpat-0123456789abcdefghij"
	var pr v1.BoardGitResponse
	o.must(200, "PATCH", git, &v1.UpdateBoardGitRequest{ApiToken: new(token), GitlabUrl: new(gl.srv.URL + "/")}, &pr)
	if g := pr.GetGit(); !g.GetHasApiToken() || g.GetGitlabUrl() != gl.srv.URL || g.GetBacklinkError() != "" || strings.Contains(string(o.lastBody), token) {
		t.Fatalf("PATCH: %s", o.lastBody)
	}
	if strings.Contains(string(bob.lastBody), token) {
		t.Fatal("the token leaked")
	}

	// A merge request newly linked by its branch: one note; a redelivery with another body: none.
	task := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "Новая карточка @all"}, 201)
	send("Merge Request Hook", labMerged(gl.srv.URL, task.GetKey(), 21, sha('c'), sha('d')))
	waitFor(t, "the note", func() bool { return gl.count() == 1 })
	gl.mu.Lock()
	path, body, tok := gl.paths[0], gl.bodies[0], gl.tokens[0]
	gl.mu.Unlock()
	if path != "/api/v4/projects/gptunnel%2Fgpt/merge_requests/21/notes" || tok != token ||
		!strings.HasPrefix(body, "Задача Calab: "+task.GetKey()+" — Новая карточка @\u2060all") || !strings.HasSuffix(body, "/t/"+task.GetKey()) {
		t.Fatalf("note: %s %q %q", path, body, tok)
	}
	send("Merge Request Hook", append(labMerged(gl.srv.URL, task.GetKey(), 21, sha('c'), sha('d')), ' '))
	// A bare mention in the description links the merge request without a note.
	other := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "Mentioned"}, 201)
	mention := strings.Replace(string(labMerged(gl.srv.URL, "x-1", 22, sha('e'), sha('f'))), `"title":"Feature"`,
		`"title":"Feature","description":"see `+other.GetKey()+`"`, 1)
	send("Merge Request Hook", []byte(mention))
	if l := getTask(t, o, other.GetId()).GetTask().GetGitLinks(); len(l) != 1 {
		t.Fatalf("mention not linked: %v", l)
	}
	time.Sleep(300 * time.Millisecond)
	if n := gl.count(); n != 1 {
		t.Fatalf("notes %d, want 1 (no repeat, no note for a mention)", n)
	}

	// A refused token: the status names the scope; never the token.
	gl.mu.Lock()
	gl.status = 403
	gl.mu.Unlock()
	third := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "Third"}, 201)
	send("Merge Request Hook", labMerged(gl.srv.URL, third.GetKey(), 23, sha('1'), sha('2')))
	waitFor(t, "the refusal", func() bool { return strings.Contains(gitStatus(t, o, b.GetId()).GetBacklinkError(), "api scope") })
	if strings.Contains(string(o.lastBody), token) {
		t.Fatal("the status leaked the token")
	}
	// A merge request of another host never gets the token.
	fourth := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "Fourth"}, 201)
	send("Merge Request Hook", labMerged("https://evil.example", fourth.GetKey(), 24, sha('3'), sha('4')))
	waitFor(t, "the host refusal", func() bool { return strings.Contains(gitStatus(t, o, b.GetId()).GetBacklinkError(), "is not on") })
	if n := gl.count(); n != 2 {
		t.Fatalf("notes %d, want 2", n)
	}
	// The token is bound to its address: another address without a new token forgets it (a
	// changed address never receives the stored token); the same address keeps it.
	o.must(200, "PATCH", git, &v1.UpdateBoardGitRequest{GitlabUrl: new(gl.srv.URL)}, &pr)
	if !pr.GetGit().GetHasApiToken() {
		t.Fatal("the same address dropped the token")
	}
	o.must(200, "PATCH", git, &v1.UpdateBoardGitRequest{GitlabUrl: new("https://gitlab.attacker.example")}, &pr)
	if g := pr.GetGit(); g.GetHasApiToken() || !strings.Contains(g.GetBacklinkError(), "no GitLab API token") {
		t.Fatalf("a new address kept the token: %v", g)
	}
	fifth := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "Fifth"}, 201)
	send("Merge Request Hook", labMerged("https://gitlab.attacker.example", fifth.GetKey(), 25, sha('5'), sha('6')))
	time.Sleep(300 * time.Millisecond)
	if n := gl.count(); n != 2 {
		t.Fatalf("notes %d, want 2", n)
	}
	o.must(200, "PATCH", git, &v1.UpdateBoardGitRequest{GitlabUrl: new(gl.srv.URL), ApiToken: new(token)}, &pr)
	if !pr.GetGit().GetHasApiToken() {
		t.Fatal("token and address together: token lost")
	}
	// Removing the token.
	o.must(200, "PATCH", git, &v1.UpdateBoardGitRequest{ApiToken: new("")}, &pr)
	if pr.GetGit().GetHasApiToken() {
		t.Fatal("token kept")
	}
}

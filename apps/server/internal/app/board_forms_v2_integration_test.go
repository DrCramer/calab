//go:build integration

package app_test

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/google/uuid"
	"google.golang.org/protobuf/encoding/protojson"
)

// Forms v2 (ADR-0064 «v2 (2026-10-14)»): routes, FILE and PEOPLE fields, mapped answers.

func formCode(f *v1.BoardForm) string { return f.Url[strings.LastIndex(f.Url, "/")+1:] }

// formUpload posts a multipart file to a form's upload route as c (anonymous unless c has a token).
func formUpload(t *testing.T, c *client, path, name, contentType string, data []byte) (int, *v1.BoardFormUploadResponse) {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	h := make(map[string][]string)
	h["Content-Disposition"] = []string{`form-data; name="file"; filename="` + name + `"`}
	h["Content-Type"] = []string{contentType}
	fw, _ := mw.CreatePart(h)
	_, _ = fw.Write(data)
	_ = mw.Close()
	req, _ := http.NewRequestWithContext(context.Background(), "POST", srv.URL+path, &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	if c.ip != "" {
		req.Header.Set("X-Forwarded-For", c.ip)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(resp.Body)
	c.lastBody = raw
	if resp.StatusCode != 201 {
		return resp.StatusCode, nil
	}
	var r v1.BoardFormUploadResponse
	if err := protojson.Unmarshal(raw, &r); err != nil {
		t.Fatal(err)
	}
	return resp.StatusCode, &r
}

var tinyPDF = []byte("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n")

func TestBoardFormsV2RoutingMappingPeople(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	a := createBoard(t, o, ws.Id, &v1.CreateBoardRequest{Name: "Intake"}, 201)
	b := createBoard(t, o, ws.Id, &v1.CreateBoardRequest{Name: "Bugs"}, 201)
	bugA, featureA, bugB := createLabel(t, o, a.Id, "Bug"), createLabel(t, o, a.Id, "Feature"), createLabel(t, o, b.Id, "Bug")
	title, kind, urgency, due, ownerF, approver, watchers := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	d := &v1.BoardFormDefinition{Title: "Request", TitleFieldId: title, StatusId: a.Statuses[0].Id, Fields: []*v1.BoardFormField{
		{Id: title, Type: v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_TEXT, Label: "Subject", Required: true},
		{Id: kind, Type: v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_SELECT, Label: "Kind", Options: []string{"Bug", "Feature", "Other"},
			Target: v1.BoardFormFieldTarget_BOARD_FORM_FIELD_TARGET_LABELS, OptionLabels: map[string]string{"Bug": bugA, "Feature": featureA}},
		{Id: urgency, Type: v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_SELECT, Label: "Urgency", Options: []string{"Low", "High"},
			Target: v1.BoardFormFieldTarget_BOARD_FORM_FIELD_TARGET_PRIORITY, OptionPriorities: map[string]v1.TaskPriority{"Low": v1.TaskPriority_TASK_PRIORITY_LOW, "High": v1.TaskPriority_TASK_PRIORITY_URGENT}},
		{Id: due, Type: v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_DATE, Label: "Due", Target: v1.BoardFormFieldTarget_BOARD_FORM_FIELD_TARGET_DUE_DATE},
		{Id: ownerF, Type: v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_PEOPLE, Label: "Owner", Target: v1.BoardFormFieldTarget_BOARD_FORM_FIELD_TARGET_ASSIGNEES},
		{Id: approver, Type: v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_PEOPLE, Label: "Approver", Target: v1.BoardFormFieldTarget_BOARD_FORM_FIELD_TARGET_APPROVERS},
		{Id: watchers, Type: v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_PEOPLE, Label: "Watchers", Multiple: true, Target: v1.BoardFormFieldTarget_BOARD_FORM_FIELD_TARGET_WATCHERS},
	}, Routes: []*v1.BoardFormRoute{{FieldId: kind, Option: "Bug", BoardId: b.Id, StatusId: b.Statuses[1].Id}}}
	path := "/api/boards/" + a.Id + "/forms"
	// Static rules: a target must fit the type, a route needs a select option.
	bad := protojsonClone(d)
	bad.Fields[3].Target = v1.BoardFormFieldTarget_BOARD_FORM_FIELD_TARGET_PRIORITY
	o.must(422, "POST", path, &v1.CreateBoardFormRequest{Definition: bad}, nil)
	bad = protojsonClone(d)
	bad.Routes[0].Option = "Nope"
	o.must(422, "POST", path, &v1.CreateBoardFormRequest{Definition: bad}, nil)
	var fr v1.BoardFormResponse
	o.must(201, "POST", path, &v1.CreateBoardFormRequest{Definition: d}, &fr)
	code := formCode(fr.Form)

	// Anonymous: PEOPLE fields hidden by default, management settings never leave.
	anon := &client{t: t, ip: "192.0.2.210"}
	var view v1.PublicBoardFormResponse
	anon.must(200, "GET", "/api/public/forms/"+code, nil, &view)
	for _, leak := range []string{"TARGET_LABELS", "TARGET_PRIORITY", "routes", b.Id, bugA, bob.id, "Owner", "Watchers"} {
		if strings.Contains(string(anon.lastBody), leak) {
			t.Fatalf("public form leaked %q: %s", leak, anon.lastBody)
		}
	}
	if len(view.Fields) != 4 || len(view.People) != 0 {
		t.Fatalf("anonymous view: %d fields, %d people", len(view.Fields), len(view.People))
	}
	submit := func(c *client, route string, revision uint32, want int, answers ...*v1.BoardFormAnswer) {
		t.Helper()
		c.must(want, "POST", route+"/submissions", &v1.SubmitBoardFormRequest{Revision: revision, Nonce: uuid.NewString(), Answers: answers}, nil)
	}
	public := "/api/public/forms/" + code
	submit(anon, public, view.Revision, 422, &v1.BoardFormAnswer{FieldId: title, Value: "x"}, &v1.BoardFormAnswer{FieldId: ownerF, Values: []string{bob.id}})
	// Mapped answers without a route: the form's board, priority, due date and label.
	submit(anon, public, view.Revision, 201, &v1.BoardFormAnswer{FieldId: title, Value: "Feature ask"}, &v1.BoardFormAnswer{FieldId: kind, Value: "Feature"},
		&v1.BoardFormAnswer{FieldId: urgency, Value: "High"}, &v1.BoardFormAnswer{FieldId: due, Value: "2026-12-01"})
	ta := listTasks(t, o, a.Id, nil)
	if len(ta) != 1 || ta[0].Priority != v1.TaskPriority_TASK_PRIORITY_URGENT || ta[0].DueOn != "2026-12-01" || !slices.Equal(ta[0].LabelIds, []string{featureA}) ||
		!strings.Contains(ta[0].Description, "High") {
		t.Fatalf("mapped task: %v", ta)
	}

	// A signed-in member sees PEOPLE fields with names; routed to B with mapped people.
	internal := "/api/forms/" + code
	bob.must(200, "GET", internal, nil, &view)
	if len(view.Fields) != 7 || len(view.People) != 3 {
		t.Fatalf("member view: %d fields, %d people", len(view.Fields), len(view.People))
	}
	if !slices.ContainsFunc(view.People[0].People, func(p *v1.BoardFormPerson) bool { return p.UserId == o.id && p.Name != "" }) {
		t.Fatalf("people options: %v", view.People[0].People)
	}
	// Someone outside the workspace (or no one at all) is refused on the field.
	o2 := owner(t)
	ws2 := createWorkspace(t, o2, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	stranger := register(t, invite(t, o2, ws2.Id))
	for _, id := range []string{stranger.id, uuid.NewString()} {
		submit(bob.client, internal, view.Revision, 422, &v1.BoardFormAnswer{FieldId: title, Value: "Bad"}, &v1.BoardFormAnswer{FieldId: ownerF, Values: []string{id}})
		if e := (&v1.ApiError{}); protojson.Unmarshal(bob.lastBody, e) != nil || e.Field != ownerF {
			t.Fatalf("non-member rejected on the wrong field: %s", bob.lastBody)
		}
	}
	submit(bob.client, internal, view.Revision, 201, &v1.BoardFormAnswer{FieldId: title, Value: "Crash"}, &v1.BoardFormAnswer{FieldId: kind, Value: "Bug"},
		&v1.BoardFormAnswer{FieldId: ownerF, Values: []string{bob.id}}, &v1.BoardFormAnswer{FieldId: approver, Values: []string{o.id}},
		&v1.BoardFormAnswer{FieldId: watchers, Values: []string{o.id, bob.id}})
	tb := listTasks(t, o, b.Id, nil)
	if len(tb) != 1 || tb[0].StatusId != b.Statuses[1].Id || !slices.Equal(tb[0].LabelIds, []string{bugB}) {
		t.Fatalf("routed task: %v", tb)
	}
	full := getTask(t, o, tb[0].Id).GetTask()
	if len(full.Assignees) != 1 || full.Assignees[0].UserId != bob.id || !full.Assignees[0].IsLead ||
		len(full.Approvers) != 1 || full.Approvers[0].UserId != o.id || len(full.WatcherIds) != 2 || full.CreatedBy != bob.id {
		t.Fatalf("people mapping: %v", full)
	}
	if !strings.Contains(full.Description, "**Owner**") {
		t.Fatalf("people answer not in the description: %q", full.Description)
	}

	// show_members opens the PEOPLE fields to anonymous fillers (names only).
	d.ShowMembers = true
	o.must(200, "PUT", path+"/"+fr.Form.Id, &v1.UpdateBoardFormRequest{Definition: d, Revision: fr.Form.Revision}, &fr)
	anon.must(200, "GET", public, nil, &view)
	if len(view.Fields) != 7 || len(view.People) != 3 || strings.Contains(string(anon.lastBody), "email") {
		t.Fatalf("show_members view: %d fields %d people", len(view.Fields), len(view.People))
	}

	// The routes' owner is the last editor: bob manages A; once he may not create tasks on B, a
	// route there is refused at save and at submit, the default board still works.
	setBoardPerms(o, a.Id, 200, userOv(bob.id, perm.ViewBoard|perm.ManageBoard, 0))
	bob.must(200, "PUT", path+"/"+fr.Form.Id, &v1.UpdateBoardFormRequest{Definition: d, Revision: fr.Form.Revision}, &fr)
	setBoardPerms(o, b.Id, 200, userOv(bob.id, 0, perm.CreateTasks))
	bob.must(422, "PUT", path+"/"+fr.Form.Id, &v1.UpdateBoardFormRequest{Definition: d, Revision: fr.Form.Revision}, nil)
	submit(anon, public, fr.Form.Revision, 409, &v1.BoardFormAnswer{FieldId: title, Value: "Bug again"}, &v1.BoardFormAnswer{FieldId: kind, Value: "Bug"})
	if reason, _ := errReason(anon); reason != "FORM_TARGET_UNAVAILABLE" {
		t.Fatalf("reason %q", reason)
	}
	submit(anon, public, fr.Form.Revision, 201, &v1.BoardFormAnswer{FieldId: title, Value: "Other"}, &v1.BoardFormAnswer{FieldId: kind, Value: "Other"})
	if len(listTasks(t, o, b.Id, nil)) != 1 || len(listTasks(t, o, a.Id, nil)) != 2 {
		t.Fatal("refused route created a task")
	}
	// A route to a board where due dates are off is refused at submit too.
	setBoardPerms(o, b.Id, 200)
	setBoardFeatures(t, b.Id, 1<<uint(v1.BoardFeature_BOARD_FEATURE_DUE_DATE))
	submit(anon, public, fr.Form.Revision, 409, &v1.BoardFormAnswer{FieldId: title, Value: "Dated"}, &v1.BoardFormAnswer{FieldId: kind, Value: "Bug"}, &v1.BoardFormAnswer{FieldId: due, Value: "2026-12-02"})
	if reason, _ := errReason(anon); reason != "FEATURE_DISABLED" {
		t.Fatalf("reason %q", reason)
	}
}

func protojsonClone(d *v1.BoardFormDefinition) *v1.BoardFormDefinition {
	raw, _ := protojson.Marshal(d)
	out := &v1.BoardFormDefinition{}
	_ = protojson.Unmarshal(raw, out)
	return out
}

func TestBoardFormsV2Files(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	b := createBoard(t, o, ws.Id, &v1.CreateBoardRequest{Name: "Files", IsPrivate: true}, 201)
	title, docs, other := uuid.NewString(), uuid.NewString(), uuid.NewString()
	d := &v1.BoardFormDefinition{Title: "Files", TitleFieldId: title, StatusId: b.Statuses[0].Id, Fields: []*v1.BoardFormField{
		{Id: title, Type: v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_TEXT, Label: "Subject", Required: true},
		{Id: docs, Type: v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_FILE, Label: "Docs", Multiple: true, MaxFiles: 2, MaxFileMb: 1, Accept: []string{"image", "pdf"}, Required: true},
		{Id: other, Type: v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_FILE, Label: "Other"},
	}}
	path := "/api/boards/" + b.Id + "/forms"
	tooMany := protojsonClone(d)
	tooMany.Fields[1].MaxFiles = 20
	o.must(422, "POST", path, &v1.CreateBoardFormRequest{Definition: tooMany}, nil) // 20 + 1 > 20 files per submission
	var fr v1.BoardFormResponse
	o.must(201, "POST", path, &v1.CreateBoardFormRequest{Definition: d}, &fr)
	code := formCode(fr.Form)
	public := "/api/public/forms/" + code
	anon := &client{t: t, ip: "192.0.2.220"}
	png := pngBytes(16, 16)
	// Type by content: HTML or text claimed as an image is refused, PDF and PNG pass.
	if st, _ := formUpload(t, anon, public+"/files?field="+docs, "x.png", "image/png", []byte("<html><script>alert(1)</script></html>")); st != 422 {
		t.Fatalf("html upload: %d", st)
	}
	if st, _ := formUpload(t, anon, public+"/files?field="+docs, "notes.txt", "text/plain", []byte("plain text")); st != 422 {
		t.Fatalf("text upload to image/pdf field: %d", st)
	}
	if st, _ := formUpload(t, anon, public+"/files?field="+title, "a.png", "image/png", png); st != 422 {
		t.Fatalf("upload to a text field: %d", st)
	}
	if st, _ := formUpload(t, anon, public+"/files?field="+docs, "big.pdf", "application/pdf", append(slices.Clone(tinyPDF), make([]byte, 2<<20)...)); st != 413 {
		t.Fatalf("over the field limit: %d", st)
	}
	_, img := formUpload(t, anon, public+"/files?field="+docs, "shot.png", "image/png", png)
	_, pdf := formUpload(t, anon, public+"/files?field="+docs, "spec.pdf", "application/pdf", tinyPDF)
	_, misc := formUpload(t, anon, public+"/files?field="+other, "misc.png", "image/png", png)
	if img == nil || pdf == nil || misc == nil || img.Mime != "image/png" || pdf.Mime != "application/pdf" || len(img.UploadId) != 43 {
		t.Fatalf("uploads: %v %v %v", img, pdf, misc)
	}
	// Staged files belong to no one: not readable by id, not even by the workspace owner.
	var fileID string
	if err := testDB.Pool.QueryRow(context.Background(), "SELECT file_id FROM board_form_uploads WHERE form_id = $1 ORDER BY created_at LIMIT 1", fr.Form.Id).Scan(&fileID); err != nil {
		t.Fatal(err)
	}
	if st := o.do("GET", "/api/files/"+fileID, nil, nil); st == 200 {
		t.Fatal("staged upload readable")
	}
	ips := 230
	submit := func(_ *client, want int, answers ...*v1.BoardFormAnswer) {
		t.Helper()
		ips++ // own submission budget per call (5 a minute per IP)
		c := &client{t: t, ip: fmt.Sprintf("192.0.2.%d", ips)}
		c.must(want, "POST", public+"/submissions", &v1.SubmitBoardFormRequest{Revision: fr.Form.Revision, Nonce: uuid.NewString(), Answers: answers}, nil)
	}
	// An upload of another field, an unknown id or a missing required field is refused.
	submit(anon, 422, &v1.BoardFormAnswer{FieldId: title, Value: "x"}, &v1.BoardFormAnswer{FieldId: docs, Values: []string{misc.UploadId}})
	submit(anon, 422, &v1.BoardFormAnswer{FieldId: title, Value: "x"}, &v1.BoardFormAnswer{FieldId: docs, Values: []string{"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}})
	submit(anon, 422, &v1.BoardFormAnswer{FieldId: title, Value: "x"})
	submit(anon, 201, &v1.BoardFormAnswer{FieldId: title, Value: "With files"}, &v1.BoardFormAnswer{FieldId: docs, Values: []string{img.UploadId, pdf.UploadId}})
	tasks := listTasks(t, o, b.Id, nil)
	if len(tasks) != 1 {
		t.Fatalf("tasks %d", len(tasks))
	}
	full := getTask(t, o, tasks[0].Id).GetTask()
	if len(full.Attachments) != 2 || full.Attachments[0].Name != "shot.png" || full.Attachments[1].Name != "spec.pdf" || !strings.Contains(full.Description, "spec.pdf") {
		t.Fatalf("attachments: %v", full.Attachments)
	}
	// Served to those who see the task only: the owner yes, bob (private board) no.
	o.must(200, "GET", "/api/files/"+full.Attachments[0].Id, nil, nil)
	if st := bob.do("GET", "/api/files/"+full.Attachments[0].Id, nil, nil); st == 200 {
		t.Fatal("attachment readable without task access")
	}
	// A consumed upload cannot be submitted again.
	submit(anon, 422, &v1.BoardFormAnswer{FieldId: title, Value: "Again"}, &v1.BoardFormAnswer{FieldId: docs, Values: []string{img.UploadId}})
	// A signed-in upload is not usable anonymously (and the reverse).
	bob.ip = "192.0.2.221"
	_, mine := formUpload(t, bob.client, "/api/forms/"+code+"/files?field="+docs, "bob.png", "image/png", png)
	if mine == nil {
		t.Fatalf("member upload: %s", bob.lastBody)
	}
	submit(anon, 422, &v1.BoardFormAnswer{FieldId: title, Value: "Stolen"}, &v1.BoardFormAnswer{FieldId: docs, Values: []string{mine.UploadId}})

	// Quota: the workspace's, reserved at upload.
	var used int64
	if err := testDB.Pool.QueryRow(context.Background(), "SELECT storage_used_bytes FROM workspaces WHERE id = $1", ws.Id).Scan(&used); err != nil {
		t.Fatal(err)
	}
	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE workspaces SET storage_quota_bytes = storage_used_bytes + 10 WHERE id = $1", ws.Id); err != nil {
		t.Fatal(err)
	}
	if st, _ := formUpload(t, anon, public+"/files?field="+docs, "q.png", "image/png", png); st != 413 {
		t.Fatalf("over quota: %d", st)
	}
	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE workspaces SET storage_quota_bytes = 10737418240 WHERE id = $1", ws.Id); err != nil {
		t.Fatal(err)
	}

	// Never submitted for an hour: the cleanup removes the file and returns its quota.
	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE board_form_uploads SET created_at = now() - interval '2 hours' WHERE form_id = $1", fr.Form.Id); err != nil {
		t.Fatal(err)
	}
	n, err := testApp.Files.CleanupStaged(context.Background(), time.Now())
	if err != nil || n < 2 {
		t.Fatalf("cleanup: %d %v", n, err)
	}
	var left int
	var after int64
	if err := testDB.Pool.QueryRow(context.Background(), "SELECT count(*) FROM board_form_uploads WHERE form_id = $1", fr.Form.Id).Scan(&left); err != nil || left != 0 {
		t.Fatalf("staged left %d %v", left, err)
	}
	if err := testDB.Pool.QueryRow(context.Background(), "SELECT storage_used_bytes FROM workspaces WHERE id = $1", ws.Id).Scan(&after); err != nil || after >= used {
		t.Fatalf("quota not released: %d -> %d %v", used, after, err)
	}
	o.must(200, "GET", "/api/files/"+full.Attachments[0].Id, nil, nil) // submitted files stay
	submit(anon, 422, &v1.BoardFormAnswer{FieldId: title, Value: "Late"}, &v1.BoardFormAnswer{FieldId: docs, Values: []string{misc.UploadId}})

	// Rate limit by IP: 20 uploads a minute.
	limited := &client{t: t, ip: "192.0.2.222"}
	got429 := false
	for range 22 {
		if st, _ := formUpload(t, limited, public+"/files?field="+other, "r.png", "image/png", png); st == 429 {
			got429 = true
			break
		}
	}
	if !got429 {
		t.Fatal("uploads not rate-limited")
	}
	// Submissions: 5 a minute per IP.
	sub := &client{t: t, ip: "192.0.2.223"}
	statuses := []int{}
	for range 6 {
		statuses = append(statuses, sub.do("POST", public+"/submissions", &v1.SubmitBoardFormRequest{Revision: fr.Form.Revision, Nonce: uuid.NewString(),
			Answers: []*v1.BoardFormAnswer{{FieldId: title, Value: "x"}}}, nil))
	}
	if statuses[5] != 429 {
		t.Fatalf("submissions not rate-limited: %v", statuses)
	}
}

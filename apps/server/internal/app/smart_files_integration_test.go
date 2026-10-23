//go:build integration

package app_test

import (
	"bytes"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"strings"
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
)

// smartPDF is a PDF of n blank pages.
func smartPDF(n int) []byte {
	var b bytes.Buffer
	var offs []int
	obj := func(s string) {
		offs = append(offs, b.Len())
		fmt.Fprintf(&b, "%d 0 obj\n%s\nendobj\n", len(offs), s)
	}
	b.WriteString("%PDF-1.4\n")
	kids := make([]string, n)
	for i := range kids {
		kids[i] = fmt.Sprintf("%d 0 R", 3+i)
	}
	obj("<< /Type /Catalog /Pages 2 0 R >>")
	obj(fmt.Sprintf("<< /Type /Pages /Kids [%s] /Count %d >>", strings.Join(kids, " "), n))
	for range n {
		obj("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] >>")
	}
	xref := b.Len()
	fmt.Fprintf(&b, "xref\n0 %d\n0000000000 65535 f \n", len(offs)+1)
	for _, o := range offs {
		fmt.Fprintf(&b, "%010d 00000 n \n", o)
	}
	fmt.Fprintf(&b, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(offs)+1, xref)
	return b.Bytes()
}

func smartPNG() []byte {
	img := image.NewRGBA(image.Rect(0, 0, 40, 30))
	for i := range img.Pix {
		img.Pix[i] = 0xff
	}
	img.Set(1, 1, color.Black)
	var b bytes.Buffer
	_ = png.Encode(&b, img)
	return b.Bytes()
}

func smartImagesLast() int {
	smartFakeMu.Lock()
	defer smartFakeMu.Unlock()
	if len(smartFakeImages) == 0 {
		return -1
	}
	return smartFakeImages[len(smartFakeImages)-1]
}

// TestSmartTaskFilesRefusalsDuplicates (CBF-75, ADR-0123): the model gets images (a PDF's first
// and last page) and text files' text; a model without vision is asked again by name; the
// model may decline with a reason (plain text, no task); with «Искать дубли» the model compares
// with the board's recent tasks the person sees — and only those.
func TestSmartTaskFilesRefusalsDuplicates(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	setPlan(t, wid, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_ENTERPRISE})
	base := "/api/workspaces/" + wid + "/ai"
	smart := "/api/workspaces/" + wid + "/smart-tasks"
	gpt := v1.AiProvider_AI_PROVIDER_GPTUNNEL
	key := aiFakeKey
	o.must(200, "PUT", base, &v1.PutAiSettingsRequest{Provider: gpt, Model: "gpt-6-astra", ApiKey: &key}, nil)
	o.must(200, "POST", base+"/check", &v1.CheckAiRequest{Provider: gpt, Model: "gpt-6-astra"}, nil)

	dev := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Разработка", Key: "DEV"}, 201)
	prv := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Документы", Key: "PRV", IsPrivate: true}, 201)
	setBoardPerms(o, prv.GetId(), 200, creatorOv(o), userOv(bob.id, perm.CreateTasks, 0)) // bob: create-only

	// Files: an image, a 5-page PDF (pages 1 and 5) and a text file.
	up := func(name, mime string, data []byte) string {
		t.Helper()
		st, f := uploadAs(t, bob, "/api/workspaces/"+wid+"/files", name, mime, data)
		if st != 201 && st != 200 {
			t.Fatalf("upload %s: %d", name, st)
		}
		return f.GetId()
	}
	ids := []string{up("photo.png", "image/png", smartPNG()), up("act.pdf", "application/pdf", smartPDF(5)), up("notes.txt", "text/plain", []byte("Сумма счёта: 1500 ₽"))}
	var res v1.CreateSmartTaskResponse
	bob.must(201, "POST", smart, &v1.CreateSmartTaskRequest{Text: "ROUTE=DEV разобрать счёт", AttachmentIds: ids}, &res)
	seen := smartLastSeen()
	if smartImagesLast() != 3 || !strings.Contains(seen, `"shown_pages":[1,5]`) || !strings.Contains(seen, `"pages":5`) ||
		!strings.Contains(seen, "Сумма счёта: 1500 ₽") || res.GetFilesUnseen() || res.GetTask().GetAttachmentCount() != 3 {
		t.Fatalf("files for the model (%d images): %s / %v", smartImagesLast(), seen, &res)
	}

	// A model without vision: asked again by name, the task is filed, the answer says so.
	ids = []string{up("photo2.png", "image/png", smartPNG()), up("n2.txt", "text/plain", []byte("текст"))}
	bob.must(201, "POST", smart, &v1.CreateSmartTaskRequest{Text: "ROUTE=DEV NOIMAGES", AttachmentIds: ids}, &res)
	if !res.GetFilesUnseen() || smartImagesLast() != 0 || !strings.Contains(smartLastSeen(), `"note":"no_images"`) || !strings.Contains(smartLastSeen(), "текст") {
		t.Fatalf("no vision: %v / %s", &res, smartLastSeen())
	}

	// A refusal: 200, a plain-text reason, no task; the files stay unattached (sent again).
	before := len(listTasks(t, o, dev.GetId(), nil))
	ids = []string{up("photo3.png", "image/png", smartPNG())}
	bob.must(200, "POST", smart, &v1.CreateSmartTaskRequest{Text: "REFUSE", AttachmentIds: ids}, &res)
	if r := res.GetRefusal(); res.GetTask() != nil || r == nil || r.GetReason() != "Не хватает данных: сумма , см. everyone" || r.GetDuplicateKey() != "" {
		t.Fatalf("refusal %v", &res)
	}
	if len(listTasks(t, o, dev.GetId(), nil)) != before {
		t.Fatal("a refused smart task was created")
	}
	bob.must(201, "POST", smart, &v1.CreateSmartTaskRequest{Text: "ROUTE=DEV теперь с данными", AttachmentIds: ids}, nil)

	// «Искать дубли за 2 недели»: MANAGE_BOARD writes it, off by default.
	on := true
	if prv.GetAiFindDuplicates() {
		t.Fatal("on by default")
	}
	bob.must(403, "PATCH", "/api/boards/"+prv.GetId(), &v1.UpdateBoardRequest{AiFindDuplicates: &on}, nil)
	var br v1.BoardResponse
	o.must(200, "PATCH", "/api/boards/"+prv.GetId(), &v1.UpdateBoardRequest{AiFindDuplicates: &on}, &br)
	if !br.GetBoard().GetAiFindDuplicates() {
		t.Fatal("not switched on")
	}

	// PRV: the owner's task (bob does not see it) and bob's own one.
	theirs := createTask(t, o, prv.GetId(), &v1.CreateTaskRequest{Title: "Чужая секретная задача"}, 201)
	mine := createTask(t, bob, prv.GetId(), &v1.CreateTaskRequest{Title: "Моя задача про счёт"}, 201)
	mineKey := "PRV-" + fmt.Sprint(mine.GetNumber())
	theirsKey := "PRV-" + fmt.Sprint(theirs.GetNumber())

	// A duplicate of bob's own task: declined, the key named.
	bob.must(200, "POST", smart, &v1.CreateSmartTaskRequest{Text: "ROUTE=PRV DUP=" + mineKey}, &res)
	seen = smartLastSeen()
	if r := res.GetRefusal(); r == nil || r.GetDuplicateKey() != mineKey {
		t.Fatalf("duplicate %v", &res)
	}
	if !strings.Contains(seen, "Моя задача про счёт") || strings.Contains(seen, "Чужая") || strings.Contains(seen, `"key":"`+theirsKey+`"`) {
		t.Fatalf("recent tasks the model saw: %s", seen)
	}
	// A «duplicate» of a task bob does not see is no refusal: the task is filed.
	bob.must(201, "POST", smart, &v1.CreateSmartTaskRequest{Text: "ROUTE=PRV DUP=" + theirsKey}, &res)
	if res.GetTask().GetBoardId() != prv.GetId() {
		t.Fatalf("filed %v", &res)
	}
	// Switched off: no duplicate step (the last call is the board choice).
	off := false
	o.must(200, "PATCH", "/api/boards/"+prv.GetId(), &v1.UpdateBoardRequest{AiFindDuplicates: &off}, nil)
	bob.must(201, "POST", smart, &v1.CreateSmartTaskRequest{Text: "ROUTE=PRV DUP=" + mineKey}, &res)
	if strings.Contains(smartLastSeen(), "recent_tasks") {
		t.Fatal("recent tasks sent with the check off")
	}
}

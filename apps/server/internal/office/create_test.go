package office

import (
	"archive/zip"
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
)

func zipEntry(t *testing.T, body []byte, name string) string {
	t.Helper()
	z, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range z.File {
		if f.Name == name {
			rc, err := f.Open()
			if err != nil {
				t.Fatal(err)
			}
			b, _ := io.ReadAll(rc)
			_ = rc.Close()
			return string(b)
		}
	}
	t.Fatalf("no %s", name)
	return ""
}

// The templates pass the saved-file check, and the language goes where the spell check and the
// sheet name read it; nothing else changes.
func TestBlankFiles(t *testing.T) {
	for _, ext := range []string{"docx", "xlsx", "pptx"} {
		f, _ := formatByExt(ext)
		for code, l := range langs {
			b, err := blankFile(ext, l)
			if err != nil {
				t.Fatal(ext, code, err)
			}
			if err := f.Check(b); err != nil {
				t.Fatalf("%s/%s: %v", ext, code, err)
			}
			switch ext {
			case "docx":
				if s := zipEntry(t, b, "word/styles.xml"); !strings.Contains(s, `w:val="`+l.tag+`"`) || (l.tag != "en-US" && strings.Contains(s, "en-US")) {
					t.Fatalf("docx %s: the text language", code)
				}
			case "pptx":
				if s := zipEntry(t, b, "ppt/presentation.xml"); !strings.Contains(s, `lang="`+l.tag+`"`) {
					t.Fatalf("pptx %s: the text language", code)
				}
			case "xlsx":
				if s := zipEntry(t, b, "xl/workbook.xml"); !strings.Contains(s, `name="`+l.sheet+`"`) {
					t.Fatalf("xlsx %s: the sheet name", code)
				}
			}
		}
	}
	if langOf("zh-CN").tag != "zh-CN" || langOf("EN").tag != "en-US" || langOf("de").tag != "ru-RU" || langOf("").tag != "ru-RU" {
		t.Fatal("langOf")
	}
	if regionOf("es") != "es-ES" || regionOf("zh") != "zh-CN" || regionOf("fr") != "fr" {
		t.Fatal("regionOf")
	}
}

func TestCreate(t *testing.T) {
	h := newHarness(t)
	ws := uuid.New()
	post := func(id auth.Identity, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/workspaces/"+ws.String()+"/office/create", strings.NewReader(body))
		r = r.WithContext(auth.WithIdentity(r.Context(), id))
		w := httptest.NewRecorder()
		h.mux.ServeHTTP(w, r)
		return w
	}
	u := auth.Identity{UserID: uuid.New()}
	for _, c := range []struct{ body, name string }{
		{`{"extension":"docx","lang":"ru"}`, "Новый документ.docx"},
		{`{"extension":"xlsx","lang":"en"}`, "New spreadsheet.xlsx"},
		{`{"extension":"pptx"}`, "Новая презентация.pptx"},
		{`{"extension":"docx","name":"  Отчёт.DOCX "}`, "Отчёт.docx"},
		{`{"extension":"xlsx","name":"План","parent_id":"` + uuid.NewString() + `"}`, "План.xlsx"},
	} {
		w := post(u, c.body)
		if w.Code != http.StatusCreated {
			t.Fatalf("%s: %d %s", c.body, w.Code, w.Body)
		}
		var resp v1.DiskItemResponse
		if err := protojson.Unmarshal(w.Body.Bytes(), &resp); err != nil || resp.GetItem().GetName() != c.name {
			t.Fatalf("%s: %v %v", c.body, resp.GetItem(), err)
		}
		id, _ := uuid.Parse(resp.GetItem().GetId())
		f, _ := FormatOf(c.name)
		if err := f.Check(h.store.files[id]); err != nil {
			t.Fatalf("%s: stored bytes %v", c.body, err)
		}
	}
	for _, bad := range []string{`{"extension":"doc"}`, `{"extension":"pdf"}`, `{}`, `{"extension":"docx","name":"a/b"}`, `{"extension":"docx","name":"` + strings.Repeat("я", 201) + `"}`, `{"extension":"docx","parent_id":"x"}`, `{"extension":"docx","unknown":1}`} {
		if w := post(u, bad); w.Code != http.StatusBadRequest && w.Code != http.StatusUnprocessableEntity {
			t.Fatalf("%s: %d", bad, w.Code)
		}
	}
	if w := post(auth.Identity{UserID: uuid.New(), IsBot: true}, `{"extension":"docx"}`); w.Code != http.StatusForbidden {
		t.Fatalf("bot: %d", w.Code)
	}
	h.svc.cfg.Enabled = false
	if w := post(u, `{"extension":"docx"}`); w.Code != http.StatusNotFound {
		t.Fatalf("off: %d", w.Code)
	}
}

package office

import (
	"archive/zip"
	"bytes"
	"embed"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/httpx"
)

// «Создать» in the Disk (ADR-0143): a blank document, spreadsheet or presentation from the
// templates below, filed like any upload — the same byte check as a saved file (Format.Check),
// the quota, DISK_WRITE on the folder, a free name and the journal's «upload»
// (Store.AddFile → disk.AddFile).
//
// The templates (tools/office-fidelity/templates.py) come from the Office-made templates of
// python-docx, openpyxl and python-pptx: A4 docx, 16:9 pptx with one title slide, one sheet. They
// are stored with the text language en-US and the sheet «Sheet1»; blankFile sets both from the
// app language, so the editor's spell check of new text matches what the user types.
//
//go:embed templates/blank.docx templates/blank.xlsx templates/blank.pptx
var templates embed.FS

// lang is one app language: the text language of the template (BCP 47), the first sheet's name
// and the default names of the three kinds.
type lang struct {
	tag, sheet string
	names      map[string]string
}

var langs = map[string]lang{
	"ru": {tag: "ru-RU", sheet: "Лист1", names: map[string]string{"docx": "Новый документ", "xlsx": "Новая таблица", "pptx": "Новая презентация"}},
	"en": {tag: "en-US", sheet: "Sheet1", names: map[string]string{"docx": "New document", "xlsx": "New spreadsheet", "pptx": "New presentation"}},
	"es": {tag: "es-ES", sheet: "Hoja1", names: map[string]string{"docx": "Nuevo documento", "xlsx": "Nueva hoja de cálculo", "pptx": "Nueva presentación"}},
	"zh": {tag: "zh-CN", sheet: "工作表1", names: map[string]string{"docx": "新建文档", "xlsx": "新建表格", "pptx": "新建演示文稿"}},
}

// langOf maps an app language (ru, en, es, zh, zh-CN, …) onto langs; unknown = ru.
func langOf(code string) lang {
	code = strings.ToLower(code)
	if i := strings.IndexAny(code, "-_"); i > 0 {
		code = code[:i]
	}
	if l, ok := langs[code]; ok {
		return l
	}
	return langs["ru"]
}

// blankFile is the template of ext ("docx", "xlsx", "pptx") in language l: the parts that carry
// the text language (docx styles, every pptx part) say l.tag instead of en-US, the workbook's
// sheet is l.sheet. Every other entry is copied as stored.
func blankFile(ext string, l lang) ([]byte, error) {
	raw, err := templates.ReadFile("templates/blank." + ext)
	if err != nil {
		return nil, err
	}
	z, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		return nil, err
	}
	var out bytes.Buffer
	w := zip.NewWriter(&out)
	for _, f := range z.File {
		rc, err := f.Open()
		if err != nil {
			return nil, err
		}
		data, err := io.ReadAll(rc)
		_ = rc.Close()
		if err != nil {
			return nil, err
		}
		switch {
		case ext == "docx" && (f.Name == "word/styles.xml" || f.Name == "word/stylesWithEffects.xml"):
			data = bytes.ReplaceAll(data, []byte(`"en-US"`), []byte(`"`+l.tag+`"`))
		case ext == "pptx" && strings.HasPrefix(f.Name, "ppt/") && strings.HasSuffix(f.Name, ".xml"):
			data = bytes.ReplaceAll(data, []byte(`lang="en-US"`), []byte(`lang="`+l.tag+`"`))
		case ext == "xlsx" && f.Name == "xl/workbook.xml":
			data = bytes.Replace(data, []byte(`name="Sheet1"`), []byte(`name="`+l.sheet+`"`), 1)
		}
		hdr := f.FileHeader
		hdr.CompressedSize64, hdr.UncompressedSize64, hdr.CRC32 = 0, 0, 0
		fw, err := w.CreateHeader(&hdr)
		if err != nil {
			return nil, err
		}
		if _, err := fw.Write(data); err != nil {
			return nil, err
		}
	}
	if err := w.Close(); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

// createFile: POST /api/workspaces/{id}/office/create {parent_id, extension, name, lang}.
func (s *Service) createFile(w http.ResponseWriter, r *http.Request) error {
	id := auth.MustFromContext(r.Context())
	if id.IsBot || id.ViaBot != uuid.Nil {
		return auth.ErrBotNotAllowed // a bot uploads its files through the Disk API
	}
	ws, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return err
	}
	var req v1.CreateOfficeFileRequest
	if err := httpx.DecodeStrict(w, r, &req); err != nil {
		return err
	}
	ext := req.GetExtension()
	if ext != "docx" && ext != "xlsx" && ext != "pptx" {
		return httpx.Validation("extension", "must be docx, xlsx or pptx")
	}
	f, _ := formatByExt(ext)
	var parent *uuid.UUID
	if req.GetParentId() != "" {
		p, err := uuid.Parse(req.GetParentId())
		if err != nil {
			return httpx.Validation("parent_id", "must be an id")
		}
		parent = &p
	}
	l := langOf(req.GetLang())
	base := strings.TrimSpace(req.GetName())
	if base == "" {
		base = l.names[ext]
	}
	if n := len(ext) + 1; len(base) > n && strings.EqualFold(base[len(base)-n:], "."+ext) {
		base = strings.TrimSpace(base[:len(base)-n]) // «Отчёт.docx» is «Отчёт»
	}
	if base == "" || utf8.RuneCountInString(base) > 200 || strings.ContainsAny(base, "/\\") || strings.IndexFunc(base, func(c rune) bool { return c < 0x20 || c == 0x7f }) >= 0 {
		return httpx.Validation("name", "must be 1..200 characters without slashes or control characters")
	}
	if s.ConfigLimit != nil {
		if err := s.ConfigLimit.Take(r.Context(), id.UserID.String()); err != nil {
			return err
		}
	}
	body, err := blankFile(ext, l)
	if err != nil {
		return err
	}
	if err := f.Check(body); err != nil { // the same check as every saved file
		return err
	}
	item, err := s.store.AddFile(r, ws, parent, base+"."+ext, f, body)
	if err != nil {
		return err
	}
	slog.InfoContext(r.Context(), "office: created", "user", id.UserID, "item", item.GetId(), "ext", ext)
	httpx.Write(w, http.StatusCreated, &v1.DiskItemResponse{Item: item})
	return nil
}

package office

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
)

func TestFormatMap(t *testing.T) {
	want := map[string]struct {
		doc string
		cap v1.OfficeCapability
		to  string
	}{
		"docx": {"word", capEdit, ""}, "xlsx": {"cell", capEdit, ""}, "pptx": {"slide", capEdit, ""},
		"odt": {"word", capEdit, ""}, "ods": {"cell", capEdit, ""}, "odp": {"slide", capEdit, ""},
		"csv": {"cell", capEdit, ""}, "txt": {"word", capEdit, ""}, "rtf": {"word", capEdit, ""},
		"doc": {"word", capConvert, "docx"}, "xls": {"cell", capConvert, "xlsx"}, "ppt": {"slide", capConvert, "pptx"},
		"pdf": {"pdf", capView, ""},
	}
	if len(formats) != len(want) {
		t.Fatalf("%d formats, want %d", len(formats), len(want))
	}
	for e, w := range want {
		f, ok := FormatOf("Файл." + strings.ToUpper(e))
		if !ok || f.DocType != w.doc || f.Cap != w.cap || f.ConvertTo != w.to {
			t.Errorf("%s: %+v", e, f)
		}
		if f.Cap == capEdit && (f.check == nil || f.Mime == "") {
			t.Errorf("%s: an edited format needs a check and a mime", e)
		}
		if f.Cap != capEdit && f.check != nil {
			t.Errorf("%s: never written, must have no check", e)
		}
		if f.ConvertTo != "" {
			if to, ok := formatByExt(f.ConvertTo); !ok || to.Cap != capEdit {
				t.Errorf("%s converts to %s, which is not edited in place", e, f.ConvertTo)
			}
		}
	}
	for _, n := range []string{"a.exe", "a", ".xlsx.", "a.xlsm", "a.png", "a.zip"} {
		if _, ok := FormatOf(n); ok {
			t.Errorf("%s opens", n)
		}
	}
}

func TestFormatChecks(t *testing.T) {
	f := func(e string) Format { x, _ := formatByExt(e); return x }
	docx := zipOfParts(t, map[string]string{"[Content_Types].xml": "", "word/document.xml": ""})
	pptx := zipOfParts(t, map[string]string{"[Content_Types].xml": "", "ppt/presentation.xml": ""})
	odt := zipOfParts(t, map[string]string{"mimetype": mimeOdt, "content.xml": ""})
	ods := zipOfParts(t, map[string]string{"mimetype": mimeOds, "content.xml": ""})
	for _, c := range []struct {
		ext  string
		body []byte
		ok   bool
	}{
		{"xlsx", xlsxOf(t, "x"), true},
		{"xlsx", docx, false}, // a docx named .xlsx
		{"docx", docx, true},
		{"pptx", pptx, true},
		{"xlsx", []byte("<html>error page</html>"), false},
		{"xlsx", []byte("PK\x03\x04garbage"), false},
		{"odt", odt, true},
		{"odt", ods, false},
		{"ods", ods, true},
		{"odp", odt, false},
		{"rtf", []byte(`{\rtf1\ansi hello}`), true},
		{"rtf", []byte("hello"), false},
		{"csv", []byte("\xef\xbb\xbfa;b\n1;2\n"), true},
		{"csv", []byte("a\x00b"), false},
		{"txt", []byte("\xff\xfe\x00h"), false},
		{"doc", []byte("\xd0\xcf\x11\xe0"), false}, // never written
		{"pdf", []byte("%PDF-1.7"), false},
	} {
		if err := f(c.ext).Check(c.body); (err == nil) != c.ok {
			t.Errorf("%s %q: %v", c.ext, c.body[:min(len(c.body), 12)], err)
		}
	}
}

func TestCapabilities(t *testing.T) {
	h := newHarness(t)
	get := func() *v1.OfficeCapabilitiesResponse {
		r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/office/capabilities", nil)
		r = r.WithContext(auth.WithIdentity(r.Context(), auth.Identity{UserID: uuid.New()}))
		w := httptest.NewRecorder()
		h.mux.ServeHTTP(w, r)
		var out v1.OfficeCapabilitiesResponse
		if w.Code != http.StatusOK || protojson.Unmarshal(w.Body.Bytes(), &out) != nil {
			t.Fatalf("capabilities %d", w.Code)
		}
		return &out
	}
	c := get()
	if !c.Enabled || len(c.Formats) != len(formats) || c.DocsUrl != "https://docs.calab.test" || c.MaxSizeBytes != 100<<20 || c.ThemeDark != "default-dark" || c.ThemeLight != "default-light" {
		t.Fatalf("%v", c)
	}
	h.svc.cfg.Enabled = false
	if c := get(); c.Enabled || len(c.Formats) != 0 {
		t.Fatal("off must say so")
	}
	it := h.store.add("a.xlsx", xlsxOf(t, "v1"))
	if w, _, _ := h.open(editor(h, edit), it.ID, ""); w.Code != http.StatusNotFound {
		t.Fatalf("config while off: %d", w.Code)
	}
}

func TestViewOnlyAndLegacyFormats(t *testing.T) {
	h := newHarness(t)
	u := editor(h, edit)
	for _, c := range []struct{ name, docType string }{{"scan.pdf", "pdf"}, {"old.doc", "word"}, {"old.xls", "cell"}, {"old.ppt", "slide"}} {
		it := h.store.add(c.name, []byte("legacy"))
		w, resp, cfg := h.open(u, it.ID, "")
		if w.Code != http.StatusOK || resp.Mode != v1.OfficeMode_OFFICE_MODE_VIEW || cfg["documentType"] != c.docType ||
			dig(cfg, "document", "permissions", "edit") != false {
			t.Fatalf("%s: %d %v", c.name, w.Code, resp)
		}
		if _, ok := cfg["editorConfig"].(map[string]any)["callbackUrl"]; ok {
			t.Fatalf("%s: a never-written format must have no callback", c.name)
		}
		if _, ok, _ := h.sessions.Get(context.Background(), it.ID); ok {
			t.Fatalf("%s: no editing session for a view", c.name)
		}
	}
	// pptx, odt, csv edit in place.
	for _, n := range []string{"deck.pptx", "text.odt", "table.csv"} {
		it := h.store.add(n, []byte("x"))
		if _, resp, _ := h.open(u, it.ID, ""); resp.Mode != v1.OfficeMode_OFFICE_MODE_EDIT || resp.Format.GetCapability() != capEdit {
			t.Fatalf("%s: %v", n, resp)
		}
	}
	big := h.store.add("big.xlsx", []byte("x"))
	h.svc.cfg.MaxSize = 0
	if w, _, _ := h.open(u, big.ID, ""); w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("too large: %d", w.Code)
	}
}

// An attachment opens read-only with no session; only for who may read it.
func TestAttachmentView(t *testing.T) {
	h := newHarness(t)
	a := h.store.addAttachment("Отчёт.xlsx", xlsxOf(t, "att"))
	reader := uuid.New()
	h.store.readers[reader] = true
	if w, _, _ := h.openQ(uuid.New(), "file="+a.ID.String()); w.Code != http.StatusNotFound {
		t.Fatalf("a non-reader: %d", w.Code)
	}
	w, resp, cfg := h.openQ(reader, "file="+a.ID.String())
	if w.Code != http.StatusOK || resp.Mode != v1.OfficeMode_OFFICE_MODE_VIEW || resp.ItemId != "" || resp.FileId != a.ID.String() {
		t.Fatalf("%d %v", w.Code, resp)
	}
	if _, ok := cfg["editorConfig"].(map[string]any)["callbackUrl"]; ok {
		t.Fatal("an attachment has no callback")
	}
	u, _ := url.Parse(dig(cfg, "document", "url").(string))
	r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, u.Path, nil)
	r.Header.Set("Authorization", "Bearer "+dsToken(t, dsSecret, jwt.MapClaims{"operation": "download"}))
	rec := httptest.NewRecorder()
	h.mux.ServeHTTP(rec, r)
	if rec.Code != http.StatusOK || rec.Body.String() != string(xlsxOf(t, "att")) {
		t.Fatalf("attachment download %d", rec.Code)
	}
}

func TestBotsGetNoEditor(t *testing.T) {
	h := newHarness(t)
	it := h.store.add("a.xlsx", xlsxOf(t, "v1"))
	bot := editor(h, edit)
	for _, id := range []auth.Identity{{UserID: bot, IsBot: true}, {UserID: bot, ViaBot: uuid.New()}} {
		r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/office/config?item="+it.ID.String(), nil)
		r = r.WithContext(auth.WithIdentity(r.Context(), id))
		w := httptest.NewRecorder()
		h.mux.ServeHTTP(w, r)
		if w.Code != http.StatusForbidden {
			t.Fatalf("bot config: %d", w.Code)
		}
	}
}

// A file URL is pinned to one version: after a save it answers 410, never the new bytes under
// an old session nor the old bytes under a new one.
func TestFileURLReplayAcrossVersions(t *testing.T) {
	h := newHarness(t)
	it := h.store.add("a.xlsx", xlsxOf(t, "v1"))
	u := editor(h, edit)
	_, r, cfg := h.open(u, it.ID, "")
	if e := h.callback(cfg, map[string]any{"key": r.Key, "status": 6, "filetype": "xlsx", "url": h.edited("s", xlsxOf(t, "v2")), "users": []string{u.String()}}); e != 0 {
		t.Fatal("forcesave")
	}
	fu, _ := url.Parse(dig(cfg, "document", "url").(string))
	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, fu.Path, nil)
	req.Header.Set("Authorization", "Bearer "+dsToken(t, dsSecret, jwt.MapClaims{"operation": "download"}))
	w := httptest.NewRecorder()
	h.mux.ServeHTTP(w, req)
	if w.Code != http.StatusGone {
		t.Fatalf("old file url after a save: %d", w.Code)
	}
}

// The callback URL is pinned to its session key: a valid Document Server body for another key
// is refused even while that other session is live.
func TestCallbackURLPinnedToKey(t *testing.T) {
	h := newHarness(t)
	a := h.store.add("a.xlsx", xlsxOf(t, "a1"))
	b := h.store.add("b.xlsx", xlsxOf(t, "b1"))
	u := editor(h, edit)
	_, _, cfgA := h.open(u, a.ID, "")
	_, rb, _ := h.open(u, b.ID, "")
	if e := h.callback(cfgA, map[string]any{"key": rb.Key, "status": 2, "filetype": "xlsx", "url": h.edited("x", xlsxOf(t, "evil")), "users": []string{u.String()}}); e != 1 {
		t.Fatal("a body of another session accepted")
	}
	if len(h.store.versions[a.ID])+len(h.store.versions[b.ID]) != 0 {
		t.Fatal("stored")
	}
}

func TestSaveSourceChecks(t *testing.T) {
	setup := func(t *testing.T) (*harness, Item, uuid.UUID, string, map[string]any) {
		h := newHarness(t)
		it := h.store.add("a.xlsx", xlsxOf(t, "v1"))
		u := editor(h, edit)
		_, r, cfg := h.open(u, it.ID, "")
		return h, it, u, r.Key, cfg
	}
	body := func(key string, u uuid.UUID, src string) map[string]any {
		return map[string]any{"key": key, "status": 2, "filetype": "xlsx", "url": src, "users": []string{u.String()}}
	}
	t.Run("public url maps onto the internal one", func(t *testing.T) {
		h, it, u, key, cfg := setup(t)
		h.saved["/cache/pub"] = xlsxOf(t, "pub")
		if h.callback(cfg, body(key, u, "https://docs.calab.test/cache/pub")) != 0 {
			t.Fatal("refused")
		}
		if cur, _ := h.store.Item(context.Background(), it.ID); cur.Sha256 != sum(xlsxOf(t, "pub")) {
			t.Fatal("not saved")
		}
	})
	for name, src := range map[string]string{ //nolint:gosec // URLs with test credentials
		"other host":       "https://evil.test/cache/x",
		"credentials":      "https://user:pw@docs.calab.test/cache/x",
		"scheme":           "ftp://docs.calab.test/cache/x",
		"lookalike origin": "https://docs.calab.test.evil.test/cache/x",
	} {
		t.Run(name, func(t *testing.T) {
			h, _, u, key, cfg := setup(t)
			if h.callback(cfg, body(key, u, src)) != 1 {
				t.Fatal("accepted")
			}
		})
	}
	t.Run("not an xlsx", func(t *testing.T) {
		h, _, u, key, cfg := setup(t)
		if h.callback(cfg, body(key, u, h.edited("html", []byte("<html>")))) != 1 {
			t.Fatal("accepted")
		}
	})
	t.Run("redirect not followed", func(t *testing.T) {
		h, _, u, key, cfg := setup(t)
		other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(xlsxOf(t, "r")) }))
		defer other.Close()
		redirect := httptest.NewServer(http.RedirectHandler(other.URL, http.StatusFound))
		defer redirect.Close()
		h.svc.cfg.DocsInternalURL = redirect.URL
		if h.callback(cfg, body(key, u, redirect.URL+"/x")) != 1 {
			t.Fatal("followed a redirect")
		}
	})
	t.Run("html content type", func(t *testing.T) {
		h, _, u, key, cfg := setup(t)
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "text/html")
			_, _ = w.Write(xlsxOf(t, "h"))
		}))
		defer srv.Close()
		h.svc.cfg.DocsInternalURL = srv.URL
		if h.callback(cfg, body(key, u, srv.URL+"/x")) != 1 {
			t.Fatal("accepted text/html")
		}
	})
	t.Run("renamed to another type", func(t *testing.T) {
		h, it, u, key, cfg := setup(t)
		h.store.mu.Lock()
		x := h.store.items[it.ID]
		x.Name = "a.doc"
		h.store.items[it.ID] = x
		h.store.mu.Unlock()
		if h.callback(cfg, body(key, u, h.edited("x", xlsxOf(t, "x")))) != 1 {
			t.Fatal("wrote a legacy-named item in place")
		}
	})
	t.Run("deleted item", func(t *testing.T) {
		h, it, u, key, cfg := setup(t)
		h.store.mu.Lock()
		delete(h.store.items, it.ID)
		h.store.mu.Unlock()
		if h.callback(cfg, body(key, u, h.edited("x", xlsxOf(t, "x")))) != 1 {
			t.Fatal("accepted")
		}
		if _, ok, _ := h.sessions.Get(context.Background(), it.ID); ok {
			t.Fatal("the session of a deleted item must end")
		}
	})
}

// Losing access during a session: whoever is connected is rechecked; an editor without
// DISK_WRITE and a member without DISK_VIEW are dropped through the command service.
func TestRecheckDrops(t *testing.T) {
	h := newHarness(t)
	it := h.store.add("a.xlsx", xlsxOf(t, "v1"))
	a, b, c := editor(h, edit), editor(h, edit), editor(h, view)
	_, r, cfg := h.open(a, it.ID, "")
	h.open(b, it.ID, "")
	h.open(c, it.ID, "")
	if e := h.callback(cfg, map[string]any{"key": r.Key, "status": 1, "users": []string{a.String(), b.String(), c.String()}}); e != 0 {
		t.Fatal("status 1")
	}
	if len(h.commands) != 0 {
		t.Fatalf("nobody lost access: %v", h.commands)
	}
	h.store.bits[b] = view // «Правка» → «Просмотр»
	h.store.bits[c] = 0    // access gone
	h.svc.recheck(context.Background(), it.ID)
	if len(h.commands) != 1 || h.commands[0]["c"] != "drop" || h.commands[0]["key"] != r.Key {
		t.Fatalf("commands %v", h.commands)
	}
	got, _ := json.Marshal(h.commands[0]["users"])
	if !strings.Contains(string(got), b.String()) || !strings.Contains(string(got), c.String()) || strings.Contains(string(got), a.String()) {
		t.Fatalf("dropped %s", got)
	}
	if s, _, _ := h.sessions.Get(context.Background(), it.ID); len(s.Editors) != 1 || s.Editors[0] != a {
		t.Fatalf("editors after the drop: %v", s.Editors)
	}
}

func TestConvert(t *testing.T) {
	h := newHarness(t)
	it := h.store.add("Отпуска 2019.xls", []byte("\xd0\xcf\x11\xe0legacy"))
	u := editor(h, edit)
	calls := 0
	h.saved["/conv/out.xlsx"] = xlsxOf(t, "converted")
	h.convert = func(req jwt.MapClaims) map[string]any {
		calls++
		if req["filetype"] != "xls" || req["outputtype"] != "xlsx" || !strings.HasPrefix(req["url"].(string), "http://api.calab.test/api/office/file/") {
			t.Errorf("converter request %v", req)
		}
		if calls < 2 {
			return map[string]any{"endConvert": false, "percent": 50}
		}
		return map[string]any{"endConvert": true, "percent": 100, "fileUrl": "https://docs.calab.test/conv/out.xlsx"}
	}
	post := func(path string, uid uuid.UUID) *httptest.ResponseRecorder {
		r := httptest.NewRequestWithContext(context.Background(), http.MethodPost, path, nil)
		r = r.WithContext(auth.WithIdentity(r.Context(), auth.Identity{UserID: uid}))
		w := httptest.NewRecorder()
		h.mux.ServeHTTP(w, r)
		return w
	}
	w := post("/api/disk/items/"+it.ID.String()+"/office/convert", u)
	if w.Code != http.StatusCreated || calls != 2 || len(h.store.added) != 1 || h.store.added[0] != "Отпуска 2019.xlsx" {
		t.Fatalf("convert %d %s calls=%d added=%v", w.Code, w.Body, calls, h.store.added)
	}
	if cur, _ := h.store.Item(context.Background(), it.ID); cur.FileID != it.FileID || cur.Name != it.Name || len(h.store.versions[it.ID]) != 0 {
		t.Fatal("the source must stay untouched")
	}
	if w := post("/api/disk/items/"+it.ID.String()+"/office/convert", editor(h, 0)); w.Code != http.StatusNotFound {
		t.Fatalf("no access: %d", w.Code)
	}
	x := h.store.add("a.xlsx", xlsxOf(t, "v1"))
	if w := post("/api/disk/items/"+x.ID.String()+"/office/convert", u); w.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("xlsx is not converted: %d", w.Code)
	}
	// A result that is not an xlsx is refused.
	h.saved["/conv/out.xlsx"] = []byte("<html>")
	calls = 5
	if w := post("/api/disk/items/"+it.ID.String()+"/office/convert", u); w.Code != http.StatusBadGateway {
		t.Fatalf("bad result: %d", w.Code)
	}
}

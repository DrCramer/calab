package office

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

// The configuration every opener holds is signed with the Document Server's secret: it must
// expire, and it must never pass as a request of the Document Server (file download, callback).
func TestConfigTokenIsNotADocumentServerRequest(t *testing.T) {
	h := newHarness(t)
	it := h.store.add("a.xlsx", xlsxOf(t, "v1"))
	_, r, cfg := h.open(editor(h, edit), it.ID, "")
	tok := cfg["token"].(string)
	claims, err := parseDS(dsSecret, tok)
	if err != nil {
		t.Fatal(err)
	}
	exp, err := claims.GetExpirationTime()
	if err != nil || exp == nil || time.Until(exp.Time) > ConfigTokenTTL || time.Until(exp.Time) < ConfigTokenTTL-time.Minute {
		t.Fatalf("config token exp %v %v", exp, err)
	}

	u, _ := url.Parse(dig(cfg, "document", "url").(string))
	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, u.Path, nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	w := httptest.NewRecorder()
	h.mux.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("the config token downloaded the file: %d", w.Code)
	}
	// A callback carrying the config token in the header or in the body is refused.
	body := map[string]any{"key": r.Key, "status": 2, "filetype": "xlsx", "url": h.edited("x", xlsxOf(t, "x")), "users": []string{uuid.NewString()}}
	if h.post(cfg, body, "Bearer "+tok) != 1 {
		t.Fatal("the config token passed as a callback header token")
	}
	body["token"] = tok
	if h.post(cfg, body, "") != 1 {
		t.Fatal("the config token passed as a callback body token")
	}
}

// Requests of the Document Server must carry exp (it always sets one) and be within it.
func TestDocumentServerTokenExpiry(t *testing.T) {
	h := newHarness(t)
	it := h.store.add("a.xlsx", xlsxOf(t, "v1"))
	u := editor(h, edit)
	_, r, cfg := h.open(u, it.ID, "")
	body := map[string]any{"key": r.Key, "status": 6, "filetype": "xlsx", "url": h.edited("x", xlsxOf(t, "x")), "users": []string{u.String()}}
	for name, exp := range map[string]any{"no exp": nil, "expired": time.Now().Add(-10 * time.Minute).Unix()} {
		tok := dsToken(t, dsSecret, jwt.MapClaims{"payload": body, "operation": "callback", "exp": exp})
		if h.post(cfg, body, "Bearer "+tok) != 1 {
			t.Fatalf("%s: accepted", name)
		}
	}
	if cur, _ := h.store.Item(context.Background(), it.ID); cur.FileID != it.FileID {
		t.Fatal("stored a version")
	}
	if h.callback(cfg, body) != 0 {
		t.Fatal("a fresh token refused")
	}
	if _, err := parseDS(dsSecret, dsToken(t, dsSecret, jwt.MapClaims{"exp": nil})); err == nil {
		t.Fatal("parseDS accepted a token without exp")
	}
	none := jwt.NewWithClaims(jwt.SigningMethodNone, jwt.MapClaims{"exp": time.Now().Add(time.Minute).Unix()})
	if s, _ := none.SignedString(jwt.UnsafeAllowNoneSignatureType); s != "" {
		if _, err := parseDS(dsSecret, s); err == nil {
			t.Fatal("alg none accepted")
		}
	}
}

// The Document Server reports only editors in status 1, so viewers are found by their marks: a
// viewer who lost the item is dropped though never «online». An editor dropped for losing
// «Правка» is dropped again when they reconnect as an editor with the configuration they kept,
// and left alone while they only view.
func TestRecheckViewersAndKeptEditConfigs(t *testing.T) {
	h := newHarness(t)
	it := h.store.add("a.xlsx", xlsxOf(t, "v1"))
	a, b, c := editor(h, edit), editor(h, edit), editor(h, view)
	_, r, cfg := h.open(a, it.ID, "")
	h.open(b, it.ID, "")
	h.open(c, it.ID, "")
	if e := h.callback(cfg, map[string]any{"key": r.Key, "status": 1, "users": []string{a.String(), b.String()}}); e != 0 {
		t.Fatal("status 1")
	}
	dropped := func() string {
		if len(h.commands) == 0 {
			return ""
		}
		got, _ := json.Marshal(h.commands[len(h.commands)-1]["users"])
		h.commands = nil
		return string(got)
	}

	h.store.bits[c] = 0 // the viewer leaves the workspace
	h.svc.recheck(context.Background(), it.ID)
	if got := dropped(); !strings.Contains(got, c.String()) || strings.Contains(got, a.String()) {
		t.Fatalf("viewer not dropped: %s", got)
	}
	if s, _, _ := h.sessions.Get(context.Background(), it.ID); len(s.Viewers) != 0 {
		t.Fatalf("the dropped viewer must be forgotten: %+v", s)
	}
	h.svc.recheck(context.Background(), it.ID)
	if got := dropped(); got != "" {
		t.Fatalf("a forgotten viewer dropped again: %s", got)
	}

	h.store.bits[b] = view // «Правка» → «Просмотр»
	h.svc.recheck(context.Background(), it.ID)
	if got := dropped(); !strings.Contains(got, b.String()) {
		t.Fatalf("editor not dropped: %s", got)
	}
	// The Document Server reports b gone; b reopens legitimately as a viewer (no status 1).
	if e := h.callback(cfg, map[string]any{"key": r.Key, "status": 1, "users": []string{a.String()}}); e != 0 {
		t.Fatal("status 1")
	}
	if _, rb, _ := h.open(b, it.ID, ""); rb == nil || rb.Mode.String() != "OFFICE_MODE_VIEW" {
		t.Fatal("b must open in view mode")
	}
	h.svc.recheck(context.Background(), it.ID)
	if got := dropped(); got != "" {
		t.Fatalf("a revoked editor who only views was dropped: %s", got)
	}
	// b reconnects with the edit configuration they kept: status 1 lists them as an editor.
	if e := h.callback(cfg, map[string]any{"key": r.Key, "status": 1, "users": []string{a.String(), b.String()}}); e != 0 {
		t.Fatal("status 1")
	}
	if got := dropped(); !strings.Contains(got, b.String()) || strings.Contains(got, a.String()) {
		t.Fatalf("a revoked editor reconnecting in edit mode must be dropped at once: %s", got)
	}
}

// A drop that does not reach the Document Server keeps the marks: the next sweep retries.
func TestRecheckKeepsMarksWhenTheDropFails(t *testing.T) {
	h := newHarness(t)
	it := h.store.add("a.xlsx", xlsxOf(t, "v1"))
	v := editor(h, view)
	h.open(v, it.ID, "")
	h.store.bits[v] = 0
	h.ds.Close() // the Document Server is down
	h.svc.recheck(context.Background(), it.ID)
	if s, _, _ := h.sessions.Get(context.Background(), it.ID); len(s.Viewers) != 1 {
		t.Fatalf("marks lost on a failed drop: %+v", s)
	}
}

// An open between a forcesave's commit and its Advance (the session still on the file the save
// replaced) joins the live session instead of ending it: ending it would refuse every later
// save of the editors connected to it.
func TestOpenDuringForcesaveKeepsTheSession(t *testing.T) {
	h := newHarness(t)
	it := h.store.add("a.xlsx", xlsxOf(t, "v1"))
	a := editor(h, edit)
	_, r, cfg := h.open(a, it.ID, "")
	// The save lands in the store, the session is not advanced yet.
	saved, err := h.store.SaveVersion(context.Background(), it.ID, it.FileID, a, Format{}, xlsxOf(t, "v2"))
	if err != nil {
		t.Fatal(err)
	}
	_, r2, _ := h.open(editor(h, edit), it.ID, "")
	if r2.Key != r.Key {
		t.Fatal("an open during a forcesave started another session")
	}
	if s, _, _ := h.sessions.Get(context.Background(), it.ID); s.Key != r.Key || s.FileID != saved.FileID {
		t.Fatalf("session %+v", s)
	}
	// The original editors' next save still lands.
	if h.callback(cfg, map[string]any{"key": r.Key, "status": 2, "filetype": "xlsx", "url": h.edited("v3", xlsxOf(t, "v3")), "users": []string{a.String()}}) != 0 {
		t.Fatal("the live session's save was refused")
	}
	// A session on an unrelated older file is still replaced.
	h.sessions.m[it.ID] = Session{Key: "calab-lost", FileID: it.FileID}
	if _, r3, _ := h.open(a, it.ID, ""); r3.Key == "calab-lost" {
		t.Fatal("joined a stale session")
	}
}

func TestRedactURL(t *testing.T) {
	err := redactURL(&url.Error{Op: "Get", URL: "http://ds/cache/files/x?md5=secret", Err: errors.New("dial tcp: refused")})
	if strings.Contains(err.Error(), "md5") || strings.Contains(err.Error(), "/cache/") || !strings.Contains(err.Error(), "refused") {
		t.Fatalf("redacted %q", err)
	}
}

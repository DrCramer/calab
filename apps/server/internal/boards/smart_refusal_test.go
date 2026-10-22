package boards

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/calaba/calaba/server/internal/aifiles"
)

// CBF-75: the model may decline with a reason; the reason is plain text, the duplicate one of
// the tasks shown, and a refusal never comes with a task.
func TestSmartRefusals(t *testing.T) {
	// Step 1: a refusal instead of a board.
	_, _, ref, err := parsePick(`{"refuse":"Не хватает данных: **сумма** счёта"}`, smartList)
	if err != nil || ref == nil || ref.reason != "Не хватает данных: сумма счёта" || ref.duplicate != "" {
		t.Fatalf("pick refusal %+v %v", ref, err)
	}
	for name, raw := range map[string]string{
		"refusal with a board":    `{"refuse":"нет данных","board_key":"DEV"}`,
		"refusal with a title":    `{"refuse":"нет данных","title":"x"}`,
		"empty refusal":           `{"refuse":"  "}`,
		"markup only":             `{"refuse":"** <> []"}`,
		"refusal names a dup":     `{"refuse":"дубль","duplicate_of":"DEV-1"}`,
		"refusal not a string":    `{"refuse":true}`,
		"overlong refusal":        `{"refuse":"` + strings.Repeat("я", maxReasonRaw+1) + `"}`,
		"refusal and prose after": `{"refuse":"нет"} ok`,
	} {
		if _, _, r, err := parsePick(raw, smartList); !errors.Is(err, errBadAnswer) {
			t.Errorf("%s: want a bad answer, got %+v %v", name, r, err)
		}
	}
	// A long reason is clipped to what the window shows.
	_, _, ref, err = parsePick(`{"refuse":"`+strings.Repeat("я", 500)+`"}`, smartList)
	if err != nil || utf8.RuneCountInString(ref.reason) != maxReason {
		t.Fatalf("clipped %+v %v", ref, err)
	}

	// Step 2: a duplicate must be one of the recent tasks shown.
	keys := []string{"DOC-12", "DOC-7"}
	_, ref, err = parseShape(`{"refuse":"Это дубль задачи DOC-12","duplicate_of":"doc-12"}`, nil, []string{"none"}, keys)
	if err != nil || ref == nil || ref.duplicate != "DOC-12" {
		t.Fatalf("shape duplicate %+v %v", ref, err)
	}
	_, ref, err = parseShape(`{"refuse":"Дубль HR-1","duplicate_of":"HR-1"}`, nil, []string{"none"}, keys)
	if err != nil || ref == nil || ref.duplicate != "" {
		t.Fatalf("a key not shown is dropped: %+v %v", ref, err)
	}
	for name, raw := range map[string]string{
		"refusal with a task":     `{"refuse":"дубль","duplicate_of":"DOC-12","title":"t"}`,
		"task naming a duplicate": `{"title":"t","description":"","labels":[],"priority":"none","duplicate_of":"DOC-12"}`,
	} {
		if _, r, err := parseShape(raw, nil, []string{"none"}, keys); !errors.Is(err, errBadAnswer) {
			t.Errorf("%s: want a bad answer, got %+v %v", name, r, err)
		}
	}

	// The duplicate check alone.
	if ref, err := parseDup(`{"duplicate_of":""}`, keys); err != nil || ref != nil {
		t.Fatalf("no duplicate %+v %v", ref, err)
	}
	if ref, err := parseDup(`{"refuse":"Уже есть DOC-7","duplicate_of":"DOC-7"}`, keys); err != nil || ref == nil || ref.duplicate != "DOC-7" {
		t.Fatalf("duplicate %+v %v", ref, err)
	}
	// A «duplicate» of nothing shown files the task.
	if ref, err := parseDup(`{"refuse":"дубль","duplicate_of":"SEC-1"}`, keys); err != nil || ref != nil {
		t.Fatalf("unknown duplicate %+v %v", ref, err)
	}
	for _, raw := range []string{`{"duplicate_of":"DOC-7"}`, `{"refuse":"x","duplicate_of":"DOC-7","title":"t"}`, `yes`, `{}{}`} {
		if _, err := parseDup(raw, keys); !errors.Is(err, errBadAnswer) {
			t.Errorf("%s: want a bad answer, got %v", raw, err)
		}
	}
}

func TestCleanReason(t *testing.T) {
	id := "0b6f1a52-3c1e-4c55-9a9e-5d2f7b1c0e11"
	for in, want := range map[string]string{
		"Нет [ссылки](https://evil.example/x?y) и www.evil.example": "Нет ссылки ( и",
		"Позовите @everyone и @" + id:                               "Позовите everyone и " + id,
		"<b>жирный</b>\n\n# заголовок | `код`":                      "b жирный /b заголовок код",
		"скрытый\u202eтекст\u200bи\x00ноль":                         "скрытый текст и ноль",
		"javascript:alert(1) mailto:a@b.c":                          "",
	} {
		if got := cleanReason(in); got != want {
			t.Errorf("%q -> %q, want %q", in, got, want)
		}
	}
}

// The duplicate candidates: live tasks of the window in the order given (newest first), at
// most limit, on one line and clipped.
func TestDupCandidates(t *testing.T) {
	now := time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC)
	since := now.Add(-dupWindow)
	archived := now
	rows := []taskRow{
		{BoardKey: "DOC", Number: 9, Title: "Новая", Description: "строка 1\n\nстрока 2", CreatedAt: now},
		{BoardKey: "DOC", Number: 8, Title: "Архивная", CreatedAt: now, ArchivedAt: &archived},
		{BoardKey: "DOC", Number: 7, Title: "Длинная", Description: strings.Repeat("я", 1000), CreatedAt: now.Add(-13 * 24 * time.Hour)},
		{BoardKey: "DOC", Number: 6, Title: "Старая", CreatedAt: now.Add(-15 * 24 * time.Hour)},
		{BoardKey: "DOC", Number: 5, Title: "Ещё", CreatedAt: now},
	}
	got := dupCandidates(rows, since, 2)
	if len(got) != 2 || got[0].Key != "DOC-9" || got[0].Description != "строка 1 строка 2" || got[1].Key != "DOC-7" ||
		utf8.RuneCountInString(got[1].Description) != maxDupDescription {
		t.Fatalf("%+v", got)
	}
	if got := dupCandidates(rows, since, 10); len(got) != 3 || got[2].Key != "DOC-5" {
		t.Fatalf("window %+v", got)
	}
}

// The data message: plain text without images; with images, the JSON, then a server-written
// label and each image.
func TestUserMessage(t *testing.T) {
	files := aifiles.Prepared{Files: []aifiles.File{{Name: "a.txt", Content: aifiles.ContentText, Text: "x"}}}
	m := userMessage(map[string]any{"request": "r"}, files)
	if m.Content == "" || m.Parts != nil || !strings.Contains(m.Content, `"files":[{"name":"a.txt"`) {
		t.Fatalf("text %+v", m)
	}
	files.Files = append(files.Files, aifiles.File{Name: "act.pdf", Content: aifiles.ContentPages, Images: []int{1, 2}})
	files.Images = []aifiles.Image{{File: 1, Page: 1, DataURL: "data:image/jpeg;base64,AA=="}, {File: 1, Page: 9, DataURL: "data:image/jpeg;base64,AQ=="}}
	m = userMessage(map[string]any{"request": "r"}, files)
	if len(m.Parts) != 5 || m.Parts[1].Text != "Image 1: file 2, page 1" || m.Parts[3].Text != "Image 2: file 2, page 9" ||
		m.Parts[4].ImageURL == nil || m.Parts[4].ImageURL.URL != "data:image/jpeg;base64,AQ==" {
		t.Fatalf("parts %+v", m.Parts)
	}
	b, _ := json.Marshal(m)
	if !strings.Contains(string(b), `"content":[{"type":"text"`) || !strings.Contains(string(b), `"type":"image_url","image_url":{"url":"data:image/jpeg;base64,AA=="}`) {
		t.Fatalf("wire %s", b)
	}
}

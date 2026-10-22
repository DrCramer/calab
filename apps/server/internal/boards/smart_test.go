package boards

import (
	"errors"
	"strings"
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/messages"
	"github.com/calaba/calaba/server/internal/perm"
)

var smartList = []smartBoard{{Key: "DEV", Name: "Разработка"}, {Key: "DOC", Name: "Документы", Labels: []string{"Счёт", "Договор"}}}

func TestParsePick(t *testing.T) {
	for _, c := range []struct {
		name, raw string
		idx       int
		title     string
		bad       bool
	}{
		{name: "valid", raw: `{"board_key":"DOC","title":"Оплатить счёт"}`, idx: 1, title: "Оплатить счёт"},
		{name: "lower-case key", raw: `{"board_key":"dev","title":"x"}`, idx: 0, title: "x"},
		{name: "code fence", raw: "```json\n{\"board_key\":\"DEV\",\"title\":\"Fix\"}\n```", idx: 0, title: "Fix"},
		{name: "mentions and newlines dropped", raw: `{"board_key":"DEV","title":"call @everyone\nnow"}`, idx: 0, title: "call everyone now"},
		{name: "board not in the list", raw: `{"board_key":"HR","title":"x"}`, bad: true},
		{name: "no key", raw: `{"title":"x"}`, bad: true},
		{name: "extra field", raw: `{"board_key":"DEV","title":"x","assignee":"u1"}`, bad: true},
		{name: "prose", raw: `I think DEV fits best.`, bad: true},
		{name: "prose around JSON", raw: `Sure: {"board_key":"DEV","title":"x"}`, bad: true},
		{name: "two objects", raw: `{"board_key":"DEV","title":"x"}{"board_key":"DOC","title":"y"}`, bad: true},
		{name: "array", raw: `[{"board_key":"DEV"}]`, bad: true},
		{name: "wrong type", raw: `{"board_key":7,"title":"x"}`, bad: true},
		{name: "empty", raw: ``, bad: true},
	} {
		i, title, err := parsePick(c.raw, smartList)
		if c.bad {
			if !errors.Is(err, errBadAnswer) {
				t.Errorf("%s: want a bad answer, got %d %q %v", c.name, i, title, err)
			}
			continue
		}
		if err != nil || i != c.idx || title != c.title {
			t.Errorf("%s: %d %q %v", c.name, i, title, err)
		}
	}
}

func TestParseShape(t *testing.T) {
	all := []string{"none", "low", "medium", "high", "urgent"}
	sh, err := parseShape(`{"title":"Счёт №5","description":"Сумма: 100\n@11111111-2222-3333-4444-555555555555 проверить","labels":["счёт","Чужая","Счёт"],"priority":"HIGH"}`,
		smartList[1].Labels, all)
	if err != nil {
		t.Fatal(err)
	}
	if sh.title != "Счёт №5" || sh.priority != v1.TaskPriority_TASK_PRIORITY_HIGH || len(sh.labels) != 1 || sh.labels[0] != "Счёт" {
		t.Fatalf("shaped %+v", sh)
	}
	if strings.Contains(sh.description, "@") {
		t.Fatalf("a mention the model wrote survived: %q", sh.description)
	}
	// Priority off on the board: only "none" (or nothing) is accepted.
	if sh, err := parseShape(`{"title":"t","description":"","labels":[],"priority":""}`, nil, []string{"none"}); err != nil || sh.priority != v1.TaskPriority_TASK_PRIORITY_NONE {
		t.Fatalf("no priority: %+v %v", sh, err)
	}
	for name, raw := range map[string]string{
		"priority not allowed": `{"title":"t","description":"","labels":[],"priority":"high"}`,
		"unknown priority":     `{"title":"t","description":"","labels":[],"priority":"asap"}`,
		"empty title":          `{"title":"  ","description":"d","labels":[],"priority":"none"}`,
		"extra field":          `{"title":"t","description":"d","labels":[],"priority":"none","board_key":"DEV"}`,
		"garbage":              `not json`,
	} {
		if _, err := parseShape(raw, nil, []string{"none"}); !errors.Is(err, errBadAnswer) {
			t.Errorf("%s: want a bad answer, got %v", name, err)
		}
	}
	// Long texts are clipped.
	long := strings.Repeat("я", 9000)
	sh, err = parseShape(`{"title":"`+long+`","description":"`+long+`","labels":[],"priority":"none"}`, nil, all)
	if err != nil || len([]rune(sh.title)) > maxSmartTitle || len([]rune(sh.description)) > maxSmartDescription {
		t.Fatalf("clipped: %d %d %v", len([]rune(sh.title)), len([]rune(sh.description)), err)
	}
}

func TestSmartEligible(t *testing.T) {
	for _, c := range []struct {
		name string
		acc  perm.BoardAccess
		want bool
	}{
		{"create", perm.BoardAccess{Bits: perm.ViewBoard | perm.CreateTasks}, true},
		{"create-only (ADR-0115)", perm.BoardAccess{Bits: perm.CreateTasks, TaskScoped: true}, true},
		{"view only", perm.BoardAccess{Bits: perm.ViewBoard}, false},
		{"task-scoped by invitation", perm.BoardAccess{TaskScoped: true}, false},
		{"hidden", perm.BoardAccess{}, false},
		{"archived", perm.BoardAccess{Bits: perm.ViewBoard | perm.CreateTasks, Archived: true}, false},
		{"suspended", perm.BoardAccess{Bits: perm.ViewBoard | perm.CreateTasks, Suspended: true}, false},
	} {
		if got := smartEligible(c.acc); got != c.want {
			t.Errorf("%s: %v", c.name, got)
		}
	}
}

// A model's mentions never survive, even nested ones that a single pass would uncover.
func TestStripMentions(t *testing.T) {
	id := "0b6f1a52-3c1e-4c55-9a9e-5d2f7b1c0e11"
	for _, in := range []string{"@" + id, "@@" + id, "@@@everyone", "x @@here y", "@@@@" + id + " @@everyone"} {
		out := stripMentions(in)
		if users, everyone := messages.ParseMentions(out); len(users) > 0 || everyone {
			t.Fatalf("%q -> %q still mentions", in, out)
		}
	}
}

func TestSmartTexts(t *testing.T) {
	if got := fallbackTitle("  первая   строка\nвторая"); got != "первая строка" {
		t.Fatalf("fallback %q", got)
	}
	if got := quoted("a\nb"); got != "> a\n> b" {
		t.Fatalf("quoted %q", got)
	}
	// The data message keeps the user's text as data (no HTML escaping, valid JSON).
	if got := userJSON(map[string]any{"request": `<b>"x"</b>`}); got != `{"request":"<b>\"x\"</b>"}` {
		t.Fatalf("json %s", got)
	}
}

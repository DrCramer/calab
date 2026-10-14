package boards

import (
	"strings"
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/google/uuid"
)

func TestFormV2Definition(t *testing.T) {
	sel, date, people, file := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	label := uuid.NewString()
	base := func() *v1.BoardFormDefinition {
		return &v1.BoardFormDefinition{Title: "V2", StatusId: uuid.NewString(), Fields: []*v1.BoardFormField{
			{Id: sel, Type: ftSelect, Label: "Kind", Options: []string{"A", "B"}, Target: toPriority, OptionPriorities: map[string]v1.TaskPriority{"A": v1.TaskPriority_TASK_PRIORITY_HIGH}},
			{Id: date, Type: ftDate, Label: "Due", Target: toDue},
			{Id: people, Type: ftPeople, Label: "Who", Multiple: true, Target: toAssignees},
			{Id: file, Type: ftFile, Label: "Files", Multiple: true, MaxFiles: 3, Accept: []string{"pdf"}},
		}, Routes: []*v1.BoardFormRoute{{FieldId: sel, Option: "B", BoardId: uuid.NewString()}}}
	}
	if err := validateForm(base()); err != nil {
		t.Fatal(err)
	}
	for name, mutate := range map[string]func(d *v1.BoardFormDefinition){
		"target type": func(d *v1.BoardFormDefinition) { d.Fields[1].Target = toLabels },
		"duplicate target": func(d *v1.BoardFormDefinition) {
			d.Fields[1].Type, d.Fields[1].Target, d.Fields[1].Options = ftSelect, toPriority, []string{"x"}
		},
		"unknown option": func(d *v1.BoardFormDefinition) { d.Fields[0].OptionPriorities["Z"] = 1 },
		"labels map":     func(d *v1.BoardFormDefinition) { d.Fields[0].OptionLabels = map[string]string{"A": label} },
		"route field":    func(d *v1.BoardFormDefinition) { d.Routes[0].FieldId = date },
		"route option":   func(d *v1.BoardFormDefinition) { d.Routes[0].Option = "C" },
		"files total": func(d *v1.BoardFormDefinition) {
			d.Fields[3].MaxFiles = 20
			d.Fields = append(d.Fields, &v1.BoardFormField{Id: uuid.NewString(), Type: ftFile, Label: "More"})
		},
		"file category":   func(d *v1.BoardFormDefinition) { d.Fields[3].Accept = []string{"exe"} },
		"single files":    func(d *v1.BoardFormDefinition) { d.Fields[3].Multiple = false },
		"multiple text":   func(d *v1.BoardFormDefinition) { d.Fields[1].Multiple = true },
		"title from file": func(d *v1.BoardFormDefinition) { d.TitleFieldId = file },
		"role on select":  func(d *v1.BoardFormDefinition) { d.Fields[0].RoleId = uuid.NewString() },
	} {
		d := base()
		mutate(d)
		if err := validateForm(d); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	d := base()
	d.Fields[0].Target, d.Fields[0].OptionPriorities, d.Fields[0].OptionLabels = toLabels, nil, map[string]string{"A": label}
	if err := validateForm(d); err != nil {
		t.Fatal(err)
	}
	who := uuid.NewString()
	res, err := parseAnswers(d, []*v1.BoardFormAnswer{{FieldId: sel, Value: "A"}, {FieldId: date, Value: "2026-11-01"},
		{FieldId: people, Values: []string{who}}, {FieldId: file, Values: []string{"a.pdf"}}}, answerOpts{})
	if err != nil || res.due != "2026-11-01" || len(res.labels) != 1 || res.labels[0].String() != label || len(res.assignees) != 1 || !strings.Contains(res.description, "a.pdf") {
		t.Fatalf("mapping %+v %v", res, err)
	}
	if _, err := parseAnswers(d, []*v1.BoardFormAnswer{{FieldId: people, Values: []string{who}}}, answerOpts{hidden: map[string]bool{people: true}}); err == nil {
		t.Fatal("hidden field answered")
	}
	if _, err := parseAnswers(d, []*v1.BoardFormAnswer{{FieldId: file, Values: []string{"1", "2", "3", "4"}}}, answerOpts{}); err == nil {
		t.Fatal("too many files")
	}
	if _, err := parseAnswers(d, []*v1.BoardFormAnswer{{FieldId: people, Value: who}}, answerOpts{}); err == nil {
		t.Fatal("people answered with value")
	}
}

func TestFormFileAllowed(t *testing.T) {
	for _, tc := range []struct {
		mime, name string
		accept     []string
		ok         bool
	}{
		{"text/html", "a.png", nil, false}, {"image/svg+xml", "a.svg", []string{"image"}, false},
		{"image/png", "a.png", []string{"image"}, true}, {"application/pdf", "a.pdf", []string{"image"}, false},
		{"application/zip", "a.docx", []string{"document"}, true}, {"application/zip", "a.zip", []string{"document"}, false},
		{"application/zip", "a.zip", []string{"archive"}, true}, {"application/octet-stream", "a.bin", nil, true},
	} {
		if formFileAllowed(tc.mime, tc.name, tc.accept) != tc.ok {
			t.Errorf("%s %s %v", tc.mime, tc.name, tc.accept)
		}
	}
}

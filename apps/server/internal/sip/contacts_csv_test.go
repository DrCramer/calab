package sip

import (
	"bytes"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/google/uuid"
	"golang.org/x/text/encoding/charmap"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
)

const ruCaller = "+74951234567"

func mustParse(t *testing.T, raw string) []importRow {
	t.Helper()
	rows, err := parseContactsCSV([]byte(raw), ruCaller)
	if err != nil {
		t.Fatal(err)
	}
	return rows
}

func numbersOf(r importRow) []string {
	out := []string{}
	for _, p := range r.phones {
		out = append(out, p.Label+":"+p.Number)
	}
	return out
}

func TestImportRussianSemicolonBOM(t *testing.T) {
	raw := "\xef\xbb\xbfФИО;Организация;Мобильный телефон;Рабочий;Комментарий\r\n" +
		"Анна Петрова;ООО Ромашка;8 (916) 123-45-67;+7 495 765-43-21, 9031112233;Перезвонить\r\n" +
		";ООО Лютик;;'+74957654300;\r\n" +
		";;;;\r\n" + // a blank row is no row
		"Борис;;;;без номера\r\n"
	rows := mustParse(t, raw)
	if len(rows) != 3 {
		t.Fatalf("rows: %+v", rows)
	}
	a := rows[0]
	if a.skip != "" || a.name != "Анна Петрова" || a.company != "ООО Ромашка" || a.note != "Перезвонить" || a.line != 2 ||
		strings.Join(numbersOf(a), " ") != "mobile:+79161234567 work:+74957654321 work:+79031112233" {
		t.Fatalf("row 2: %+v", a)
	}
	if b := rows[1]; b.skip != "" || b.name != "" || b.company != "ООО Лютик" || strings.Join(numbersOf(b), " ") != "work:+74957654300" {
		t.Fatalf("row 3: %+v", b)
	}
	if c := rows[2]; c.skip != skipNoNumber || c.line != 5 {
		t.Fatalf("row 5: %+v", c)
	}
}

func TestImportEnglishCommaAndCP1251(t *testing.T) {
	rows := mustParse(t, "Name,Company,Phone 1,Phone 2,Notes\n\"Doe, John\",ACME,+1 212 555 0100,\"+44 20 7946 0958; +49 30 1234567\",vip\n")
	if len(rows) != 1 || rows[0].name != "Doe, John" || len(rows[0].phones) != 3 || rows[0].phones[0].Label != "other" {
		t.Fatalf("english: %+v", rows)
	}
	enc, err := charmap.Windows1251.NewEncoder().String("Имя;Телефон\nСергей Иванов;+79161234567\n")
	if err != nil {
		t.Fatal(err)
	}
	rows = mustParse(t, enc)
	if len(rows) != 1 || rows[0].name != "Сергей Иванов" || rows[0].skip != "" {
		t.Fatalf("cp1251: %+v", rows)
	}
}

func TestImportRowReasons(t *testing.T) {
	long := strings.Repeat("я", 129)
	eleven := make([]string, 11)
	for i := range eleven {
		eleven[i] = fmt.Sprintf("+791612345%02d", i)
	}
	rows := mustParse(t, "Имя;Компания;Телефон\n"+
		";;+79161234567\n"+ // no name
		"A;;12345\n"+ // bad number
		long+";;+79161234567\n"+ // too long
		"B;;\""+strings.Join(eleven, ",")+"\"\n"+ // too many numbers
		"C;\x01ctl;+79161230000\n")
	want := []string{skipNoName, skipBad, skipTooLong, skipTooMany, ""}
	for i, w := range want {
		if rows[i].skip != w {
			t.Fatalf("row %d: %q, want %q (%+v)", i, rows[i].skip, w, rows[i])
		}
	}
	if rows[1].skipNumber != "12345" || rows[4].company != "ctl" {
		t.Fatalf("details: %+v %+v", rows[1], rows[4])
	}
}

func TestImportFileErrors(t *testing.T) {
	var big strings.Builder
	big.WriteString("Имя;Телефон\n")
	for i := range importMaxRows + 1 {
		fmt.Fprintf(&big, "A;+7916%07d\n", i)
	}
	for name, raw := range map[string]string{
		"5001 rows":   big.String(),
		"too large":   strings.Repeat("x", importMaxBytes+1),
		"no header":   "Анна;+79161234567\n",
		"no phone":    "Имя;Компания\nАнна;ООО\n",
		"empty":       "",
		"name absent": "Телефон\n+79161234567\n",
	} {
		_, err := parseContactsCSV([]byte(raw), ruCaller)
		var he *httpx.Error
		if !errors.As(err, &he) || he.Status != 422 || he.Field != "file" {
			t.Fatalf("%s: %v", name, err)
		}
	}
	// 5000 rows are fine.
	var ok strings.Builder
	ok.WriteString("Имя;Телефон\n")
	for i := range importMaxRows {
		fmt.Fprintf(&ok, "A;+7916%07d\n", i)
	}
	if rows := mustParse(t, ok.String()); len(rows) != importMaxRows {
		t.Fatalf("5000: %d", len(rows))
	}
}

func TestPlanImport(t *testing.T) {
	rows := mustParse(t, "Имя;Телефон\nA;+79161234567\nB;+79160000001, +79161234567\nC;+79160000002\nD;+79160000003\nE;+79160000004\n")
	owner := uuid.New()
	taken := map[string]sqlc.SipContactNumberOwnersRow{"+79160000002": {Number: "+79160000002", ID: owner, Company: "ООО Ромашка"}}
	planImport(rows, taken, MaxContacts-2)
	got := []string{}
	for _, r := range rows {
		got = append(got, r.skip)
	}
	// A in, B repeats A's number, C's number is taken, D in (the cap leaves 2), E over the cap.
	if strings.Join(got, ",") != ",duplicate,number_taken,,limit" || rows[2].skipContact.ID != owner || rows[1].skipNumber != "+79161234567" {
		t.Fatalf("plan: %v %+v", got, rows)
	}
}

func TestExportDefusesFormulasAndRoundTrips(t *testing.T) {
	for in, want := range map[string]string{
		"=HYPERLINK(\"x\")": "'=HYPERLINK(\"x\")", "+79161234567": "'+79161234567", "-1": "'-1", "@SUM(A1)": "'@SUM(A1)",
		"\tx": "'\tx", "ООО Ромашка": "ООО Ромашка", "": "",
	} {
		if got := csvSafe(in); got != want {
			t.Fatalf("csvSafe(%q) = %q", in, got)
		}
	}
	var buf bytes.Buffer
	contacts := []*v1.SipContact{
		{Name: "=cmd|' /C calc'!A0", Company: "ООО «Ромашка»; филиал", Note: "строка 1\nстрока 2", Phones: []*v1.SipContactPhone{
			{Number: "+79161234567", Label: v1.SipPhoneLabel_SIP_PHONE_LABEL_MOBILE},
			{Number: "+74957654321", Label: v1.SipPhoneLabel_SIP_PHONE_LABEL_WORK},
			{Number: "+74957654322", Label: v1.SipPhoneLabel_SIP_PHONE_LABEL_WORK},
		}},
	}
	if err := writeContactsCSV(&buf, contacts); err != nil {
		t.Fatal(err)
	}
	out := buf.String()
	if !strings.HasPrefix(out, utf8BOM+"Имя;Компания;Мобильный") || strings.Contains(out, ";=cmd") || !strings.Contains(out, "'=cmd") ||
		!strings.Contains(out, "'+79161234567") {
		t.Fatalf("export: %q", out)
	}
	rows := mustParse(t, out)
	if len(rows) != 1 || rows[0].skip != "" || rows[0].name != "=cmd|' /C calc'!A0" || rows[0].company != "ООО «Ромашка»; филиал" ||
		rows[0].note != "строка 1\nстрока 2" ||
		strings.Join(numbersOf(rows[0]), " ") != "mobile:+79161234567 work:+74957654321 work:+74957654322" {
		t.Fatalf("round trip: %+v", rows)
	}
}

func TestHeaderColumns(t *testing.T) {
	for cell, want := range map[string]csvColumn{
		"Имя": {kind: "name"}, " ФИО ": {kind: "name"}, "Full Name": {kind: "name"}, "Компания": {kind: "company"},
		"Organization": {kind: "company"}, "Телефон": {kind: "phone", label: "other"}, "Мобильный": {kind: "phone", label: "mobile"},
		"Телефон (рабочий)": {kind: "phone", label: "work"}, "Home Phone": {kind: "phone", label: "home"}, "Phone 2": {kind: "phone", label: "other"},
		"Заметка": {kind: "note"}, "Должность": {}, "E-mail": {}, "Телеграм": {}, "Тел. моб.": {kind: "phone", label: "mobile"},
	} {
		if got := headerColumn(cell); got != want {
			t.Fatalf("%q: %+v, want %+v", cell, got, want)
		}
	}
}

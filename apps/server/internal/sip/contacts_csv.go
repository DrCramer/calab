package sip

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"golang.org/x/text/encoding/charmap"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
)

// CSV import and export of the phone book (ADR-0137 §2). The file is untrusted: its size and
// rows are bounded before anything is parsed, its encoding is UTF-8 (BOM or not) or else
// Windows-1251, every cell is cleaned like a typed field, and nothing it says overwrites a
// contact (a number that is taken skips the row with the reason). The export defuses cells a
// spreadsheet would run as formulas.

// Import limits.
const (
	importMaxBytes = 1 << 20
	importMaxRows  = 5000
)

// Reasons a row of an import is skipped (SipContactImportSkip.reason).
const (
	skipTaken     = "number_taken"
	skipDuplicate = "duplicate"
	skipNoName    = "no_name"
	skipNoNumber  = "no_number"
	skipBad       = "bad_number"
	skipTooMany   = "too_many_numbers"
	skipTooLong   = "too_long"
	skipLimit     = "limit"
)

func errImport(msg string) error { return httpx.Validation("file", msg) }

// importRow is a data row of an import file: its contact or why it is skipped.
type importRow struct {
	line                int
	name, company, note string
	phones              []contactPhone
	skip, skipNumber    string
	skipContact         *sqlc.SipContactNumberOwnersRow
}

// csvColumn is what a column of the file holds.
type csvColumn struct {
	kind  string // "name", "company", "note", "phone"; "" = ignored
	label string // phone columns: mobile / work / home / other
}

// headerColumn recognises a header cell (Russian or English, any case).
func headerColumn(cell string) csvColumn {
	h := strings.ToLower(strings.Join(strings.Fields(cleanCell(cell)), " "))
	switch h {
	case "имя", "фио", "ф.и.о.", "name", "full name", "контакт", "contact", "имя контакта", "contact name":
		return csvColumn{kind: "name"}
	case "компания", "организация", "company", "organization", "organisation", "фирма":
		return csvColumn{kind: "company"}
	case "заметка", "заметки", "комментарий", "примечание", "note", "notes", "comment", "comments":
		return csvColumn{kind: "note"}
	case "мобильный", "mobile", "cell", "сотовый":
		return csvColumn{kind: "phone", label: "mobile"}
	case "рабочий", "work":
		return csvColumn{kind: "phone", label: "work"}
	case "домашний", "home":
		return csvColumn{kind: "phone", label: "home"}
	case "другой", "other":
		return csvColumn{kind: "phone", label: "other"}
	}
	if strings.HasPrefix(h, "телефон") || strings.HasPrefix(h, "phone") || h == "тел" || strings.HasPrefix(h, "тел.") ||
		strings.HasPrefix(h, "тел ") || strings.Contains(h, " телефон") || strings.Contains(h, " phone") {
		switch {
		case strings.Contains(h, "моб") || strings.Contains(h, "mobile") || strings.Contains(h, "сот"):
			return csvColumn{kind: "phone", label: "mobile"}
		case strings.Contains(h, "раб") || strings.Contains(h, "work"):
			return csvColumn{kind: "phone", label: "work"}
		case strings.Contains(h, "дом") || strings.Contains(h, "home"):
			return csvColumn{kind: "phone", label: "home"}
		}
		return csvColumn{kind: "phone", label: "other"}
	}
	return csvColumn{}
}

// cleanCell drops what the export added (a leading «'») and the spreadsheet's padding.
func cleanCell(s string) string {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "'")
	return strings.TrimSpace(s)
}

// importText cleans a text cell: control characters become spaces (line breaks and tabs stay in
// notes), surrounding space goes. ok = false when it is longer than n runes.
func importText(s string, n int, note bool) (string, bool) {
	s = strings.ReplaceAll(cleanCell(s), "\r\n", "\n")
	s = strings.Map(func(r rune) rune {
		switch {
		case r == utf8.RuneError:
			return ' '
		case note && (r == '\n' || r == '\t'):
			return r
		case unicode.IsControl(r):
			return ' '
		}
		return r
	}, s)
	s = strings.TrimSpace(s)
	return s, utf8.RuneCountInString(s) <= n
}

// utf8BOM starts the export (Excel reads the file as UTF-8 then).
const utf8BOM = "\xef\xbb\xbf"

// decodeCSV is the file as UTF-8 text: without a BOM, from Windows-1251 when it is not UTF-8.
func decodeCSV(raw []byte) (string, error) {
	raw = bytes.TrimPrefix(raw, []byte(utf8BOM))
	if utf8.Valid(raw) {
		return string(raw), nil
	}
	out, err := charmap.Windows1251.NewDecoder().Bytes(raw)
	if err != nil {
		return "", errImport("the file is neither UTF-8 nor Windows-1251 text")
	}
	return string(out), nil
}

// csvDelimiter: «;» when the first line has more of them than «,» (Excel on a Russian Windows).
func csvDelimiter(text string) rune {
	first, _, _ := strings.Cut(text, "\n")
	if strings.Count(first, ";") > strings.Count(first, ",") {
		return ';'
	}
	return ','
}

// splitNumbers splits a phone cell into its numbers («,» or «;» between them).
func splitNumbers(cell string) []string {
	var out []string
	for _, part := range strings.FieldsFunc(cell, func(r rune) bool { return r == ',' || r == ';' || r == '\n' }) {
		if p := cleanCell(part); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// parseContactsCSV reads an import file into its rows (callerID: the workspace's number, for the
// 10-digit +7 rule). An error is the whole file's: too large, too many rows, no header.
func parseContactsCSV(raw []byte, callerID string) ([]importRow, error) {
	if len(raw) > importMaxBytes {
		return nil, errImport("the file is larger than 1 MB")
	}
	text, err := decodeCSV(raw)
	if err != nil {
		return nil, err
	}
	rd := csv.NewReader(strings.NewReader(text))
	rd.Comma, rd.LazyQuotes, rd.FieldsPerRecord = csvDelimiter(text), true, -1
	header, err := rd.Read()
	if errors.Is(err, io.EOF) {
		return nil, errImport("the file is empty")
	}
	if err != nil {
		return nil, errImport("the file is not CSV")
	}
	cols := make([]csvColumn, len(header))
	var hasName, hasPhone bool
	seen := map[string]bool{}
	for i, h := range header {
		c := headerColumn(h)
		if c.kind != "phone" && c.kind != "" {
			if seen[c.kind] {
				c = csvColumn{} // a second name column is ignored
			}
			seen[c.kind] = true
		}
		cols[i] = c
		hasName = hasName || c.kind == "name" || c.kind == "company"
		hasPhone = hasPhone || c.kind == "phone"
	}
	if !hasName || !hasPhone {
		return nil, errImport("the first row must name the columns: Имя or Компания, and Телефон (Name, Company, Phone)")
	}
	var rows []importRow
	for {
		rec, err := rd.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, errImport("the file is not CSV")
		}
		line, _ := rd.FieldPos(0)
		if blank(rec) {
			continue
		}
		if len(rows) == importMaxRows {
			return nil, errImport("the file has more than 5000 rows")
		}
		rows = append(rows, importRowOf(line, rec, cols, callerID))
	}
	return rows, nil
}

func blank(rec []string) bool {
	for _, c := range rec {
		if strings.TrimSpace(c) != "" {
			return false
		}
	}
	return true
}

func importRowOf(line int, rec []string, cols []csvColumn, callerID string) importRow {
	row := importRow{line: line}
	long := false
	seen := map[string]bool{}
	for i, cell := range rec {
		if i >= len(cols) {
			break
		}
		var ok bool
		switch c := cols[i]; c.kind {
		case "name":
			row.name, ok = importText(cell, contactNameMax, false)
			long = long || !ok
		case "company":
			row.company, ok = importText(cell, contactNameMax, false)
			long = long || !ok
		case "note":
			row.note, ok = importText(cell, contactNoteMax, true)
			long = long || !ok
		case "phone":
			for _, raw := range splitNumbers(cell) {
				n, ok := NormalizeContactNumber(raw, callerID)
				if !ok {
					if row.skip == "" {
						row.skip, row.skipNumber = skipBad, clip(raw, 32)
					}
					continue
				}
				if !seen[n] {
					seen[n] = true
					row.phones = append(row.phones, contactPhone{Number: n, Label: c.label, Position: len(row.phones)})
				}
			}
		}
	}
	switch {
	case row.skip != "":
	case long:
		row.skip = skipTooLong
	case row.name == "" && row.company == "":
		row.skip = skipNoName
	case len(row.phones) == 0:
		row.skip = skipNoNumber
	case len(row.phones) > maxContactPhones:
		row.skip = skipTooMany
	}
	return row
}

// planImport marks the rows that cannot be imported against the file itself (a number an
// earlier row has), the workspace's contacts (taken numbers) and its cap (have contacts now).
func planImport(rows []importRow, taken map[string]sqlc.SipContactNumberOwnersRow, have int) {
	inFile := map[string]bool{}
	room := MaxContacts - have
	for i := range rows {
		r := &rows[i]
		if r.skip != "" {
			continue
		}
		for _, p := range r.phones {
			if o, ok := taken[p.Number]; ok {
				r.skip, r.skipNumber, r.skipContact = skipTaken, p.Number, &o
				break
			}
			if inFile[p.Number] {
				r.skip, r.skipNumber = skipDuplicate, p.Number
				break
			}
		}
		if r.skip != "" {
			continue
		}
		if room <= 0 {
			r.skip = skipLimit
			continue
		}
		room--
		for _, p := range r.phones {
			inFile[p.Number] = true
		}
	}
}

// importFile reads the multipart part "file" of the request (≤ 1 MB).
func importFile(w http.ResponseWriter, r *http.Request) ([]byte, error) {
	r.Body = http.MaxBytesReader(w, r.Body, importMaxBytes+64<<10)
	mr, err := r.MultipartReader()
	if err != nil {
		return nil, errImport("send the file as multipart/form-data in the part «file»")
	}
	for {
		part, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			return nil, errImport("no part «file»")
		}
		if err != nil {
			return nil, errImport("the file is larger than 1 MB or the form is broken")
		}
		if part.FormName() != "file" {
			_ = part.Close()
			continue
		}
		raw, err := io.ReadAll(io.LimitReader(part, importMaxBytes+1))
		_ = part.Close()
		if err != nil {
			return nil, errImport("the file is larger than 1 MB or the form is broken")
		}
		if len(raw) > importMaxBytes {
			return nil, errImport("the file is larger than 1 MB")
		}
		return raw, nil
	}
}

func (s *Service) importContacts(w http.ResponseWriter, r *http.Request) error {
	u, err := s.sectionMember(r)
	if err != nil {
		return err
	}
	if !u.manager() {
		return httpx.Forbidden("MANAGE_INTEGRATIONS required")
	}
	ctx := r.Context()
	if err := s.planAllows(ctx, u.ws); err != nil {
		return err
	}
	dry := r.URL.Query().Get("dry_run") == "1" || r.URL.Query().Get("dry_run") == "true"
	if err := s.ImportLimit.Take(ctx, u.ws.String()); err != nil {
		return err
	}
	raw, err := importFile(w, r)
	if err != nil {
		return err
	}
	a, _, err := s.account(ctx, s.db.Q, u.ws)
	if err != nil {
		return err
	}
	rows, err := parseContactsCSV(raw, a.CallerID)
	if err != nil {
		return err
	}
	out := &v1.ImportSipContactsResponse{DryRun: dry, Rows: uint32(len(rows)), Skipped: []*v1.SipContactImportSkip{}} //nolint:gosec // ≤ 5000
	plan := func(q *sqlc.Queries) error {
		var numbers []string
		for _, r := range rows {
			for _, p := range r.phones {
				numbers = append(numbers, p.Number)
			}
		}
		taken := map[string]sqlc.SipContactNumberOwnersRow{}
		if len(numbers) > 0 {
			owners, err := q.SipContactNumberOwners(ctx, sqlc.SipContactNumberOwnersParams{WorkspaceID: u.ws, Numbers: numbers})
			if err != nil {
				return err
			}
			for _, o := range owners {
				taken[o.Number] = o
			}
		}
		have, err := q.CountSipContacts(ctx, u.ws)
		if err != nil {
			return err
		}
		planImport(rows, taken, int(have))
		return nil
	}
	if dry {
		err = plan(s.db.Q)
	} else {
		err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
			if err := q.LockSipContacts(ctx, u.ws); err != nil {
				return err
			}
			if err := plan(q); err != nil {
				return err
			}
			return insertImport(ctx, q, u, rows)
		})
	}
	if err != nil {
		return err
	}
	for _, r := range rows {
		if r.skip == "" {
			out.Created++
			continue
		}
		sk := &v1.SipContactImportSkip{Row: uint32(max(r.line, 0)), Reason: r.skip, Number: r.skipNumber} //nolint:gosec // a line number
		if r.skipContact != nil {
			sk.ContactId, sk.ContactName = r.skipContact.ID.String(), displayName(r.skipContact.Name, r.skipContact.Company)
		}
		out.Skipped = append(out.Skipped, sk)
	}
	slog.InfoContext(ctx, "sip: contacts imported", "workspace", u.ws, "by", u.user, "dry_run", dry, "rows", len(rows),
		"created", out.Created, "skipped", len(out.Skipped))
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// insertImport writes the rows that are not skipped: the contacts and their numbers, two statements.
func insertImport(ctx context.Context, q *sqlc.Queries, u sectionUser, rows []importRow) error {
	type contactRow struct {
		ID      uuid.UUID `json:"id"`
		Name    string    `json:"name"`
		Company string    `json:"company"`
		Note    string    `json:"note"`
	}
	var contacts []contactRow
	var phones []contactPhone
	for _, r := range rows {
		if r.skip != "" {
			continue
		}
		id, err := uuid.NewV7()
		if err != nil {
			return err
		}
		contacts = append(contacts, contactRow{ID: id, Name: r.name, Company: r.company, Note: r.note})
		for _, p := range r.phones {
			p.ContactID = id
			phones = append(phones, p)
		}
	}
	if len(contacts) == 0 {
		return nil
	}
	raw, err := json.Marshal(contacts)
	if err != nil {
		return err
	}
	if err := q.InsertSipContacts(ctx, sqlc.InsertSipContactsParams{WorkspaceID: u.ws, Contacts: raw, CreatedBy: &u.user}); err != nil {
		return err
	}
	raw, err = json.Marshal(phones)
	if err != nil {
		return err
	}
	return q.InsertSipContactPhones(ctx, sqlc.InsertSipContactPhonesParams{WorkspaceID: u.ws, Phones: raw})
}

// csvSafe defuses a cell a spreadsheet would evaluate (CSV injection): a leading =, +, -, @, tab
// or line break gets a «'» in front (the import drops it again).
func csvSafe(s string) string {
	if s != "" && strings.ContainsRune("=+-@\t\r\n", rune(s[0])) {
		return "'" + s
	}
	return s
}

// exportLabels: the phone columns of the export, in order.
var exportLabels = []string{"mobile", "work", "home", "other"}

// writeContactsCSV writes the phone book: UTF-8 with BOM, «;», a header, a row per contact.
func writeContactsCSV(w io.Writer, contacts []*v1.SipContact) error {
	if _, err := io.WriteString(w, utf8BOM); err != nil {
		return err
	}
	cw := csv.NewWriter(w)
	cw.Comma, cw.UseCRLF = ';', true
	if err := cw.Write([]string{"Имя", "Компания", "Мобильный", "Рабочий", "Домашний", "Другой", "Заметка"}); err != nil {
		return err
	}
	for _, c := range contacts {
		by := map[string][]string{}
		for _, p := range c.GetPhones() {
			l := phoneLabelToDB[p.GetLabel()]
			by[l] = append(by[l], p.GetNumber())
		}
		rec := []string{csvSafe(c.GetName()), csvSafe(c.GetCompany())}
		for _, l := range exportLabels {
			rec = append(rec, csvSafe(strings.Join(by[l], ", ")))
		}
		rec = append(rec, csvSafe(c.GetNote()))
		if err := cw.Write(rec); err != nil {
			return err
		}
	}
	cw.Flush()
	return cw.Error()
}

func (s *Service) exportContacts(w http.ResponseWriter, r *http.Request) error {
	u, err := s.sectionMember(r)
	if err != nil {
		return err
	}
	if !u.manager() {
		return httpx.Forbidden("MANAGE_INTEGRATIONS required")
	}
	ctx := r.Context()
	if err := s.ExportLimit.Take(ctx, u.ws.String()); err != nil {
		return err
	}
	rows, err := s.db.Q.ListSipContacts(ctx, sqlc.ListSipContactsParams{WorkspaceID: u.ws, Lim: MaxContacts + 1})
	if err != nil {
		return err
	}
	contacts, err := s.contactsPB(ctx, s.db.Q, rows)
	if err != nil {
		return err
	}
	var buf bytes.Buffer
	if err := writeContactsCSV(&buf, contacts); err != nil {
		return err
	}
	slog.InfoContext(ctx, "sip: contacts exported", "workspace", u.ws, "by", u.user, "contacts", len(contacts))
	h := w.Header()
	h.Set("Content-Type", "text/csv; charset=utf-8")
	h.Set("Content-Disposition", `attachment; filename="contacts.csv"`)
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, err = w.Write(buf.Bytes())
	return err
}

package boards

import (
	"fmt"
	"math"
	"net/mail"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/google/uuid"
)

const maxFormFields = 30

// Definition text is stored verbatim; bound the stored value, including whitespace.
func validFormText(field, value string) error {
	if strings.TrimSpace(value) == "" || utf8.RuneCountInString(value) > 100 {
		return httpx.Validation(field, "1..100 characters required")
	}
	return nil
}

func validateForm(d *v1.BoardFormDefinition) error {
	if d == nil {
		return httpx.Validation("definition", "form definition required")
	}
	if err := validFormText("title", d.Title); err != nil {
		return err
	}
	if utf8.RuneCountInString(d.Description) > 2000 {
		return httpx.Validation("description", "at most 2000 characters")
	}
	if len(d.Fields) == 0 || len(d.Fields) > maxFormFields {
		return httpx.Validation("fields", "1..30 fields required")
	}
	if _, err := uuid.Parse(d.StatusId); err != nil {
		return httpx.Validation("statusId", "status required")
	}
	if _, err := validPriority(d.Priority); err != nil {
		return err
	}
	seen, title := map[string]bool{}, d.TitleFieldId == ""
	for i, f := range d.Fields {
		key := fmt.Sprintf("fields[%d]", i)
		if f == nil {
			return httpx.Validation(key, "field required")
		}
		if _, err := uuid.Parse(f.Id); err != nil || seen[f.Id] {
			return httpx.Validation(key+".id", "unique UUID required")
		}
		seen[f.Id] = true
		if err := validFormText(key+".label", f.Label); err != nil {
			return err
		}
		if utf8.RuneCountInString(f.Hint) > 500 || utf8.RuneCountInString(f.Placeholder) > 500 {
			return httpx.Validation(key, "hint and placeholder: at most 500 characters")
		}
		if f.Type < v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_TEXT || f.Type > v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_PEOPLE {
			return httpx.Validation(key+".type", "unknown field type")
		}
		if f.Id == d.TitleFieldId {
			title = true
			if !titleSource(f.Type) {
				return httpx.Validation("titleFieldId", "single-value field required")
			}
		}
		if f.Type == v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_SELECT || f.Type == v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_MULTISELECT {
			if len(f.Options) == 0 || len(f.Options) > 30 {
				return httpx.Validation(key+".options", "1..30 options required")
			}
			opts := map[string]bool{}
			for _, o := range f.Options {
				if err := validFormText(key+".options", o); err != nil {
					return err
				}
				if opts[o] {
					return httpx.Validation(key+".options", "duplicate option")
				}
				opts[o] = true
			}
		} else if len(f.Options) != 0 {
			return httpx.Validation(key+".options", "options require a select field")
		}
	}
	if !title {
		return httpx.Validation("titleFieldId", "title field required")
	}
	if err := validateFormV2(d); err != nil {
		return err
	}
	if len(d.AllowedUserIds) > 100 {
		return httpx.Validation("allowedUserIds", "at most 100 users")
	}
	users := map[string]bool{}
	for _, u := range d.AllowedUserIds {
		if _, err := uuid.Parse(u); err != nil || users[u] {
			return httpx.Validation("allowedUserIds", "unique user UUIDs required")
		}
		users[u] = true
	}
	if !d.IsPrivate && len(users) > 0 {
		return httpx.Validation("allowedUserIds", "public forms do not have an allowlist")
	}
	return nil
}

// Escape Markdown metacharacters and mention syntax. Answers are data, never commands or mentions.
func formText(s string) string {
	return strings.NewReplacer("\\", "\\\\", "`", "\\`", "*", "\\*", "_", "\\_", "[", "\\[", "]", "\\]", "<", "&lt;", ">", "&gt;", "#", "\\#", "!", "\\!", "@", "＠").Replace(s)
}

// answerOpts: what a submission (or preview) adds to the pure checks of parseAnswers.
type answerOpts struct {
	// hidden: fields the filler does not see; answering one is an unknown field.
	hidden map[string]bool
	// people validates the user ids of a PEOPLE answer and returns their names (nil: ids).
	people func(f *v1.BoardFormField, ids []uuid.UUID) ([]string, error)
	// files resolves the upload ids of a FILE answer and returns the file names (nil: the
	// values are shown as they are — the preview, which uploads nothing).
	files func(f *v1.BoardFormField, values []string) ([]string, error)
}

// formResult is a validated submission: the title and description, and the answers mapped
// onto task fields (ADR-0064 v2).
type formResult struct {
	title, description             string
	priority                       *v1.TaskPriority
	due                            string
	labels                         []uuid.UUID // labels of the form's board
	assignees, approvers, watchers []uuid.UUID
}

func formAnswers(d *v1.BoardFormDefinition, answers []*v1.BoardFormAnswer) (string, string, error) {
	r, err := parseAnswers(d, answers, answerOpts{})
	if err != nil {
		return "", "", err
	}
	return r.title, r.description, nil
}

func parseAnswers(d *v1.BoardFormDefinition, answers []*v1.BoardFormAnswer, o answerOpts) (*formResult, error) {
	if len(answers) > maxFormFields {
		return nil, httpx.Validation("answers", "too many answers")
	}
	vals := map[string]*v1.BoardFormAnswer{}
	fields := map[string]bool{}
	for _, f := range d.Fields {
		fields[f.Id] = !o.hidden[f.Id]
	}
	for _, a := range answers {
		if a == nil || !fields[a.FieldId] {
			return nil, httpx.Validation("answers", "unknown field")
		}
		if _, ok := vals[a.FieldId]; ok {
			return nil, httpx.Validation(a.FieldId, "duplicate answer")
		}
		vals[a.FieldId] = a
	}

	res := &formResult{title: d.Title}
	var desc strings.Builder
	for _, f := range d.Fields {
		if o.hidden[f.Id] {
			continue
		}
		a := vals[f.Id]
		v := strings.TrimSpace(a.GetValue())
		fail := func(message string) (*formResult, error) { return nil, httpx.Validation(f.Id, message) }
		var list []string // the selected options / names of a list answer, in display order
		switch f.Type {
		case ftMultiselect:
			if a.GetValue() != "" || len(a.GetValues()) > 30 {
				return fail("multiple choices require values only, at most 30")
			}
			selected := map[string]bool{}
			for _, option := range a.GetValues() {
				if selected[option] || !slices.Contains(f.Options, option) {
					return fail("unknown or duplicate option")
				}
				selected[option] = true
			}
			for _, option := range f.Options {
				if selected[option] {
					list = append(list, option)
				}
			}
			v = strings.Join(list, "; ")
		case ftFile:
			if a.GetValue() != "" || len(a.GetValues()) > formMaxFiles(f) {
				return fail(fmt.Sprintf("at most %d files", formMaxFiles(f)))
			}
			for i, x := range a.GetValues() {
				if x == "" || len(x) > 255 || slices.Contains(a.GetValues()[:i], x) {
					return fail("invalid or duplicate upload")
				}
			}
			list = a.GetValues()
			if o.files != nil && len(list) > 0 {
				names, err := o.files(f, list)
				if err != nil {
					return nil, err
				}
				list = names
			}
			v = strings.Join(list, "; ")
		case ftPeople:
			if a.GetValue() != "" || len(a.GetValues()) > formMaxPeople(f) {
				return fail(fmt.Sprintf("at most %d people", formMaxPeople(f)))
			}
			ids := make([]uuid.UUID, 0, len(a.GetValues()))
			for _, x := range a.GetValues() {
				id, err := uuid.Parse(x)
				if err != nil || slices.Contains(ids, id) {
					return fail("invalid or duplicate user id")
				}
				ids = append(ids, id)
			}
			list = a.GetValues()
			if o.people != nil && len(ids) > 0 {
				names, err := o.people(f, ids)
				if err != nil {
					return nil, err
				}
				list = names
			}
			v = strings.Join(list, "; ")
			switch f.Target {
			case toAssignees:
				res.assignees = ids
			case toApprovers:
				res.approvers = ids
			case toWatchers:
				res.watchers = ids
			}
		default:
			if len(a.GetValues()) != 0 {
				return fail("values is only supported for multiple choices, files and people")
			}
		}
		if f.Required && (v == "" || (f.Type == ftCheckbox && v != "true")) {
			return fail("required field")
		}
		if v == "" {
			continue
		}
		if !listAnswer(f.Type) && utf8.RuneCountInString(v) > 2000 {
			return fail("at most 2000 characters")
		}
		switch f.Type {
		case v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_EMAIL:
			addr, err := mail.ParseAddress(v)
			if err != nil || addr.Address != v || addr.Name != "" {
				return fail("invalid email")
			}
		case v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_PHONE:
			if !validFormPhone(v) {
				return fail("phone: 7..15 digits, optional leading +, spaces, parentheses, dots and hyphens")
			}
		case v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_URL:
			u, err := url.Parse(v)
			if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil || strings.ContainsFunc(v, func(c rune) bool { return unicode.IsSpace(c) || unicode.IsControl(c) }) {
				return fail("absolute HTTP or HTTPS URL required, without credentials or whitespace")
			}
		case v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_NUMBER:
			n, err := strconv.ParseFloat(v, 64)
			if err != nil || math.IsNaN(n) || math.IsInf(n, 0) {
				return fail("finite number required")
			}
		case ftDate:
			if _, ok := ParseDate(v); !ok {
				return fail("valid YYYY-MM-DD date required")
			}
			if f.Target == toDue {
				res.due = v
			}
		case ftSelect:
			if !slices.Contains(f.Options, v) {
				return fail("unknown option")
			}
			list = []string{v}
			if p, ok := f.OptionPriorities[v]; ok && f.Target == toPriority {
				res.priority = &p
			}
		case ftCheckbox:
			if v != "true" && v != "false" {
				return fail("true or false required")
			}
		}
		if f.Target == toLabels {
			for _, option := range list {
				if l, err := uuid.Parse(f.OptionLabels[option]); err == nil && !slices.Contains(res.labels, l) {
					res.labels = append(res.labels, l)
				}
			}
		}
		if f.Id == d.TitleFieldId {
			title := strings.Join(strings.Fields(v), " ")
			runes := []rune(title)
			if len(runes) > MaxTitle {
				title = string(runes[:MaxTitle])
			}
			res.title = title
		}
		if desc.Len() > 0 {
			desc.WriteString("\n\n")
		}
		desc.WriteString("**" + formText(f.Label) + "**\n" + formText(v))
	}
	if _, err := validTitle(res.title); err != nil {
		return nil, err
	}
	description, err := validDescription(desc.String())
	res.description = description
	return res, err
}

// Validate presentation, not reachability. Do not guess a country or discard leading zeroes.
func validFormPhone(value string) bool {
	if len(value) > 64 {
		return false
	}
	digits := 0
	for i, c := range value {
		switch {
		case c >= '0' && c <= '9':
			digits++
		case c == '+' && i == 0:
		case c == ' ' || c == '(' || c == ')' || c == '-' || c == '.':
		default:
			return false
		}
	}
	return digits >= 7 && digits <= 15
}

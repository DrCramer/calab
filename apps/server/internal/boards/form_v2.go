package boards

// Board forms v2 (ADR-0064 «v2 (2026-10-14)»): routes by answer, FILE and PEOPLE fields and
// answers mapped onto task fields. The definition rules here are static; the board-dependent
// ones (statuses, labels, features, the owner's rights) are in form_targets.go.

import (
	"fmt"
	"path"
	"slices"
	"strings"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/google/uuid"
)

const (
	maxFormRoutes      = 20
	maxFormPeople      = 10  // answers of a multiple PEOPLE field (assignees / approvers bound)
	maxFormFileMB      = 100 // per file; the server's MAX_FILE_SIZE_MB bounds it further
	defaultFormFiles   = 5   // multiple FILE field without max_files
	maxFormPendingFile = 512 << 20
)

type (
	fieldType   = v1.BoardFormFieldType
	fieldTarget = v1.BoardFormFieldTarget
)

const (
	ftFile        = v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_FILE
	ftPeople      = v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_PEOPLE
	ftSelect      = v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_SELECT
	ftMultiselect = v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_MULTISELECT
	ftDate        = v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_DATE
	ftCheckbox    = v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_CHECKBOX

	toNone      = v1.BoardFormFieldTarget_BOARD_FORM_FIELD_TARGET_NONE
	toPriority  = v1.BoardFormFieldTarget_BOARD_FORM_FIELD_TARGET_PRIORITY
	toDue       = v1.BoardFormFieldTarget_BOARD_FORM_FIELD_TARGET_DUE_DATE
	toLabels    = v1.BoardFormFieldTarget_BOARD_FORM_FIELD_TARGET_LABELS
	toAssignees = v1.BoardFormFieldTarget_BOARD_FORM_FIELD_TARGET_ASSIGNEES
	toApprovers = v1.BoardFormFieldTarget_BOARD_FORM_FIELD_TARGET_APPROVERS
	toWatchers  = v1.BoardFormFieldTarget_BOARD_FORM_FIELD_TARGET_WATCHERS
)

// titleSource: the single-value types a task title can come from.
func titleSource(t fieldType) bool {
	return t != ftCheckbox && t != ftMultiselect && t != ftFile && t != ftPeople
}

// listAnswer: the types answered with values (not value).
func listAnswer(t fieldType) bool { return t == ftMultiselect || t == ftFile || t == ftPeople }

// formMaxFiles is the effective number of files a FILE field takes.
func formMaxFiles(f *v1.BoardFormField) int {
	switch {
	case !f.Multiple:
		return 1
	case f.MaxFiles == 0:
		return defaultFormFiles
	default:
		return int(f.MaxFiles)
	}
}

// formMaxPeople is the number of people a PEOPLE field takes.
func formMaxPeople(f *v1.BoardFormField) int {
	if f.Multiple {
		return maxFormPeople
	}
	return 1
}

// formFileBytes is the per-file limit of a FILE field (0 = the server's limit).
func formFileBytes(f *v1.BoardFormField) int64 {
	if f.MaxFileMb == 0 {
		return maxFormFileMB << 20
	}
	return int64(f.MaxFileMb) << 20
}

var fileCategories = []string{"image", "pdf", "document", "video", "audio", "archive"}

var officeExt = []string{".docx", ".xlsx", ".pptx", ".odt", ".ods", ".odp"}

// formFileAllowed checks a detected type (files.DetectMime: sniffing wins) and the sanitized
// name against a FILE field: active content (HTML, XML, SVG, scripts) never, the categories of
// accept when it is set.
func formFileAllowed(mime, name string, accept []string) bool {
	if strings.Contains(mime, "html") || strings.Contains(mime, "xml") || strings.Contains(mime, "javascript") ||
		strings.Contains(mime, "ecmascript") || mime == "image/svg+xml" {
		return false
	}
	if len(accept) == 0 {
		return true
	}
	ext := strings.ToLower(path.Ext(name))
	for _, c := range accept {
		switch c {
		case "image":
			if strings.HasPrefix(mime, "image/") {
				return true
			}
		case "pdf":
			if mime == "application/pdf" {
				return true
			}
		case "video":
			if strings.HasPrefix(mime, "video/") {
				return true
			}
		case "audio":
			if strings.HasPrefix(mime, "audio/") || mime == "application/ogg" {
				return true
			}
		case "archive":
			if mime == "application/zip" || mime == "application/x-gzip" || mime == "application/x-rar-compressed" ||
				mime == "application/x-7z-compressed" || mime == "application/x-tar" {
				return true
			}
		case "document":
			if mime == "text/plain" || mime == "text/csv" || mime == "application/rtf" || mime == "text/rtf" ||
				mime == "application/msword" || strings.HasPrefix(mime, "application/vnd.ms-") ||
				strings.HasPrefix(mime, "application/vnd.openxmlformats-officedocument.") ||
				strings.HasPrefix(mime, "application/vnd.oasis.opendocument.") ||
				(mime == "application/zip" && slices.Contains(officeExt, ext)) {
				return true
			}
		}
	}
	return false
}

// validateFormV2 checks the v2 settings of a definition that validateForm already accepted.
func validateFormV2(d *v1.BoardFormDefinition) error {
	byID := map[string]*v1.BoardFormField{}
	targets := map[fieldTarget]bool{}
	files := 0
	for i, f := range d.Fields {
		key := fmt.Sprintf("fields[%d]", i)
		byID[f.Id] = f
		if f.Multiple && f.Type != ftFile && f.Type != ftPeople {
			return httpx.Validation(key+".multiple", "only file and people fields take several answers")
		}
		if f.Type == ftFile {
			if f.MaxFiles > MaxAttachments || (!f.Multiple && f.MaxFiles > 1) {
				return httpx.Validation(key+".maxFiles", "1..20 files, 1 without multiple")
			}
			if f.MaxFileMb > maxFormFileMB {
				return httpx.Validation(key+".maxFileMb", "at most 100 MB")
			}
			if len(f.Accept) > len(fileCategories) {
				return httpx.Validation(key+".accept", "too many categories")
			}
			for j, c := range f.Accept {
				if !slices.Contains(fileCategories, c) || slices.Contains(f.Accept[:j], c) {
					return httpx.Validation(key+".accept", "unknown or duplicate category")
				}
			}
			files += formMaxFiles(f)
		} else if f.MaxFiles != 0 || f.MaxFileMb != 0 || len(f.Accept) != 0 {
			return httpx.Validation(key, "file limits require a file field")
		}
		if f.RoleId != "" {
			if f.Type != ftPeople {
				return httpx.Validation(key+".roleId", "a role requires a people field")
			}
			if _, err := uuid.Parse(f.RoleId); err != nil {
				return httpx.Validation(key+".roleId", "invalid role id")
			}
		}
		if err := validFieldTarget(key, f); err != nil {
			return err
		}
		if f.Target != toNone && f.Target != toLabels {
			if targets[f.Target] {
				return httpx.Validation(key+".target", "one field per task field")
			}
			targets[f.Target] = true
		}
	}
	if files > MaxAttachments {
		return httpx.Validation("fields", "at most 20 files per submission in all file fields")
	}
	if len(d.Routes) > maxFormRoutes {
		return httpx.Validation("routes", "at most 20 routes")
	}
	for i, r := range d.Routes {
		key := fmt.Sprintf("routes[%d]", i)
		if r == nil {
			return httpx.Validation(key, "route required")
		}
		f := byID[r.FieldId]
		if f == nil || f.Type != ftSelect {
			return httpx.Validation(key+".fieldId", "a single choice field of the form is required")
		}
		if !slices.Contains(f.Options, r.Option) {
			return httpx.Validation(key+".option", "an option of the field is required")
		}
		if _, err := uuid.Parse(r.BoardId); err != nil {
			return httpx.Validation(key+".boardId", "board required")
		}
		if r.StatusId != "" {
			if _, err := uuid.Parse(r.StatusId); err != nil {
				return httpx.Validation(key+".statusId", "invalid status id")
			}
		}
	}
	return nil
}

// validFieldTarget checks a field's mapping onto the task: the target fits the type, the
// option maps belong to it and name options of the field.
func validFieldTarget(key string, f *v1.BoardFormField) error {
	ok := false
	switch f.Target {
	case toNone:
		ok = true
	case toPriority:
		ok = f.Type == ftSelect
	case toDue:
		ok = f.Type == ftDate
	case toLabels:
		ok = f.Type == ftSelect || f.Type == ftMultiselect
	case toAssignees, toApprovers, toWatchers:
		ok = f.Type == ftPeople
	}
	if !ok {
		return httpx.Validation(key+".target", "the field type cannot fill this task field")
	}
	if len(f.OptionPriorities) > 0 && f.Target != toPriority {
		return httpx.Validation(key+".optionPriorities", "priorities require the priority target")
	}
	if len(f.OptionLabels) > 0 && f.Target != toLabels {
		return httpx.Validation(key+".optionLabels", "labels require the labels target")
	}
	for o, p := range f.OptionPriorities {
		if !slices.Contains(f.Options, o) {
			return httpx.Validation(key+".optionPriorities", "unknown option")
		}
		if _, err := validPriority(p); err != nil {
			return httpx.Validation(key+".optionPriorities", "invalid priority")
		}
	}
	for o, l := range f.OptionLabels {
		if !slices.Contains(f.Options, o) {
			return httpx.Validation(key+".optionLabels", "unknown option")
		}
		if _, err := uuid.Parse(l); err != nil {
			return httpx.Validation(key+".optionLabels", "invalid label id")
		}
	}
	return nil
}

// formUses lists the board features a definition needs on a board its tasks go to.
type formUses struct{ priority, due, labels, files, approvers bool }

func usesOf(d *v1.BoardFormDefinition) formUses {
	u := formUses{priority: d.Priority != v1.TaskPriority_TASK_PRIORITY_NONE}
	for _, f := range d.Fields {
		switch {
		case f.Type == ftFile:
			u.files = true
		case f.Target == toPriority:
			for _, p := range f.OptionPriorities {
				u.priority = u.priority || p != v1.TaskPriority_TASK_PRIORITY_NONE
			}
		case f.Target == toDue:
			u.due = true
		case f.Target == toLabels:
			u.labels = u.labels || len(f.OptionLabels) > 0
		case f.Target == toApprovers:
			u.approvers = true
		}
	}
	return u
}

// hiddenPeople: the PEOPLE fields an anonymous filler does not see (show_members off).
func hiddenPeople(d *v1.BoardFormDefinition, anonymous bool) map[string]bool {
	if !anonymous || d.ShowMembers {
		return nil
	}
	out := map[string]bool{}
	for _, f := range d.Fields {
		if f.Type == ftPeople {
			out[f.Id] = true
		}
	}
	return out
}

// publicFields are the fields a filler sees: without the hidden ones and without the
// management-only settings (targets, option maps, roles).
func publicFields(d *v1.BoardFormDefinition, hidden map[string]bool) []*v1.BoardFormField {
	out := make([]*v1.BoardFormField, 0, len(d.Fields))
	for _, f := range d.Fields {
		if hidden[f.Id] {
			continue
		}
		out = append(out, &v1.BoardFormField{Id: f.Id, Type: f.Type, Label: f.Label, Hint: f.Hint, Placeholder: f.Placeholder,
			Required: f.Required, Options: f.Options, Multiple: f.Multiple, MaxFiles: f.MaxFiles, MaxFileMb: f.MaxFileMb, Accept: f.Accept})
	}
	return out
}

// routeOf picks the first route whose field was answered with its option (nil = the form's
// board). Answers are not validated here: an unknown value matches no route.
func routeOf(d *v1.BoardFormDefinition, answers []*v1.BoardFormAnswer) *v1.BoardFormRoute {
	for _, r := range d.Routes {
		for _, a := range answers {
			if a != nil && a.FieldId == r.FieldId && strings.TrimSpace(a.Value) == r.Option {
				return r
			}
		}
	}
	return nil
}

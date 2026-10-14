package boards

// The board-dependent rules of forms v2 (ADR-0064 «v2»): where a submission goes (routes, the
// owner's rights, statuses, features), the labels of the form's board and the people a PEOPLE
// field offers. Checked when a form is saved and again under the locks of a submission.

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/google/uuid"
)

func targetUnavailable() error {
	return httpx.Conflict("form target is unavailable").WithDetails("FORM_TARGET_UNAVAILABLE", 0, 0)
}

// requireUses checks the board features the definition needs on board b (409 FEATURE_DISABLED).
func requireUses(b sqlc.Board, u formUses) error {
	for _, c := range []struct {
		f     v1.BoardFeature
		field string
		sets  bool
	}{
		{v1.BoardFeature_BOARD_FEATURE_PRIORITY, "priority", u.priority},
		{v1.BoardFeature_BOARD_FEATURE_DUE_DATE, "dueOn", u.due},
		{v1.BoardFeature_BOARD_FEATURE_LABELS, "labelIds", u.labels},
		{v1.BoardFeature_BOARD_FEATURE_ATTACHMENTS, "attachmentIds", u.files},
		{v1.BoardFeature_BOARD_FEATURE_APPROVALS, "approverIds", u.approvers},
	} {
		if err := requireFeature(b.DisabledFeatures, c.f, c.field, c.sets); err != nil {
			return err
		}
	}
	return nil
}

// routeTarget checks the board tb a route sends tasks of the form's board fb to and returns the
// status of the new task: same workspace, not archived, the owner (the last editor) may see the
// board and create tasks there (not checked for the form's own board, which its managers own),
// the status is one of tb (empty = its default), the features the form uses are on.
func routeTarget(ctx context.Context, q *sqlc.Queries, fb, tb sqlc.Board, r *v1.BoardFormRoute, owner *uuid.UUID, u formUses) (sqlc.BoardStatus, error) {
	if tb.WorkspaceID != fb.WorkspaceID || tb.ArchivedAt != nil {
		return sqlc.BoardStatus{}, targetUnavailable()
	}
	if tb.ID != fb.ID {
		if owner == nil {
			return sqlc.BoardStatus{}, targetUnavailable()
		}
		acc, err := perm.NewResolver(q).Board(ctx, tb.ID, *owner)
		if err != nil {
			if errors.Is(err, perm.ErrNoBoard) || errors.Is(err, perm.ErrNotMember) || fileDenied(err) {
				return sqlc.BoardStatus{}, targetUnavailable()
			}
			return sqlc.BoardStatus{}, err
		}
		if acc.Archived || !acc.Bits.Has(perm.ViewBoard|perm.CreateTasks) {
			return sqlc.BoardStatus{}, targetUnavailable()
		}
	}
	it, err := items(ctx, q, tb.ID)
	if err != nil {
		return sqlc.BoardStatus{}, err
	}
	var st *sqlc.BoardStatus
	if r.StatusId == "" {
		st = it.def
	} else if id, err := uuid.Parse(r.StatusId); err == nil {
		if x, ok := it.statuses[id]; ok {
			st = &x
		}
	}
	if st == nil {
		return sqlc.BoardStatus{}, targetUnavailable()
	}
	return *st, requireUses(tb, u)
}

// fileDenied: an expected denial of the resolver (unauthenticated, forbidden, not found).
func fileDenied(err error) bool {
	var e *httpx.Error
	return errors.As(err, &e) && e.Err == nil && (e.Status == http.StatusForbidden || e.Status == http.StatusNotFound || e.Status == http.StatusUnauthorized)
}

// validateFormSave checks a definition against the form's board b and the workspace when the
// editor saves (or previews) it: the own target (validateFormTarget), the features the
// mapped fields need, labels of b, workspace roles, and every route with the editor as the
// owner. Route problems are 422 on the route.
func validateFormSave(ctx context.Context, q *sqlc.Queries, b sqlc.Board, d *v1.BoardFormDefinition, editor uuid.UUID) error {
	if err := validateFormTarget(ctx, q, b, d); err != nil {
		return err
	}
	u := usesOf(d)
	if err := requireUses(b, u); err != nil {
		return err
	}
	labels, err := q.ListBoardLabels(ctx, []uuid.UUID{b.ID})
	if err != nil {
		return err
	}
	for i, f := range d.Fields {
		for _, l := range f.OptionLabels {
			if !slices.ContainsFunc(labels, func(x sqlc.BoardLabel) bool { return x.ID.String() == l }) {
				return httpx.Validation(fmt.Sprintf("fields[%d].optionLabels", i), "a label of this board is required")
			}
		}
		if f.RoleId != "" {
			role, _ := uuid.Parse(f.RoleId)
			if _, err := q.GetWorkspaceRole(ctx, sqlc.GetWorkspaceRoleParams{ID: role, WorkspaceID: b.WorkspaceID}); err != nil {
				if db.IsNotFound(err) {
					return httpx.Validation(fmt.Sprintf("fields[%d].roleId", i), "a role of this workspace is required")
				}
				return err
			}
		}
	}
	for i, r := range d.Routes {
		id, _ := uuid.Parse(r.BoardId)
		tb, err := q.GetBoard(ctx, id)
		if db.IsNotFound(err) {
			return httpx.Validation(fmt.Sprintf("routes[%d].boardId", i), "a board you can create tasks on is required")
		}
		if err != nil {
			return err
		}
		if _, err := routeTarget(ctx, q, b, tb, r, &editor, u); err != nil {
			var e *httpx.Error
			if errors.As(err, &e) && e.Reason == "FORM_TARGET_UNAVAILABLE" {
				return httpx.Validation(fmt.Sprintf("routes[%d].boardId", i), "a board you can create tasks on, with this status, is required")
			}
			return err
		}
	}
	return nil
}

// person is a member a PEOPLE field may offer.
type person struct {
	name                 string
	guest, bot, disabled bool
	roles                []uuid.UUID
}

func loadPeople(ctx context.Context, q *sqlc.Queries, ws uuid.UUID) (map[uuid.UUID]person, error) {
	rows, err := q.ListMembers(ctx, ws)
	if err != nil {
		return nil, err
	}
	out := make(map[uuid.UUID]person, len(rows))
	for _, m := range rows {
		name := strings.TrimSpace(m.WorkspaceMember.Nickname)
		if name == "" {
			name = m.User.DisplayName
		}
		out[m.User.ID] = person{name: name, guest: m.WorkspaceMember.Role == "guest" || m.User.IsGuest, bot: m.User.IsBot,
			disabled: m.User.DisabledAt != nil, roles: m.RoleIds}
	}
	return out, nil
}

// candidate: whether p may be chosen in PEOPLE field f — a member who is not disabled nor a
// guest, not a bot for approvers and watchers (humans only), with the field's role if any.
func candidate(f *v1.BoardFormField, p person) bool {
	if p.disabled || p.guest {
		return false
	}
	if p.bot && f.Target != toAssignees {
		return false
	}
	if f.RoleId != "" {
		role, _ := uuid.Parse(f.RoleId)
		return slices.Contains(p.roles, role)
	}
	return true
}

// maxFormCandidates bounds the names one PEOPLE field lists.
const maxFormCandidates = 1000

// peopleOptions lists the candidates of the PEOPLE fields among fields (names only).
func peopleOptions(ctx context.Context, q *sqlc.Queries, ws uuid.UUID, fields []*v1.BoardFormField, d *v1.BoardFormDefinition) ([]*v1.BoardFormPeopleOptions, error) {
	var out []*v1.BoardFormPeopleOptions
	var people map[uuid.UUID]person
	for _, pf := range fields {
		if pf.Type != ftPeople {
			continue
		}
		f := pf
		for _, x := range d.Fields { // the full field: target and role are not public
			if x.Id == pf.Id {
				f = x
			}
		}
		if people == nil {
			var err error
			if people, err = loadPeople(ctx, q, ws); err != nil {
				return nil, err
			}
		}
		opts := &v1.BoardFormPeopleOptions{FieldId: f.Id}
		for id, p := range people {
			if candidate(f, p) {
				opts.People = append(opts.People, &v1.BoardFormPerson{UserId: id.String(), Name: p.name})
			}
		}
		slices.SortFunc(opts.People, func(a, b *v1.BoardFormPerson) int {
			if c := strings.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name)); c != 0 {
				return c
			}
			return strings.Compare(a.UserId, b.UserId)
		})
		if len(opts.People) > maxFormCandidates {
			opts.People = opts.People[:maxFormCandidates]
		}
		out = append(out, opts)
	}
	return out, nil
}

// peopleResolver validates PEOPLE answers against the candidates of the workspace and returns
// their names (422 on the field for anyone else).
func peopleResolver(ctx context.Context, q *sqlc.Queries, ws uuid.UUID) func(f *v1.BoardFormField, ids []uuid.UUID) ([]string, error) {
	var people map[uuid.UUID]person
	return func(f *v1.BoardFormField, ids []uuid.UUID) ([]string, error) {
		if people == nil {
			var err error
			if people, err = loadPeople(ctx, q, ws); err != nil {
				return nil, err
			}
		}
		names := make([]string, len(ids))
		for i, id := range ids {
			p, ok := people[id]
			if !ok || !candidate(f, p) {
				return nil, httpx.Validation(f.Id, "a member of the workspace offered by this field is required")
			}
			names[i] = p.name
		}
		return names, nil
	}
}

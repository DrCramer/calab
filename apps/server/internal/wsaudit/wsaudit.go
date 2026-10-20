// Package wsaudit is the workspace journal of private-access decisions (addenda 2026-10-14 to
// ADR-0058 / ADR-0078 / ADR-0094 / ADR-0096): the owner switching «Владелец видит приватное» and
// «Сделать меня владельцем» of a former member's private item. Rows carry ids only — never the
// names of private items. Table workspace_audit (migration 00097).
package wsaudit

import (
	"context"

	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/perm"
)

// workspace_audit.kind values.
const (
	OwnerSeesPrivateOn  = "owner_sees_private_on"
	OwnerSeesPrivateOff = "owner_sees_private_off"
	TakeOver            = "take_over"
)

// workspace_audit.subject_type values of TakeOver.
const (
	SubjectRoom       = "room"
	SubjectBoard      = "board"
	SubjectDiskItem   = "disk_item"
	SubjectWikiPage   = "wiki_page"
	SubjectCanvasItem = "canvas_item"
)

// ReasonOwnerOnly is the error reason of a take-over by anyone but the owner who sees private
// (the same text as rooms.ReasonOwnerOnly).
const ReasonOwnerOnly = "OWNER_ONLY"

// Toggle records a change of «Владелец видит приватное» by actor.
func Toggle(ctx context.Context, q *sqlc.Queries, wsID, actor uuid.UUID, on bool) error {
	kind := OwnerSeesPrivateOff
	if on {
		kind = OwnerSeesPrivateOn
	}
	return q.InsertWorkspaceAudit(ctx, sqlc.InsertWorkspaceAuditParams{WorkspaceID: wsID, ActorID: &actor, Kind: kind})
}

// RecordTakeOver records actor taking over a private item from its former owner (nil = unknown).
func RecordTakeOver(ctx context.Context, q *sqlc.Queries, wsID, actor uuid.UUID, subjectType string, subject uuid.UUID, previous *uuid.UUID) error {
	return q.InsertWorkspaceAudit(ctx, sqlc.InsertWorkspaceAuditParams{
		WorkspaceID: wsID, ActorID: &actor, Kind: TakeOver, SubjectType: &subjectType, SubjectID: &subject, PreviousOwnerID: previous,
	})
}

// MayTakeOver reports whether m may take over a private item owned by owner (nil = unknown):
// the workspace owner while «Владелец видит приватное» is on (else errOwnerOnly), and the item's
// owner is no longer a member (else errStillMember). The two errors are the caller's (they
// differ per package only in wording); nil means allowed.
func MayTakeOver(ctx context.Context, q *sqlc.Queries, wsID uuid.UUID, m perm.Member, owner *uuid.UUID, errOwnerOnly, errStillMember error) error {
	if !m.SeesPrivate() {
		return errOwnerOnly
	}
	if owner == nil {
		return nil
	}
	member, err := q.IsWorkspaceMember(ctx, sqlc.IsWorkspaceMemberParams{WorkspaceID: wsID, UserID: *owner})
	if err != nil {
		return err
	}
	if member {
		return errStillMember
	}
	return nil
}

// Proto converts a row.
func Proto(a sqlc.WorkspaceAudit) *v1.WorkspaceAuditEntry {
	out := &v1.WorkspaceAuditEntry{Id: a.ID.String(), SubjectType: deref(a.SubjectType)}
	switch a.Kind {
	case OwnerSeesPrivateOn:
		out.Kind = v1.WorkspaceAuditKind_WORKSPACE_AUDIT_KIND_OWNER_SEES_PRIVATE_ON
	case OwnerSeesPrivateOff:
		out.Kind = v1.WorkspaceAuditKind_WORKSPACE_AUDIT_KIND_OWNER_SEES_PRIVATE_OFF
	case TakeOver:
		out.Kind = v1.WorkspaceAuditKind_WORKSPACE_AUDIT_KIND_TAKE_OVER
	}
	if a.ActorID != nil {
		out.ActorId = a.ActorID.String()
	}
	if a.SubjectID != nil {
		out.SubjectId = a.SubjectID.String()
	}
	if a.PreviousOwnerID != nil {
		out.PreviousOwnerId = a.PreviousOwnerID.String()
	}
	out.CreatedAt = timestamppb.New(a.CreatedAt)
	return out
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

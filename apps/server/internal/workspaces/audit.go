package workspaces

import (
	"net/http"
	"strconv"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/wsaudit"
)

// audit: GET /api/workspaces/{id}/audit?before=<id>&limit=<1..100> — the workspace journal of
// private-access decisions (internal/wsaudit), newest first. The workspace owner or VIEW_JOURNALS.
func (h *Handlers) audit(w http.ResponseWriter, r *http.Request) error {
	wsID, bits, role, err := access(r)
	if err != nil {
		return err
	}
	if role != perm.RoleOwner && (role == perm.RoleGuest || !bits.Has(perm.ViewJournals)) {
		return httpx.Forbidden("VIEW_JOURNALS required")
	}
	p := sqlc.ListWorkspaceAuditParams{WorkspaceID: wsID, Lim: 50}
	if s := r.URL.Query().Get("before"); s != "" {
		id, err := uuid.Parse(s)
		if err != nil {
			return httpx.Validation("before", "invalid id")
		}
		p.Before = &id
	}
	if s := r.URL.Query().Get("limit"); s != "" {
		n, err := strconv.Atoi(s)
		if err != nil || n < 1 || n > 100 {
			return httpx.Validation("limit", "limit must be 1..100")
		}
		p.Lim = int32(n) //nolint:gosec // 1..100
	}
	rows, err := h.db.Q.ListWorkspaceAudit(r.Context(), p)
	if err != nil {
		return err
	}
	out := &v1.ListWorkspaceAuditResponse{Entries: make([]*v1.WorkspaceAuditEntry, len(rows))}
	for i, row := range rows {
		out.Entries[i] = wsaudit.Proto(row)
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

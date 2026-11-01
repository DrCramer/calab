package boards

import (
	"context"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/perm"
)

// Saved task searches (ADR-0139): a person's named filters in a workspace.
const (
	MaxSavedSearches      = 50
	MaxSavedSearchName    = 60
	ReasonTaskSearchLimit = "TASK_SEARCH_LIMIT"
)

var savedStates = map[string]bool{"": true, "all": true, "open": true, "done": true, "archived": true}

// checkQuery validates a saved query like the search would read it.
func (s *Service) checkQuery(r *http.Request, q *v1.TaskSearchQuery) error {
	if q == nil {
		return nil
	}
	if utf8.RuneCountInString(q.GetQ()) > maxTextQuery {
		return httpx.Validation("query.q", "q must be 0..200 characters")
	}
	if !savedStates[q.GetState()] {
		return httpx.Validation("query.state", "state must be all, open, done or archived")
	}
	if srt := strings.TrimPrefix(q.GetSort(), "-"); srt != "" && !sortKeys[srt] {
		return httpx.Validation("query.sort", "unknown sort")
	}
	return s.checkFilter(r, q.GetFilter())
}

func queryJSON(q *v1.TaskSearchQuery) []byte {
	if q == nil {
		q = &v1.TaskSearchQuery{}
	}
	b, err := protojson.Marshal(q)
	if err != nil {
		return []byte("{}")
	}
	return b
}

// searchMember resolves the workspace of the path for a person (guests and bots: 403).
func searchMember(r *http.Request, wsID uuid.UUID) error {
	m, err := member(r, wsID)
	if err != nil {
		return err
	}
	if m.Role == perm.RoleGuest || isBot(r) {
		return httpx.Forbidden("saved task searches are for members")
	}
	return nil
}

const savedCols = "id, name, query, position"

func scanSaved(row pgx.Row) (*v1.SavedTaskSearch, error) {
	var id uuid.UUID
	var name string
	var raw []byte
	var pos int32
	if err := row.Scan(&id, &name, &raw, &pos); err != nil {
		return nil, err
	}
	q := &v1.TaskSearchQuery{}
	_ = protojson.Unmarshal(raw, q) // a stored query is valid; a future field is dropped
	return &v1.SavedTaskSearch{Id: id.String(), Name: name, Query: q, Position: pos}, nil
}

func (s *Service) listSavedSearches(w http.ResponseWriter, r *http.Request) error {
	wsID, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return err
	}
	if err := searchMember(r, wsID); err != nil {
		return err
	}
	out := &v1.ListSavedTaskSearchesResponse{Searches: []*v1.SavedTaskSearch{}}
	err = s.db.ReadTx(r.Context(), func(tx pgx.Tx) error {
		rows, err := tx.Query(r.Context(), "SELECT "+savedCols+" FROM task_searches WHERE workspace_id = $1 AND user_id = $2 ORDER BY position, created_at", wsID, uid(r))
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			x, err := scanSaved(rows)
			if err != nil {
				return err
			}
			out.Searches = append(out.Searches, x)
		}
		return rows.Err()
	})
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

func (s *Service) createSavedSearch(w http.ResponseWriter, r *http.Request) error {
	wsID, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return err
	}
	if err := searchMember(r, wsID); err != nil {
		return err
	}
	var req v1.CreateSavedTaskSearchRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	name, err := validText("name", req.GetName(), 1, MaxSavedSearchName)
	if err != nil {
		return err
	}
	if err := s.checkQuery(r, req.GetQuery()); err != nil {
		return err
	}
	var out *v1.SavedTaskSearch
	err = s.tx(r.Context(), func(_ *sqlc.Queries, tx pgx.Tx) error {
		// One person's rows: their own lock (two tabs saving at once still respect the limit).
		if _, err := tx.Exec(r.Context(), "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", "task_searches:"+wsID.String()+":"+uid(r).String()); err != nil {
			return err
		}
		var n, next int32
		if err := tx.QueryRow(r.Context(), "SELECT count(*), coalesce(max(position) + 1, 0) FROM task_searches WHERE workspace_id = $1 AND user_id = $2", wsID, uid(r)).Scan(&n, &next); err != nil {
			return err
		}
		if n >= MaxSavedSearches {
			return httpx.Conflict("at most 50 saved searches").WithDetails(ReasonTaskSearchLimit, uint64(n), MaxSavedSearches)
		}
		var err error
		out, err = scanSaved(tx.QueryRow(r.Context(), "INSERT INTO task_searches (id, workspace_id, user_id, name, query, position) VALUES ($1, $2, $3, $4, $5, $6) RETURNING "+savedCols,
			uuid.New(), wsID, uid(r), name, queryJSON(req.GetQuery()), next))
		return err
	})
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusCreated, &v1.SavedTaskSearchResponse{Search: out})
	return nil
}

// savedSearch is the caller's own saved search of the path in its workspace (404 otherwise).
func (s *Service) savedSearch(ctx context.Context, r *http.Request) (uuid.UUID, error) {
	wsID, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return wsID, err
	}
	if err := searchMember(r, wsID); err != nil {
		return wsID, err
	}
	id, err := httpx.PathUUID(r, "sid", "search")
	if err != nil {
		return id, err
	}
	err = s.db.ReadTx(ctx, func(tx pgx.Tx) error {
		var ok bool
		return tx.QueryRow(ctx, "SELECT true FROM task_searches WHERE id = $1 AND workspace_id = $2 AND user_id = $3", id, wsID, uid(r)).Scan(&ok)
	})
	if db.IsNotFound(err) {
		return id, httpx.NotFound("search")
	}
	return id, err
}

func (s *Service) updateSavedSearch(w http.ResponseWriter, r *http.Request) error {
	id, err := s.savedSearch(r.Context(), r)
	if err != nil {
		return err
	}
	var req v1.UpdateSavedTaskSearchRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	var name *string
	if req.Name != nil {
		n, err := validText("name", req.GetName(), 1, MaxSavedSearchName)
		if err != nil {
			return err
		}
		name = &n
	}
	var query []byte
	if req.Query != nil {
		if err := s.checkQuery(r, req.GetQuery()); err != nil {
			return err
		}
		query = queryJSON(req.GetQuery())
	}
	var out *v1.SavedTaskSearch
	err = s.tx(r.Context(), func(_ *sqlc.Queries, tx pgx.Tx) error {
		var err error
		out, err = scanSaved(tx.QueryRow(r.Context(), "UPDATE task_searches SET name = coalesce($2, name), query = coalesce($3::jsonb, query), position = coalesce($4, position) WHERE id = $1 AND user_id = $5 RETURNING "+savedCols,
			id, name, query, req.Position, uid(r)))
		if db.IsNotFound(err) {
			return httpx.NotFound("search")
		}
		return err
	})
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.SavedTaskSearchResponse{Search: out})
	return nil
}

func (s *Service) deleteSavedSearch(w http.ResponseWriter, r *http.Request) error {
	id, err := s.savedSearch(r.Context(), r)
	if err != nil {
		return err
	}
	if err := s.tx(r.Context(), func(_ *sqlc.Queries, tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), "DELETE FROM task_searches WHERE id = $1 AND user_id = $2", id, uid(r))
		return err
	}); err != nil {
		return err
	}
	httpx.NoContent(w)
	return nil
}

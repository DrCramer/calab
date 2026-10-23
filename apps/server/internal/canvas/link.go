package canvas

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"net/http"
	"net/netip"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/canvasacl"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/redisx"
	"github.com/calaba/calaba/server/internal/ysync"
)

// The public read-only link of a canvas (ADR-0127 wave 5, docs/05 «Холст: публичная ссылка»):
// the owner of the canvas or CANVAS_MANAGE makes it (one live link per canvas), whoever has its
// code reads the canvas through GET /api/public/canvas/{code} (the name) and the anonymous
// receive-only socket GET /api/public/canvas/{code}/sync (ysync.Hub.ServeViewer: the snapshot and
// the updates, never awareness, any frame from it closes it). Every anonymous request resolves
// the code again (linkOpen): an unknown, revoked or expired code, a folder, a canvas in the trash
// or restricted along its chain, a suspended or billing-suspended workspace and an identity
// policy without public capabilities are one and the same 404.

// CodeLength is the length of a public link code: 32 random bytes, base64url (43 characters).
const CodeLength = 43

// Default socket limits of the public link (Service.ViewersPerLink / ViewersPerIP).
const (
	DefaultViewersPerLink = 100
	DefaultViewersPerIP   = 10
)

// linkDays are the expiries a link may get, in days (0 = never).
var linkDays = map[uint32]bool{0: true, 1: true, 7: true, 30: true}

var (
	errNoLink     = httpx.NotFound("link")
	errLinkFolder = httpx.Conflict("only a canvas has a public link")
	errRestricted = httpx.Conflict("a private canvas has no public link").WithDetails("CANVAS_RESTRICTED", 0, 0)
)

// newCode is a public link code: 32 random bytes, base64url without padding (43 characters).
func newCode() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// validCode: 43 characters of the base64url alphabet (anything else is not looked up).
func validCode(code string) bool {
	if len(code) != CodeLength {
		return false
	}
	for i := 0; i < len(code); i++ {
		c := code[i]
		ok := c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-' || c == '_'
		if !ok {
			return false
		}
	}
	return true
}

func (s *Service) publicURL(code string) string { return s.PublicURL + "/c/" + code }

func linkProto(l sqlc.CanvasLink) *v1.CanvasLink {
	out := &v1.CanvasLink{Code: l.Code, CanvasId: l.CanvasID.String(), CreatedBy: idp(l.CreatedBy),
		CreatedAt: timestamppb.New(l.CreatedAt), Views: uint64(max(l.Views, 0))} //nolint:gosec // non-negative
	if l.ExpiresAt != nil {
		out.ExpiresAt = timestamppb.New(*l.ExpiresAt)
	}
	return out
}

// linkable: the caller may manage the link of a.item — the owner or CANVAS_MANAGE, a canvas (not
// a folder) not in the trash nor restricted along its chain.
func linkable(a access) error {
	if !a.structure() {
		return errNotStructure
	}
	if a.item.Kind != kindCanvas {
		return errLinkFolder
	}
	if a.item.TrashedAt != nil {
		return errTrashed
	}
	if perm.RestrictedIn(a.nodes()) {
		return errRestricted
	}
	return nil
}

// getLink: GET /api/canvas/items/{id}/link — the live link of a canvas (link unset without one).
// The owner or CANVAS_MANAGE; 404 without CANVAS_VIEW.
func (s *Service) getLink(w http.ResponseWriter, r *http.Request) error {
	a, err := s.pathItem(r)
	if err != nil {
		return err
	}
	if !a.structure() {
		return errNotStructure
	}
	if a.item.Kind != kindCanvas {
		return errLinkFolder
	}
	out := &v1.CanvasLinkResponse{}
	l, err := s.db.Q.GetCanvasLink(r.Context(), a.item.ID)
	switch {
	case err == nil:
		out.Link, out.Url = linkProto(l), s.publicURL(l.Code)
	case !db.IsNotFound(err):
		return err
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// createLink: POST /api/canvas/items/{id}/link — makes the public link of a canvas (201) or,
// while one is live, changes its expiry and keeps its code (200). The owner or CANVAS_MANAGE;
// not for a folder, a canvas in the trash or a restricted one (409 CANVAS_RESTRICTED), nor in a
// suspended workspace or one whose identity policy forbids public capabilities.
func (s *Service) createLink(w http.ResponseWriter, r *http.Request) error {
	id, err := httpx.PathUUID(r, "id", "item")
	if err != nil {
		return err
	}
	var req v1.CreateCanvasLinkRequest
	if err := httpx.DecodeStrict(w, r, &req); err != nil {
		return err
	}
	days := req.GetExpiresInDays()
	if !linkDays[days] {
		return httpx.Validation("expires_in_days", "must be 0 (never), 1, 7 or 30")
	}
	var expires *time.Time
	if days > 0 {
		t := s.Now().Add(time.Duration(days) * 24 * time.Hour)
		expires = &t
	}
	code, err := newCode()
	if err != nil {
		return err
	}
	ctx := r.Context()
	var link sqlc.CanvasLink
	fresh := false
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		a, err := resolve(r, q, id)
		if err != nil {
			return err
		}
		ws := a.item.WorkspaceID
		if err := writable(ctx, q, ws); err != nil {
			return err
		}
		// Under the tree lock: a restricted switch, a move or a trash of the canvas or of a folder
		// above it (they take it too) cannot pass between the check and the insert.
		if err := q.LockCanvasTree(ctx, ws); err != nil {
			return err
		}
		if a, err = resolve(r, q, id); err != nil { // again under the lock
			return err
		}
		if err := linkable(a); err != nil {
			return err
		}
		if err := auth.CheckPublicCapability(ctx, q, ws); err != nil {
			return err
		}
		if _, err := q.GetCanvasItemForUpdate(ctx, id); err != nil {
			return err
		}
		live, err := q.GetCanvasLink(ctx, id)
		switch {
		case err == nil:
			link, err = q.SetCanvasLinkExpiry(ctx, sqlc.SetCanvasLinkExpiryParams{Code: live.Code, ExpiresAt: expires})
			return err
		case !db.IsNotFound(err):
			return err
		}
		// An expired link that was never revoked is revoked now: one live link per canvas.
		if _, err := q.RevokeCanvasLink(ctx, id); err != nil {
			return err
		}
		if link, err = q.InsertCanvasLink(ctx, sqlc.InsertCanvasLinkParams{CanvasID: id, Code: code, CreatedBy: &a.c.uid, ExpiresAt: expires}); err != nil {
			return err
		}
		fresh = true
		after := snap{"expires_in_days": float64(days)}
		return s.journal(ctx, q, a.item, &a.c.uid, "link_on", nil, after)
	})
	if err != nil {
		return err
	}
	status := http.StatusOK
	if fresh {
		status = http.StatusCreated
	} else {
		s.kick(ctx, []uuid.UUID{id}) // the live viewers read the new expiry
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.Write(w, status, &v1.CanvasLinkResponse{Link: linkProto(link), Url: s.publicURL(link.Code)})
	return nil
}

// deleteLink: DELETE /api/canvas/items/{id}/link — revokes the public link (the owner or
// CANVAS_MANAGE); 404 without one. The live anonymous sockets close within seconds (Kick).
func (s *Service) deleteLink(w http.ResponseWriter, r *http.Request) error {
	id, err := httpx.PathUUID(r, "id", "item")
	if err != nil {
		return err
	}
	ctx := r.Context()
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		a, err := resolve(r, q, id)
		if err != nil {
			return err
		}
		if err := writable(ctx, q, a.item.WorkspaceID); err != nil {
			return err
		}
		if !a.structure() {
			return errNotStructure
		}
		n, err := q.RevokeCanvasLink(ctx, id)
		if err != nil {
			return err
		}
		if n == 0 {
			return errNoLink
		}
		return s.journal(ctx, q, a.item, &a.c.uid, "link_off", nil, nil)
	})
	if err != nil {
		return err
	}
	s.kick(ctx, []uuid.UUID{id})
	w.WriteHeader(http.StatusNoContent)
	return nil
}

// dropLinks revokes the links of item id and of everything below it once the item is in the
// trash or restricted along its chain (a restricted switch, a move into a restricted folder, the
// trash), in q's transaction after the change: a private canvas has no public link, and one made
// private does not get it back when the switch goes off again. The anonymous resolution refuses
// such a canvas anyway (linkOpen); this keeps the table honest. The callers Kick the sockets.
func dropLinks(ctx context.Context, q *sqlc.Queries, id uuid.UUID) error {
	ch, err := canvasacl.Load(ctx, q, []uuid.UUID{id})
	if err != nil || !ch.Has(id) {
		return err
	}
	if ch.Item(id).TrashedAt == nil && !perm.RestrictedIn(ch.Nodes(id)) {
		return nil
	}
	_, err = q.RevokeCanvasSubtreeLinks(ctx, id)
	return err
}

// ---- anonymous ----

// linkOpen is the anonymous access rule of a live link row (at a visit, at the socket's connect
// and on every recheck): a live canvas, not restricted along its chain, in a workspace that is
// not suspended (by a superadmin or its billing) and whose identity policy allows public
// capabilities. Every refusal is errNoLink; other errors are the dependencies'.
func (s *Service) linkOpen(ctx context.Context, row sqlc.GetCanvasLinkByCodeRow) error {
	p := row.CanvasItemHead
	if p.Kind != kindCanvas || p.TrashedAt != nil {
		return errNoLink
	}
	q := s.db.Q
	ch, err := canvasacl.Load(ctx, q, []uuid.UUID{p.ID})
	if err != nil {
		return err
	}
	if !ch.Has(p.ID) || ch.Item(p.ID).TrashedAt != nil || perm.RestrictedIn(ch.Nodes(p.ID)) {
		return errNoLink
	}
	ws, err := q.GetWorkspace(ctx, p.WorkspaceID)
	if err != nil {
		return err
	}
	if ws.SuspendedAt != nil {
		return errNoLink
	}
	if s.Billing != nil {
		if err := s.Billing.CheckBillingOpen(ctx, q, ws.ID); err != nil {
			if ysync.IsRefusal(err) {
				return errNoLink
			}
			return err
		}
	}
	if err := auth.CheckPublicCapability(ctx, q, ws.ID); err != nil {
		if ysync.IsRefusal(err) {
			return errNoLink
		}
		return err
	}
	return nil
}

// lookup resolves an anonymous code: the live link and its canvas, or errNoLink.
func (s *Service) lookup(ctx context.Context, code string) (sqlc.GetCanvasLinkByCodeRow, error) {
	if !validCode(code) {
		return sqlc.GetCanvasLinkByCodeRow{}, errNoLink
	}
	row, err := s.db.Q.GetCanvasLinkByCode(ctx, code)
	if db.IsNotFound(err) {
		return row, errNoLink
	}
	if err != nil {
		return row, err
	}
	return row, s.linkOpen(ctx, row)
}

// anonymous sets the headers of every anonymous answer and spends limit (per client IP).
func anonymous(w http.ResponseWriter, r *http.Request, limit *redisx.RateLimiter) error {
	h := w.Header()
	h.Set("Cache-Control", "no-store")
	h.Set("X-Robots-Tag", "noindex, nofollow")
	h.Set("Referrer-Policy", "no-referrer")
	if limit == nil {
		return nil
	}
	return limit.Take(r.Context(), ipGroup(httpx.ClientIP(r.Context())))
}

// ipGroup is the key of a client address in the anonymous limits: the address, or its /64 for
// IPv6 (one host usually holds a whole /64).
func ipGroup(ip string) string {
	a, err := netip.ParseAddr(ip)
	if err != nil {
		return ip
	}
	a = a.Unmap()
	if a.Is6() {
		return netip.PrefixFrom(a, 64).Masked().String()
	}
	return a.String()
}

// publicCanvas: GET /api/public/canvas/{code} — PublicCanvas, anonymous. A GET (not a HEAD)
// counts as a view.
func (s *Service) publicCanvas(w http.ResponseWriter, r *http.Request) error {
	if err := anonymous(w, r, s.LinkReadLimit); err != nil {
		return err
	}
	ctx := r.Context()
	row, err := s.lookup(ctx, r.PathValue("code"))
	if err != nil {
		return err
	}
	if r.Method == http.MethodGet {
		if err := db.GuardExec(ctx, s.db, func(q *sqlc.Queries) error { return q.CountCanvasLinkView(ctx, row.CanvasLink.Code) }); err != nil {
			return err
		}
	}
	p := row.CanvasItemHead
	out := &v1.PublicCanvas{Name: p.Name, UpdatedAt: timestamppb.New(p.UpdatedAt), ReadOnly: true}
	if e := row.CanvasLink.ExpiresAt; e != nil {
		out.ExpiresAt = timestamppb.New(*e)
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// publicSync: GET /api/public/canvas/{code}/sync — the anonymous receive-only sync socket of a
// link's canvas (ysync.Hub.ServeViewer). The origin, the connect rate (per client IP) and the code
// are checked before the upgrade (a refused code is a plain 404); the socket counts in the sets
// of its canvas (ViewersPerLink) and of its client IP (ViewersPerIP, across links) and resolves
// the code again on every recheck: a revoke, an expiry, the trash, restricted, a deletion close it
// 4404.
func (s *Service) publicSync(w http.ResponseWriter, r *http.Request) error {
	if s.sync == nil {
		return errNoLink
	}
	if !s.sync.OriginAllowed(r) {
		http.Error(w, "origin not allowed", http.StatusForbidden)
		return nil
	}
	if err := anonymous(w, r, s.LinkSyncLimit); err != nil {
		return err
	}
	ctx := r.Context()
	code := r.PathValue("code")
	row, err := s.lookup(ctx, code)
	if err != nil {
		return err
	}
	doc := row.CanvasItemHead.ID
	check := func(ctx context.Context) (time.Time, int, string) {
		row, err := s.lookup(ctx, code)
		switch {
		case err == errNoLink: //nolint:errorlint // sentinel returned as is
			return time.Time{}, ysync.CloseNotFound, "the link is gone"
		case err != nil:
			return time.Time{}, ysync.CloseTryAgain, "try again"
		case row.CanvasItemHead.ID != doc:
			return time.Time{}, ysync.CloseNotFound, "the link is gone"
		}
		if e := row.CanvasLink.ExpiresAt; e != nil {
			return *e, 0, ""
		}
		return time.Time{}, 0, ""
	}
	perLink, perIP := s.ViewersPerLink, s.ViewersPerIP
	if perLink <= 0 {
		perLink = DefaultViewersPerLink
	}
	if perIP <= 0 {
		perIP = DefaultViewersPerIP
	}
	s.sync.ServeViewer(w, r, ysync.Viewer{Doc: doc, Check: check, Slots: []ysync.Slot{
		{Key: "link:" + doc.String(), Max: perLink},
		{Key: "ip:" + ipGroup(httpx.ClientIP(ctx)), Max: perIP},
	}})
	return nil
}

package boards

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"log/slog"
	"net/http"
	"strconv"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/redis/rueidis"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/plans"
	"github.com/calaba/calaba/server/internal/redisx"
	"github.com/calaba/calaba/server/internal/sealbox"
	"github.com/calaba/calaba/server/internal/webhook"
)

// Board webhooks (ADR-0058 §4): one webhook per board, configured by those who manage the
// board and the workspace's integrations; every task change is queued in the transaction of
// the change (webhook_outbox.go) and delivered by the shared engine (internal/webhook), signed
// with v1 (timestamp + body). Business plans only (§5): below it the webhook stays configured
// but nothing is queued (paused_reason PLAN).

const (
	webhookLockKey   = "boards:webhook:worker"
	webhookMinSecret = 16
	webhookMaxSecret = 256
	webhookPingEvery = 10 * time.Second
	webhookVersion   = 1
	webhookUserAgent = "Calab-Webhook/1.0"
	// webhookPlanFeature names the feature in the 409 PLAN_LIMIT refusal.
	webhookPlanFeature = "board webhooks"
)

// Webhooks delivers board webhooks (the worker) and holds their secret box and transport.
type Webhooks struct {
	s      *Service
	box    *sealbox.Box
	tr     *webhook.Transport
	worker *webhook.Worker
	redis  rueidis.Client
}

// EnableWebhooks turns on board webhooks: secret is the sealing key (JWT_SECRET, like bots),
// o the delivery options (shared with bot webhooks). Run the returned worker in the background.
func (s *Service) EnableWebhooks(r rueidis.Client, secret []byte, o webhook.Options) *Webhooks {
	o = o.WithDefaults()
	h := &Webhooks{s: s, box: sealbox.New("calaba/board-webhook/v1", secret), tr: webhook.NewTransport(o), redis: r}
	h.worker = webhook.NewWorker(boardQueue{h}, h.tr, r, webhookLockKey, o)
	s.hooks = h
	return h
}

// Run delivers board webhooks while this instance holds the worker lock, until ctx is done.
func (h *Webhooks) Run(ctx context.Context) { h.worker.Run(ctx) }

// Process delivers due board webhooks now (tests; the caller must hold the worker lock).
func (h *Webhooks) Process(ctx context.Context) (int, error) { return h.worker.Process(ctx) }

func (h *Webhooks) wake() {
	if h != nil {
		h.worker.Wake()
	}
}

// webhookRoutes registers the webhook routes (MANAGE_BOARD + MANAGE_INTEGRATIONS; bots never).
func (s *Service) webhookRoutes(mux httpx.Router, wrap func(http.Handler) http.Handler) {
	h := func(pattern string, f func(http.ResponseWriter, *http.Request) error) {
		mux.Handle(pattern, wrap(httpx.HandlerFunc(f)))
	}
	h("GET /api/boards/{id}/webhook", s.getWebhook)
	h("PUT /api/boards/{id}/webhook", s.setWebhook)
	h("DELETE /api/boards/{id}/webhook", s.deleteWebhook)
	h("POST /api/boards/{id}/webhook/ping", s.pingWebhook)
}

// webhooksAllowed: the workspace's plan includes board webhooks (no plan service: yes).
func (s *Service) webhooksAllowed(ctx context.Context, wsID uuid.UUID) (bool, error) {
	if s.plans == nil {
		return true, nil
	}
	l, err := s.plans.Effective(ctx, wsID)
	return !l.BoardWebhooksDisabled, err
}

// webhookBoard resolves the board of a webhook route: MANAGE_BOARD, and for changes (manage)
// also MANAGE_INTEGRATIONS of the workspace and a writable one. Bots by the same bits (ADR-0109).
func (s *Service) webhookBoard(r *http.Request, archivedOK, manage bool) (uuid.UUID, perm.BoardAccess, error) {
	if s.hooks == nil {
		return uuid.Nil, perm.BoardAccess{}, httpx.Unavailable(nil)
	}
	id, acc, err := pathBoard(r, archivedOK)
	if err != nil {
		return id, acc, err
	}
	if !acc.Bits.Has(perm.ManageBoard) {
		return id, acc, httpx.Forbidden("MANAGE_BOARD required")
	}
	if !manage {
		return id, acc, nil
	}
	if !acc.Member.Workspace().Has(perm.ManageIntegrations) {
		return id, acc, httpx.Forbidden("MANAGE_INTEGRATIONS required")
	}
	return id, acc, writable(acc)
}

func (s *Service) webhookPB(ctx context.Context, wh sqlc.BoardWebhook, wsID uuid.UUID) (*v1.BoardWebhook, error) {
	out := &v1.BoardWebhook{
		BoardId: wh.BoardID.String(), Url: wh.Url, HasSecret: len(wh.SecretEnc) > 0, Enabled: wh.DisabledAt == nil,
		DisabledAt: tsp(wh.DisabledAt), FailingSince: tsp(wh.FailingSince), LastOkAt: tsp(wh.LastOkAt), LastError: wh.LastError,
		CreatedBy: idp(wh.CreatedBy), CreatedAt: timestamppb.New(wh.CreatedAt), UpdatedAt: timestamppb.New(wh.UpdatedAt),
	}
	n, err := s.db.Q.CountPendingBoardWebhookDeliveries(ctx, wh.BoardID)
	if err != nil {
		return nil, err
	}
	out.Pending = uint32(max(n, 0)) //nolint:gosec // a count
	ok, err := s.webhooksAllowed(ctx, wsID)
	if err != nil {
		return nil, err
	}
	if !ok {
		out.PausedReason = v1.BoardWebhookPauseReason_BOARD_WEBHOOK_PAUSE_REASON_PLAN
	}
	return out, nil
}

// getWebhook: GET /api/boards/{id}/webhook — any MANAGE_BOARD sees it (never the secret).
func (s *Service) getWebhook(w http.ResponseWriter, r *http.Request) error {
	id, acc, err := s.webhookBoard(r, true, false)
	if err != nil {
		return err
	}
	wh, err := s.db.Q.GetBoardWebhook(r.Context(), id)
	if db.IsNotFound(err) {
		httpx.Write(w, http.StatusOK, &v1.BoardWebhookResponse{})
		return nil
	}
	if err != nil {
		return err
	}
	pb, err := s.webhookPB(r.Context(), wh, acc.WorkspaceID)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.BoardWebhookResponse{Webhook: pb})
	return nil
}

// setWebhook: PUT /api/boards/{id}/webhook — creates, replaces or re-enables; the secret is
// returned once (an empty one is generated).
func (s *Service) setWebhook(w http.ResponseWriter, r *http.Request) error {
	id, acc, err := s.webhookBoard(r, false, true)
	if err != nil {
		return err
	}
	if ok, err := s.webhooksAllowed(r.Context(), acc.WorkspaceID); err != nil {
		return err
	} else if !ok {
		return plans.FeatureError(webhookPlanFeature)
	}
	var req v1.SetBoardWebhookRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	u, err := s.hooks.tr.CheckURL(req.GetUrl())
	if err != nil {
		return err
	}
	secret := req.GetSecret()
	if secret == "" {
		b := make([]byte, 32)
		if _, err := rand.Read(b); err != nil {
			return err
		}
		secret = base64.RawURLEncoding.EncodeToString(b)
	} else if n := utf8.RuneCountInString(secret); n < webhookMinSecret || n > webhookMaxSecret {
		return httpx.Validation("secret", "secret must be 16..256 characters (or empty to generate one)")
	}
	sealed, err := s.hooks.box.Seal([]byte(secret))
	if err != nil {
		return err
	}
	me := uid(r)
	var wh sqlc.BoardWebhook
	if err := s.tx(r.Context(), func(q *sqlc.Queries, _ pgx.Tx) error {
		wh, err = q.UpsertBoardWebhook(r.Context(), sqlc.UpsertBoardWebhookParams{BoardID: id, Url: u, SecretEnc: sealed, CreatedBy: &me})
		return err
	}); err != nil {
		return err
	}
	pb, err := s.webhookPB(r.Context(), wh, acc.WorkspaceID)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.BoardWebhookResponse{Webhook: pb, Secret: secret})
	return nil
}

// deleteWebhook: DELETE /api/boards/{id}/webhook — the queue is marked failed.
func (s *Service) deleteWebhook(w http.ResponseWriter, r *http.Request) error {
	id, _, err := s.webhookBoard(r, true, true)
	if err != nil {
		return err
	}
	if err := s.tx(r.Context(), func(q *sqlc.Queries, _ pgx.Tx) error {
		n, err := q.DeleteBoardWebhook(r.Context(), id)
		if err != nil {
			return err
		}
		if n == 0 {
			return httpx.NotFound("webhook")
		}
		return q.FailPendingBoardWebhookDeliveries(r.Context(), sqlc.FailPendingBoardWebhookDeliveriesParams{BoardID: id, Error: "webhook removed"})
	}); err != nil {
		return err
	}
	httpx.NoContent(w)
	return nil
}

// pingWebhook: POST /api/boards/{id}/webhook/ping — a synchronous "ping" delivery over the
// same transport, ≤ 1 per 10 s per board.
func (s *Service) pingWebhook(w http.ResponseWriter, r *http.Request) error {
	id, acc, err := s.webhookBoard(r, false, true)
	if err != nil {
		return err
	}
	if ok, err := s.webhooksAllowed(r.Context(), acc.WorkspaceID); err != nil {
		return err
	} else if !ok {
		return plans.FeatureError(webhookPlanFeature)
	}
	wh, err := s.db.Q.GetBoardWebhook(r.Context(), id)
	if db.IsNotFound(err) {
		return httpx.NotFound("webhook")
	}
	if err != nil {
		return err
	}
	if s.hooks.redis != nil {
		err := s.hooks.redis.Do(r.Context(), s.hooks.redis.B().Set().Key(redisx.Key("boards:webhook:ping:"+id.String())).
			Value("1").Nx().Px(webhookPingEvery).Build()).Error()
		if rueidis.IsRedisNil(err) {
			return httpx.RateLimited()
		}
		if err != nil {
			return err
		}
	}
	secret, err := s.hooks.box.Open(wh.SecretEnc)
	if err != nil {
		return err
	}
	b, err := s.db.Q.GetBoard(r.Context(), id)
	if err != nil {
		return err
	}
	me := uid(r)
	ev, err := s.webhookEvent(r.Context(), s.db.Q, b, "ping", 0, &me)
	if err != nil {
		return err
	}
	did, err := uuid.NewV7()
	if err != nil {
		return err
	}
	ev.Id = did.String()
	body, err := webhookJSON.Marshal(ev)
	if err != nil {
		return err
	}
	d := webhook.Delivery{ID: did, Owner: id, Event: "ping", Payload: body}
	status, perr := s.hooks.tr.Post(r.Context(), wh.Url, body, boardQueue{s.hooks}.Headers(d, webhook.Target{Secret: secret}, s.Now()))
	out := &v1.BoardWebhookPingResponse{Ok: perr == nil, Status: uint32(max(status, 0))} //nolint:gosec // an HTTP status
	if perr != nil {
		out.Error = perr.Error()
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// ---- the outbox as a webhook.Queue ----

type boardQueue struct{ h *Webhooks }

var _ webhook.Queue = boardQueue{}

func (b boardQueue) Claim(ctx context.Context, lease time.Duration, limit int32) ([]webhook.Delivery, error) {
	d := b.h.s.db
	rows, err := db.GuardValue(ctx, d, func(q *sqlc.Queries) ([]sqlc.BoardWebhookDelivery, error) {
		return q.ClaimBoardWebhookDeliveries(ctx, sqlc.ClaimBoardWebhookDeliveriesParams{
			Lease: pgtype.Interval{Microseconds: lease.Microseconds(), Valid: true}, Lim: limit,
		})
	})
	out := make([]webhook.Delivery, len(rows))
	for i, r := range rows {
		out[i] = webhook.Delivery{ID: r.ID, Owner: r.BoardID, Event: r.EventType, Payload: r.Payload, Attempts: r.Attempts, CreatedAt: r.CreatedAt}
	}
	return out, err
}

func (b boardQueue) Target(ctx context.Context, board uuid.UUID) (webhook.Target, bool) {
	wh, err := b.h.s.db.Q.GetBoardWebhook(ctx, board)
	if err != nil || wh.DisabledAt != nil {
		return webhook.Target{}, false
	}
	secret, err := b.h.box.Open(wh.SecretEnc)
	if err != nil {
		slog.WarnContext(ctx, "board webhooks: secret", "board_id", board, "err", err)
		return webhook.Target{}, false
	}
	return webhook.Target{URL: wh.Url, Secret: secret}, true
}

// Headers: the v1 signature over the timestamp and the body (ADR-0058 §4).
func (boardQueue) Headers(d webhook.Delivery, t webhook.Target, now time.Time) http.Header {
	ts := now.Unix()
	h := http.Header{}
	h.Set("User-Agent", webhookUserAgent)
	h.Set("X-Calab-Webhook-Version", strconv.Itoa(webhookVersion))
	h.Set("X-Calab-Delivery", d.ID.String())
	h.Set("X-Calab-Event", d.Event)
	h.Set(webhook.HeaderTimestamp, strconv.FormatInt(ts, 10))
	h.Set(webhook.HeaderSignature, webhook.Sign(t.Secret, ts, d.Payload))
	return h
}

func (b boardQueue) Delivered(ctx context.Context, d webhook.Delivery) error {
	return b.h.s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if err := q.MarkBoardWebhookDelivered(ctx, d.ID); err != nil {
			return err
		}
		return q.BoardWebhookOK(ctx, d.Owner)
	})
}

func (b boardQueue) Retry(ctx context.Context, d webhook.Delivery, next time.Time, msg string) error {
	return db.GuardExec(ctx, b.h.s.db, func(q *sqlc.Queries) error {
		return q.MarkBoardWebhookRetry(ctx, sqlc.MarkBoardWebhookRetryParams{ID: d.ID, NextAt: next, Error: msg})
	})
}

func (b boardQueue) Failed(ctx context.Context, d webhook.Delivery, msg string) error {
	return db.GuardExec(ctx, b.h.s.db, func(q *sqlc.Queries) error {
		return q.MarkBoardWebhookFailed(ctx, sqlc.MarkBoardWebhookFailedParams{ID: d.ID, Error: msg})
	})
}

func (b boardQueue) Failing(ctx context.Context, board uuid.UUID, msg string) (*time.Time, error) {
	wh, err := db.GuardValue(ctx, b.h.s.db, func(q *sqlc.Queries) (sqlc.BoardWebhook, error) {
		return q.BoardWebhookFailing(ctx, sqlc.BoardWebhookFailingParams{BoardID: board, LastError: msg})
	})
	if db.IsNotFound(err) {
		return nil, nil // removed meanwhile
	}
	return wh.FailingSince, err
}

// Disable turns off a webhook failing for a day: its queue is dropped and the board's viewers
// get BOARD_UPDATE (the managers' webhook tab reloads the state).
func (b boardQueue) Disable(ctx context.Context, board uuid.UUID) {
	s := b.h.s
	changed := false
	err := s.db.Tx(ctx, func(q *sqlc.Queries) error {
		_, err := q.DisableBoardWebhook(ctx, board)
		if db.IsNotFound(err) {
			return nil // already disabled (another delivery of the batch) or removed
		}
		if err != nil {
			return err
		}
		changed = true
		return q.FailPendingBoardWebhookDeliveries(ctx, sqlc.FailPendingBoardWebhookDeliveriesParams{BoardID: board, Error: "webhook disabled after a day of failures"})
	})
	if err != nil {
		slog.WarnContext(ctx, "board webhooks: disable", "board_id", board, "err", err)
		return
	}
	if !changed {
		return
	}
	slog.WarnContext(ctx, "board webhook disabled after a day of failures", "board_id", board)
	if wsID, err := s.workspaceOf(ctx, board); err == nil {
		s.publishBoard(ctx, wsID, board, false)
	}
}

func (b boardQueue) Cleanup(ctx context.Context, before time.Time) error {
	_, err := db.GuardValue(ctx, b.h.s.db, func(q *sqlc.Queries) (int64, error) {
		return q.DeleteOldBoardWebhookDeliveries(ctx, before)
	})
	return err
}

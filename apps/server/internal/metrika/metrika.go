// Package metrika sends server-side conversions to Yandex Metrika over the Measurement
// Protocol (ADR-0135) so Yandex Direct can optimise on registrations and payments.
//
// Conversions are written to the metrika_conversions outbox in the transaction of the business
// fact (the registration, the credit of a confirmed payment); a dedupe key makes each one
// once-only, so a redelivered payment webhook adds nothing. A worker sends due rows with
// bounded retries. Nothing here can fail a registration or a payment beyond the database the
// transaction already uses: no network inside the transaction.
//
// Only accounts with a Metrika ClientID take part (the landing passes it only after the
// visitor consented to analytics). No email, name or IP leaves the server: the client id, the
// goal, and for a payment its amount, currency, plan and id.
package metrika

import (
	"context"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// Goals (JavaScript-event goals of the counter with these identifiers).
const (
	GoalSignup   = "signup"
	GoalPurchase = "purchase"
)

// DefaultEndpoint is the Measurement Protocol collector.
const DefaultEndpoint = "https://mc.yandex.ru/collect"

// maxValue bounds a stored attribution value (characters).
const maxValue = 200

var clientIDRe = regexp.MustCompile(`^[0-9]{1,32}$`)

// Config of the sender (env, config.Config.Metrika).
type Config struct {
	// Token: YM_MP_TOKEN, the counter's Measurement Protocol token. Empty = disabled: no
	// conversion is recorded or sent (attribution is still stored).
	Token string
	// CounterID: YM_COUNTER_ID.
	CounterID int64
	// Endpoint: YM_MP_URL (tests point it at a stub).
	Endpoint string
	// PageURL: the page the hits report (PUBLIC_APP_URL).
	PageURL string
	// HTTP client; nil = a client with a 10 s timeout.
	HTTP *http.Client
	// Poll: how often the worker looks for due rows; 0 = DefaultPoll.
	Poll time.Duration
}

// Service records and sends conversions. A nil *Service is valid and disabled.
type Service struct {
	cfg  Config
	db   *db.DB
	http *http.Client
	now  func() time.Time
}

// New creates the service; it records nothing unless cfg has a token and a counter.
func New(d *db.DB, cfg Config) *Service {
	if cfg.Endpoint == "" {
		cfg.Endpoint = DefaultEndpoint
	}
	if cfg.Poll <= 0 {
		cfg.Poll = DefaultPoll
	}
	hc := cfg.HTTP
	if hc == nil {
		hc = &http.Client{Timeout: 10 * time.Second}
	}
	return &Service{cfg: cfg, db: d, http: hc, now: time.Now}
}

// Enabled reports whether conversions are recorded and sent.
func (s *Service) Enabled() bool {
	return s != nil && s.cfg.Token != "" && s.cfg.CounterID > 0
}

// ValidClientID reports whether id is a Metrika ClientID (a non-negative integer).
func ValidClientID(id string) bool { return clientIDRe.MatchString(id) }

// Attribution turns the client's sign-up attribution into the row to store (UserID left for
// the caller). ok = false when nothing usable came. Values are trimmed and cut to 200
// characters; a ClientID that is not digits is dropped.
func Attribution(a *v1.SignupAttribution) (row sqlc.InsertUserAttributionParams, ok bool) {
	if a == nil {
		return row, false
	}
	row = sqlc.InsertUserAttributionParams{
		UtmSource: clean(a.GetUtmSource()), UtmMedium: clean(a.GetUtmMedium()), UtmCampaign: clean(a.GetUtmCampaign()),
		UtmContent: clean(a.GetUtmContent()), UtmTerm: clean(a.GetUtmTerm()), Yclid: clean(a.GetYclid()),
	}
	if id := strings.TrimSpace(a.GetYmClientId()); ValidClientID(id) {
		row.YmClientID = id
	}
	ok = row.UtmSource != "" || row.UtmMedium != "" || row.UtmCampaign != "" || row.UtmContent != "" ||
		row.UtmTerm != "" || row.Yclid != "" || row.YmClientID != ""
	return row, ok
}

func clean(v string) string {
	v = strings.TrimSpace(strings.ToValidUTF8(v, ""))
	v = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, v)
	if utf8.RuneCountInString(v) > maxValue {
		v = string([]rune(v)[:maxValue])
	}
	return v
}

// Signup records the registration conversion of userID in the caller's transaction. No-op
// when disabled or without a client id.
func (s *Service) Signup(ctx context.Context, q *sqlc.Queries, userID uuid.UUID, clientID string, at time.Time) error {
	if !s.Enabled() || !ValidClientID(clientID) {
		return nil
	}
	return q.InsertMetrikaConversion(ctx, sqlc.InsertMetrikaConversionParams{
		DedupeKey: GoalSignup + ":" + userID.String(), Goal: GoalSignup, ClientID: clientID, OccurredAt: at.UTC(),
	})
}

// Purchase records the conversion of a payment that was just credited (billing core hook,
// in the credit's transaction): a live payment of an account whose workspace owner has a
// client id. Once per payment (dedupe key), so a repeated credit attempt adds nothing.
func (s *Service) Purchase(ctx context.Context, q *sqlc.Queries, acc sqlc.BillingAccount, pay sqlc.BillingPayment) error {
	if !s.Enabled() || !pay.Livemode || pay.AmountMinor <= 0 {
		return nil
	}
	cid, err := q.GetBillingOwnerMetrikaClientID(ctx, acc.ID)
	if err != nil || !ValidClientID(cid) {
		return err
	}
	at := s.now()
	if pay.SucceededAt != nil {
		at = *pay.SucceededAt
	}
	return q.InsertMetrikaConversion(ctx, sqlc.InsertMetrikaConversionParams{
		DedupeKey: GoalPurchase + ":" + pay.ID.String(), Goal: GoalPurchase, ClientID: cid, OccurredAt: at.UTC(),
		AmountMinor: pay.AmountMinor, Currency: pay.Currency, Plan: acc.Plan, TransactionID: pay.ID.String(),
	})
}

// major formats minor units as a decimal of major units (both billing currencies have 2).
func major(minor int64) string { return fmt.Sprintf("%d.%02d", minor/100, minor%100) }

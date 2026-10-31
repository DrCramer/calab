//go:build integration

package metrika_test

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/billing/core"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/dbtest"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/metrika"
)

func TestMain(m *testing.M) { os.Exit(dbtest.Run(m)) }

var ctx = context.Background()

// fakeYM is the collector: it answers status and records the bodies.
type fakeYM struct {
	mu     sync.Mutex
	status int
	bodies []string
}

func (f *fakeYM) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	b, _ := io.ReadAll(r.Body)
	f.mu.Lock()
	defer f.mu.Unlock()
	f.bodies = append(f.bodies, string(b))
	w.WriteHeader(f.status)
	_, _ = io.WriteString(w, "<!-- OK -->")
}

func (f *fakeYM) got() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.bodies...)
}

type env struct {
	d     *db.DB
	svc   *metrika.Service
	core  *core.Core
	owner uuid.UUID
	acc   uuid.UUID
}

// newEnv: an owner with a ClientID (or none), a workspace and its active billing account whose
// core credits payments with the purchase hook of svc.
func newEnv(t *testing.T, svc *metrika.Service, d *db.DB, cid string) *env {
	t.Helper()
	e := &env{d: d, svc: svc}
	e.core = core.New(d, billing.DBClock{}, core.Config{}, core.Hooks{PaymentCredited: svc.Purchase})
	email := uuid.NewString() + "@metrika.test"
	u, err := d.Q.CreateUser(ctx, sqlc.CreateUserParams{Email: &email, DisplayName: "Owner", Settings: []byte("{}")})
	if err != nil {
		t.Fatal(err)
	}
	e.owner = u.ID
	if cid != "" {
		if err := d.Q.InsertUserAttribution(ctx, sqlc.InsertUserAttributionParams{UserID: u.ID, UtmSource: "yandex", YmClientID: cid}); err != nil {
			t.Fatal(err)
		}
	}
	ws, err := d.Q.CreateWorkspace(ctx, sqlc.CreateWorkspaceParams{Slug: "m" + strings.ReplaceAll(uuid.NewString(), "-", "")[:20],
		Name: "Metrika", Visibility: "private", OwnerID: u.ID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.Q.AddMember(ctx, sqlc.AddMemberParams{WorkspaceID: ws.ID, UserID: u.ID, Role: "owner"}); err != nil {
		t.Fatal(err)
	}
	acc, err := e.core.EnableAccount(ctx, ws.ID, "ru", "tochka", &u.ID)
	if err != nil {
		t.Fatal(err)
	}
	e.acc = acc.ID
	return e
}

// pay records a succeeded payment and credits it twice (a redelivered webhook).
func (e *env) pay(t *testing.T, amount int64, live bool) uuid.UUID {
	t.Helper()
	at := time.Now()
	p, err := e.d.Q.InsertBillingPayment(ctx, sqlc.InsertBillingPaymentParams{AccountID: e.acc, Provider: "tochka",
		ProviderAccount: "acct", Livemode: live, ProviderPaymentID: "op_" + uuid.NewString(), AmountMinor: amount,
		Currency: "RUB", Status: "succeeded", Origin: "checkout", SucceededAt: &at})
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if _, err := e.core.CreditPaymentTx(ctx, p.ID); err != nil {
			t.Fatal(err)
		}
	}
	return p.ID
}

func conversions(t *testing.T, d *db.DB, key string) []sqlc.MetrikaConversion {
	t.Helper()
	rows, err := d.Pool.Query(ctx, `SELECT id, goal, client_id, amount_minor, currency, plan, transaction_id, attempts, sent_at, failed_at
		FROM metrika_conversions WHERE dedupe_key = $1`, key)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []sqlc.MetrikaConversion
	for rows.Next() {
		var c sqlc.MetrikaConversion
		if err := rows.Scan(&c.ID, &c.Goal, &c.ClientID, &c.AmountMinor, &c.Currency, &c.Plan, &c.TransactionID, &c.Attempts, &c.SentAt, &c.FailedAt); err != nil {
			t.Fatal(err)
		}
		out = append(out, c)
	}
	return out
}

func TestPurchaseOncePerPaymentAndSend(t *testing.T) {
	d := dbtest.Connect(t)
	ym := &fakeYM{status: http.StatusOK}
	srv := httptest.NewServer(ym)
	defer srv.Close()
	svc := metrika.New(d, metrika.Config{Token: "tok", CounterID: 1, Endpoint: srv.URL, PageURL: "https://app.example.com"})

	e := newEnv(t, svc, d, "1710232430899999999")
	pay := e.pay(t, 99000, true)
	rows := conversions(t, d, "purchase:"+pay.String())
	if len(rows) != 1 {
		t.Fatalf("a credited payment twice must give one conversion: %d", len(rows))
	}
	if c := rows[0]; c.ClientID != "1710232430899999999" || c.AmountMinor != 99000 || c.Currency != "RUB" || c.Plan != "team" || c.TransactionID != pay.String() {
		t.Fatalf("conversion: %+v", c)
	}
	// A test-mode payment and an owner without a ClientID record nothing.
	test := e.pay(t, 5000, false)
	if n := len(conversions(t, d, "purchase:"+test.String())); n != 0 {
		t.Fatalf("test-mode payment recorded: %d", n)
	}
	plain := newEnv(t, svc, d, "")
	if p := plain.pay(t, 5000, true); len(conversions(t, d, "purchase:"+p.String())) != 0 {
		t.Fatal("owner without ClientID recorded")
	}

	// Signup goes through the same outbox; a repeat is a no-op too.
	user := uuid.New()
	for range 2 {
		if err := d.Tx(ctx, func(q *sqlc.Queries) error { return svc.Signup(ctx, q, user, "77", time.Now()) }); err != nil {
			t.Fatal(err)
		}
	}
	if n := len(conversions(t, d, "signup:"+user.String())); n != 1 {
		t.Fatalf("signup rows: %d", n)
	}

	n, err := svc.ProcessOnce(ctx)
	if err != nil || n < 2 {
		t.Fatalf("process: %d %v", n, err)
	}
	var purchaseBody string
	for _, b := range ym.got() {
		if strings.Contains(b, "ti="+pay.String()) {
			purchaseBody = b
		}
	}
	if lines := strings.Split(purchaseBody, "\n"); len(lines) != 3 || !strings.Contains(lines[1], "ea=purchase") ||
		!strings.Contains(lines[2], "tr=990.00") || !strings.Contains(lines[2], "cu=RUB") {
		t.Fatalf("purchase batch: %q", purchaseBody)
	}
	if c := conversions(t, d, "purchase:"+pay.String())[0]; c.SentAt == nil || c.Attempts != 1 {
		t.Fatalf("not marked sent: %+v", c)
	}
	// Sent rows are never sent again.
	before := len(ym.got())
	if _, err := svc.ProcessOnce(ctx); err != nil {
		t.Fatal(err)
	}
	if len(ym.got()) != before {
		t.Fatal("a sent conversion was sent again")
	}
}

func TestRetryAndReject(t *testing.T) {
	d := dbtest.Connect(t)
	ym := &fakeYM{status: http.StatusServiceUnavailable}
	srv := httptest.NewServer(ym)
	defer srv.Close()
	svc := metrika.New(d, metrika.Config{Token: "tok", CounterID: 1, Endpoint: srv.URL})
	user := uuid.New()
	if err := d.Tx(ctx, func(q *sqlc.Queries) error { return svc.Signup(ctx, q, user, "5", time.Now()) }); err != nil {
		t.Fatal(err)
	}
	key := "signup:" + user.String()
	if _, err := svc.ProcessOnce(ctx); err != nil {
		t.Fatal(err)
	}
	c := conversions(t, d, key)[0]
	if c.SentAt != nil || c.FailedAt != nil || c.Attempts != 1 {
		t.Fatalf("503 must schedule a retry: %+v", c)
	}
	var next time.Time
	if err := d.Pool.QueryRow(ctx, `SELECT next_at FROM metrika_conversions WHERE id = $1`, c.ID).Scan(&next); err != nil {
		t.Fatal(err)
	}
	if time.Until(next) < 30*time.Second {
		t.Fatalf("retry not backed off: %v", time.Until(next))
	}
	// Due again, now rejected (400): given up at once.
	ym.mu.Lock()
	ym.status = http.StatusBadRequest
	ym.mu.Unlock()
	if _, err := d.Pool.Exec(ctx, `UPDATE metrika_conversions SET next_at = now() WHERE id = $1`, c.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ProcessOnce(ctx); err != nil {
		t.Fatal(err)
	}
	if c := conversions(t, d, key)[0]; c.FailedAt == nil || c.SentAt != nil || c.Attempts != 2 {
		t.Fatalf("400 must give up: %+v", c)
	}
}

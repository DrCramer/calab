package metrika

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

var now = time.Date(2026, 10, 26, 12, 0, 0, 0, time.UTC)

func TestAttribution(t *testing.T) {
	if _, ok := Attribution(nil); ok {
		t.Fatal("nil attribution is usable")
	}
	if _, ok := Attribution(&v1.SignupAttribution{YmClientId: "abc", UtmSource: "  "}); ok {
		t.Fatal("blank values and a non-numeric client id are usable")
	}
	long := strings.Repeat("я", 250)
	row, ok := Attribution(&v1.SignupAttribution{
		UtmSource: " yandex ", UtmMedium: "cpc\n", UtmCampaign: long, Yclid: "123", YmClientId: " 1710232430899999999 ",
	})
	if !ok || row.UtmSource != "yandex" || row.UtmMedium != "cpc" || row.Yclid != "123" || row.YmClientID != "1710232430899999999" {
		t.Fatalf("row: %+v", row)
	}
	if n := len([]rune(row.UtmCampaign)); n != maxValue {
		t.Fatalf("campaign not cut to %d: %d", maxValue, n)
	}
	row, ok = Attribution(&v1.SignupAttribution{YmClientId: "-1", UtmSource: "x"})
	if !ok || row.YmClientID != "" {
		t.Fatalf("a negative client id must be dropped, utm kept: %+v", row)
	}
}

func TestDisabled(t *testing.T) {
	var nilSvc *Service
	if nilSvc.Enabled() || New(nil, Config{CounterID: 1}).Enabled() || New(nil, Config{Token: "t"}).Enabled() {
		t.Fatal("enabled without token or counter")
	}
	// Disabled: no query runs (a nil *sqlc.Queries would panic).
	if err := nilSvc.Signup(context.Background(), nil, uuid.New(), "1", now); err != nil {
		t.Fatal(err)
	}
	if err := New(nil, Config{}).Purchase(context.Background(), nil, sqlc.BillingAccount{}, sqlc.BillingPayment{Livemode: true, AmountMinor: 100}); err != nil {
		t.Fatal(err)
	}
	// Enabled, but no client id / a test-mode payment: nothing either.
	on := New(nil, Config{Token: "t", CounterID: 1})
	if err := on.Signup(context.Background(), nil, uuid.New(), "", now); err != nil {
		t.Fatal(err)
	}
	if err := on.Purchase(context.Background(), nil, sqlc.BillingAccount{}, sqlc.BillingPayment{Livemode: false, AmountMinor: 100}); err != nil {
		t.Fatal(err)
	}
}

func TestHitsSignup(t *testing.T) {
	c := sqlc.MetrikaConversion{Goal: GoalSignup, ClientID: "42", OccurredAt: now.Add(-time.Minute)}
	h := Hits(c, "https://app.calab.io", now)
	if len(h) != 2 {
		t.Fatalf("hits: %v", h)
	}
	et := strconv.FormatInt(now.Add(-time.Minute).Unix(), 10)
	want := []url.Values{
		{"cid": {"42"}, "t": {"pageview"}, "dl": {"https://app.calab.io"}, "dt": {"Calab"}, "et": {et}},
		{"cid": {"42"}, "t": {"event"}, "dl": {"https://app.calab.io"}, "ea": {"signup"}, "et": {et}},
	}
	for i := range want {
		if h[i].Encode() != want[i].Encode() {
			t.Fatalf("hit %d: %s, want %s", i, h[i].Encode(), want[i].Encode())
		}
	}
	for _, k := range []string{"ms", "tid", "email"} {
		if h[0].Has(k) || h[1].Has(k) {
			t.Fatalf("hit line carries %s", k)
		}
	}
}

func TestHitsPurchase(t *testing.T) {
	c := sqlc.MetrikaConversion{Goal: GoalPurchase, ClientID: "42", OccurredAt: now.Add(-20 * time.Hour),
		AmountMinor: 150005, Currency: "RUB", Plan: "enterprise", TransactionID: "pay-1"}
	h := Hits(c, "", now)
	if len(h) != 3 {
		t.Fatalf("hits: %v", h)
	}
	for _, v := range h {
		if v.Has("et") || v.Has("dl") {
			t.Fatalf("et older than the 12 h window / an empty dl must be omitted: %s", v.Encode())
		}
	}
	if g := h[1]; g.Get("ea") != "purchase" || g.Get("ev") != "1500.05" || g.Get("cu") != "RUB" {
		t.Fatalf("goal hit: %s", g.Encode())
	}
	e := h[2]
	if e.Get("pa") != "purchase" || e.Get("ti") != "pay-1" || e.Get("tr") != "1500.05" || e.Get("cu") != "RUB" ||
		e.Get("pr1id") != "enterprise" || e.Get("pr1nm") != "Business" || e.Get("pr1pr") != "1500.05" || e.Get("pr1qt") != "1" || e.Has("ea") {
		t.Fatalf("ecommerce hit: %s", e.Encode())
	}
	if major(5) != "0.05" || major(100) != "1.00" {
		t.Fatal("major units")
	}
}

func TestSend(t *testing.T) {
	var gotQuery url.Values
	var gotBody string
	status, reply := http.StatusOK, "<!-- OK -->"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.Query()
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.WriteHeader(status)
		_, _ = io.WriteString(w, reply)
	}))
	defer srv.Close()
	s := New(nil, Config{Token: "secret-token", CounterID: 113761661, Endpoint: srv.URL, PageURL: "https://app.calab.io"})
	s.now = func() time.Time { return now }
	c := sqlc.MetrikaConversion{Goal: GoalSignup, ClientID: "42", OccurredAt: now}
	if err := s.send(context.Background(), c); err != nil {
		t.Fatal(err)
	}
	if gotQuery.Get("tid") != "113761661" || gotQuery.Get("ms") != "secret-token" || len(gotQuery) != 2 {
		t.Fatalf("query: %v", gotQuery)
	}
	lines := strings.Split(gotBody, "\n")
	if len(lines) != 2 || strings.HasSuffix(gotBody, "\n") || !strings.Contains(lines[1], "ea=signup") {
		t.Fatalf("body: %q", gotBody)
	}

	status, reply = http.StatusBadRequest, "<!-- Invalid format of 'cid' parameter -->"
	err := s.send(context.Background(), c)
	if err == nil || !strings.Contains(err.Error(), "Invalid format of 'cid' parameter") || !errors.Is(err, errRejected) {
		t.Fatalf("400: %v", err)
	}
	status = http.StatusServiceUnavailable
	if err := s.send(context.Background(), c); err == nil || errors.Is(err, errRejected) {
		t.Fatalf("503 must be retryable: %v", err)
	}
	// A network error never carries the token (the URL holds it).
	srv.Close()
	if err := s.send(context.Background(), c); err == nil || strings.Contains(err.Error(), "secret-token") || errors.Is(err, errRejected) {
		t.Fatalf("network error: %v", err)
	}
}

func TestRetryDelay(t *testing.T) {
	if RetryDelay(0) != time.Minute || RetryDelay(1) != time.Minute || RetryDelay(3) != 30*time.Minute || RetryDelay(99) != 6*time.Hour {
		t.Fatal("retry schedule")
	}
}

package metrika

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"

	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// Worker defaults.
const (
	DefaultPoll = 30 * time.Second
	lease       = 2 * time.Minute
	batch       = 20
	// maxAttempts bounds the sends of one conversion; then it is given up.
	maxAttempts = 6
	// eventWindow: Metrika rejects an event time (et) older than 12 hours; an older conversion
	// is sent without et (dated at receipt) rather than lost.
	eventWindow = 11 * time.Hour
)

// retryDelay is the wait after the n-th failed attempt (1-based).
var retryDelay = []time.Duration{time.Minute, 5 * time.Minute, 30 * time.Minute, 2 * time.Hour, 6 * time.Hour}

var sent = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "calaba_metrika_conversions_total",
	Help: "Measurement Protocol conversions by goal and result (sent, retry, failed).",
}, []string{"goal", "result"})

// errRejected: Metrika answered 400 — the hit is invalid and a retry would not help.
var errRejected = errors.New("metrika: rejected")

// Run sends due conversions until ctx is done; returns at once when disabled.
func (s *Service) Run(ctx context.Context) {
	if !s.Enabled() {
		return
	}
	t := time.NewTicker(s.cfg.Poll)
	defer t.Stop()
	for {
		if _, err := s.ProcessOnce(ctx); err != nil && ctx.Err() == nil {
			slog.Warn("metrika: process conversions", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// ProcessOnce claims and sends due conversions (several batches); returns how many were sent.
func (s *Service) ProcessOnce(ctx context.Context) (int, error) {
	n := 0
	for {
		var rows []sqlc.MetrikaConversion
		err := s.db.Tx(ctx, func(q *sqlc.Queries) error {
			var err error
			rows, err = q.ClaimMetrikaConversions(ctx, sqlc.ClaimMetrikaConversionsParams{
				Lease: pgtype.Interval{Microseconds: lease.Microseconds(), Valid: true}, Lim: batch,
			})
			return err
		})
		if err != nil {
			return n, err
		}
		for _, c := range rows {
			if err := s.deliver(ctx, c); err != nil {
				return n, err
			}
			if ctx.Err() == nil {
				n++
			}
		}
		if len(rows) < batch {
			return n, nil
		}
	}
}

// deliver sends one claimed conversion and records the outcome (an error only from the database).
func (s *Service) deliver(ctx context.Context, c sqlc.MetrikaConversion) error {
	err := s.send(ctx, c)
	switch {
	case err == nil:
		sent.WithLabelValues(c.Goal, "sent").Inc()
		return s.db.Tx(ctx, func(q *sqlc.Queries) error { return q.MarkMetrikaConversionSent(ctx, c.ID) })
	case errors.Is(err, errRejected) || int(c.Attempts) >= maxAttempts:
		sent.WithLabelValues(c.Goal, "failed").Inc()
		slog.Warn("metrika: conversion given up", "id", c.ID, "goal", c.Goal, "attempts", c.Attempts, "err", err)
		return s.db.Tx(ctx, func(q *sqlc.Queries) error {
			return q.MarkMetrikaConversionFailed(ctx, sqlc.MarkMetrikaConversionFailedParams{ID: c.ID, Error: errText(err)})
		})
	default:
		sent.WithLabelValues(c.Goal, "retry").Inc()
		next := s.now().Add(RetryDelay(int(c.Attempts)))
		return s.db.Tx(ctx, func(q *sqlc.Queries) error {
			return q.MarkMetrikaConversionRetry(ctx, sqlc.MarkMetrikaConversionRetryParams{ID: c.ID, NextAt: next, Error: errText(err)})
		})
	}
}

// RetryDelay is the wait after the attempt-th failed send (1-based).
func RetryDelay(attempt int) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	if attempt > len(retryDelay) {
		attempt = len(retryDelay)
	}
	return retryDelay[attempt-1]
}

func errText(err error) string {
	t := err.Error()
	if len(t) > 300 {
		t = t[:300]
	}
	return t
}

// send posts the conversion's hits as one batch: tid and ms in the query string (shared by
// every line), one hit per body line.
func (s *Service) send(ctx context.Context, c sqlc.MetrikaConversion) error {
	lines := Hits(c, s.cfg.PageURL, s.now())
	body := make([]string, len(lines))
	for i, l := range lines {
		body[i] = l.Encode()
	}
	q := url.Values{"tid": {strconv.FormatInt(s.cfg.CounterID, 10)}, "ms": {s.cfg.Token}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.cfg.Endpoint+"?"+q.Encode(), strings.NewReader(strings.Join(body, "\n")))
	if err != nil {
		return errors.New("metrika: bad endpoint") // never echo the URL: it carries the token
	}
	req.Header.Set("Content-Type", "text/plain; charset=utf-8")
	resp, err := s.http.Do(req)
	if err != nil {
		var ue *url.Error
		if errors.As(err, &ue) {
			err = ue.Err // the URL carries the token
		}
		return fmt.Errorf("metrika: send: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	text, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	msg := strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(strings.TrimSpace(string(text)), "<!--"), "-->"))
	switch resp.StatusCode {
	case http.StatusOK:
		return nil
	case http.StatusBadRequest:
		return fmt.Errorf("%w: %s", errRejected, msg)
	default:
		return fmt.Errorf("metrika: HTTP %d: %s", resp.StatusCode, msg)
	}
}

// Hits builds the Measurement Protocol lines of a conversion (without tid / ms): a pageview
// that opens a visit for the client id (an event Metrika cannot attach to a visit is dropped),
// the goal (with its value for a purchase), and for a purchase the ecommerce transaction.
func Hits(c sqlc.MetrikaConversion, pageURL string, now time.Time) []url.Values {
	base := func(t string) url.Values {
		v := url.Values{"cid": {c.ClientID}, "t": {t}}
		if pageURL != "" {
			v.Set("dl", pageURL)
		}
		if age := now.Sub(c.OccurredAt); age >= 0 && age < eventWindow {
			v.Set("et", strconv.FormatInt(c.OccurredAt.Unix(), 10))
		}
		return v
	}
	view := base("pageview")
	view.Set("dt", "Calab")
	goal := base("event")
	goal.Set("ea", c.Goal)
	if c.Goal != GoalPurchase {
		return []url.Values{view, goal}
	}
	amount := major(c.AmountMinor)
	goal.Set("ev", amount)
	goal.Set("cu", c.Currency)
	ecom := base("event")
	ecom.Set("pa", "purchase")
	ecom.Set("ti", c.TransactionID)
	ecom.Set("tr", amount)
	ecom.Set("cu", c.Currency)
	ecom.Set("pr1id", c.Plan)
	ecom.Set("pr1nm", planName(c.Plan))
	ecom.Set("pr1pr", amount)
	ecom.Set("pr1qt", "1")
	return []url.Values{view, goal, ecom}
}

func planName(plan string) string {
	switch plan {
	case "team":
		return "Team"
	case "enterprise":
		return "Business"
	case "":
		return "Plan"
	}
	return plan
}

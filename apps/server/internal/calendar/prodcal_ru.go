package calendar

import (
	"context"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/billing/provider"
	"github.com/calaba/calaba/server/internal/mail"
	"github.com/calaba/calaba/server/internal/prodcal"
)

// The Russian production calendar lives in internal/prodcal (shared with the telephony
// schedule, ADR-0138); these are the calendar's names for it.

// HolidaysRU is the holiday calendar id of the Russian production calendar.
const HolidaysRU = prodcal.RU

// prodRUFirst, prodRULast: the years the table covers.
var prodRUFirst, prodRULast = prodcal.FirstYear, prodcal.LastYear

// isWorkday reports whether the civil date y-m-d is a working day of calendar cal ("" = Mon–Fri).
func isWorkday(cal string, y int, m time.Month, d int) bool { return prodcal.IsWorkday(cal, y, m, d) }

// prodRUChanges: the dates of [from, to] that differ from Mon–Fri (prodcal.ChangesRU).
func prodRUChanges(from, to time.Time) (off, working []time.Time) { return prodcal.ChangesRU(from, to) }

// holidaysFor decides the holiday calendar of a new working-days series of a workspace
// (ADR-0136): the market of its live billing account when it has one (RU market = paid in
// roubles through the Russian acquirer), otherwise its owner's language.
func holidaysFor(market, ownerLocale string) string {
	switch market {
	case provider.MarketRU:
		return HolidaysRU
	case "":
		if mail.Locale(ownerLocale) == mail.LocaleRU {
			return HolidaysRU
		}
	}
	return ""
}

// holidayCalendar is holidaysFor of workspace ws.
func (s *Service) holidayCalendar(ctx context.Context, ws uuid.UUID) (string, error) {
	sig, err := s.db.Q.WorkspaceHolidaySignal(ctx, ws)
	if err != nil {
		return "", err
	}
	return holidaysFor(sig.Market, sig.OwnerLocale), nil
}

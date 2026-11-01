/*
 * The working-hours schedule of the inbound entry point (ADR-0138) on the client: minutes ↔ the
 * «9:00» text of a time field, the server's interval rules checked before a save (the same as
 * internal/sip/schedule.go CheckIntervals — the server checks again) and the one-line summary of
 * the settings list («Пн–Пт 9:00–18:00 · РФ календарь → Гром»). Pure: no i18n, the caller passes
 * the words.
 */

export interface Hours {
  /** 1 = Monday … 7 = Sunday (sip.proto SipScheduleInterval). */
  weekday: number;
  /** 0..1439 minutes after midnight. */
  start: number;
  /** 1..1440 (1440 = midnight); less than start = the next day (a night shift). */
  end: number;
}

export const MINUTES_PER_DAY = 1440;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;
/** At most this many intervals start on one weekday (ADR-0138 §2). */
export const MAX_PER_DAY = 6;
export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

/** «9:00», «18:30», «24:00» (1440). */
export function fmtMinutes(m: number): string {
  const h = Math.floor(m / 60);
  return `${h}:${String(m % 60).padStart(2, '0')}`;
}

/** The value of `<input type="time">` («09:00»); 1440 is midnight — «00:00». */
export function timeValue(m: number): string {
  const v = m % MINUTES_PER_DAY;
  return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
}

/** «HH:MM» → minutes, null when empty or not a time. */
export function parseTime(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

/** The end of an interval from its field: «00:00» is midnight (1440), so 0:00–0:00 is the whole day. */
export const endOf = (m: number): number => (m === 0 ? MINUTES_PER_DAY : m);

/** The interval runs into the next day (22:00–02:00). */
export const crossesMidnight = (h: Hours): boolean => h.end < h.start;

export type HoursProblem = { weekday: number; kind: 'range' | 'tooMany' | 'overlap' } | null;

/**
 * The first problem of a week of hours, by the server's rules: minutes in range and not empty,
 * ≤ 6 intervals starting on a weekday, no overlap — a night shift counts into the next day,
 * Sunday's into Monday. `weekday` is where it shows: the day of the later of two overlapping
 * intervals.
 */
export function hoursProblem(hours: readonly Hours[]): HoursProblem {
  const per = new Map<number, number>();
  const spans: Array<{ from: number; to: number; weekday: number }> = [];
  for (const h of hours) {
    if (h.weekday < 1 || h.weekday > 7 || h.start < 0 || h.start >= MINUTES_PER_DAY || h.end < 1 || h.end > MINUTES_PER_DAY || h.start === h.end) return { weekday: h.weekday, kind: 'range' };
    const n = (per.get(h.weekday) ?? 0) + 1;
    per.set(h.weekday, n);
    if (n > MAX_PER_DAY) return { weekday: h.weekday, kind: 'tooMany' };
    const day = h.weekday - 1;
    const from = day * MINUTES_PER_DAY + h.start;
    let to = day * MINUTES_PER_DAY + h.end;
    if (crossesMidnight(h)) to += MINUTES_PER_DAY;
    if (to > MINUTES_PER_WEEK) {
      spans.push({ from: 0, to: to - MINUTES_PER_WEEK, weekday: h.weekday });
      to = MINUTES_PER_WEEK;
    }
    spans.push({ from, to, weekday: h.weekday });
  }
  spans.sort((a, b) => a.from - b.from);
  for (let i = 1; i < spans.length; i++) {
    const cur = spans[i];
    const prev = spans[i - 1];
    if (cur && prev && cur.from < prev.to) return { weekday: cur.weekday, kind: 'overlap' };
  }
  return null;
}

/** The intervals of a weekday, by their start. */
export const dayHours = (hours: readonly Hours[], weekday: number): Hours[] => hours.filter((h) => h.weekday === weekday).sort((a, b) => a.start - b.start);

/** «9:00–18:00, 19:00–22:00» of one day. */
const daySpans = (hours: readonly Hours[], weekday: number): string =>
  dayHours(hours, weekday)
    .map((h) => `${fmtMinutes(h.start)}–${fmtMinutes(h.end)}`)
    .join(', ');

/**
 * The week in a line: runs of days with the same hours — «Пн–Пт 9:00–18:00; Сб 10:00–16:00».
 * `days` are the short weekday names, Monday first. Days without hours are left out.
 */
export function weekSummary(hours: readonly Hours[], days: readonly string[]): string {
  const parts: string[] = [];
  let i = 0;
  while (i < 7) {
    const spans = daySpans(hours, i + 1);
    if (!spans) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < 7 && daySpans(hours, j + 2) === spans) j++;
    const name = j === i ? days[i] : j === i + 1 ? `${days[i]}, ${days[j]}` : `${days[i]}–${days[j]}`;
    parts.push(`${name} ${spans}`);
    i = j + 1;
  }
  return parts.join('; ');
}

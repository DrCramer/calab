/**
 * Member time zones (User.timezone, IANA): «+3 UTC» as a tiny tag after a name when that person's offset
 * from UTC differs from mine (Discord style). Pure, unit-tested; offsets are taken for the given
 * moment, so daylight saving time is right on both sides.
 */
import { t } from '../i18n';

/** This device's IANA zone ('' when the runtime can't tell). */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
}

/** Offset of `tz` from UTC at `at`, in minutes (east positive); null for an unknown zone. */
export function utcOffsetMinutes(tz: string, at: Date): number | null {
  if (!tz) return null;
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName')?.value;
    if (!part) return null;
    if (part === 'GMT') return 0;
    const m = /^GMT([+-−])(\d{1,2})(?::(\d{2}))?$/.exec(part);
    if (!m) return null;
    const sign = m[1] === '+' ? 1 : -1;
    return sign * (Number(m[2]) * 60 + Number(m[3] ?? 0));
  } catch {
    return null;
  }
}

/** «+3 UTC», «−3:30 UTC», «UTC» — the true minus sign, minutes only when not whole hours. */
export function formatUtcOffset(minutes: number): string {
  if (minutes === 0) return 'UTC';
  const sign = minutes > 0 ? '+' : '−';
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `${sign}${h}${m ? `:${String(m).padStart(2, '0')}` : ''} UTC`;
}

/**
 * The label after a member's name, or null: their zone is unset / unknown, or its offset right
 * now equals mine (then the time is the same, no point in saying it).
 */
export function timeZoneLabel(theirs: string, mine: string, at: Date = new Date()): string | null {
  const t = utcOffsetMinutes(theirs, at);
  if (t === null) return null;
  const m = utcOffsetMinutes(mine, at);
  if (m !== null && m === t) return null;
  return formatUtcOffset(t);
}

/**
 * The zone as the profile's local-time line shows it (docs/09 #48): «UTC+3», «UTC−5:30», «UTC»
 * (no «+0») — the true minus sign, minutes only when not whole hours.
 */
export function formatUtcZone(minutes: number): string {
  if (minutes === 0) return 'UTC';
  const sign = minutes > 0 ? '+' : '−';
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
}

/** Their offset minus mine at `at`, in minutes (positive: they are ahead); null when either is unknown. */
export function zoneDiffMinutes(theirs: string, mine: string, at: Date): number | null {
  const t = utcOffsetMinutes(theirs, at);
  const m = utcOffsetMinutes(mine, at);
  return t === null || m === null ? null : t - m;
}

/** A member's local clock: their zone right now, their wall time, and how far they are from me. */
export type LocalClock = {
  /** «UTC+3». */
  zone: string;
  /** Their wall time, «14:05» (locale format). */
  time: string;
  /** Minutes they are ahead of me (negative: behind); 0 / null → no hint. */
  diff: number | null;
};

/** «на 2 ч впереди», «на 30 мин позади», «на 5 ч 30 мин впереди»; null when the offset is the same. */
export function zoneDiffHint(diff: number | null): string | null {
  if (!diff) return null;
  const abs = Math.abs(diff);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  const span = h && m ? t('people.tz.hoursMinutes', { h, m }) : h ? t('people.tz.hours', { h }) : t('people.tz.minutes', { m });
  return t(diff > 0 ? 'people.tz.ahead' : 'people.tz.behind', { diff: span });
}

/** The clock for `theirs` at `at`, or null when the zone is unset / unknown (no line then). */
export function localClock(theirs: string, mine: string, at: Date, formatTime: (d: Date, tz: string) => string): LocalClock | null {
  const off = utcOffsetMinutes(theirs, at);
  if (off === null) return null;
  return { zone: formatUtcZone(off), time: formatTime(at, theirs), diff: zoneDiffMinutes(theirs, mine, at) };
}

const hourLabel = (min: number): string => {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return m ? `${h}:${String(m).padStart(2, '0')}` : String(h);
};

/** «10–19», «9:30–18» — working hours as minutes from their local midnight (24:00 reads as 0). */
export function formatWorkRange(startMin: number, endMin: number): string {
  return `${hourLabel(startMin)}–${hourLabel(endMin)}`;
}

/** «Пн–Пт», «Пн, Ср, Пт» — ISO weekdays (1 = Monday) by Intl; runs of 3+ days collapse to «Пн–Пт». */
export function formatWorkDays(days: readonly number[], locale: string): string {
  const sorted = [...new Set(days)].filter((d) => d >= 1 && d <= 7).sort((a, b) => a - b);
  if (!sorted.length) return '';
  let name: (d: number) => string;
  try {
    const f = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
    // 2024-01-01 was a Monday.
    name = (d) => f.format(new Date(Date.UTC(2024, 0, d)));
  } catch {
    name = (d) => String(d);
  }
  const out: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === (sorted[j] ?? 0) + 1) j++;
    const a = sorted[i] ?? 1;
    const b = sorted[j] ?? a;
    if (j - i >= 2) out.push(`${name(a)}–${name(b)}`);
    else for (let k = i; k <= j; k++) out.push(name(sorted[k] ?? 1));
    i = j + 1;
  }
  return out.join(', ');
}

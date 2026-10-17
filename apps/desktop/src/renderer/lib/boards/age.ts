import type { MessageKey } from '../../i18n';

/** No activity for this long: the list row's «updated» slot turns to the warning tone. */
export const STALE_DAYS = 14;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** The short age of a timestamp as an i18n key + number: «2 ч», «5 дн», «3 нед» (pure; `now` injected). */
export function ageOf(at: number, now: number): { key: MessageKey; n: number } | null {
  if (!at) return null;
  const d = Math.max(0, now - at);
  if (d < MIN) return { key: 'boards.age.now', n: 0 };
  if (d < HOUR) return { key: 'boards.age.min', n: Math.floor(d / MIN) };
  if (d < DAY) return { key: 'boards.age.hour', n: Math.floor(d / HOUR) };
  if (d < 7 * DAY) return { key: 'boards.age.day', n: Math.floor(d / DAY) };
  if (d < 30 * DAY) return { key: 'boards.age.week', n: Math.floor(d / (7 * DAY)) };
  if (d < 365 * DAY) return { key: 'boards.age.month', n: Math.floor(d / (30 * DAY)) };
  return { key: 'boards.age.year', n: Math.floor(d / (365 * DAY)) };
}

/** Quiet for {@link STALE_DAYS} days or more. */
export const isStale = (at: number, now: number): boolean => at > 0 && now - at >= STALE_DAYS * DAY;

import { t } from '../../i18n';
import { fmt } from '../format';

/** Two stamps closer than this read as one moment: «обновлено» is left out right after creation. */
const SAME_MOMENT_MS = 60_000;

const sameDay = (a: Date, b: Date): boolean => a.toDateString() === b.toDateString();

function isYesterday(d: Date, now: Date): boolean {
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  return sameDay(d, y);
}

/**
 * A moment in the tracker's style (#90): «сегодня в 13:40», «вчера в 13:40», else «23 сент., 15:30»
 * (the year is added when it is not this one). The viewer's time zone — `Date` and Intl use it.
 */
export function trackerStamp(d: Date, now: Date = new Date()): string {
  if (sameDay(d, now)) return t('date.todayAt', { time: fmt.time(d) });
  if (isYesterday(d, now)) return t('date.yesterdayAt', { time: fmt.time(d) });
  return fmt.dateTime(d, 'short', now);
}

/**
 * The grey line under a task's title: «Создано 13 окт., 10:54 · обновлено вчера в 13:40»; only
 * «Создано …» while the task has not been touched since (Task.updated_at follows the history).
 */
export function taskDatesLine(createdMs: number, updatedMs: number, now: Date = new Date()): string {
  const created = t('boards.dates.created', { when: trackerStamp(new Date(createdMs), now) });
  if (!updatedMs || updatedMs - createdMs < SAME_MOMENT_MS) return created;
  return `${created} · ${t('boards.dates.updated', { when: trackerStamp(new Date(updatedMs), now) })}`;
}

/** The hover text: both moments in full (weekday, date, time). */
export function taskDatesFull(createdMs: number, updatedMs: number): string[] {
  const out = [t('boards.dates.created', { when: fmt.full(new Date(createdMs)) })];
  if (updatedMs && updatedMs - createdMs >= SAME_MOMENT_MS) out.push(t('boards.dates.updated', { when: fmt.full(new Date(updatedMs)) }));
  return out;
}

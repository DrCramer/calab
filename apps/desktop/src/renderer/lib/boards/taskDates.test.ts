import { describe, expect, it } from 'vitest';
import { t } from '../../i18n';
import { fmt } from '../format';
import { taskDatesFull, taskDatesLine, trackerStamp } from './taskDates';

// Local-time dates: the formatting is in the viewer's zone by design.
const now = new Date(2026, 9, 27, 15, 0);
const at = (y: number, mo: number, d: number, h: number, mi: number): Date => new Date(y, mo, d, h, mi);

describe('trackerStamp', () => {
  it('says today and yesterday with the time', () => {
    const today = at(2026, 9, 27, 13, 40);
    const yesterday = at(2026, 9, 26, 13, 40);
    expect(trackerStamp(today, now)).toBe(t('date.todayAt', { time: fmt.time(today) }));
    expect(trackerStamp(yesterday, now)).toBe(t('date.yesterdayAt', { time: fmt.time(yesterday) }));
  });
  it('gives the date and time earlier, with the year only when it is not this one', () => {
    const same = trackerStamp(at(2026, 8, 23, 15, 30), now);
    expect(same).toMatch(/23/);
    expect(same).not.toMatch(/2026/);
    expect(trackerStamp(at(2025, 8, 23, 15, 30), now)).toMatch(/2025/);
  });
  it('calls a moment just after midnight yesterday, not today', () => {
    const late = new Date(2026, 9, 27, 0, 30);
    expect(trackerStamp(new Date(2026, 9, 26, 23, 59), late)).toBe(t('date.yesterdayAt', { time: fmt.time(new Date(2026, 9, 26, 23, 59)) }));
  });
});

describe('taskDatesLine', () => {
  const created = at(2026, 9, 13, 10, 54).getTime();
  it('shows both moments', () => {
    const updated = at(2026, 9, 26, 13, 40).getTime();
    const line = taskDatesLine(created, updated, now);
    expect(line).toContain(t('boards.dates.created', { when: trackerStamp(new Date(created), now) }));
    expect(line).toContain(` · ${t('boards.dates.updated', { when: trackerStamp(new Date(updated), now) })}`);
  });
  it('leaves «updated» out for a task not touched since creation', () => {
    expect(taskDatesLine(created, created + 20_000, now)).not.toContain(' · ');
    expect(taskDatesLine(created, 0, now)).not.toContain(' · ');
  });
  it('has the full dates for the hover', () => {
    expect(taskDatesFull(created, created + 20_000)).toHaveLength(1);
    expect(taskDatesFull(created, at(2026, 9, 26, 13, 40).getTime())).toHaveLength(2);
  });
});

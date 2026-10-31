import { describe, expect, it } from 'vitest';
import { formatUtcOffset, formatUtcZone, formatWorkDays, formatWorkRange, localClock, timeZoneLabel, utcOffsetMinutes, zoneDiffHint, zoneDiffMinutes } from './timezone';

const JAN = new Date('2026-01-15T12:00:00Z');
const JUL = new Date('2026-07-15T12:00:00Z');

describe('utcOffsetMinutes', () => {
  it('reads IANA offsets, DST included', () => {
    expect(utcOffsetMinutes('Europe/Moscow', JAN)).toBe(180);
    expect(utcOffsetMinutes('Asia/Kolkata', JAN)).toBe(330);
    expect(utcOffsetMinutes('America/St_Johns', JAN)).toBe(-210);
    expect(utcOffsetMinutes('Europe/Berlin', JAN)).toBe(60);
    expect(utcOffsetMinutes('Europe/Berlin', JUL)).toBe(120);
    expect(utcOffsetMinutes('UTC', JAN)).toBe(0);
  });
  it('unknown or empty zone → null', () => {
    expect(utcOffsetMinutes('', JAN)).toBeNull();
    expect(utcOffsetMinutes('Mars/Olympus', JAN)).toBeNull();
  });
});

describe('formatUtcOffset', () => {
  it('+H UTC, −H:MM UTC, UTC', () => {
    expect(formatUtcOffset(180)).toBe('+3 UTC');
    expect(formatUtcOffset(330)).toBe('+5:30 UTC');
    expect(formatUtcOffset(-210)).toBe('−3:30 UTC');
    expect(formatUtcOffset(-300)).toBe('−5 UTC');
    expect(formatUtcOffset(0)).toBe('UTC');
  });
});

describe('timeZoneLabel', () => {
  it('only when their offset differs from mine right now', () => {
    expect(timeZoneLabel('Asia/Yekaterinburg', 'Europe/Moscow', JAN)).toBe('+5 UTC');
    expect(timeZoneLabel('Europe/Moscow', 'Europe/Moscow', JAN)).toBeNull();
    // Different names, same offset at that moment → nothing to say.
    expect(timeZoneLabel('Europe/Istanbul', 'Europe/Moscow', JAN)).toBeNull();
    // Berlin vs London: +1 vs 0 in winter and +2 vs +1 in summer — always shown.
    expect(timeZoneLabel('Europe/Berlin', 'Europe/London', JUL)).toBe('+2 UTC');
  });
  it('unset / unknown zone → nothing; my zone unknown → still shown', () => {
    expect(timeZoneLabel('', 'Europe/Moscow', JAN)).toBeNull();
    expect(timeZoneLabel('Mars/Olympus', 'Europe/Moscow', JAN)).toBeNull();
    expect(timeZoneLabel('Asia/Tokyo', '', JAN)).toBe('+9 UTC');
  });
});

describe('formatUtcZone (local time line, docs/09 #48)', () => {
  it('UTC+3, UTC−5:30, UTC for zero', () => {
    expect(formatUtcZone(180)).toBe('UTC+3');
    expect(formatUtcZone(-330)).toBe('UTC−5:30');
    expect(formatUtcZone(345)).toBe('UTC+5:45');
    expect(formatUtcZone(-300)).toBe('UTC−5');
    expect(formatUtcZone(0)).toBe('UTC');
  });
});

describe('zone difference', () => {
  it('their offset minus mine, DST on the day', () => {
    expect(zoneDiffMinutes('Asia/Yekaterinburg', 'Europe/Moscow', JAN)).toBe(120);
    expect(zoneDiffMinutes('Europe/London', 'Europe/Moscow', JAN)).toBe(-180);
    expect(zoneDiffMinutes('Europe/London', 'Europe/Moscow', JUL)).toBe(-120);
    expect(zoneDiffMinutes('Asia/Kolkata', 'Europe/Moscow', JAN)).toBe(150);
    expect(zoneDiffMinutes('Europe/Istanbul', 'Europe/Moscow', JAN)).toBe(0);
    expect(zoneDiffMinutes('Asia/Tokyo', '', JAN)).toBeNull();
  });
  it('hint: ahead / behind, hours and minutes, nothing when equal', () => {
    expect(zoneDiffHint(120)).toBe('на 2 ч впереди');
    expect(zoneDiffHint(-180)).toBe('на 3 ч позади');
    expect(zoneDiffHint(150)).toBe('на 2 ч 30 мин впереди');
    expect(zoneDiffHint(-30)).toBe('на 30 мин позади');
    expect(zoneDiffHint(0)).toBeNull();
    expect(zoneDiffHint(null)).toBeNull();
  });
  it('localClock: zone, their wall time, diff; unknown zone → null', () => {
    const at = new Date('2026-01-15T11:05:00Z');
    const time = (d: Date, tz: string): string => new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit', timeZone: tz }).format(d);
    expect(localClock('Europe/Moscow', 'Asia/Yekaterinburg', at, time)).toEqual({ zone: 'UTC+3', time: '14:05', diff: -120 });
    expect(localClock('UTC', '', at, time)).toEqual({ zone: 'UTC', time: '11:05', diff: null });
    expect(localClock('', 'Europe/Moscow', at, time)).toBeNull();
    expect(localClock('Mars/Olympus', 'Europe/Moscow', at, time)).toBeNull();
  });
});

describe('working hours labels', () => {
  it('formats the range and the days', () => {
    expect(formatWorkRange(600, 1140)).toBe('10–19');
    expect(formatWorkRange(570, 1080)).toBe('9:30–18');
    expect(formatWorkDays([1, 2, 3, 4, 5], 'en')).toBe('Mon–Fri');
    expect(formatWorkDays([5, 1, 3], 'en')).toBe('Mon, Wed, Fri');
    expect(formatWorkDays([6, 7], 'en')).toBe('Sat, Sun');
    expect(formatWorkDays([], 'en')).toBe('');
  });
});

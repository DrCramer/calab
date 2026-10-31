import { describe, expect, it } from 'vitest';
import { endOf, fmtMinutes, hoursProblem, parseTime, timeValue, weekSummary, type Hours } from './hours';

const DAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const nineToSix = (days: number[]): Hours[] => days.map((weekday) => ({ weekday, start: 540, end: 1080 }));

describe('schedule times', () => {
  it('formats and parses minutes', () => {
    expect(fmtMinutes(540)).toBe('9:00');
    expect(fmtMinutes(1440)).toBe('24:00');
    expect(timeValue(1440)).toBe('00:00');
    expect(timeValue(570)).toBe('09:30');
    expect(parseTime('09:30')).toBe(570);
    expect(parseTime('24:00')).toBeNull();
    expect(parseTime('')).toBeNull();
    expect(endOf(0)).toBe(1440);
    expect(endOf(120)).toBe(120);
  });
});

describe('hoursProblem (the server rules of ADR-0138 §2)', () => {
  it('accepts a working week, a split day and a night shift', () => {
    expect(hoursProblem(nineToSix([1, 2, 3, 4, 5]))).toBeNull();
    expect(hoursProblem([{ weekday: 1, start: 540, end: 780 }, { weekday: 1, start: 840, end: 1080 }])).toBeNull();
    expect(hoursProblem([{ weekday: 5, start: 1320, end: 120 }, { weekday: 6, start: 540, end: 1080 }])).toBeNull();
  });

  it('finds an overlap inside a day', () => {
    expect(hoursProblem([{ weekday: 2, start: 540, end: 780 }, { weekday: 2, start: 720, end: 1080 }])).toEqual({ weekday: 2, kind: 'overlap' });
  });

  it('counts a night shift into the next day, Sunday into Monday', () => {
    expect(hoursProblem([{ weekday: 1, start: 1320, end: 600 }, { weekday: 2, start: 540, end: 1080 }])).toEqual({ weekday: 2, kind: 'overlap' });
    expect(hoursProblem([{ weekday: 7, start: 1320, end: 600 }, { weekday: 1, start: 540, end: 1080 }])?.kind).toBe('overlap');
    expect(hoursProblem([{ weekday: 7, start: 1320, end: 300 }, { weekday: 1, start: 540, end: 1080 }])).toBeNull();
  });

  it('refuses an empty interval and a seventh one a day', () => {
    expect(hoursProblem([{ weekday: 3, start: 600, end: 600 }])).toEqual({ weekday: 3, kind: 'range' });
    const many = Array.from({ length: 7 }, (_, i): Hours => ({ weekday: 4, start: i * 60, end: i * 60 + 30 }));
    expect(hoursProblem(many)).toEqual({ weekday: 4, kind: 'tooMany' });
  });
});

describe('weekSummary', () => {
  it('folds runs of equal days', () => {
    expect(weekSummary(nineToSix([1, 2, 3, 4, 5]), DAYS)).toBe('Пн–Пт 9:00–18:00');
    expect(weekSummary([...nineToSix([1, 2, 3, 4, 5]), { weekday: 6, start: 600, end: 960 }], DAYS)).toBe('Пн–Пт 9:00–18:00; Сб 10:00–16:00');
    expect(weekSummary(nineToSix([1, 2, 4]), DAYS)).toBe('Пн, Вт 9:00–18:00; Чт 9:00–18:00');
  });

  it('lists a split day and a night shift as they are', () => {
    expect(weekSummary([{ weekday: 1, start: 840, end: 1080 }, { weekday: 1, start: 540, end: 780 }, { weekday: 7, start: 1320, end: 120 }], DAYS)).toBe('Пн 9:00–13:00, 14:00–18:00; Вс 22:00–2:00');
    expect(weekSummary([], DAYS)).toBe('');
  });
});

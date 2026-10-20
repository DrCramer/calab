import { describe, expect, it } from 'vitest';
import { isoWeek, shortWeekday, utcOffsetLabel, weekDays } from './time';

// Weekday headers (owner, 30.09; docs/09 #140): two letters in Russian, the locale's short form elsewhere.
const week = (locale: string): string[] => {
  const f = new Intl.DateTimeFormat(locale, { weekday: 'short' });
  return Array.from({ length: 7 }, (_, i) => shortWeekday(f.format(new Date(2026, 0, 5 + i))));
};

describe('shortWeekday', () => {
  it('ru: «Пн … Вс»', () => {
    expect(week('ru')).toEqual(['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']);
  });

  it('en / es / zh-CN: short, capitalised, no trailing dot', () => {
    expect(week('en')[0]).toBe('Mon');
    expect(week('es')[0]).toBe('Lun');
    expect(week('zh-CN')[0]).toBe('周一');
    expect(shortWeekday('lun.')).toBe('Lun');
  });
});

describe('week view helpers', () => {
  it('weekDays: Monday-first and Sunday-first weeks', () => {
    expect(weekDays('2026-10-21', 1)).toEqual(['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25']);
    expect(weekDays('2026-10-19', 1)[0]).toBe('2026-10-19');
    expect(weekDays('2026-10-25', 1)[0]).toBe('2026-10-19');
    expect(weekDays('2026-10-21', 0)[0]).toBe('2026-10-18');
    // across a month and a year
    expect(weekDays('2027-01-01', 1)).toEqual(['2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03']);
  });

  it('isoWeek: ISO 8601 numbers, year edges included', () => {
    expect(isoWeek('2026-10-19')).toBe(43);
    expect(isoWeek('2026-10-25')).toBe(43);
    expect(isoWeek('2026-01-01')).toBe(1);
    expect(isoWeek('2027-01-01')).toBe(53);
    expect(isoWeek('2024-12-30')).toBe(1);
    expect(isoWeek('2021-01-03')).toBe(53);
  });

  it('utcOffsetLabel: the device zone at an instant', () => {
    const at = Date.UTC(2026, 9, 19, 12);
    const off = -new Date(at).getTimezoneOffset();
    const label = utcOffsetLabel(at);
    if (off === 0) expect(label).toBe('UTC');
    else expect(label).toMatch(off > 0 ? /^UTC\+\d{1,2}(:\d\d)?$/ : /^UTC−\d{1,2}(:\d\d)?$/);
  });
});

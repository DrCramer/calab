import { describe, expect, it } from 'vitest';
import { moveUp, parseZonesSig, zoneCity, zoneOffsetLabel, zoneOffsetShort, zoneOptions, zoneRows, zonesSig, zoneTitle } from './zones';

const H = 3_600_000;
/** The 24 hour lines of a Moscow day (UTC+3, no DST): midnight is 21:00 UTC of the day before. */
const moscowDay = (y: number, m: number, d: number): number[] => Array.from({ length: 24 }, (_, h) => Date.UTC(y, m - 1, d, h) - 3 * H);

describe('calendar extra zones (board #85)', () => {
  it('keeps the list as a primitive and back', () => {
    const z = [
      { zone: 'Asia/Kolkata', label: 'Дели' },
      { zone: 'America/New_York', label: '' },
    ];
    expect(parseZonesSig(zonesSig(z))).toEqual(z);
    expect(zonesSig(undefined)).toBe('');
    expect(parseZonesSig('')).toEqual([]);
  });

  it('names a zone by its city unless labelled', () => {
    expect(zoneCity('America/Argentina/Buenos_Aires')).toBe('Buenos Aires');
    expect(zoneCity('UTC')).toBe('UTC');
    expect(zoneTitle({ zone: 'Asia/Kolkata', label: '' })).toBe('Kolkata');
    expect(zoneTitle({ zone: 'Asia/Kolkata', label: ' Дели ' })).toBe('Дели');
  });

  it('offsets come from the zone database, DST included', () => {
    const winter = Date.UTC(2026, 0, 15, 12);
    const summer = Date.UTC(2026, 6, 15, 12);
    expect(zoneOffsetLabel('Asia/Kolkata', winter)).toBe('UTC+5:30');
    expect(zoneOffsetLabel('America/New_York', winter)).toBe('UTC−5');
    expect(zoneOffsetLabel('America/New_York', summer)).toBe('UTC−4');
    expect(zoneOffsetLabel('UTC', summer)).toBe('UTC');
    expect(zoneOffsetShort('Asia/Kathmandu', summer)).toBe('+5:45');
    expect(zoneOffsetShort('UTC', summer)).toBe('±0');
    expect(zoneOffsetLabel('Mars/Base', summer)).toBe('');
  });

  it('a half-hour zone ahead: rows at :30, the next day from its midnight', () => {
    // Moscow 2026-10-28: Kolkata is 2:30 ahead, its midnight is at Moscow 21:30.
    const rows = zoneRows(moscowDay(2026, 10, 28), 'Asia/Kolkata', 'ru', 'Europe/Moscow');
    expect(rows).toHaveLength(23);
    expect(rows[0]).toMatchObject({ hour: 1, time: '03:30', newDay: null, shift: 0 });
    expect(rows[20]).toMatchObject({ hour: 21, time: '23:30', newDay: null });
    expect(rows[21]).toMatchObject({ hour: 22, time: '00:30', newDay: '2026-10-29', shift: 1 });
    expect(rows[22]).toMatchObject({ hour: 23, time: '01:30', newDay: null });
  });

  it('a zone behind: the previous day until its midnight', () => {
    // Moscow 2026-10-28 00:00 = New York 2026-10-27 17:00 (EDT, UTC−4).
    const rows = zoneRows(moscowDay(2026, 10, 28), 'America/New_York', 'ru', 'Europe/Moscow');
    expect(rows[0]).toMatchObject({ time: '18:00', newDay: '2026-10-27', shift: -1 });
    expect(rows[1]).toMatchObject({ newDay: null, shift: -1 });
    expect(rows[6]).toMatchObject({ hour: 7, time: '00:00', newDay: '2026-10-28', shift: 0 });
  });

  it('a DST change inside the day: the column follows the zone', () => {
    // New York leaves DST on 2026-11-01 at 02:00 EDT (06:00 UTC = Moscow 09:00).
    const rows = zoneRows(moscowDay(2026, 11, 1), 'America/New_York', 'ru', 'Europe/Moscow');
    expect(rows.find((r) => r.hour === 8)?.time).toBe('01:00'); // EDT
    expect(rows.find((r) => r.hour === 9)?.time).toBe('01:00'); // EST: the hour repeats
    expect(rows.find((r) => r.hour === 10)?.time).toBe('02:00');
  });

  it('lists the zones with the search fields, by offset', () => {
    const list = zoneOptions('en', Date.UTC(2026, 0, 15));
    const kolkata = list.find((z) => z.id === 'Asia/Kolkata');
    expect(kolkata?.offsetLabel).toBe('UTC+5:30');
    expect(kolkata?.search).toContain('Kolkata');
    expect(list.some((z) => z.id === 'UTC')).toBe(true);
    for (let i = 1; i < list.length; i++) expect((list[i]?.offset ?? 0) >= (list[i - 1]?.offset ?? 0)).toBe(true);
  });

  it('moves a zone up', () => {
    expect(moveUp(['a', 'b'], 1)).toEqual(['b', 'a']);
    expect(moveUp(['a', 'b'], 0)).toEqual(['a', 'b']);
  });
});

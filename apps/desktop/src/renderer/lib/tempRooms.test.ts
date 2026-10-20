import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { describe, expect, it } from 'vitest';
import {
  EXPIRING_MS,
  MAX_TTL_S,
  endOfDay,
  expiresMs,
  extendTo,
  formatRemaining,
  fromLocalInput,
  isExpiring,
  isTempRoom,
  presetTtl,
  remainingParts,
  sortTempRooms,
  toLocalInput,
  validEnd,
} from './tempRooms';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ru = { d: (n: number) => `${n} д`, h: (n: number) => `${n} ч`, m: (n: number) => `${n} м` };

describe('formatRemaining', () => {
  it('hours and minutes: «1 ч 20 м»; a whole hour drops the minutes', () => {
    expect(formatRemaining(HOUR + 20 * MIN, ru)).toBe('1 ч 20 м');
    expect(formatRemaining(3 * HOUR, ru)).toBe('3 ч');
  });

  it('under an hour: minutes only, rounded up (a live room never shows 0)', () => {
    expect(formatRemaining(9 * MIN + 1_000, ru)).toBe('10 м');
    expect(formatRemaining(9 * MIN, ru)).toBe('9 м');
    expect(formatRemaining(10_000, ru)).toBe('1 м');
    expect(formatRemaining(0, ru)).toBe('1 м');
  });

  it('days: «2 д 3 ч», at most two units', () => {
    expect(formatRemaining(2 * DAY + 3 * HOUR + 15 * MIN, ru)).toBe('2 д 3 ч');
    expect(formatRemaining(7 * DAY, ru)).toBe('7 д');
  });

  it('parts', () => {
    expect(remainingParts(DAY + HOUR + MIN)).toEqual({ d: 1, h: 1, m: 1 });
    expect(remainingParts(-5)).toEqual({ d: 0, h: 0, m: 0 });
  });

  it('attention under 10 minutes', () => {
    expect(isExpiring(EXPIRING_MS - 1)).toBe(true);
    expect(isExpiring(EXPIRING_MS)).toBe(false);
  });
});

describe('lifetime presets', () => {
  const now = new Date(2026, 0, 15, 13, 30).getTime();

  it('fixed presets', () => {
    expect(presetTtl('1h', now)).toBe(3600);
    expect(presetTtl('3h', now)).toBe(3 * 3600);
    expect(presetTtl('1d', now)).toBe(86400);
    expect(presetTtl('3d', now)).toBe(3 * 86400);
    expect(presetTtl('7d', now)).toBe(7 * 86400);
    expect(presetTtl('30d', now)).toBe(MAX_TTL_S);
    expect(MAX_TTL_S).toBe(30 * 86400);
  });

  it('«до конца дня»: to the local midnight; too late in the evening is out of bounds', () => {
    expect(endOfDay(now)).toBe(new Date(2026, 0, 16, 0, 0).getTime());
    expect(presetTtl('eod', now)).toBe(10.5 * 3600);
    expect(presetTtl('eod', new Date(2026, 0, 15, 23, 50).getTime())).toBeNull();
  });

  it('«до даты»: within 15 minutes … 30 days', () => {
    expect(presetTtl('date', now, now + 30 * DAY)).toBe(30 * 86400);
    expect(presetTtl('date', now, now + 2 * DAY)).toBe(2 * 86400);
    expect(presetTtl('date', now, now + 10 * MIN)).toBeNull();
    expect(presetTtl('date', now, now + 31 * DAY)).toBeNull();
    expect(presetTtl('date', now)).toBeNull();
    expect(presetTtl('date', now, NaN)).toBeNull();
  });

  it('datetime-local round trip', () => {
    expect(toLocalInput(now)).toBe('2026-01-15T13:30');
    expect(fromLocalInput('2026-01-15T13:30')).toBe(now);
    expect(fromLocalInput('')).toBeNaN();
  });
});

describe('extension', () => {
  const now = 1_000_000_000_000;

  it('adds to the current end, capped at 30 days from now', () => {
    expect(extendTo(now + HOUR, HOUR, now)).toBe(now + 2 * HOUR);
    expect(extendTo(now + 29.5 * DAY, DAY, now)).toBe(now + 30 * DAY);
  });

  it('an end already passed counts from now', () => {
    expect(extendTo(now - MIN, HOUR, now)).toBe(now + HOUR);
  });

  it('a picked end: 15 minutes … 30 days ahead', () => {
    expect(validEnd(now + DAY, now)).toBe(now + DAY);
    expect(validEnd(now + MIN, now)).toBeNull();
    expect(validEnd(now + 30 * DAY, now)).toBe(now + 30 * DAY);
    expect(validEnd(now + 30 * DAY + MIN, now)).toBeNull();
  });
});

describe('temp rooms', () => {
  const room = (id: string, name: string, at?: number) => ({ id, name, ...(at === undefined ? {} : { expiresAt: timestampFromMs(at) }) });

  it('is temp by expires_at', () => {
    expect(isTempRoom(room('a', 'A', 5))).toBe(true);
    expect(isTempRoom(room('a', 'A'))).toBe(false);
    expect(isTempRoom(undefined)).toBe(false);
    expect(expiresMs(room('a', 'A', 5_000))).toBe(5_000);
    expect(expiresMs(room('a', 'A'))).toBe(0);
  });

  it('the group sorts by expiry, then name', () => {
    const list = [room('1', 'Б', 3_000), room('2', 'А', 3_000), room('3', 'В', 1_000)];
    expect(sortTempRooms(list).map((r) => r.id)).toEqual(['3', '2', '1']);
  });
});

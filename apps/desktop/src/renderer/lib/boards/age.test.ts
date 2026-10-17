import { describe, expect, it } from 'vitest';
import { ageOf, isStale } from './age';

const now = Date.UTC(2026, 9, 17, 12);
const H = 3_600_000;
const D = 24 * H;
const ago = (ms: number): number => now - ms;

describe('ageOf', () => {
  it('picks the largest short unit', () => {
    expect(ageOf(ago(10_000), now)).toEqual({ key: 'boards.age.now', n: 0 });
    expect(ageOf(ago(5 * 60_000), now)).toEqual({ key: 'boards.age.min', n: 5 });
    expect(ageOf(ago(2 * H), now)).toEqual({ key: 'boards.age.hour', n: 2 });
    expect(ageOf(ago(5 * D), now)).toEqual({ key: 'boards.age.day', n: 5 });
    expect(ageOf(ago(21 * D), now)).toEqual({ key: 'boards.age.week', n: 3 });
    expect(ageOf(ago(70 * D), now)).toEqual({ key: 'boards.age.month', n: 2 });
    expect(ageOf(ago(400 * D), now)).toEqual({ key: 'boards.age.year', n: 1 });
  });
  it('has nothing for an unset time and clamps the future', () => {
    expect(ageOf(0, now)).toBeNull();
    expect(ageOf(now + H, now)?.key).toBe('boards.age.now');
  });
});

describe('isStale', () => {
  it('turns at 14 days', () => {
    expect(isStale(ago(13 * D), now)).toBe(false);
    expect(isStale(ago(14 * D), now)).toBe(true);
    expect(isStale(0, now)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { after, before, between, isValidKey } from './fracIndex';

describe('fractional keys', () => {
  it('has an open-ended start', () => {
    const k = between(null, null, null);
    expect(isValidKey(k)).toBe(true);
  });
  it('after() and before() order correctly', () => {
    const a = after(null, null);
    const b = after(a, null);
    const c = before(a, null);
    expect(c < a).toBe(true);
    expect(b > a).toBe(true);
    expect(isValidKey(c)).toBe(true);
  });
  it('always lands strictly between neighbours, however often it is squeezed', () => {
    let lo = after(null, null);
    const hi = after(lo, null);
    for (let i = 0; i < 200; i++) {
      const mid = between(lo, hi, null);
      expect(mid > lo).toBe(true);
      expect(mid < hi).toBe(true);
      expect(isValidKey(mid)).toBe(true);
      lo = mid;
    }
  });
  it('squeezing from the other side also works', () => {
    const lo = after(null, null);
    let hi = after(lo, null);
    for (let i = 0; i < 200; i++) {
      const mid = between(lo, hi, null);
      expect(mid > lo && mid < hi).toBe(true);
      hi = mid;
    }
  });
  it('appending forever keeps the keys short-ish and ordered', () => {
    let k: string | null = null;
    const keys: string[] = [];
    for (let i = 0; i < 2000; i++) {
      k = after(k, null);
      keys.push(k);
    }
    expect([...keys].sort()).toEqual(keys);
    expect(Math.max(...keys.map((x) => x.length))).toBeLessThanOrEqual(3);
  });
  it('5000 appends stay at 4 characters', () => {
    let k: string | null = null;
    let prev = '';
    for (let i = 0; i < 5000; i++) {
      k = after(k, null);
      expect(k > prev).toBe(true);
      prev = k;
    }
    expect(prev.length).toBe(4);
  });
  it('appends after keys that came from between()', () => {
    const lo = between(null, null, null);
    expect(after(lo, null) > lo).toBe(true);
    expect(after('zzzzz', null) > 'zzzzz').toBe(true);
  });
  it('before() goes below even deep keys', () => {
    for (const k of ['V', '1', '2', 'zz', 'A1', '11', '01']) {
      const b = before(k, null);
      expect(b < k).toBe(true);
      expect(isValidKey(b)).toBe(true);
    }
    expect(before(before(before('V', null), null), null) < 'V').toBe(true);
  });
  it('with a random tail stays inside (a, b)', () => {
    let seed = 1;
    const rng = (): number => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    let lo = after(null, rng);
    const hi = after(lo, rng);
    for (let i = 0; i < 300; i++) {
      const mid = between(lo, hi, rng);
      expect(mid > lo && mid < hi).toBe(true);
      expect(isValidKey(mid)).toBe(true);
      lo = mid;
    }
  });
  it('two clients appending at once rarely collide', () => {
    const base = after(null, null);
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(after(base));
    expect(seen.size).toBeGreaterThan(90);
  });
  it('rejects inverted bounds', () => {
    expect(() => between('b', 'a', null)).toThrow();
    expect(() => between('a', 'a', null)).toThrow();
  });
  it('validates keys', () => {
    expect(isValidKey('V')).toBe(true);
    expect(isValidKey('')).toBe(false);
    expect(isValidKey('a00')).toBe(true);
    expect(isValidKey('a-b')).toBe(false);
    expect(isValidKey(5)).toBe(false);
  });
});

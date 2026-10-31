import { describe, expect, it } from 'vitest';
import { gridScrollTarget } from './scrollTarget';

describe('gridScrollTarget', () => {
  it('puts the working day start (less 30 min) at the top', () => {
    expect(gridScrollTarget(9 * 60, undefined)).toEqual({ minute: 8 * 60 + 30, at: 'top' });
  });
  it('defaults to 08:00 without working hours', () => {
    expect(gridScrollTarget(undefined, undefined)).toEqual({ minute: 480, at: 'top' });
  });
  it('a selected meeting wins', () => {
    expect(gridScrollTarget(9 * 60, 14 * 60)).toEqual({ minute: 840, at: 'third' });
  });
  it('never goes above midnight', () => {
    expect(gridScrollTarget(10, undefined).minute).toBe(0);
  });
});

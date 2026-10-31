import { describe, expect, it } from 'vitest';
import { joinPlan, peopleSummary } from './joinConfirm';

describe('joinPlan', () => {
  it('no seat: a plain confirmation', () => {
    expect(joinPlan({ roomId: null, call: false }, 'r1')).toBe('free');
  });
  it('already in that room: nothing to join', () => {
    expect(joinPlan({ roomId: 'r1', call: false }, 'r1')).toBe('here');
  });
  it('another voice room: leaving is part of the choice', () => {
    expect(joinPlan({ roomId: 'r2', call: false }, 'r1')).toBe('switch');
  });
  it('a one-to-one call is named as a call', () => {
    expect(joinPlan({ roomId: 'dm1', call: true }, 'r1')).toBe('call');
  });
});

describe('peopleSummary', () => {
  it('caps the names and counts the rest', () => {
    expect(peopleSummary(['A', 'B', 'C', 'D', 'E'])).toEqual({ shown: ['A', 'B', 'C'], more: 2 });
    expect(peopleSummary(['A', '', 'B'])).toEqual({ shown: ['A', 'B'], more: 0 });
    expect(peopleSummary([])).toEqual({ shown: [], more: 0 });
  });
});

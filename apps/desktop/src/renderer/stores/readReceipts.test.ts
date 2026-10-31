import { afterEach, describe, expect, it } from 'vitest';
import { TICKS_NONE, TICKS_READ, TICKS_SENT, tickState, useReadReceipts } from './readReceipts';

const id = (n: number): string => `0190a0b0-0000-7000-8000-${String(n).padStart(12, '0')}`;

afterEach(() => useReadReceipts.getState().reset());

describe('readReceipts', () => {
  it('keeps the furthest marker per room; a stale one changes nothing (same state object)', () => {
    const s = useReadReceipts.getState();
    s.set('r', id(5));
    const before = useReadReceipts.getState();
    s.set('r', id(4));
    s.set('r', id(5));
    expect(useReadReceipts.getState()).toBe(before);
    s.set('r', id(9));
    s.set('q', id(1));
    expect(useReadReceipts.getState().byRoom).toEqual({ r: id(9), q: id(1) });
  });

  it('a receipt flips only the ticks it passes (what useReadReceipt selects per bubble)', () => {
    // 100 own messages in r, one ticks selector each, as the feed mounts them.
    const read = (n: number): boolean => {
      const upTo = useReadReceipts.getState().byRoom['r'];
      return upTo !== undefined && upTo >= id(n);
    };
    const before = Array.from({ length: 100 }, (_, n) => read(n));
    useReadReceipts.getState().set('r', id(10));
    const mid = Array.from({ length: 100 }, (_, n) => read(n));
    expect(mid.filter((v, n) => v !== before[n])).toHaveLength(11); // 0..10
    useReadReceipts.getState().set('r', id(12));
    useReadReceipts.getState().set('q', id(99)); // another room: nothing here
    expect(Array.from({ length: 100 }, (_, n) => read(n)).filter((v, n) => v !== mid[n])).toHaveLength(2);
  });

  it('tickState (ADR-0140): no ticks before the start, ✓ until someone saw, ✓✓ up to the marker', () => {
    expect(tickState(id(3), undefined, '')).toBe(TICKS_SENT);
    expect(tickState(id(3), id(5), '')).toBe(TICKS_READ);
    expect(tickState(id(5), id(5), '')).toBe(TICKS_READ);
    expect(tickState(id(6), id(5), '')).toBe(TICKS_SENT);
    // Before read receipts started: nothing — even when an old marker is past it.
    expect(tickState(id(3), id(9), id(4))).toBe(TICKS_NONE);
    expect(tickState(id(4), id(9), id(4))).toBe(TICKS_READ);
  });

  it('setFrom keeps the state object when unchanged; reset clears it', () => {
    const s = useReadReceipts.getState();
    s.setFrom(id(1));
    const before = useReadReceipts.getState();
    s.setFrom(id(1));
    expect(useReadReceipts.getState()).toBe(before);
    s.reset();
    expect(useReadReceipts.getState().from).toBe('');
  });
});

import { describe, expect, it } from 'vitest';
import { stackLayout } from './assigneeStack';

const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ userId: `u${i}`, atMs: (i + 1) * 1000 }));

describe('stackLayout', () => {
  it('draws up to three people as avatars with no «+N»', () => {
    for (const n of [1, 2, 3]) {
      const l = stackLayout(mk(n));
      expect(l.shown).toHaveLength(n);
      expect(l.more).toBe(0);
    }
  });
  it('makes the third circle «+N» from four people on', () => {
    const l = stackLayout(mk(5));
    expect(l.shown.map((a) => a.userId)).toEqual(['u0', 'u1']);
    expect(l.more).toBe(3);
    expect(stackLayout(mk(4)).more).toBe(2);
  });
  it('puts the earlier assigned first; an unknown time goes last', () => {
    const l = stackLayout([
      { userId: 'c', atMs: 0 },
      { userId: 'b', atMs: 2000 },
      { userId: 'a', atMs: 1000 },
    ]);
    expect(l.shown.map((a) => a.userId)).toEqual(['a', 'b', 'c']);
  });
  it('keeps the server order for equal times', () => {
    const l = stackLayout([
      { userId: 'x', atMs: 5 },
      { userId: 'y', atMs: 5 },
    ]);
    expect(l.shown.map((a) => a.userId)).toEqual(['x', 'y']);
  });
});

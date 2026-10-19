import { describe, expect, it } from 'vitest';
import { guides, snapMove, snapResizePoint } from './snap';

const opts = { threshold: 6, grid: 0 };
const other = { x: 200, y: 100, w: 100, h: 50 };

describe('snapMove', () => {
  it('pulls an edge onto a neighbour\'s edge and reports the guide', () => {
    const r = snapMove({ x: 94, y: 0, w: 100, h: 50 }, [other], opts);
    // right edge 194 → neighbour's left 200
    expect(r.dx).toBe(6);
    expect(r.guides.some((g) => g.axis === 'x' && g.at === 200)).toBe(true);
    const g = r.guides.find((x) => x.axis === 'x');
    expect(g?.from).toBeLessThanOrEqual(0);
    expect(g?.to).toBeGreaterThanOrEqual(150);
  });
  it('aligns centers', () => {
    const r = snapMove({ x: 0, y: 0, w: 100, h: 40 }, [{ x: 20, y: 200, w: 66, h: 20 }], opts);
    expect(r.dx).toBe(3); // center 50 → 53
  });
  it('ignores neighbours beyond the threshold', () => {
    const r = snapMove({ x: 0, y: 0, w: 100, h: 50 }, [other], opts);
    expect(r.dx).toBe(0);
    expect(r.guides).toEqual([]);
  });
  it('snaps both axes independently', () => {
    const r = snapMove({ x: 195, y: 96, w: 40, h: 40 }, [other], opts);
    expect(r.dx).toBe(5);
    expect(r.dy).toBe(4);
  });
  it('falls back to the grid when nothing attracts', () => {
    const r = snapMove({ x: 13, y: 21, w: 50, h: 50 }, [], { threshold: 6, grid: 8 });
    expect(r.dx).toBe(3);
    expect(r.dy).toBe(3);
    expect(r.guides).toEqual([]);
  });
  it('guides win over the grid on their axis only', () => {
    const r = snapMove({ x: 197, y: 21, w: 50, h: 50 }, [other], { threshold: 6, grid: 8 });
    expect(r.dx).toBe(3);
    expect(r.dy).toBe(3); // grid on y: 21 → 24
  });
});

describe('guides', () => {
  it('lists only coinciding lines, once each', () => {
    const g = guides({ x: 200, y: 0, w: 100, h: 50 }, [other, { x: 200, y: 300, w: 10, h: 10 }]);
    const xs = g.filter((x) => x.axis === 'x').map((x) => x.at);
    expect(xs).toContain(200);
    expect(new Set(xs).size).toBe(xs.length);
  });
});

describe('snapResizePoint', () => {
  it('snaps the dragged edge to neighbours', () => {
    const r = snapResizePoint({ x: 196, y: 500 }, 'e', [other], opts);
    expect(r.p).toEqual({ x: 200, y: 500 });
    expect(r.guides.some((g) => g.axis === 'x' && g.at === 200)).toBe(true);
  });
  it('only touches the axes of the handle', () => {
    expect(snapResizePoint({ x: 203, y: 103 }, 's', [other], opts).p).toEqual({ x: 203, y: 100 });
    expect(snapResizePoint({ x: 203, y: 103 }, 'e', [other], opts).p).toEqual({ x: 200, y: 103 });
    expect(snapResizePoint({ x: 203, y: 103 }, 'se', [other], opts).p).toEqual({ x: 200, y: 100 });
  });
  it('uses the grid without neighbours', () => {
    expect(snapResizePoint({ x: 13, y: 13 }, 'se', [], { threshold: 6, grid: 8 }).p).toEqual({ x: 16, y: 16 });
  });
});

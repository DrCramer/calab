import { describe, expect, it } from 'vitest';
import { RouteCache, anchorPoint, elbowPath, endDirection, nearestSide, routeConnector, simplify, STUB, type ResolvedEnd } from './route';
import type { BoxRec, ShapeRec } from './types';

const box = (id: string, x: number, y: number, w = 100, h = 60): BoxRec => ({ kind: 'sticky', id, z: 'a', x, y, w, h, color: 'yellow', text: '' });
const world = (...bs: BoxRec[]) => (id: string) => bs.find((b) => b.id === id);

const pairs = (pts: readonly number[]): [number, number][] => {
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < pts.length; i += 2) out.push([pts[i] ?? 0, pts[i + 1] ?? 0]);
  return out;
};
const isOrthogonal = (pts: readonly number[]): boolean => {
  const p = pairs(pts);
  for (let i = 1; i < p.length; i++) if (p[i]?.[0] !== p[i - 1]?.[0] && p[i]?.[1] !== p[i - 1]?.[1]) return false;
  return true;
};

describe('anchors', () => {
  const r = { x: 0, y: 0, w: 100, h: 60 };
  it('sit at the middle of each side', () => {
    expect(anchorPoint(r, undefined, 'top')).toEqual({ x: 50, y: 0 });
    expect(anchorPoint(r, undefined, 'right')).toEqual({ x: 100, y: 30 });
    expect(anchorPoint(r, undefined, 'bottom')).toEqual({ x: 50, y: 60 });
    expect(anchorPoint(r, undefined, 'left')).toEqual({ x: 0, y: 30 });
  });
  it('triangle left/right anchors are on the slanted edges', () => {
    expect(anchorPoint(r, 'triangle', 'left')).toEqual({ x: 25, y: 30 });
    expect(anchorPoint(r, 'triangle', 'right')).toEqual({ x: 75, y: 30 });
    expect(anchorPoint(r, 'triangle', 'top')).toEqual({ x: 50, y: 0 });
  });
  it('auto picks the side nearest to the other end', () => {
    expect(nearestSide(r, undefined, { x: 500, y: 30 })).toBe('right');
    expect(nearestSide(r, undefined, { x: -400, y: 30 })).toBe('left');
    expect(nearestSide(r, undefined, { x: 50, y: 700 })).toBe('bottom');
    expect(nearestSide(r, undefined, { x: 50, y: -700 })).toBe('top');
  });
});

describe('straight connectors', () => {
  const a = box('a', 0, 0);
  const b = box('b', 400, 0);
  it('glue to the nearest sides', () => {
    const r = routeConnector({ id: 'a', side: 'auto' }, { id: 'b', side: 'auto' }, 'straight', world(a, b));
    expect(r.points).toEqual([100, 30, 400, 30]);
    expect(r.from.side).toBe('right');
    expect(r.to.side).toBe('left');
  });
  it('honour explicit sides', () => {
    const r = routeConnector({ id: 'a', side: 'bottom' }, { id: 'b', side: 'top' }, 'straight', world(a, b));
    expect(r.points).toEqual([50, 60, 450, 0]);
  });
  it('follow a moved target', () => {
    const moved = box('b', 0, 400);
    const r = routeConnector({ id: 'a', side: 'auto' }, { id: 'b', side: 'auto' }, 'straight', world(a, moved));
    expect(r.points.slice(0, 2)).toEqual([50, 60]);
    expect(r.to.target).toBe('b');
  });
  it('free ends stay where they are', () => {
    const r = routeConnector({ x: 5, y: 6 }, { x: 70, y: 80 }, 'straight', world());
    expect(r.points).toEqual([5, 6, 70, 80]);
    expect(r.from.dir).toBeNull();
  });
  it('a dangling end stays at its last position, else collapses onto the other end', () => {
    const r1 = routeConnector({ id: 'a', side: 'auto' }, { id: 'gone', side: 'auto' }, 'straight', world(a), { to: { x: 300, y: 300 } });
    expect(r1.points.slice(2)).toEqual([300, 300]);
    const r2 = routeConnector({ id: 'a', side: 'auto' }, { id: 'gone', side: 'auto' }, 'straight', world(a));
    expect(r2.points.slice(2)).toEqual(r2.points.slice(0, 2));
  });
  it('uses the triangle anchor for shapes', () => {
    const tri: ShapeRec = { kind: 'shape', id: 't', z: 'a', x: 0, y: 0, w: 100, h: 100, shape: 'triangle', fill: 'none', stroke: 'stroke', strokeWidth: 2, text: '' };
    const r = routeConnector({ id: 't', side: 'right' }, { x: 500, y: 50 }, 'straight', world(tri));
    expect(r.points.slice(0, 2)).toEqual([75, 50]);
  });
});

describe('elbow connectors', () => {
  it('goes out and in along the side normals, orthogonally', () => {
    const a = box('a', 0, 0);
    const b = box('b', 400, 200);
    const r = routeConnector({ id: 'a', side: 'right' }, { id: 'b', side: 'left' }, 'elbow', world(a, b));
    expect(isOrthogonal(r.points)).toBe(true);
    const p = pairs(r.points);
    expect(p[0]).toEqual([100, 30]);
    expect(p[p.length - 1]).toEqual([400, 230]);
    // first segment leaves to the right, last arrives from the left
    expect((p[1]?.[0] ?? 0) > 100).toBe(true);
    expect((p[p.length - 2]?.[0] ?? 0) < 400).toBe(true);
  });
  it('right → top makes a single bend when the target is ahead', () => {
    const a = box('a', 0, 0);
    const b = box('b', 300, 200);
    const r = routeConnector({ id: 'a', side: 'right' }, { id: 'b', side: 'top' }, 'elbow', world(a, b));
    expect(isOrthogonal(r.points)).toBe(true);
    expect(pairs(r.points)).toEqual([[100, 30], [350, 30], [350, 200]]);
  });
  it('wraps around when both ends leave the same way', () => {
    const a = box('a', 0, 0);
    const b = box('b', 0, 200);
    const r = routeConnector({ id: 'a', side: 'right' }, { id: 'b', side: 'right' }, 'elbow', world(a, b));
    expect(isOrthogonal(r.points)).toBe(true);
    const xs = pairs(r.points).map((q) => q[0]);
    expect(Math.max(...xs)).toBe(100 + STUB);
  });
  it('vertical to vertical uses a middle bar', () => {
    const a = box('a', 0, 0);
    const b = box('b', 200, 300);
    const r = routeConnector({ id: 'a', side: 'bottom' }, { id: 'b', side: 'top' }, 'elbow', world(a, b));
    expect(isOrthogonal(r.points)).toBe(true);
    expect(pairs(r.points)).toEqual([[50, 60], [50, 180], [250, 180], [250, 300]]);
  });
  it('free ends route without stubs', () => {
    const r = routeConnector({ x: 0, y: 0 }, { x: 100, y: 50 }, 'elbow', world());
    expect(isOrthogonal(r.points)).toBe(true);
    expect(pairs(r.points)[0]).toEqual([0, 0]);
    expect(pairs(r.points).at(-1)).toEqual([100, 50]);
  });
  it('is cached by resolved geometry', () => {
    const cache = new RouteCache();
    const a = box('a', 0, 0);
    const b = box('b', 400, 200);
    const l = world(a, b);
    const r1 = routeConnector({ id: 'a', side: 'auto' }, { id: 'b', side: 'auto' }, 'elbow', l, {}, cache);
    const r2 = routeConnector({ id: 'a', side: 'auto' }, { id: 'b', side: 'auto' }, 'elbow', l, {}, cache);
    expect(r2.points).toBe(r1.points);
    expect(cache.hits).toBe(1);
    expect(cache.misses).toBe(1);
    routeConnector({ id: 'a', side: 'auto' }, { id: 'b', side: 'auto' }, 'elbow', world(a, box('b', 500, 200)), {}, cache);
    expect(cache.misses).toBe(2);
  });
  it('the cache is bounded', () => {
    const cache = new RouteCache(3);
    for (let i = 0; i < 10; i++) cache.set(`k${i}`, [i]);
    expect(cache.get('k0')).toBeUndefined();
    expect(cache.get('k9')).toEqual([9]);
  });
  it('simplify drops repeats and collinear middles', () => {
    expect(simplify([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }])).toEqual([0, 0, 10, 0, 10, 10]);
  });
  it('elbowPath handles stacked boxes on one column', () => {
    const e = (x: number, y: number, dx: number, dy: number): ResolvedEnd => ({ p: { x, y }, dir: { x: dx, y: dy }, target: 'x', side: null });
    const pts = elbowPath(e(50, 60, 0, 1), e(50, 200, 0, -1));
    expect(pts).toEqual([50, 60, 50, 200]);
  });
});

describe('arrow direction', () => {
  it('uses the last segment', () => {
    expect(endDirection([0, 0, 10, 0, 10, 10], true)).toEqual({ x: 0, y: 1 });
    expect(endDirection([0, 0, 10, 0, 10, 10], false)).toEqual({ x: -1, y: 0 });
    expect(endDirection([0, 0], true)).toEqual({ x: 1, y: 0 });
  });
});

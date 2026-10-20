import { describe, expect, it } from 'vitest';
import {
  boundsOf, distToPolyline, distToSegment, handlePoint, hitHandle, mapRect, pointsBounds, polylineMidpoint,
  rectContains, rectFromPoints, rectInflate, rectUnion, rectsIntersect, resizeRect, snapTo,
} from './geometry';
import { pointInShape } from './shapes';

describe('rects', () => {
  it('builds from points in any order', () => {
    expect(rectFromPoints({ x: 10, y: 20 }, { x: 4, y: 5 })).toEqual({ x: 4, y: 5, w: 6, h: 15 });
  });
  it('intersects, contains, unions', () => {
    const a = { x: 0, y: 0, w: 10, h: 10 };
    expect(rectsIntersect(a, { x: 10, y: 10, w: 5, h: 5 })).toBe(true);
    expect(rectsIntersect(a, { x: 11, y: 0, w: 5, h: 5 })).toBe(false);
    expect(rectContains(a, { x: 1, y: 1, w: 2, h: 2 })).toBe(true);
    expect(rectUnion(a, { x: 5, y: -5, w: 20, h: 6 })).toEqual({ x: 0, y: -5, w: 25, h: 15 });
    expect(rectInflate(a, 2)).toEqual({ x: -2, y: -2, w: 14, h: 14 });
    expect(boundsOf([])).toBeNull();
    expect(boundsOf([a, { x: 20, y: 20, w: 1, h: 1 }])).toEqual({ x: 0, y: 0, w: 21, h: 21 });
  });
  it('bounds of a polyline', () => {
    expect(pointsBounds([1, 5, 9, -2, 3, 3])).toEqual({ x: 1, y: -2, w: 8, h: 7 });
    expect(pointsBounds([])).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });
});

describe('distances', () => {
  it('to a segment clamps at the ends', () => {
    expect(distToSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(3);
    expect(distToSegment({ x: -3, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
    expect(distToSegment({ x: 1, y: 1 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBeCloseTo(Math.SQRT2);
  });
  it('to a polyline takes the nearest segment', () => {
    expect(distToPolyline({ x: 10, y: 5 }, [0, 0, 10, 0, 10, 10])).toBe(0);
    expect(distToPolyline({ x: 5, y: 4 }, [0, 0, 10, 0, 10, 10])).toBe(4);
  });
  it('finds the midpoint along the path', () => {
    expect(polylineMidpoint([0, 0, 10, 0, 10, 10])).toEqual({ x: 10, y: 0 });
    expect(polylineMidpoint([0, 0, 10, 0])).toEqual({ x: 5, y: 0 });
  });
  it('snaps to a step', () => {
    expect(snapTo(13, 8)).toBe(16);
    expect(snapTo(11, 8)).toBe(8);
  });
});

describe('resizeRect', () => {
  const r = { x: 100, y: 100, w: 200, h: 100 };
  it('moves only the dragged edges', () => {
    expect(resizeRect(r, 'e', { x: 400, y: 999 })).toEqual({ x: 100, y: 100, w: 300, h: 100 });
    expect(resizeRect(r, 'nw', { x: 50, y: 60 })).toEqual({ x: 50, y: 60, w: 250, h: 140 });
    expect(resizeRect(r, 's', { x: 0, y: 260 })).toEqual({ x: 100, y: 100, w: 200, h: 160 });
  });
  it('never flips: stops at the minimum size', () => {
    const out = resizeRect(r, 'e', { x: 0, y: 0 }, { minW: 24 });
    expect(out).toEqual({ x: 100, y: 100, w: 24, h: 100 });
    const nw = resizeRect(r, 'nw', { x: 900, y: 900 }, { minW: 24, minH: 24 });
    expect(nw).toEqual({ x: 276, y: 176, w: 24, h: 24 });
  });
  it('keeps the aspect ratio on corners with the opposite corner fixed', () => {
    const out = resizeRect(r, 'se', { x: 500, y: 150 }, { keepAspect: true });
    expect(out.x).toBe(100);
    expect(out.y).toBe(100);
    expect(out.w / out.h).toBeCloseTo(2);
    const nw = resizeRect(r, 'nw', { x: 0, y: 90 }, { keepAspect: true });
    expect(nw.x + nw.w).toBe(300);
    expect(nw.y + nw.h).toBe(200);
    expect(nw.w / nw.h).toBeCloseTo(2);
  });
  it('resizes around the center', () => {
    const out = resizeRect(r, 'e', { x: 400, y: 0 }, { fromCenter: true });
    expect(out).toEqual({ x: 0, y: 100, w: 400, h: 100 });
  });
  it('maps rects through a group resize', () => {
    const from = { x: 0, y: 0, w: 100, h: 100 };
    const to = { x: 10, y: 20, w: 200, h: 50 };
    expect(mapRect({ x: 50, y: 50, w: 10, h: 10 }, from, to)).toEqual({ x: 110, y: 45, w: 20, h: 5 });
  });
});

describe('handles', () => {
  const r = { x: 0, y: 0, w: 100, h: 60 };
  it('places 8 handles on the outline', () => {
    expect(handlePoint(r, 'n')).toEqual({ x: 50, y: 0 });
    expect(handlePoint(r, 'se')).toEqual({ x: 100, y: 60 });
    expect(handlePoint(r, 'w')).toEqual({ x: 0, y: 30 });
  });
  it('hits the nearest handle within the radius', () => {
    expect(hitHandle(r, { x: 3, y: 2 }, 8)).toBe('nw');
    expect(hitHandle(r, { x: 50, y: 30 }, 8)).toBeNull();
    expect(hitHandle(r, { x: 98, y: 31 }, 8)).toBe('e');
  });
});

describe('pointInShape', () => {
  const r = { x: 0, y: 0, w: 100, h: 100 };
  it('ellipse excludes the corners', () => {
    expect(pointInShape('ellipse', r, { x: 50, y: 50 })).toBe(true);
    expect(pointInShape('ellipse', r, { x: 5, y: 5 })).toBe(false);
  });
  it('diamond is |dx|+|dy| ≤ half', () => {
    expect(pointInShape('diamond', r, { x: 50, y: 5 })).toBe(true);
    expect(pointInShape('diamond', r, { x: 10, y: 10 })).toBe(false);
  });
  it('triangle has its apex up', () => {
    expect(pointInShape('triangle', r, { x: 50, y: 10 })).toBe(true);
    expect(pointInShape('triangle', r, { x: 10, y: 10 })).toBe(false);
    expect(pointInShape('triangle', r, { x: 10, y: 95 })).toBe(true);
  });
  it('rect and rounded are their bounds', () => {
    expect(pointInShape('rect', r, { x: 1, y: 99 })).toBe(true);
    expect(pointInShape('rounded', r, { x: 101, y: 50 })).toBe(false);
  });
});

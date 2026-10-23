import { describe, expect, it } from 'vitest';
import { ALIGN_OPS, DISTRIBUTE_OPS, arrangeDeltas, arrangeUnits, type ArrangeOp, type ArrangeUnit } from './arrange';
import type { ObjectRec } from './types';

const u = (id: string, x: number, y: number, w: number, h: number): ArrangeUnit => ({ ids: [id], rect: { x, y, w, h } });
const sticky = (id: string, x: number, y: number, w: number, h: number, extra: object = {}): ObjectRec =>
  ({ kind: 'sticky', id, z: id, x, y, w, h, color: 'yellow', text: '', ...extra });

const run = (units: ArrangeUnit[], op: ArrangeOp): { dx: number; dy: number }[] => {
  const d = arrangeDeltas(units, op);
  if (!d) throw new Error('no deltas');
  return d;
};

describe('align', () => {
  const units = [u('a', 0, 0, 100, 50), u('b', 200, 100, 60, 80), u('c', 400, 40, 20, 20)];
  it('left / right / center on the union of the rects', () => {
    expect(run(units, 'left').map((d) => d.dx)).toEqual([0, -200, -400]);
    expect(run(units, 'right').map((d) => d.dx)).toEqual([320, 160, 0]); // union right edge = 420
    expect(run(units, 'hcenter').map((d) => d.dx)).toEqual([160, -20, -200]);
    for (const op of ['left', 'right', 'hcenter'] as const) expect(run(units, op).every((d) => d.dy === 0)).toBe(true);
  });
  it('top / bottom / middle', () => {
    expect(run(units, 'top').map((d) => d.dy)).toEqual([0, -100, -40]);
    expect(run(units, 'bottom').map((d) => d.dy)).toEqual([130, 0, 120]); // union bottom edge = 180
    expect(run(units, 'vmiddle').map((d) => d.dy)).toEqual([90 - 25, 90 - 140, 90 - 50]);
    for (const op of ['top', 'bottom', 'vmiddle'] as const) expect(run(units, op).every((d) => d.dx === 0)).toBe(true);
  });
  it('after applying every align op, the edges coincide', () => {
    for (const op of ALIGN_OPS) {
      const d = run(units, op);
      const moved = units.map((x, i) => ({ ...x.rect, x: x.rect.x + (d[i]?.dx ?? 0), y: x.rect.y + (d[i]?.dy ?? 0) }));
      const key = (r: { x: number; y: number; w: number; h: number }): number =>
        op === 'left' ? r.x : op === 'right' ? r.x + r.w : op === 'hcenter' ? r.x + r.w / 2 : op === 'top' ? r.y : op === 'bottom' ? r.y + r.h : r.y + r.h / 2;
      for (const r of moved) expect(key(r)).toBeCloseTo(key(moved[0] ?? r));
    }
  });
  it('needs two units; distribute needs three', () => {
    expect(arrangeDeltas([u('a', 0, 0, 10, 10)], 'left')).toBeNull();
    expect(arrangeDeltas([u('a', 0, 0, 10, 10), u('b', 50, 0, 10, 10)], 'hspace')).toBeNull();
    expect(arrangeDeltas([u('a', 0, 0, 10, 10), u('b', 50, 0, 10, 10)], 'left')).not.toBeNull();
    expect(arrangeDeltas([], 'top')).toBeNull();
  });
});

describe('distribute', () => {
  it('makes the gaps equal across the span; the outermost stay put', () => {
    const units = [u('a', 0, 0, 100, 10), u('b', 150, 0, 50, 10), u('c', 500, 0, 100, 10)];
    const d = run(units, 'hspace');
    // span 600, widths 250 → two gaps of 175
    expect(d.map((x) => x.dx)).toEqual([0, 275 - 150, 0]);
    expect(d.every((x) => x.dy === 0)).toBe(true);
    expect(DISTRIBUTE_OPS).toEqual(['hspace', 'vspace']);
  });
  it('is order-independent (sorted by center) and works vertically', () => {
    const a = u('a', 0, 0, 10, 100);
    const b = u('b', 0, 160, 10, 40);
    const c = u('c', 0, 300, 10, 100);
    const d1 = run([a, b, c], 'vspace');
    const d2 = run([c, a, b], 'vspace');
    expect(d1[1]?.dy).toBe(d2[2]?.dy);
    expect(d1.map((x) => x.dy)).toEqual([0, 180 - 160, 0]);
    expect(d1.every((x) => x.dx === 0)).toBe(true);
  });
  it('moves already evenly spaced units by nothing', () => {
    const d = run([u('a', 0, 0, 10, 10), u('b', 20, 0, 10, 10), u('c', 40, 0, 10, 10)], 'hspace');
    expect(d.every((x) => Math.abs(x.dx) < 1e-9 && x.dy === 0)).toBe(true);
  });
});

describe('units of a selection', () => {
  const whole = (n: number) => () => n;
  it('uses the circumscribed rect of a rotated box', () => {
    const [x] = arrangeUnits([sticky('a', 0, 0, 100, 50, { rot: 90 })], whole(0));
    expect(x?.rect.w).toBeCloseTo(50);
    expect(x?.rect.h).toBeCloseTo(100);
  });
  it('a whole group is one unit; a partial group falls apart into its members', () => {
    const objs = [sticky('a', 0, 0, 10, 10, { group: 'g' }), sticky('b', 50, 0, 10, 10, { group: 'g' }), sticky('c', 200, 0, 10, 10)];
    const whole2 = arrangeUnits(objs, () => 2);
    expect(whole2).toHaveLength(2);
    expect(whole2.find((x) => x.ids.length === 2)?.rect).toEqual({ x: 0, y: 0, w: 60, h: 10 });
    expect(arrangeUnits(objs, () => 3)).toHaveLength(3);
  });
  it('locked objects and a group with a locked member do not move', () => {
    const objs = [sticky('a', 0, 0, 10, 10, { locked: true }), sticky('b', 50, 0, 10, 10), sticky('c', 90, 0, 10, 10, { group: 'g' }), sticky('d', 99, 0, 10, 10, { group: 'g', locked: true })];
    const units = arrangeUnits(objs, () => 2);
    expect(units.map((x) => x.ids)).toEqual([['b']]);
  });
  it('a connector alone is not a unit; one in a group travels with it', () => {
    const conn = { kind: 'connector', id: 'k', z: 'k', x: 0, y: 0, w: 5, h: 5, from: { x: 0, y: 0 }, to: { x: 5, y: 5 }, arrow: 'end', route: 'straight', stroke: 'stroke', strokeWidth: 2, label: '', points: [0, 0, 5, 5] } as ObjectRec;
    expect(arrangeUnits([conn], () => 0)).toEqual([]);
    const grouped = [sticky('a', 0, 0, 10, 10, { group: 'g' }), { ...conn, group: 'g' } as ObjectRec];
    const [only] = arrangeUnits(grouped, () => 2);
    expect([...(only?.ids ?? [])].sort()).toEqual(['a', 'k']);
    expect(only?.rect).toEqual({ x: 0, y: 0, w: 10, h: 10 });
  });
});

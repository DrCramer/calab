import { describe, expect, it } from 'vitest';
import { renderSceneTo } from '../../features/canvas/engine/renderer';
import { defaultPalette } from '../../features/canvas/engine/palette';
import { fakeCtx } from '../../features/canvas/engine/testing';
import { rotatePoint, rectCenter } from './geometry';
import { SIDES, SIDE_DIR, anchorOf, anchorPoint, routeConnector } from './route';
import { Scene } from './scene';
import { anchorFraction, contentRect, pointInShape, traceShape, type PathTarget } from './shapes';
import { makeDoc } from './testing';
import { TextLayouter } from './textLayout';
import { SHAPE_KINDS, type BoxRec, type ShapeKind } from './types';

const NEW_KINDS: readonly ShapeKind[] = ['star', 'hexagon', 'parallelogram', 'arrow', 'bubble', 'cylinder'];
const R = { x: 0, y: 0, w: 200, h: 120 };
const c0 = { x: 100, y: 60 };
const sceneOf = (d: ReturnType<typeof makeDoc>): Scene => new Scene(d, new TextLayouter((t, s) => t.length * s * 0.5));

describe('shape kinds', () => {
  it('lists the five original and six new kinds', () => {
    expect(SHAPE_KINDS).toHaveLength(11);
    for (const k of NEW_KINDS) expect(SHAPE_KINDS).toContain(k);
  });
});

const inside: Record<string, [number, number][]> = {
  star: [[100, 70], [100, 5], [60, 60]],
  hexagon: [[100, 60], [10, 60], [190, 60], [60, 5]],
  parallelogram: [[100, 60], [190, 5], [10, 115]],
  arrow: [[20, 60], [190, 60], [100, 60], [110, 40], [125, 10]],
  bubble: [[100, 40], [5, 5], [195, 90], [35, 110]],
  cylinder: [[100, 60], [100, 3], [100, 117], [5, 60]],
};
const outside: Record<string, [number, number][]> = {
  star: [[2, 2], [198, 2], [100, 118], [2, 118]],
  hexagon: [[2, 2], [198, 2], [2, 118], [198, 118]],
  parallelogram: [[2, 2], [198, 118], [3, 40], [197, 80]],
  arrow: [[20, 5], [20, 115], [118, 2], [118, 118]],
  bubble: [[190, 115], [100, 115], [2, 118]],
  cylinder: [[2, 2], [198, 2], [2, 118], [198, 118]],
};

describe('pointInShape: new kinds', () => {
  it.each(NEW_KINDS)('%s contains its body and excludes what the outline cuts away', (k) => {
    for (const [x, y] of inside[k] ?? []) expect(pointInShape(k, R, { x, y }), `${k} in ${x},${y}`).toBe(true);
    for (const [x, y] of outside[k] ?? []) expect(pointInShape(k, R, { x, y }), `${k} out ${x},${y}`).toBe(false);
  });
  it.each(SHAPE_KINDS)('%s: nothing outside its frame', (k) => {
    expect(pointInShape(k, R, { x: -1, y: 60 })).toBe(false);
    expect(pointInShape(k, R, { x: 100, y: 121 })).toBe(false);
  });
  it('an unknown kind is a rectangle', () => {
    expect(pointInShape('from-the-future' as ShapeKind, R, { x: 1, y: 1 })).toBe(true);
    expect(pointInShape('from-the-future' as ShapeKind, R, { x: 201, y: 1 })).toBe(false);
  });
});

describe('anchors of the new kinds', () => {
  it.each(NEW_KINDS)('%s: every side anchor is a point of the outline (inside, and a step outward is outside)', (k) => {
    for (const side of SIDES) {
      const a = anchorPoint(R, k, side);
      const grown = { x: R.x - 0.5, y: R.y - 0.5, w: R.w + 1, h: R.h + 1 };
      expect(pointInShape(k, grown, a), `${k} ${side} inside`).toBe(true);
      const d = SIDE_DIR[side];
      expect(pointInShape(k, R, { x: a.x + d.x * 4, y: a.y + d.y * 4 }), `${k} ${side} outward`).toBe(false);
    }
  });
  it('the original kinds keep their anchors', () => {
    expect(anchorFraction('triangle', 'left')).toEqual([0.25, 0.5]);
    expect(anchorFraction('rect', 'bottom')).toEqual([0.5, 1]);
    expect(anchorFraction(undefined, 'top')).toEqual([0.5, 0]);
    expect(anchorFraction('from-the-future' as ShapeKind, 'right')).toEqual([1, 0.5]);
  });
});

describe('hit-test and connectors on the scene, rotated or not', () => {
  const make = (k: ShapeKind, rot?: number) => {
    const d = makeDoc();
    d.create({ kind: 'shape', shape: k, x: 0, y: 0, w: 200, h: 120, fill: 'blue', ...(rot ? { rot } : {}) });
    return { d, s: sceneOf(d) };
  };
  it.each(NEW_KINDS)('%s: hit() picks its body, not the cut-away corner', (k) => {
    const { s } = make(k);
    expect(s.hit({ x: 100, y: 60 }, 2)?.id).toBe('o1');
    expect(s.hit({ x: -30, y: -30 }, 2)).toBeNull();
  });
  it.each(NEW_KINDS)('%s rotated 33°: the body follows the rotation', (k) => {
    const { s } = make(k, 33);
    const c = c0;
    for (const [x, y] of inside[k] ?? []) {
      const w = rotatePoint({ x, y }, c, 33);
      expect(s.hit(w, 0.5)?.id, `${k} in ${x},${y}`).toBe('o1');
    }
    for (const [x, y] of outside[k] ?? []) {
      const w = rotatePoint({ x, y }, c, 33);
      expect(s.hit(w, 0.5), `${k} out ${x},${y}`).toBeNull();
    }
  });
  it.each(NEW_KINDS)('%s: hitArea of an unfilled shape picks the interior but not the cut-away corner', (k) => {
    const d = makeDoc();
    d.create({ kind: 'shape', shape: k, x: 0, y: 0, w: 200, h: 120 });
    const s = sceneOf(d);
    expect(s.hit({ x: 100, y: 60 }, 2)).toBeNull(); // hollow: the outline picks only
    expect(s.hitArea({ x: 100, y: 60 }, 2)?.id).toBe('o1');
    if (k !== 'bubble') expect(s.hitArea({ x: 1, y: 1 }, 1)).toBeNull();
  });
  it.each(NEW_KINDS)('%s: a glued connector ends on the (rotated) anchor of the chosen side', (k) => {
    for (const rot of [0, 90, 33]) {
      const { s } = make(k, rot);
      const box = s.get('o1') as BoxRec;
      for (const side of SIDES) {
        const routed = routeConnector({ id: 'o1', side }, { x: 900, y: 900 }, 'straight', (id) => (id === 'o1' ? box : undefined));
        const want = rotatePoint(anchorPoint(box, k, side), rectCenter(box), rot);
        expect(routed.points[0]).toBeCloseTo(want.x, 6);
        expect(routed.points[1]).toBeCloseTo(want.y, 6);
        expect(anchorOf(box, side).x).toBeCloseTo(want.x, 6);
      }
    }
  });
  it('an unknown kind in a document is read and drawn as a rectangle', () => {
    const d = makeDoc();
    d.create({ kind: 'shape', shape: 'star', x: 0, y: 0, w: 200, h: 120, fill: 'blue' });
    d.ydoc.getMap<unknown>('objects').forEach((m) => (m as { set(k: string, v: unknown): void }).set('shape', 'hologram'));
    const s = sceneOf(d);
    expect(s.get('o1')).toMatchObject({ kind: 'shape', shape: 'rect' });
    expect(s.hit({ x: 2, y: 2 }, 1)?.id).toBe('o1'); // the corner a star would cut away
  });
});

describe('contentRect of the new kinds', () => {
  it.each(NEW_KINDS)('%s: the text box lies inside the outline and has room', (k) => {
    const box = { kind: 'shape', shape: k, id: 'a', z: 'a', x: 0, y: 0, w: 200, h: 120, fill: 'none', stroke: 'stroke', strokeWidth: 2, text: '' } as BoxRec;
    const c = contentRect(box);
    expect(c.w).toBeGreaterThan(40);
    expect(c.h).toBeGreaterThan(20);
    for (const [x, y] of [[c.x, c.y], [c.x + c.w, c.y], [c.x, c.y + c.h], [c.x + c.w, c.y + c.h]] as const) {
      expect(pointInShape(k, { x: -1, y: -1, w: 202, h: 122 }, { x, y }), `${k} corner ${x},${y}`).toBe(true);
    }
  });
});

describe('drawing the new kinds (recorded calls)', () => {
  const recordPath = (k: ShapeKind): string[] => {
    const calls: string[] = [];
    const p: PathTarget = {
      moveTo: () => calls.push('moveTo'),
      lineTo: () => calls.push('lineTo'),
      arcTo: () => calls.push('arcTo'),
      closePath: () => calls.push('closePath'),
      ellipse: () => calls.push('ellipse'),
    };
    traceShape(p, k, R);
    return calls;
  };
  it('polygons are closed paths with the expected vertex count', () => {
    expect(recordPath('star').filter((c) => c === 'lineTo')).toHaveLength(9);
    expect(recordPath('hexagon').filter((c) => c === 'lineTo')).toHaveLength(5);
    expect(recordPath('parallelogram').filter((c) => c === 'lineTo')).toHaveLength(3);
    expect(recordPath('arrow').filter((c) => c === 'lineTo')).toHaveLength(6);
    for (const k of ['star', 'hexagon', 'parallelogram', 'arrow', 'bubble'] as const) expect(recordPath(k)).toContain('closePath');
  });
  it('bubble has rounded corners and a tail; cylinder is made of elliptical arcs', () => {
    const b = recordPath('bubble');
    expect(b.filter((c) => c === 'arcTo')).toHaveLength(4);
    expect(b.filter((c) => c === 'lineTo')).toHaveLength(3);
    expect(recordPath('cylinder').filter((c) => c === 'ellipse')).toHaveLength(3);
  });
  it('an unknown kind traces a rectangle', () => {
    expect(recordPath('hologram' as ShapeKind).filter((c) => c === 'lineTo')).toHaveLength(3);
  });
  it('the scene renders every kind: one fill and one stroke each, nothing throws, text drawn', () => {
    const d = makeDoc();
    SHAPE_KINDS.forEach((k, i) => d.create({ kind: 'shape', shape: k, x: i * 240, y: 0, w: 200, h: 120, fill: 'blue', text: `t${i}` }));
    const s = sceneOf(d);
    const f = fakeCtx();
    const target = { width: 0, height: 0, getContext: () => f.ctx };
    const b = s.bounds();
    if (!b) throw new Error('empty');
    renderSceneTo(target, s, defaultPalette('light'), b, 1, 10);
    expect(f.count('fill')).toBe(SHAPE_KINDS.length);
    expect(f.count('stroke')).toBe(SHAPE_KINDS.length);
    expect(f.count('fillText')).toBe(SHAPE_KINDS.length);
  });
});

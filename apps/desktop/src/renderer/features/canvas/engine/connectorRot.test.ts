// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { rotatePoint, rectCenter, dist, type Point } from '../../../lib/canvas/geometry';
import { SIDES, anchorOf, type ConcreteSide } from '../../../lib/canvas/route';
import { isBox, type BoxRec, type ShapeKind } from '../../../lib/canvas/types';
import { destroyRigs, rig, type Rig } from './testRig';

afterEach(destroyRigs);

const SHAPES: ShapeKind[] = ['rect', 'ellipse', 'diamond', 'triangle'];
const ANGLES = [0, 30, 90, 135, 270];
const near = (a: Point | null, b: Point): void => {
  expect(a?.x).toBeCloseTo(b.x, 4);
  expect(a?.y).toBeCloseTo(b.y, 4);
};
const box = (r: Rig, id: string): BoxRec => {
  const o = r.engine.scene.get(id);
  if (!o || !isBox(o)) throw new Error('no box');
  return o;
};
/** The un-turned anchor of a side, turned about the center: the reference computed without route.ts. */
function expected(b: BoxRec, side: ConcreteSide): Point {
  const { x, y, w, h } = b;
  const tri = b.kind === 'shape' && b.shape === 'triangle';
  const local: Record<ConcreteSide, Point> = {
    top: { x: x + w / 2, y },
    bottom: { x: x + w / 2, y: y + h },
    left: tri ? { x: x + w * 0.25, y: y + h / 2 } : { x, y: y + h / 2 },
    right: tri ? { x: x + w * 0.75, y: y + h / 2 } : { x: x + w, y: y + h / 2 },
  };
  return rotatePoint(local[side], rectCenter(b), b.rot ?? 0);
}

describe('a glued connector follows the rotation of its object, in the live scene', () => {
  for (const shape of SHAPES) {
    for (const side of [...SIDES, 'auto'] as const) {
      it(`${shape}, side ${side}: the end sits on the turned side after every change of rot in the doc`, () => {
        const r = rig();
        const [a] = r.make({ init: { kind: 'shape', shape, x: 100, y: 100, w: 200, h: 120, fill: 'blue' } });
        const [c] = r.make({ init: { kind: 'connector', from: { id: a ?? '', side }, to: { x: 700, y: 520 } } });
        r.raf.flush();
        for (const rot of ANGLES) {
          r.engine.doc.patch(a ?? '', { rot });
          const from = r.engine.scene.pointOf(c ?? '', 'from');
          const b = box(r, a ?? '');
          expect(b.rot ?? 0).toBe(rot);
          if (side === 'auto') {
            // The nearest turned anchor to the other end.
            const best = SIDES.map((s) => expected(b, s)).sort((p, q) => dist(p, { x: 700, y: 520 }) - dist(q, { x: 700, y: 520 }))[0];
            near(from, best ?? { x: 0, y: 0 });
          } else near(from, expected(b, side));
          // The routed path is what the renderer draws: its first point is that end.
          const pts = r.engine.scene.get(c ?? '');
          expect(pts && 'points' in pts ? pts.points[0] : NaN).toBeCloseTo(from?.x ?? NaN, 6);
        }
      });
    }
  }

  it('the end of an elbow connector sits on the turned side too', () => {
    const r = rig();
    const [a] = r.make({ init: { kind: 'sticky', x: 100, y: 100, w: 160, h: 100 } });
    const [c] = r.make({ init: { kind: 'connector', from: { id: a ?? '', side: 'right' }, to: { x: 700, y: 520 }, route: 'elbow' } });
    for (const rot of [30, 100, 200]) {
      r.engine.doc.patch(a ?? '', { rot });
      near(r.engine.scene.pointOf(c ?? '', 'from'), anchorOf(box(r, a ?? ''), 'right'));
    }
  });

  it('through the rotation gesture, repeatedly, the end follows on every move, not only at the end', () => {
    const r = rig();
    const [a] = r.make({ init: { kind: 'sticky', x: 350, y: 258, w: 125, h: 124 } });
    const [c] = r.make({ init: { kind: 'connector', from: { id: a ?? '', side: 'right' }, to: { x: 700, y: 520 } } });
    r.engine.setSelection([a ?? '']);
    const pivot = rectCenter(box(r, a ?? ''));
    for (const target of [90, 45]) {
      const f = r.engine.selectionFrame();
      expect(f).not.toBeNull();
      if (!f) return;
      const knob = rotatePoint({ x: pivot.x, y: f.rect.y - 26 }, pivot, f.rot);
      const to = rotatePoint({ x: pivot.x, y: pivot.y - 200 }, pivot, target);
      r.down(knob.x, knob.y);
      const seen: Point[] = [];
      for (let i = 1; i <= 4; i++) {
        const p = { x: knob.x + ((to.x - knob.x) * i) / 4, y: knob.y + ((to.y - knob.y) * i) / 4 };
        r.move(p.x, p.y);
        const b = box(r, a ?? '');
        near(r.engine.scene.pointOf(c ?? '', 'from'), expected(b, 'right'));
        seen.push({ ...(r.engine.scene.pointOf(c ?? '', 'from') ?? { x: 0, y: 0 }) });
      }
      r.up(to.x, to.y);
      expect(new Set(seen.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`)).size).toBeGreaterThan(1);
      expect(box(r, a ?? '').rot ?? 0).toBeCloseTo(target, 0);
    }
  });

  it('rotating a group turns its members, and the connectors glued to them follow', () => {
    const r = rig();
    const [a, b] = r.make({ init: { kind: 'sticky', x: 0, y: 0, w: 100, h: 100 } }, { init: { kind: 'shape', shape: 'ellipse', x: 300, y: 0, w: 100, h: 100 } });
    const [ca, cb] = r.make(
      { init: { kind: 'connector', from: { id: a ?? '', side: 'right' }, to: { x: 200, y: 400 } } },
      { init: { kind: 'connector', from: { x: 200, y: -300 }, to: { id: b ?? '', side: 'left' } } },
    );
    r.engine.setSelection([a ?? '', b ?? '']);
    r.engine.groupSelection();
    r.engine.clearSelection();
    r.click(50, 50);
    // Joint bounds 0..400 × 0..100: the knob hangs 26 px above the middle of the top. Turn the group 90°.
    r.drag([200, -26], [400, 50]);
    expect(box(r, a ?? '').rot).toBe(90);
    near(r.engine.scene.pointOf(ca ?? '', 'from'), expected(box(r, a ?? ''), 'right'));
    near(r.engine.scene.pointOf(cb ?? '', 'to'), expected(box(r, b ?? ''), 'left'));
  });

  it('every pixel is repainted: the old and the new line are both in the dirty rects of the change', () => {
    const r = rig();
    const [a] = r.make({ init: { kind: 'sticky', x: 100, y: 100, w: 160, h: 100 } });
    const [c] = r.make({ init: { kind: 'connector', from: { id: a ?? '', side: 'right' }, to: { x: 700, y: 520 } } });
    r.raf.flush();
    const before = r.engine.scene.get(c ?? '');
    const changes: { dirty: readonly { x: number; y: number; w: number; h: number }[]; ids: ReadonlySet<string> }[] = [];
    r.engine.scene.subscribe((ch) => changes.push(ch));
    r.engine.doc.patch(a ?? '', { rot: 90 });
    const ch = changes[0];
    expect(ch?.ids.has(c ?? '')).toBe(true);
    const after = r.engine.scene.get(c ?? '');
    expect(after).not.toBe(before);
    const covers = (p: Point): boolean => (ch?.dirty ?? []).some((d) => p.x >= d.x && p.x <= d.x + d.w && p.y >= d.y && p.y <= d.y + d.h);
    const pts0 = before && 'points' in before ? before.points : [];
    const pts1 = after && 'points' in after ? after.points : [];
    expect(covers({ x: pts0[0] ?? NaN, y: pts0[1] ?? NaN })).toBe(true);
    expect(covers({ x: pts1[0] ?? NaN, y: pts1[1] ?? NaN })).toBe(true);
  });

  it('the frame after a rotation draws the connector from the turned side (not from where the old side was)', () => {
    const r = rig();
    const [a] = r.make({ init: { kind: 'sticky', x: 350, y: 258, w: 124, h: 124 } });
    const [c] = r.make({ init: { kind: 'connector', from: { id: a ?? '', side: 'right' }, to: { x: 700, y: 520 } } });
    r.raf.flush();
    r.fake.clear();
    r.engine.doc.patch(a ?? '', { rot: 45 });
    r.raf.flush();
    const from = r.engine.scene.pointOf(c ?? '', 'from');
    expect(from?.x).not.toBeCloseTo(474, 0);
    // Every connector path of the repaint starts at the new end; none at the old one.
    const starts: Point[] = [];
    let after = false;
    for (const call of r.fake.calls) {
      if (call.name === 'beginPath') after = true;
      if (after && call.name === 'moveTo') starts.push({ x: Number(call.args[0]), y: Number(call.args[1]) });
      if (call.name === 'stroke') after = false;
    }
    expect(starts.some((p) => Math.abs(p.x - (from?.x ?? NaN)) < 1e-6 && Math.abs(p.y - (from?.y ?? NaN)) < 1e-6)).toBe(true);
    expect(starts.some((p) => Math.abs(p.x - 474) < 1e-6 && Math.abs(p.y - 320) < 1e-6)).toBe(false);
  });

  it('a lock or a group change recomputes nothing: connectors keep their records and no content frame is asked for', () => {
    const r = rig();
    const [a, b] = r.make({ init: { kind: 'sticky', x: 100, y: 100 } }, { init: { kind: 'sticky', x: 500, y: 100 } });
    const [c] = r.make({ init: { kind: 'connector', from: { id: a ?? '', side: 'right' }, to: { id: b ?? '', side: 'left' } } });
    r.raf.flush();
    const rec = r.engine.scene.get(c ?? '');
    const misses = r.engine.scene.routes.misses;
    r.engine.setSelection([a ?? '', b ?? '']);
    r.engine.toggleLock();
    r.engine.groupSelection();
    expect(r.engine.scene.get(c ?? '')).toBe(rec);
    expect(r.engine.scene.routes.misses).toBe(misses);
  });

  it('at rest after a rotation: no frame scheduled, one connector re-route per gesture move', () => {
    const r = rig();
    const [a] = r.make({ init: { kind: 'sticky', x: 350, y: 258, w: 124, h: 124 } });
    r.make({ init: { kind: 'connector', from: { id: a ?? '', side: 'right' }, to: { x: 700, y: 520 }, route: 'elbow' } });
    r.engine.setSelection([a ?? '']);
    r.raf.flush();
    const before = r.engine.scene.routes.misses + r.engine.scene.routes.hits;
    r.down(412, 258 - 26);
    for (let i = 1; i <= 10; i++) r.move(412 + i * 10, 232 + i * 5);
    r.up(512, 282);
    r.raf.flush();
    expect(r.engine.scene.routes.misses + r.engine.scene.routes.hits - before).toBe(10);
    r.raf.flush();
    expect(r.raf.pending).toBe(0);
    expect(r.engine.renderer.frameScheduled).toBe(false);
  });
});

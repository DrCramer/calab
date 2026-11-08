import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { parse, serialize, toInits } from './clipboard';
import { CanvasDoc } from './doc';
import { FRAME_TITLE_H, framePresetSize } from './frames';
import { Scene, visualBounds } from './scene';
import { ids, makeDoc } from './testing';
import { TextLayouter } from './textLayout';
import { MAX_TITLE, type FrameRec } from './types';

const sceneOf = (d: CanvasDoc): Scene => new Scene(d, new TextLayouter((t, s) => t.length * s * 0.5));
const frame = (s: Scene, id: string): FrameRec => {
  const o = s.get(id);
  if (o?.kind !== 'frame') throw new Error(`${id} is not a frame`);
  return o;
};

describe('the frame kind in the document', () => {
  it('is created with defaults, a one-line clamped title and a plain hue (a soft prefix is the same hue)', () => {
    const d = makeDoc();
    const a = d.create({ kind: 'frame', x: 10, y: 20 }) ?? '';
    expect(d.snapshot(a)).toMatchObject({ kind: 'frame', x: 10, y: 20, w: 960, h: 540, title: '', fill: 'white' });
    expect(d.snapshot(a)).not.toHaveProperty('text');
    const b = d.create({ kind: 'frame', x: 0, y: 0, w: 5, h: 5, title: 'Line\none\t' + 'x'.repeat(300), fill: 'soft:blue', rot: 30 }) ?? '';
    const sb = d.snapshot(b);
    expect(sb).toMatchObject({ w: 80, h: 80, fill: 'blue' });
    expect(sb?.title).toHaveLength(MAX_TITLE);
    expect(String(sb?.title).startsWith('Line one ')).toBe(true);
    // A frame never rotates.
    expect(sb).not.toHaveProperty('rot');
  });

  it('patches only its own keys; setText / getText are its title', () => {
    const d = makeDoc();
    const a = d.create({ kind: 'frame', x: 0, y: 0, title: 'A' }) ?? '';
    d.patch(a, { title: 'Team', fill: 'soft:green', rot: 45, w: 10, color: 'red' });
    expect(d.snapshot(a)).toMatchObject({ title: 'Team', fill: 'green', w: 80 });
    expect(d.objects.get(a)?.has('rot')).toBe(false);
    expect(d.objects.get(a)?.has('color')).toBe(false);
    d.setText(a, 'Renamed');
    expect(d.getText(a)).toBe('Renamed');
    d.setRich(a, 'Rich', undefined);
    expect(d.getText(a)).toBe('Rich');
    expect(d.objects.get(a)?.get('text')).toBeUndefined();
  });

  it('the scene reads it; its visual bounds take the title band above', () => {
    const d = makeDoc();
    const a = d.create({ kind: 'frame', x: 0, y: 100, w: 400, h: 300, title: 'Sprint', fill: 'none' }) ?? '';
    const s = sceneOf(d);
    expect(frame(s, a)).toMatchObject({ x: 0, y: 100, w: 400, h: 300, title: 'Sprint', fill: 'none' });
    const vb = visualBounds(frame(s, a));
    expect(vb.y).toBeLessThanOrEqual(100 - FRAME_TITLE_H);
    expect(vb.y + vb.h).toBeGreaterThanOrEqual(400);
  });

  it('presets have the sizes the tool offers', () => {
    expect(framePresetSize('16:9')).toEqual({ w: 960, h: 540 });
    expect(framePresetSize('1:1')).toEqual({ w: 720, h: 720 });
    expect(framePresetSize('a4').h / framePresetSize('a4').w).toBeCloseTo(297 / 210, 2);
  });
});

describe('z-order and picking', () => {
  it('a frame is always below the other objects, whatever its z; among frames z decides', () => {
    const d = makeDoc();
    const st = d.create({ kind: 'sticky', x: 50, y: 50 }) ?? '';
    const f1 = d.create({ kind: 'frame', x: 0, y: 0, w: 400, h: 400 }) ?? '';
    const f2 = d.create({ kind: 'frame', x: 100, y: 100, w: 400, h: 400 }) ?? '';
    const s = sceneOf(d);
    expect(s.orderedIds()).toEqual([f1, f2, st]);
    d.bringToFront([f1]);
    expect(s.orderedIds()).toEqual([f2, f1, st]);
    expect(s.frames().map((f) => f.id)).toEqual([f2, f1]);
    // Drawn in that order: the culled query keeps it.
    expect(s.query({ x: 0, y: 0, w: 500, h: 500 }).map((o) => o.id)).toEqual([f2, f1, st]);
  });

  it('a click inside picks the object under the pointer first, the frame by its empty area or its title', () => {
    const d = makeDoc();
    const f = d.create({ kind: 'frame', x: 0, y: 0, w: 600, h: 400, title: 'Board' }) ?? '';
    const st = d.create({ kind: 'sticky', x: 100, y: 100 }) ?? '';
    const s = sceneOf(d);
    expect(s.hit({ x: 150, y: 150 }, 2)?.id).toBe(st);
    expect(s.hit({ x: 500, y: 300 }, 2)?.id).toBe(f);
    // The title over the top-left corner («Board», 18 px: ~45 world units wide in the test measure).
    expect(s.hit({ x: 10, y: -12 }, 2)?.id).toBe(f);
    expect(s.hit({ x: 300, y: -12 }, 2)).toBeNull();
  });

  it('the marquee takes a frame only whole, so a rect inside it picks its contents', () => {
    const d = makeDoc();
    const f = d.create({ kind: 'frame', x: 0, y: 0, w: 600, h: 400 }) ?? '';
    const st = d.create({ kind: 'sticky', x: 100, y: 100 }) ?? '';
    const s = sceneOf(d);
    expect(s.inRect({ x: 50, y: 50, w: 300, h: 300 }).map((o) => o.id)).toEqual([st]);
    expect(s.inRect({ x: -10, y: -10, w: 700, h: 500 }).map((o) => o.id).sort()).toEqual([f, st].sort());
  });
});

describe('membership (computed, never stored)', () => {
  it('holds the objects whose center is inside, nested frames and what they hold', () => {
    const d = makeDoc();
    const big = d.create({ kind: 'frame', x: 0, y: 0, w: 1000, h: 800 }) ?? '';
    const small = d.create({ kind: 'frame', x: 500, y: 400, w: 400, h: 300 }) ?? '';
    const inBig = d.create({ kind: 'sticky', x: 100, y: 100 }) ?? '';
    const inSmall = d.create({ kind: 'sticky', x: 600, y: 450 }) ?? '';
    // Center outside (the sticky only overlaps the edge).
    const edge = d.create({ kind: 'sticky', x: 950, y: 100 }) ?? '';
    const s = sceneOf(d);
    expect(s.frameMembers(big).sort()).toEqual([small, inBig, inSmall].sort());
    expect(s.frameMembers(small)).toEqual([inSmall]);
    expect(s.frameMembers(inBig)).toEqual([]);
    expect(s.withFrameMembers([small, edge]).sort()).toEqual([small, inSmall, edge].sort());
    // Dragged out: no longer a member, and nothing was written about it.
    d.patch(inBig, { x: 2000 });
    expect(s.frameMembers(big)).not.toContain(inBig);
    expect(d.objects.get(big)?.has('members')).toBe(false);
  });

  it('two frames of the same size never hold each other', () => {
    const d = makeDoc();
    const a = d.create({ kind: 'frame', x: 0, y: 0, w: 400, h: 400 }) ?? '';
    const b = d.create({ kind: 'frame', x: 10, y: 10, w: 400, h: 400 }) ?? '';
    const s = sceneOf(d);
    expect(s.frameMembers(a)).toEqual([]);
    expect(s.frameMembers(b)).toEqual([]);
  });
});

describe('clipboard', () => {
  it('round-trips a frame with its title and fill, under fresh ids', () => {
    const d = makeDoc();
    const f = d.create({ kind: 'frame', x: 10, y: 10, w: 300, h: 200, title: 'Anna', fill: 'pink', locked: true }) ?? '';
    const s = sceneOf(d);
    const payload = parse(serialize(s, d, [f]) ?? '');
    expect(payload?.objects[0]).toMatchObject({ kind: 'frame', title: 'Anna', fill: 'pink' });
    const inits = toInits(payload ?? { v: 1, objects: [] }, 20, 0, ids('n'));
    expect(inits).toEqual([{ id: 'n1', init: { kind: 'frame', x: 30, y: 10, w: 300, h: 200, title: 'Anna', fill: 'pink', locked: true } }]);
  });
});

describe('a build that does not know frames', () => {
  /** Writes a frame-shaped object under a kind this build does not know: what an older build sees in a doc with frames. */
  const unknown = (d: CanvasDoc, id: string): void => {
    d.ydoc.transact(() => {
      const m = new Y.Map<unknown>();
      d.objects.set(id, m);
      m.set('kind', 'frame-v2');
      m.set('z', 'a0');
      m.set('x', 0);
      m.set('y', 0);
      m.set('w', 600);
      m.set('h', 400);
      m.set('title', 'Board');
      m.set('fill', 'blue');
    });
  };

  it('skips it in the scene, the hit test, the snapshot and the clipboard, and keeps it in the doc', () => {
    const d = makeDoc();
    const st = d.create({ kind: 'sticky', x: 100, y: 100 }) ?? '';
    unknown(d, 'ff');
    const s = sceneOf(d);
    expect(s.size).toBe(1);
    expect(s.frames()).toEqual([]);
    expect(s.hit({ x: 500, y: 300 }, 2)).toBeNull();
    expect(s.hit({ x: 150, y: 150 }, 2)?.id).toBe(st);
    expect(d.snapshot('ff')).toBeNull();
    expect(serialize(s, d, ['ff'])).toBeNull();
    d.patch('ff', { title: 'x' });
    expect(d.objects.get('ff')?.get('title')).toBe('Board');
  });
});

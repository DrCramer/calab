import { describe, expect, it, vi } from 'vitest';
import type { Rect } from '../../../lib/canvas/geometry';
import { LiveLayer } from '../../../lib/canvas/live';
import { Scene } from '../../../lib/canvas/scene';
import { makeDoc } from '../../../lib/canvas/testing';
import { TextLayouter } from '../../../lib/canvas/textLayout';
import { DrawGesture, EraseGesture, type Core, type InkStyle } from './gestures';
import { emptyOverlay, type InkPreview } from './overlay';
import { defaultPalette } from './palette';
import { Renderer } from './renderer';
import { AwarenessLayer } from './awareness';
import { fakeCanvas, fakeCtx, manualRaf } from './testing';


/** The part of the engine the pen and the eraser use, over a real document and scene. */
function core(style: InkStyle = { color: 'blue', width: 4, marker: false }) {
  const doc = makeDoc();
  const scene = new Scene(doc, new TextLayouter((t, s) => t.length * s * 0.5));
  const previews: { ink: InkPreview | null; dirty: Rect | null }[] = [];
  const refused = vi.fn();
  const c = {
    doc, scene, inkStyle: style, eraserPx: 8,
    live: new LiveLayer(doc, scene, { setTimer: () => 0, clearTimer: () => {} }),
    px: (n: number) => n,
    previewInk: (ink: InkPreview | null, dirty: Rect | null) => previews.push({ ink: ink ? { ...ink, points: [...ink.points] } : null, dirty }),
    refuseCreate: refused,
  };
  return { core: c as unknown as Core, doc, scene, previews, refused };
}

const draw = (t: ReturnType<typeof core>, pts: [number, number][]): DrawGesture => {
  const [first, ...rest] = pts;
  const g = new DrawGesture(t.core, { x: first?.[0] ?? 0, y: first?.[1] ?? 0 });
  for (const [x, y] of rest) g.move({ x, y });
  return g;
};

describe('DrawGesture', () => {
  it('previews while drawing (the tail only) and writes one stroke, one undo step, on release', () => {
    const t = core();
    const g = draw(t, [[100, 100], [110, 100], [120, 105], [130, 120]]);
    expect(t.doc.count).toBe(0);
    expect(t.previews[0]?.dirty).toBeNull();
    // Each move repaints the last four points' box plus half the width and a 2 px margin.
    expect(t.previews[t.previews.length - 1]?.dirty).toEqual({ x: 96, y: 96, w: 38, h: 28 });
    g.end({ x: 140, y: 120 });
    expect(t.previews[t.previews.length - 1]?.ink).toBeNull();
    expect(t.doc.count).toBe(1);
    const id = t.scene.orderedIds()[0] ?? '';
    expect(t.doc.snapshot(id)).toMatchObject({ kind: 'ink', x: 100, y: 100, w: 40, h: 20, stroke: 'blue', strokeWidth: 4 });
    expect(t.doc.snapshot(id)?.marker).toBeUndefined();
    expect(t.doc.undo.undoStack.length).toBe(1);
    t.doc.undo.undo();
    expect(t.doc.count).toBe(0);
  });
  it('the marker is stored as such; a click is a dot', () => {
    const t = core({ color: 'yellow', width: 20, marker: true });
    const g = draw(t, [[50, 50]]);
    g.end({ x: 50, y: 50 });
    const id = t.scene.orderedIds()[0] ?? '';
    expect(t.doc.snapshot(id)).toMatchObject({ kind: 'ink', points: [0, 0, 0, 0], marker: true, strokeWidth: 20 });
  });
  it('skips points closer than half a pixel; Esc writes nothing', () => {
    const t = core();
    const g = draw(t, [[0, 0], [0.2, 0.1], [0.3, 0.3], [10, 0]]);
    expect(g.points).toEqual([0, 0, 10, 0]);
    g.cancel();
    expect(t.previews[t.previews.length - 1]?.ink).toBeNull();
    expect(t.doc.count).toBe(0);
  });
  it('two strokes are two undo steps; a refused create is said', () => {
    const t = core();
    draw(t, [[0, 0], [10, 10]]).end({ x: 20, y: 0 });
    draw(t, [[0, 50], [10, 60]]).end({ x: 20, y: 50 });
    expect(t.doc.undo.undoStack.length).toBe(2);
    expect(t.refused).not.toHaveBeenCalled();
    vi.spyOn(t.doc, 'create').mockReturnValue(null);
    draw(t, [[0, 0], [5, 5]]).end({ x: 5, y: 5 });
    expect(t.refused).toHaveBeenCalledTimes(1);
  });
});

describe('EraseGesture', () => {
  const setup = () => {
    const t = core();
    const [a, b, locked, sticky] = t.doc.createMany([
      { init: { kind: 'ink', x: 0, y: 0, w: 100, h: 1, points: [0, 0, 100, 0], strokeWidth: 4 } },
      { init: { kind: 'ink', x: 0, y: 200, w: 100, h: 1, points: [0, 0, 100, 0], strokeWidth: 4 } },
      { init: { kind: 'ink', x: 0, y: 100, w: 100, h: 1, points: [0, 0, 100, 0], strokeWidth: 4, locked: true } },
      { init: { kind: 'sticky', x: 300, y: 0 } },
    ]);
    t.doc.checkpoint();
    return { t, a: a ?? '', b: b ?? '', locked: locked ?? '', sticky: sticky ?? '' };
  };

  it('takes exactly the swath under its ring: the line stays one object, picked beside the hole, not in it', () => {
    const { t, a } = setup();
    const g = new EraseGesture(t.core, { x: 50, y: -20 });
    g.move({ x: 50, y: 20 });
    // Shown at once (the live layer), written on release. The press itself was out of reach (20 > 8 + 2).
    expect(t.scene.get(a)).toMatchObject({ erase: [50, -20, 50, 20, 8] });
    expect(t.doc.snapshot(a)?.erase).toBeUndefined();
    g.end({ x: 50, y: 20 });
    // Stored in the points' own frame: a flat line sits half a unit into its 1-unit-high frame.
    expect(t.doc.snapshot(a)?.erase).toEqual([50, -20.5, 50, 19.5, 8]);
    expect(t.scene.query({ x: -1, y: -5, w: 102, h: 10 }).filter((o) => o.kind === 'ink')).toHaveLength(1);
    expect(t.scene.hit({ x: 50, y: 0 }, 0)?.id).toBeUndefined();
    expect(t.scene.hit({ x: 40, y: 0 }, 0)?.id).toBe(a);
  });
  it('a stroke the swaths cover entirely is deleted; locked strokes and other kinds stay; one undo step', () => {
    const { t, a, b, locked, sticky } = setup();
    const [short] = t.doc.createMany([{ init: { kind: 'ink', x: 0, y: 300, w: 10, h: 1, points: [0, 0, 10, 0], strokeWidth: 4 } }]);
    t.doc.checkpoint();
    const steps = t.doc.undo.undoStack.length;
    // A swipe down across all three lines, along the short one and on over the sticky.
    const g = new EraseGesture(t.core, { x: 50, y: -40 });
    g.move({ x: 50, y: 260 });
    g.move({ x: -10, y: 300 });
    g.move({ x: 20, y: 300 });
    g.move({ x: 350, y: 50 });
    g.end({ x: 350, y: 60 });
    expect(g.touched.has(a) && g.touched.has(b) && g.touched.has(short ?? '')).toBe(true);
    expect(g.touched.has(locked) || g.touched.has(sticky)).toBe(false);
    expect(t.scene.has(short ?? '')).toBe(false);
    expect(t.scene.has(a) && t.scene.has(b) && t.scene.has(locked) && t.scene.has(sticky)).toBe(true);
    expect(t.doc.snapshot(locked)?.erase).toBeUndefined();
    expect(t.doc.undo.undoStack.length).toBe(steps + 1);
    t.doc.undo.undo();
    expect(t.scene.has(short ?? '')).toBe(true);
    expect(t.doc.snapshot(a)?.erase).toBeUndefined();
  });
  it('misses a line farther than its radius plus half the width; Esc gives everything back', () => {
    const { t, a } = setup();
    const g = new EraseGesture(t.core, { x: 50, y: -11 });
    expect(g.touched.size).toBe(0);
    g.move({ x: 50, y: -8 });
    expect(g.touched.has(a)).toBe(true);
    g.cancel();
    expect(t.scene.get(a)).not.toHaveProperty('erase');
    expect(t.doc.snapshot(a)?.erase).toBeUndefined();
  });
  it('a resized stroke keeps its hole where it was cut', () => {
    const { t, a } = setup();
    const g = new EraseGesture(t.core, { x: 50, y: -20 });
    g.end({ x: 50, y: 20 });
    t.doc.patch(a, { w: 200 });
    const o = t.scene.get(a);
    if (o?.kind !== 'ink') throw new Error('no stroke');
    // Stretched twice along x: the swath moved to the middle of the new length.
    expect(o.erase?.[0]).toBeCloseTo(100);
    expect(t.scene.hit({ x: 100, y: 0 }, 0)?.id).toBeUndefined();
  });
  it('a drag that erases nothing leaves no undo step', () => {
    const { t } = setup();
    const steps = t.doc.undo.undoStack.length;
    const g = new EraseGesture(t.core, { x: 500, y: 500 });
    g.end({ x: 600, y: 600 });
    expect(t.doc.undo.undoStack.length).toBe(steps);
  });
});

describe('Renderer: the stroke in progress', () => {
  it('a piece of the overlay composites only its box; anything else composites all', () => {
    const doc = makeDoc();
    const scene = new Scene(doc);
    const canvas = fakeCanvas();
    const layer = fakeCtx();
    const raf = manualRaf();
    let overlay = emptyOverlay();
    const r = new Renderer({
      canvas: canvas as unknown as HTMLCanvasElement, scene, palette: defaultPalette('light'),
      getCamera: () => ({ tx: 0, ty: 0, scale: 1 }), getOverlay: () => overlay, awareness: new AwarenessLayer(),
      raf: raf.raf, cancelRaf: raf.cancel, makeLayer: () => ({ width: 0, height: 0, getContext: () => layer.ctx }),
    });
    r.resize(800, 600, 1);
    raf.flush();
    canvas.fake.clear();
    overlay = { ...overlay, ink: { points: [10, 10, 50, 50], color: 'blue', width: 4, marker: false } };
    r.requestOverlayRect({ x: 0, y: 0, w: 60, h: 60 });
    raf.flush();
    expect(r.stats.partial).toBe(1);
    // The layer is copied back for that box only, under a clip; the stroke is painted.
    const blit = canvas.fake.calls.find((c) => c.name === 'drawImage');
    expect(blit?.args.slice(1)).toEqual([0, 0, 62, 62, 0, 0, 62, 62]);
    expect(canvas.fake.count('clip')).toBe(1);
    expect(canvas.fake.count('stroke')).toBe(1);
    canvas.fake.clear();
    r.requestOverlayRect({ x: 0, y: 0, w: 10, h: 10 });
    r.requestFrame();
    raf.flush();
    expect(r.stats.partial).toBe(1);
    expect(canvas.fake.calls.find((c) => c.name === 'drawImage')?.args.length).toBe(3);
  });
});

describe('Renderer: a drag composites only what changed', () => {
  it('a moved sticky and its selection frame: their old and new boxes, not the whole screen; a scroll: everything', () => {
    const doc = makeDoc();
    const scene = new Scene(doc);
    const canvas = fakeCanvas();
    const remote = fakeCanvas();
    const layer = fakeCtx();
    const raf = manualRaf();
    let overlay = emptyOverlay();
    let cam = { tx: 0, ty: 0, scale: 1 };
    const r = new Renderer({
      canvas: canvas as unknown as HTMLCanvasElement, remoteCanvas: remote as unknown as HTMLCanvasElement, scene, palette: defaultPalette('light'),
      getCamera: () => cam, getOverlay: () => overlay, awareness: new AwarenessLayer(),
      raf: raf.raf, cancelRaf: raf.cancel, makeLayer: () => ({ width: 0, height: 0, getContext: () => layer.ctx }),
    });
    r.resize(1600, 1000, 1);
    const [id] = doc.createMany([{ init: { kind: 'sticky', x: 100, y: 100, w: 100, h: 100 } }]);
    overlay = { ...overlay, outlines: [{ rect: { x: 100, y: 100, w: 100, h: 100 }, rot: 0 }] };
    raf.flush();
    canvas.fake.clear();
    // One step of a drag: the sticky moves 20 to the right, its outline with it.
    doc.patch(id ?? '', { x: 120 });
    overlay = { ...overlay, outlines: [{ rect: { x: 120, y: 100, w: 100, h: 100 }, rot: 0 }] };
    r.requestFrame();
    raf.flush();
    expect(r.stats.partial).toBe(1);
    const blits = canvas.fake.calls.filter((c) => c.name === 'drawImage');
    expect(blits.length).toBeGreaterThan(0);
    // Every copied piece is a part of the screen around the sticky, far from the full 1600 × 1000.
    for (const b of blits) {
      const [, x = 0, y = 0, w = 0, h = 0] = b.args as number[];
      expect(w * h).toBeLessThan(0.1 * 1600 * 1000);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
    }
    canvas.fake.clear();
    cam = { tx: 30, ty: 0, scale: 1 };
    r.requestFrame();
    raf.flush();
    expect(r.stats.partial).toBe(1);
    expect(canvas.fake.calls.find((c) => c.name === 'drawImage')?.args.length).toBe(3);
  });
});

describe('Renderer: a lifted drag', () => {
  it('moves one sprite: no content repaint while the objects travel, and they are painted back on drop', () => {
    const doc = makeDoc();
    const scene = new Scene(doc);
    const canvas = fakeCanvas();
    const remote = fakeCanvas();
    const layer = fakeCtx();
    const sprite = fakeCtx();
    const raf = manualRaf();
    const r = new Renderer({
      canvas: canvas as unknown as HTMLCanvasElement, remoteCanvas: remote as unknown as HTMLCanvasElement, scene, palette: defaultPalette('light'),
      getCamera: () => ({ tx: 0, ty: 0, scale: 1 }), getOverlay: () => emptyOverlay(), awareness: new AwarenessLayer(),
      raf: raf.raf, cancelRaf: raf.cancel,
      makeLayer: (w) => ({ width: 0, height: 0, getContext: () => (w > 1 && w < 1600 ? sprite.ctx : layer.ctx) }),
    });
    r.resize(1600, 1000, 1);
    const [a, b] = doc.createMany([
      { init: { kind: 'sticky', x: 100, y: 100, w: 100, h: 100 } },
      { init: { kind: 'sticky', x: 250, y: 100, w: 100, h: 100 } },
    ]);
    raf.flush();
    expect(r.liftObjects([a ?? '', b ?? ''])).toBe(true);
    raf.flush();
    // Painted once into the sprite (both stickies), the layer once without them.
    expect(sprite.count('fill')).toBeGreaterThan(0);
    const regions = r.stats.regions;
    for (let i = 1; i <= 5; i++) {
      doc.patchMany(new Map([[a ?? '', { x: 100 + 10 * i }], [b ?? '', { x: 250 + 10 * i }]]));
      raf.flush();
    }
    expect(r.stats.regions).toBe(regions);
    expect(r.stats.sprite).toBeGreaterThanOrEqual(5);
    r.dropLift();
    raf.flush();
    expect(r.stats.regions).toBeGreaterThan(regions);
    // Too big to lift: the drag paints as before.
    const [huge] = doc.createMany([{ init: { kind: 'shape', shape: 'rect', x: 0, y: 0, w: 5000, h: 5000 } }]);
    expect(r.liftObjects([huge ?? ''])).toBe(false);
  });
});

describe('Renderer: peers keep moving during a partial frame', () => {
  it('a remote cursor change is painted even when the main canvas composites only a piece', () => {
    const doc = makeDoc();
    const scene = new Scene(doc);
    const canvas = fakeCanvas();
    const remote = fakeCanvas();
    const layer = fakeCtx();
    const raf = manualRaf();
    let overlay = emptyOverlay();
    const r = new Renderer({
      canvas: canvas as unknown as HTMLCanvasElement, remoteCanvas: remote as unknown as HTMLCanvasElement, scene, palette: defaultPalette('light'),
      getCamera: () => ({ tx: 0, ty: 0, scale: 1 }), getOverlay: () => overlay, awareness: new AwarenessLayer(),
      raf: raf.raf, cancelRaf: raf.cancel, makeLayer: () => ({ width: 0, height: 0, getContext: () => layer.ctx }),
    });
    r.resize(1600, 1000, 1);
    raf.flush();
    const remoteBefore = r.stats.remote;
    overlay = { ...overlay, outlines: [{ rect: { x: 100, y: 100, w: 50, h: 50 }, rot: 0 }] };
    r.requestFrame();
    r.requestRemoteFrame();
    raf.flush();
    expect(r.stats.partial).toBeGreaterThan(0);
    expect(r.stats.remote).toBeGreaterThan(remoteBefore);
  });
});


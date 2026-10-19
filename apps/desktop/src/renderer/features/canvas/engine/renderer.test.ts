import { describe, expect, it } from 'vitest';
import { Scene } from '../../../lib/canvas/scene';
import { makeDoc } from '../../../lib/canvas/testing';
import { AwarenessLayer } from './awareness';
import { emptyOverlay } from './overlay';
import { defaultPalette } from './palette';
import { Renderer, renderSceneTo } from './renderer';
import { fakeCanvas, fakeCtx, manualRaf, type FakeCtx } from './testing';
import type { Camera } from '../../../lib/canvas/camera';
import type { CanvasDoc } from '../../../lib/canvas/doc';

interface Rig {
  doc: CanvasDoc;
  scene: Scene;
  r: Renderer;
  cam: Camera;
  setCam(c: Partial<Camera>): void;
  canvas: ReturnType<typeof fakeCanvas>;
  layer: FakeCtx;
  raf: ReturnType<typeof manualRaf>;
  now: { t: number };
}

function rig(opts: { objects?: number; size?: [number, number]; dpr?: number; maxDpr?: number } = {}): Rig {
  const doc = makeDoc();
  const n = opts.objects ?? 0;
  if (n > 0) {
    doc.createMany(Array.from({ length: n }, (_, i) => ({ init: { kind: 'sticky' as const, x: (i % 100) * 200, y: Math.floor(i / 100) * 200, text: `n${i}` } })));
  }
  const scene = new Scene(doc);
  const canvas = fakeCanvas();
  const layer = fakeCtx();
  const raf = manualRaf();
  const now = { t: 1000 };
  const state = { cam: { tx: 0, ty: 0, scale: 1 } };
  const r = new Renderer({
    canvas: canvas as unknown as HTMLCanvasElement,
    scene,
    palette: defaultPalette('light'),
    getCamera: () => state.cam,
    getOverlay: emptyOverlay,
    awareness: new AwarenessLayer(),
    raf: raf.raf,
    cancelRaf: raf.cancel,
    now: () => now.t,
    makeLayer: () => ({ width: 0, height: 0, getContext: () => layer.ctx }),
    ...(opts.maxDpr ? { maxDpr: opts.maxDpr } : {}),
  });
  const [w, h] = opts.size ?? [800, 600];
  r.resize(w, h, opts.dpr ?? 1);
  return {
    doc, scene, r, canvas, layer, raf, now,
    get cam() {
      return state.cam;
    },
    setCam: (c) => {
      state.cam = { ...state.cam, ...c };
      r.requestFrame();
    },
  };
}

describe('Renderer: on demand', () => {
  it('draws one frame after the first resize and then goes completely idle', () => {
    const t = rig({ objects: 10 });
    expect(t.raf.pending).toBe(1);
    t.raf.flush();
    expect(t.r.stats.frames).toBe(1);
    expect(t.r.stats.full).toBe(1);
    // Idle: nothing scheduled, and nothing arrives by itself.
    expect(t.raf.pending).toBe(0);
    expect(t.r.frameScheduled).toBe(false);
    expect(t.r.pendingDirty).toBe(false);
    const scheduled = t.raf.scheduled;
    t.raf.flush();
    expect(t.raf.scheduled).toBe(scheduled);
  });
  it('coalesces any number of invalidations into one frame', () => {
    const t = rig({ objects: 5 });
    t.raf.flush();
    for (let i = 0; i < 100; i++) t.doc.patch('o1', { x: i });
    expect(t.raf.pending).toBe(1);
    t.raf.flush();
    expect(t.r.stats.frames).toBe(2);
  });
  it('repaints only the dirty region when an object changes', () => {
    const t = rig({ objects: 50 });
    t.raf.flush();
    t.layer.clear();
    const regions = t.r.stats.regions;
    t.doc.patch('o1', { x: 5 });
    t.raf.flush();
    expect(t.r.stats.full).toBe(1);
    expect(t.r.stats.regions).toBe(regions + 1);
    // Clipped to a region far smaller than the canvas.
    const clip = t.layer.calls.find((c) => c.name === 'rect');
    expect((clip?.args[2] as number) < 400).toBe(true);
  });
  it('does not schedule anything while hidden and repaints everything when shown again', () => {
    const t = rig({ objects: 5 });
    t.raf.flush();
    t.r.setActive(false);
    t.doc.patch('o1', { x: 9 });
    expect(t.raf.pending).toBe(0);
    t.r.setActive(true);
    expect(t.raf.pending).toBe(1);
    t.raf.flush();
    expect(t.r.stats.full).toBe(2);
  });
  it('cancels a pending frame on hide and on destroy', () => {
    const t = rig();
    t.r.setActive(false);
    expect(t.raf.pending).toBe(0);
    t.r.setActive(true);
    t.r.destroy();
    expect(t.raf.pending).toBe(0);
    t.doc.create({ kind: 'sticky', x: 0, y: 0 });
    expect(t.raf.pending).toBe(0);
  });
});

describe('Renderer: panning keeps a cached layer', () => {
  it('blits the layer shifted and paints only the exposed strip', () => {
    const t = rig({ objects: 2000, size: [1000, 800] });
    t.raf.flush();
    const fullDrawn = t.r.stats.drawn;
    t.layer.clear();
    t.setCam({ tx: -120, ty: 0 });
    t.raf.flush();
    expect(t.r.stats.scrolled).toBe(1);
    expect(t.r.stats.full).toBe(1);
    const blit = t.layer.calls.find((c) => c.name === 'drawImage');
    expect(blit?.args.slice(1)).toEqual([-120, 0]);
    // The strip is 120 px wide: far fewer objects than the first full frame.
    expect(t.r.stats.drawn).toBeLessThan(fullDrawn / 2);
  });
  it('handles diagonal moves with two strips', () => {
    const t = rig({ objects: 100, size: [1000, 800] });
    t.raf.flush();
    const regions = t.r.stats.regions;
    t.setCam({ tx: 30, ty: 40 });
    t.raf.flush();
    expect(t.r.stats.regions).toBe(regions + 2);
  });
  it('repaints fully when moved further than the viewport', () => {
    const t = rig({ objects: 10, size: [500, 400] });
    t.raf.flush();
    t.setCam({ tx: 600 });
    t.raf.flush();
    expect(t.r.stats.full).toBe(2);
    expect(t.r.stats.scrolled).toBe(0);
  });
  it('repaints fully when the zoom changes', () => {
    const t = rig({ objects: 10 });
    t.raf.flush();
    t.setCam({ scale: 2 });
    t.raf.flush();
    expect(t.r.stats.full).toBe(2);
  });
  it('shifts by whole device pixels (no blur)', () => {
    const t = rig({ objects: 3, dpr: 2 });
    t.raf.flush();
    t.layer.clear();
    t.setCam({ tx: -10.3 });
    t.raf.flush();
    const blit = t.layer.calls.find((c) => c.name === 'drawImage');
    const dx = blit?.args[1] as number;
    expect(Number.isInteger(dx)).toBe(true);
    expect(dx).toBe(-21); // -10.3 css px → -20.6 → 21 device px
  });
  it('a pan that changes nothing visible still costs no object drawing', () => {
    const t = rig({ objects: 10 });
    t.raf.flush();
    const drawn = t.r.stats.drawn;
    t.r.requestFrame();
    t.raf.flush();
    expect(t.r.stats.drawn).toBe(0);
    expect(drawn).toBeGreaterThan(0);
  });
});

describe('Renderer: culling and quality', () => {
  it('draws only the objects in view out of 5000', () => {
    const t = rig({ objects: 5000, size: [1920, 1080] });
    t.raf.flush();
    expect(t.r.stats.drawn).toBeGreaterThan(20);
    expect(t.r.stats.drawn).toBeLessThan(250);
  });
  it('clamps DPR to 2, and to 1 in low-power mode', () => {
    const t = rig({ dpr: 3 });
    expect(t.canvas.width).toBe(1600);
    expect(t.r.devicePixelRatio).toBe(2);
    const lp = rig({ dpr: 3, maxDpr: 1 });
    expect(lp.canvas.width).toBe(800);
    t.r.setMaxDpr(1);
    expect(t.canvas.width).toBe(800);
  });
  it('never uses shadows or blur', () => {
    const t = rig({ objects: 20 });
    t.raf.flush();
    expect(t.layer.state.shadowBlur).toBeUndefined();
    expect(t.layer.state.shadowColor).toBeUndefined();
    expect(t.layer.state.filter).toBeUndefined();
    expect(t.canvas.fake.state.shadowBlur).toBeUndefined();
  });
  it('draws glyphs at normal zoom and plaques below 25 %', () => {
    const t = rig({ objects: 4 });
    t.raf.flush();
    expect(t.layer.count('fillText')).toBeGreaterThan(0);
    t.layer.clear();
    t.setCam({ scale: 0.2 });
    t.raf.flush();
    expect(t.layer.count('fillText')).toBe(0);
    expect(t.layer.count('fillRect')).toBeGreaterThan(4); // background + plaques
  });
  it('does not draw the text of the object under edit', () => {
    const t = rig({ objects: 1 });
    t.raf.flush();
    t.layer.clear();
    t.r.setHiddenText('o1');
    t.raf.flush();
    expect(t.layer.count('fillText')).toBe(0);
    t.r.setHiddenText(null);
    t.layer.clear();
    t.raf.flush();
    expect(t.layer.count('fillText')).toBe(1);
  });
  it('caches text layout: a repaint of unchanged text does not re-measure', () => {
    const t = rig({ objects: 30 });
    t.raf.flush();
    const misses = t.scene.text.misses;
    t.r.invalidateAll();
    t.raf.flush();
    expect(t.scene.text.misses).toBe(misses);
  });
});

describe('renderSceneTo (export)', () => {
  it('paints the whole scene into another canvas without an overlay', () => {
    const t = rig({ objects: 6 });
    const f = fakeCtx();
    const target = { width: 0, height: 0, getContext: () => f.ctx };
    const b = t.scene.bounds();
    if (!b) throw new Error('empty');
    renderSceneTo(target, t.scene, defaultPalette('dark'), b, 2, 10);
    expect(target.width).toBe(Math.ceil((b.w + 20) * 2));
    expect(f.count('fillText')).toBe(6);
  });
});

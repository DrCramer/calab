// @vitest-environment jsdom
import * as Y from 'yjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_SCALE, MIN_SCALE, screenToWorld } from '../../../lib/canvas/camera';
import { CanvasEngine, type EngineOptions } from './engine';
import { defaultPalette } from './palette';
import { fakeCtx, manualRaf } from './testing';

/** Touch pointers (pan with one finger, pinch with two) on a read-only canvas — the phone viewer (ADR-0107 §5). */
interface Rig {
  engine: CanvasEngine;
  canvas: HTMLCanvasElement;
  down(id: number, x: number, y: number): void;
  move(id: number, x: number, y: number): void;
  up(id: number, x: number, y: number): void;
  cancel(id: number, x: number, y: number): void;
}

const rigs: Rig[] = [];

function rig(opts: Partial<EngineOptions> = {}): Rig {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fakeCtx().ctx as never);
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 800, right: 400, bottom: 800, x: 0, y: 0, toJSON: () => ({}) });
  const raf = manualRaf();
  const engine = new CanvasEngine({
    canvas, doc: new Y.Doc(), palette: defaultPalette('light'), raf: raf.raf, cancelRaf: raf.cancel, now: () => 10_000,
    measure: (t, s) => t.length * s * 0.5, gridSize: 0, reducedMotion: true, readOnly: true, ...opts,
  });
  const ptr = (type: string, id: number, x: number, y: number): void => {
    const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
    Object.defineProperty(e, 'pointerId', { value: id });
    Object.defineProperty(e, 'pointerType', { value: 'touch' });
    canvas.dispatchEvent(e);
  };
  const r: Rig = {
    engine, canvas,
    down: (id, x, y) => ptr('pointerdown', id, x, y),
    move: (id, x, y) => ptr('pointermove', id, x, y),
    up: (id, x, y) => ptr('pointerup', id, x, y),
    cancel: (id, x, y) => ptr('pointercancel', id, x, y),
  };
  rigs.push(r);
  return r;
}

afterEach(() => {
  for (const r of rigs.splice(0)) r.engine.destroy();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('touch navigation on a read-only canvas', () => {
  it('tells the browser to leave touches to the canvas', () => {
    expect(rig().canvas.style.touchAction).toBe('none');
  });

  it('pans with one finger and never edits, selects or opens an editor', () => {
    const r = rig();
    const [id] = r.engine.doc.createMany([{ init: { kind: 'sticky', x: 100, y: 100, text: 'hi' } }]);
    r.down(1, 150, 150);
    r.move(1, 170, 190);
    r.move(1, 200, 250);
    r.up(1, 200, 250);
    expect(r.engine.camera).toMatchObject({ tx: 50, ty: 100, scale: 1 });
    expect(r.engine.doc.snapshot(id ?? '')).toMatchObject({ x: 100, y: 100 });
    const s = r.engine.getState();
    expect(s.selectionCount).toBe(0);
    expect(s.editing).toBe(false);
    // A double tap on the object does not open the text editor either.
    r.canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 150, clientY: 150 }));
    expect(r.engine.getState().editing).toBe(false);
    expect(r.engine.doc.count).toBe(1);
  });

  it('pinches: the world point between the fingers stays under them while the scale follows the distance', () => {
    const r = rig();
    r.down(1, 150, 400);
    r.down(2, 250, 400);
    const anchor = screenToWorld(r.engine.camera, { x: 200, y: 400 });
    r.move(1, 100, 400);
    r.move(2, 300, 400);
    const cam = r.engine.camera;
    expect(cam.scale).toBeCloseTo(2);
    const under = screenToWorld(cam, { x: 200, y: 400 });
    expect(under.x).toBeCloseTo(anchor.x);
    expect(under.y).toBeCloseTo(anchor.y);
    // Pinching in far enough stops at the 10 % floor; spreading far stops at 400 %.
    r.move(1, 195, 400);
    r.move(2, 205, 400);
    expect(r.engine.camera.scale).toBe(MIN_SCALE);
    r.move(1, 0, 400);
    r.move(2, 400, 400);
    expect(r.engine.camera.scale).toBe(MAX_SCALE);
    r.up(2, 200, 400);
    r.up(1, 200, 400);
  });

  it('moving both fingers together pans (the scale is kept)', () => {
    const r = rig();
    r.down(1, 100, 300);
    r.down(2, 200, 300);
    r.move(1, 130, 340);
    r.move(2, 230, 340);
    expect(r.engine.camera).toMatchObject({ tx: 30, ty: 40 });
    expect(r.engine.camera.scale).toBeCloseTo(1);
  });

  it('a second finger after a pan keeps the panned view instead of snapping back', () => {
    const r = rig();
    r.down(1, 100, 100);
    r.move(1, 160, 140);
    expect(r.engine.camera).toMatchObject({ tx: 60, ty: 40 });
    r.down(2, 300, 100);
    expect(r.engine.camera).toMatchObject({ tx: 60, ty: 40, scale: 1 });
  });

  it('after a pinch the finger that stays down carries on panning', () => {
    const r = rig();
    r.down(1, 100, 300);
    r.down(2, 200, 300);
    r.up(2, 200, 300);
    const before = r.engine.camera;
    r.move(1, 120, 330);
    expect(r.engine.camera).toMatchObject({ tx: before.tx + 20, ty: before.ty + 30 });
    r.up(1, 120, 330);
    expect(r.engine.activeGesture).toBeNull();
    // And nothing is left behind: a new single touch pans from scratch.
    const cam = r.engine.camera;
    r.down(3, 50, 50);
    r.move(3, 60, 50);
    expect(r.engine.camera.tx).toBe(cam.tx + 10);
  });

  it('a cancelled touch (the system took it) leaves no gesture behind', () => {
    const r = rig();
    r.down(1, 100, 100);
    r.move(1, 140, 100);
    r.cancel(1, 140, 100);
    expect(r.engine.activeGesture).toBeNull();
    expect(r.engine.camera.tx).toBe(0);
  });
});

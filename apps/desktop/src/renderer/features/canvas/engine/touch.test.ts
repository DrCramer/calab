// @vitest-environment jsdom
import * as Y from 'yjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_SCALE, MIN_SCALE, screenToWorld } from '../../../lib/canvas/camera';
import { CanvasEngine, type EngineOptions } from './engine';
import { defaultPalette } from './palette';
import { fakeCtx, manualRaf } from './testing';

/** Touch pointers (pan with one finger, pinch with two) on a read-only canvas — the phone viewer (ADR-0126 §5). */
interface Rig {
  engine: CanvasEngine;
  canvas: HTMLCanvasElement;
  down(id: number, x: number, y: number): void;
  move(id: number, x: number, y: number): void;
  up(id: number, x: number, y: number): void;
  cancel(id: number, x: number, y: number): void;
  /** The next pointerdown starts a new touch sequence (primary), as after a lost pointerup. */
  forget(): void;
  /** The camera after the frame that applies the queued gesture input. */
  cam(): CanvasEngine['camera'];
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
  const pointersDown = new Set<number>();
  const ptr = (type: string, id: number, x: number, y: number): void => {
    const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
    Object.defineProperty(e, 'pointerId', { value: id });
    Object.defineProperty(e, 'pointerType', { value: 'touch' });
    // As on a phone: the first finger of a touch sequence is the primary pointer.
    if (type === 'pointerdown') Object.defineProperty(e, 'isPrimary', { value: pointersDown.size === 0 });
    if (type === 'pointerdown') pointersDown.add(id);
    if (type === 'pointerup' || type === 'pointercancel') pointersDown.delete(id);
    canvas.dispatchEvent(e);
  };
  const r: Rig = {
    engine, canvas,
    down: (id, x, y) => ptr('pointerdown', id, x, y),
    move: (id, x, y) => ptr('pointermove', id, x, y),
    up: (id, x, y) => ptr('pointerup', id, x, y),
    cancel: (id, x, y) => ptr('pointercancel', id, x, y),
    forget: () => pointersDown.clear(),
    cam: () => {
      raf.flush();
      return engine.camera;
    },
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
    expect(r.cam()).toMatchObject({ tx: 50, ty: 100, scale: 1 });
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
    const anchor = screenToWorld(r.cam(), { x: 200, y: 400 });
    r.move(1, 100, 400);
    r.move(2, 300, 400);
    const cam = r.cam();
    expect(cam.scale).toBeCloseTo(2);
    const under = screenToWorld(cam, { x: 200, y: 400 });
    expect(under.x).toBeCloseTo(anchor.x);
    expect(under.y).toBeCloseTo(anchor.y);
    // Pinching in far enough stops at the 10 % floor; spreading far stops at 400 %.
    r.move(1, 195, 400);
    r.move(2, 205, 400);
    expect(r.cam().scale).toBe(MIN_SCALE);
    r.move(1, 0, 400);
    r.move(2, 400, 400);
    expect(r.cam().scale).toBe(MAX_SCALE);
    r.up(2, 200, 400);
    r.up(1, 200, 400);
  });

  it('moving both fingers together pans (the scale is kept)', () => {
    const r = rig();
    r.down(1, 100, 300);
    r.down(2, 200, 300);
    r.move(1, 130, 340);
    r.move(2, 230, 340);
    expect(r.cam()).toMatchObject({ tx: 30, ty: 40 });
    expect(r.cam().scale).toBeCloseTo(1);
  });

  it('a second finger after a pan keeps the panned view instead of snapping back', () => {
    const r = rig();
    r.down(1, 100, 100);
    r.move(1, 160, 140);
    expect(r.cam()).toMatchObject({ tx: 60, ty: 40 });
    r.down(2, 300, 100);
    expect(r.cam()).toMatchObject({ tx: 60, ty: 40, scale: 1 });
  });

  it('after a pinch the finger that stays down carries on panning', () => {
    const r = rig();
    r.down(1, 100, 300);
    r.down(2, 200, 300);
    r.up(2, 200, 300);
    const before = r.cam();
    r.move(1, 120, 330);
    expect(r.cam()).toMatchObject({ tx: before.tx + 20, ty: before.ty + 30 });
    r.up(1, 120, 330);
    expect(r.engine.activeGesture).toBeNull();
    // And nothing is left behind: a new single touch pans from scratch.
    const cam = r.cam();
    r.down(3, 50, 50);
    r.move(3, 60, 50);
    expect(r.cam().tx).toBe(cam.tx + 10);
  });

  it('a cancelled touch (the system took it) leaves no gesture behind', () => {
    const r = rig();
    r.down(1, 100, 100);
    r.move(1, 140, 100);
    r.cancel(1, 140, 100);
    expect(r.engine.activeGesture).toBeNull();
    expect(r.cam().tx).toBe(0);
  });
});

describe('pinch with a changing number of fingers', () => {
  const settled = (r: Rig) => {
    const c = r.cam();
    return { x: c.tx, y: c.ty, s: c.scale };
  };

  it('a third finger neither jumps the view nor takes part; lifting a pinching finger hands over to it without a jump', () => {
    const r = rig();
    r.down(1, 150, 400);
    r.down(2, 250, 400);
    r.move(2, 350, 400);
    const before = settled(r);
    expect(before.s).toBeCloseTo(2);
    r.down(3, 50, 700);
    r.move(3, 60, 650);
    expect(settled(r)).toEqual(before);
    // Finger 1 leaves: the pinch goes on with 2 and 3, measured from where they are now.
    r.up(1, 150, 400);
    expect(settled(r)).toEqual(before);
    r.move(2, 350, 420);
    r.move(3, 60, 670);
    const after = settled(r);
    // Both moved by +20 in y: a pure pan of the remaining pair.
    expect(after.s).toBeCloseTo(before.s, 1);
    expect(after.y).toBeCloseTo(before.y + 20, 0);
    r.up(2, 350, 420);
    r.up(3, 60, 670);
    expect(r.engine.activeGesture).toBeNull();
  });

  it('pan and zoom in one gesture, then one finger up: the other pans on from the exact spot', () => {
    const r = rig();
    r.down(1, 100, 300);
    r.down(2, 200, 300);
    r.move(1, 80, 340);
    r.move(2, 240, 340);
    const mid = settled(r);
    expect(mid.s).toBeCloseTo(1.6);
    r.up(2, 240, 340);
    r.move(1, 90, 350);
    const c = settled(r);
    expect(c.s).toBeCloseTo(mid.s);
    expect(c.x).toBeCloseTo(mid.x + 10);
    expect(c.y).toBeCloseTo(mid.y + 10);
  });

  it('a lost pointerup of the old sequence is dropped when a primary pointer lands', () => {
    const r = rig();
    r.down(1, 100, 100);
    r.forget();
    r.down(2, 300, 300);
    expect(r.engine.activeGesture?.kind).toBe('pan');
    r.move(2, 320, 310);
    expect(settled(r)).toEqual({ x: 20, y: 10, s: 1 });
  });
});

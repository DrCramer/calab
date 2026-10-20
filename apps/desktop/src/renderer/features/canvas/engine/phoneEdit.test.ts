// @vitest-environment jsdom
import * as Y from 'yjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CanvasEngine, type EngineOptions } from './engine';
import { defaultPalette } from './palette';
import { fakeCtx, manualRaf } from './testing';

/** The phone's edit mode in the engine (ADR-0114 wave 5b): touch pointers on an editable canvas with `touch: true`. */
interface Rig {
  engine: CanvasEngine;
  canvas: HTMLCanvasElement;
  host: HTMLElement;
  raf: ReturnType<typeof manualRaf>;
  clock: { t: number };
  down(id: number, x: number, y: number): void;
  move(id: number, x: number, y: number): void;
  up(id: number, x: number, y: number): void;
  tap(x: number, y: number): void;
  /** One finger: down, a few moves, up. */
  drag(from: [number, number], to: [number, number]): void;
  cam(): CanvasEngine['camera'];
  make(...inits: Parameters<CanvasEngine['doc']['createMany']>[0]): string[];
}

const rigs: Rig[] = [];
const sticky = (x: number, y: number, w = 160, h = 160, extra: object = {}) => ({ init: { kind: 'sticky' as const, x, y, w, h, ...extra } });

function rig(opts: Partial<EngineOptions> = {}): Rig {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fakeCtx().ctx as never);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const canvas = document.createElement('canvas');
  host.appendChild(canvas);
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 800, right: 400, bottom: 800, x: 0, y: 0, toJSON: () => ({}) });
  const raf = manualRaf();
  const clock = { t: 10_000 };
  const engine = new CanvasEngine({
    canvas, doc: new Y.Doc(), palette: defaultPalette('light'), raf: raf.raf, cancelRaf: raf.cancel, now: () => clock.t,
    measure: (t, s) => t.length * s * 0.5, gridSize: 0, reducedMotion: true, touch: true, ...opts,
  });
  const down = new Set<number>();
  const ptr = (type: string, id: number, x: number, y: number): void => {
    const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
    Object.defineProperty(e, 'pointerId', { value: id });
    Object.defineProperty(e, 'pointerType', { value: 'touch' });
    if (type === 'pointerdown') {
      Object.defineProperty(e, 'isPrimary', { value: down.size === 0 });
      down.add(id);
    }
    if (type === 'pointerup' || type === 'pointercancel') down.delete(id);
    canvas.dispatchEvent(e);
  };
  const r: Rig = {
    engine, canvas, host, raf, clock,
    down: (id, x, y) => ptr('pointerdown', id, x, y),
    move: (id, x, y) => ptr('pointermove', id, x, y),
    up: (id, x, y) => ptr('pointerup', id, x, y),
    tap(x, y) {
      this.down(1, x, y);
      this.up(1, x, y);
    },
    drag(from, to) {
      this.down(1, from[0], from[1]);
      this.move(1, (from[0] + to[0]) / 2, (from[1] + to[1]) / 2);
      this.move(1, to[0], to[1]);
      this.up(1, to[0], to[1]);
    },
    cam: () => {
      raf.flush();
      return engine.camera;
    },
    make: (...inits) => engine.doc.createMany(inits),
  };
  rigs.push(r);
  return r;
}

afterEach(() => {
  for (const r of rigs.splice(0)) r.engine.destroy();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('revealSelection: the selected object stays out from under the sheet', () => {
  it('moves the camera up just enough for an object under the bottom inset, zoom unchanged', () => {
    const r = rig();
    const [id] = r.make(sticky(100, 620));
    r.engine.setSelection([id as string]);
    // The object spans y 620..780 of an 800 px view; a 200 px sheet leaves 592 (8 px margin).
    expect(r.engine.revealSelection({ top: 64, bottom: 200 })).toBe(true);
    const c = r.cam();
    expect(c.scale).toBe(1);
    expect(c.tx).toBe(0);
    expect(c.ty).toBeCloseTo(-188, 5);
    // Already in place: nothing more to do.
    expect(r.engine.revealSelection({ top: 64, bottom: 200 })).toBe(false);
  });

  it('moves it down from under the top bars, aligns a taller-than-free object to the top, and ignores an empty selection', () => {
    const r = rig();
    const [a, b] = r.make(sticky(100, 10, 160, 100), sticky(100, 100, 160, 900));
    expect(r.engine.revealSelection({ top: 64, bottom: 200 })).toBe(false);
    r.engine.setSelection([a as string]);
    expect(r.engine.revealSelection({ top: 64, bottom: 200 })).toBe(true);
    expect(r.cam().ty).toBeCloseTo(62, 5);
    r.engine.setCamera({ tx: 0, ty: 0, scale: 1 });
    r.engine.setSelection([b as string]);
    expect(r.engine.revealSelection({ top: 64, bottom: 200 })).toBe(true);
    expect(r.cam().ty).toBeCloseTo(72 - 100, 5);
  });

  it('does nothing during a gesture', () => {
    const r = rig();
    const [id] = r.make(sticky(100, 620));
    r.engine.setSelection([id as string]);
    r.down(1, 150, 700);
    expect(r.engine.revealSelection({ top: 64, bottom: 200 })).toBe(false);
    r.up(1, 150, 700);
  });
});

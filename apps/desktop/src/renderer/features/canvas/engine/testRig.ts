import * as Y from 'yjs';
import { vi } from 'vitest';
import { CanvasEngine, type EngineOptions } from './engine';
import { defaultPalette } from './palette';
import { fakeCtx, manualRaf } from './testing';

export interface Rig {
  engine: CanvasEngine;
  ydoc: Y.Doc;
  canvas: HTMLCanvasElement;
  host: HTMLElement;
  raf: ReturnType<typeof manualRaf>;
  clip: { text: string; readText(): Promise<string>; writeText(t: string): Promise<void> };
  clock: { t: number };
  down(x: number, y: number, init?: MouseEventInit): void;
  move(x: number, y: number, init?: MouseEventInit): void;
  up(x: number, y: number, init?: MouseEventInit): void;
  drag(from: [number, number], to: [number, number], init?: MouseEventInit): void;
  click(x: number, y: number, init?: MouseEventInit): void;
  key(key: string, init?: KeyboardEventInit): void;
  wheel(dy: number, init?: WheelEventInit): void;
  make(...inits: Parameters<CanvasEngine['doc']['createMany']>[0]): string[];
}

let rigs: Rig[] = [];

/** Tears down every rig made since the last call (afterEach). */
export function destroyRigs(): void {
  for (const r of rigs) r.engine.destroy();
  rigs = [];
}

export function rig(opts: Partial<EngineOptions> = {}): Rig {
  const fake = fakeCtx();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fake.ctx as never);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const canvas = document.createElement('canvas');
  host.appendChild(canvas);
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 800, right: 1000, bottom: 800, x: 0, y: 0, toJSON: () => ({}) });
  const raf = manualRaf();
  const clock = { t: 10_000 };
  const clip = {
    text: '',
    readText: () => Promise.resolve(clip.text),
    writeText: (t: string) => {
      clip.text = t;
      return Promise.resolve();
    },
  };
  const ydoc = new Y.Doc();
  const engine = new CanvasEngine({
    canvas, doc: ydoc, palette: defaultPalette('light'), raf: raf.raf, cancelRaf: raf.cancel, now: () => clock.t,
    clipboard: clip, measure: (t, s) => t.length * s * 0.5, gridSize: 0, reducedMotion: true, ...opts,
  });
  const ptr = (type: string, x: number, y: number, init: MouseEventInit = {}): void => {
    const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, ...init });
    Object.defineProperty(e, 'pointerId', { value: 1 });
    Object.defineProperty(e, 'pointerType', { value: 'mouse' });
    canvas.dispatchEvent(e);
  };
  const r: Rig = {
    engine, ydoc, canvas, host, raf, clip, clock,
    down: (x, y, i) => ptr('pointerdown', x, y, i),
    move: (x, y, i) => ptr('pointermove', x, y, i),
    up: (x, y, i) => ptr('pointerup', x, y, i),
    drag(from, to, init) {
      this.down(from[0], from[1], init);
      this.move((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, init);
      this.move(to[0], to[1], init);
      this.up(to[0], to[1], init);
    },
    click(x, y, i) {
      this.down(x, y, i);
      this.up(x, y, i);
    },
    key: (key, init = {}) => canvas.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })),
    wheel: (dy, init = {}) => canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, bubbles: true, cancelable: true, clientX: 500, clientY: 400, ...init })),
    make: (...inits) => engine.doc.createMany(inits),
  };
  rigs.push(r);
  return r;
}


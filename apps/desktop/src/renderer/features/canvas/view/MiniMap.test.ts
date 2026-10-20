// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mapFrame, mapToWorld } from '../../../lib/canvas/minimap';
import { defaultPalette } from '../engine';
import { destroyRigs, rig, type Rig } from '../engine/testRig';
import { fakeCtx, type FakeCtx } from '../engine/testing';
import { ZoomBar } from './Controls';
import { MiniMap } from './MiniMap';
import { minimapPref } from './minimapDraw';

const KEY = 'calaba.canvas.minimap';
const palette = defaultPalette('light');

let root: Root | null = null;
let host: HTMLElement | null = null;
let mini: FakeCtx;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
});

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  mini = fakeCtx();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  destroyRigs();
  document.body.innerHTML = '';
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** An engine rig whose mini-map canvas draws on its own recording context. */
function setup(): Rig {
  const r = rig();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    return (this.dataset['testid'] === 'canvas-minimap' ? mini.ctx : r.fake.ctx) as never;
  } as never);
  r.make(
    { init: { kind: 'sticky', x: 0, y: 0 } },
    { init: { kind: 'shape', shape: 'ellipse', x: 600, y: 300, w: 200, h: 100, fill: 'blue' } },
    { init: { kind: 'text', x: -400, y: 500, text: 'note' } },
  );
  return r;
}

function show(r: Rig, withBar = false): void {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      createElement('div', null,
        createElement(MiniMap, { engine: r.engine, palette, focusCanvas: () => undefined }),
        withBar ? createElement(ZoomBar, { engine: r.engine, focusCanvas: () => undefined, canWrite: true, helpOpen: false, onHelpOpenChange: () => undefined }) : null),
    );
  });
}

const q = (id: string): HTMLElement | null => document.querySelector(`[data-testid="${id}"]`);
const draws = (): number => mini.count('clearRect');
const advance = async (ms: number): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

describe('the mini-map is off by default and costs nothing', () => {
  it('renders nothing, subscribes to nothing, arms no timer', () => {
    const r = setup();
    const sceneSub = vi.spyOn(r.engine.scene, 'subscribe');
    const viewSub = vi.spyOn(r.engine, 'subscribeView');
    const timers = vi.getTimerCount();
    show(r);
    expect(q('canvas-minimap')).toBeNull();
    expect(sceneSub).not.toHaveBeenCalled();
    expect(viewSub).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(timers);
    r.engine.doc.patch(r.engine.scene.orderedIds()[0] ?? '', { x: 50 });
    expect(vi.getTimerCount()).toBe(timers);
    expect(draws()).toBe(0);
  });
  it('reads the stored choice, and a storage that throws still works for the session', () => {
    expect(minimapPref.get()).toBe(false);
    window.localStorage.setItem(KEY, '1');
    expect(minimapPref.get()).toBe(true);
    window.localStorage.clear();
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => minimapPref.set(true)).not.toThrow();
    expect(minimapPref.get()).toBe(true);
    minimapPref.set(false);
    expect(minimapPref.get()).toBe(false);
    get.mockRestore();
    set.mockRestore();
  });
  it('the button next to the zoom turns it on and off and remembers it', async () => {
    const r = setup();
    show(r, true);
    expect(q('canvas-minimap-toggle')?.getAttribute('aria-pressed')).toBe('false');
    act(() => q('canvas-minimap-toggle')?.click());
    expect(q('canvas-minimap')).not.toBeNull();
    expect(window.localStorage.getItem(KEY)).toBe('1');
    expect(q('canvas-minimap-toggle')?.getAttribute('aria-pressed')).toBe('true');
    await advance(50);
    expect(draws()).toBe(1);
    act(() => q('canvas-minimap-toggle')?.click());
    expect(q('canvas-minimap')).toBeNull();
    expect(window.localStorage.getItem(KEY)).toBe('0');
  });
});

describe('drawing on demand', () => {
  it('paints every object once on opening and then goes completely idle', async () => {
    const r = setup();
    minimapPref.set(true);
    show(r);
    expect(q('canvas-minimap')).not.toBeNull();
    await advance(50);
    expect(draws()).toBe(1);
    // sticky, ellipse fill, text bar + the view frame fill
    expect(mini.count('fillRect')).toBe(3 + 1);
    expect(mini.count('strokeRect')).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    await advance(5000);
    expect(draws()).toBe(1);
  });
  it('a burst of scene changes costs one redraw; continuous change is capped at 10 per second', async () => {
    const r = setup();
    minimapPref.set(true);
    show(r);
    await advance(200);
    const id = r.engine.scene.orderedIds()[0] ?? '';
    const before = draws();
    for (let i = 0; i < 100; i++) r.engine.doc.patch(id, { x: i });
    await advance(150);
    expect(draws() - before).toBe(1);
    const t0 = draws();
    for (let i = 0; i < 100; i++) {
      r.engine.doc.patch(id, { x: 200 + i });
      await advance(10); // 1 s of edits, one per 10 ms
    }
    expect(draws() - t0).toBeLessThanOrEqual(11);
    expect(draws() - t0).toBeGreaterThanOrEqual(5);
    await advance(500);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('follows the camera', async () => {
    const r = setup();
    minimapPref.set(true);
    show(r);
    await advance(200);
    const before = draws();
    act(() => r.engine.setCamera({ tx: -300, ty: -100, scale: 1 }));
    await advance(150);
    expect(draws()).toBe(before + 1);
  });
  it('draws nothing while hidden, and once when shown again', async () => {
    const r = setup();
    minimapPref.set(true);
    show(r);
    await advance(200);
    act(() => r.engine.setActive(false));
    const before = draws();
    r.engine.doc.patch(r.engine.scene.orderedIds()[0] ?? '', { x: 77 });
    act(() => r.engine.setCamera({ tx: 40, ty: 40, scale: 1 }));
    await advance(1000);
    expect(draws()).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
    act(() => r.engine.setActive(true));
    await advance(200);
    expect(draws()).toBe(before + 1);
  });
  it('turning it off drops the subscriptions and the pending timer', async () => {
    const r = setup();
    minimapPref.set(true);
    show(r);
    await advance(200);
    r.engine.doc.patch(r.engine.scene.orderedIds()[0] ?? '', { x: 5 });
    expect(vi.getTimerCount()).toBe(1);
    act(() => minimapPref.set(false));
    expect(vi.getTimerCount()).toBe(0);
    const before = draws();
    r.engine.doc.patch(r.engine.scene.orderedIds()[0] ?? '', { x: 6 });
    act(() => r.engine.setCamera({ tx: 1, ty: 2, scale: 1 }));
    await advance(1000);
    expect(draws()).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('navigating with it', () => {
  const box = (): HTMLCanvasElement => q('canvas-minimap') as HTMLCanvasElement;
  const ptr = (type: 'pointerdown' | 'pointermove' | 'pointerup', x: number, y: number): void => {
    const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
    Object.defineProperty(e, 'pointerId', { value: 1 });
    act(() => void box().dispatchEvent(e));
  };

  it('a click centers the view on that point; a drag keeps following; the map does not slide meanwhile', async () => {
    const r = setup();
    minimapPref.set(true);
    show(r);
    box().getBoundingClientRect = () => ({ left: 0, top: 0, width: 180, height: 120, right: 180, bottom: 120, x: 0, y: 0, toJSON: () => ({}) });
    await advance(200);
    const frame = mapFrame(r.engine.scene.bounds(), r.engine.visibleWorld());
    const centerOf = (): { x: number; y: number } => {
      const v = r.engine.visibleWorld();
      return { x: v.x + v.w / 2, y: v.y + v.h / 2 };
    };
    ptr('pointerdown', 150, 100);
    ptr('pointerup', 150, 100);
    const want = mapToWorld(frame, { x: 150, y: 100 });
    expect(centerOf().x).toBeCloseTo(want.x, 3);
    expect(centerOf().y).toBeCloseTo(want.y, 3);
    ptr('pointerdown', 20, 20);
    ptr('pointermove', 60, 40);
    ptr('pointermove', 100, 70);
    ptr('pointerup', 100, 70);
    const want2 = mapToWorld(frame, { x: 100, y: 70 });
    expect(centerOf().x).toBeCloseTo(want2.x, 3);
    expect(centerOf().y).toBeCloseTo(want2.y, 3);
    // Zoom is untouched.
    expect(r.engine.camera.scale).toBe(1);
  });
  it('other buttons do nothing, and the map is not inside the main canvas (it takes none of its events)', async () => {
    const r = setup();
    minimapPref.set(true);
    show(r);
    await advance(200);
    const e = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 10, clientY: 10, button: 2 });
    Object.defineProperty(e, 'pointerId', { value: 1 });
    const cam = { ...r.engine.camera };
    act(() => void box().dispatchEvent(e));
    expect(r.engine.camera).toEqual(cam);
    expect(q('canvas-minimap-box')?.contains(r.canvas)).toBe(false);
    expect(r.canvas.contains(box())).toBe(false);
  });
});

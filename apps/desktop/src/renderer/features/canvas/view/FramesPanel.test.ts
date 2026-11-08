// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { defaultPalette } from '../engine';
import { destroyRigs, rig, type Rig } from '../engine/testRig';
import { FramesPanel, framesList, framesPanel } from './FramesPanel';

const palette = defaultPalette('light');
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  act(() => framesPanel.set(false));
  destroyRigs();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const frame = (x: number, title: string) => ({ init: { kind: 'frame' as const, x, y: 0, w: 400, h: 300, title } });

function mount(r: Rig, editable = true): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(createElement(FramesPanel, { engine: r.engine, palette, editable, focusCanvas: () => undefined })));
  return host;
}

const q = (sel: string): HTMLElement | null => document.querySelector(sel);

describe('framesList', () => {
  it('lists frames in document order and keeps the same snapshot until one comes, goes or is renamed', () => {
    const r = rig();
    const [a, b] = r.make(frame(0, 'Anna'), frame(500, 'Boris'), { init: { kind: 'sticky', x: 50, y: 50 } });
    const list = framesList(r.engine.scene);
    const first = list.getSnapshot();
    expect(first).toEqual([{ id: a, title: 'Anna' }, { id: b, title: 'Boris' }]);
    const cb = vi.fn();
    const off = list.subscribe(cb);
    // A move (of the frame or of a sticky on it) is not a change of the list.
    r.engine.doc.patch(a ?? '', { x: 40 });
    expect(cb).not.toHaveBeenCalled();
    expect(list.getSnapshot()).toBe(first);
    r.engine.doc.patch(b ?? '', { title: 'Vera' });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(list.getSnapshot()[1]).toEqual({ id: b, title: 'Vera' });
    off();
  });
});

describe('the frames panel', () => {
  it('renders nothing while closed; open, a row per frame with its preview, an empty state without frames', () => {
    const r = rig();
    mount(r);
    expect(q('[data-testid="canvas-frames-panel"]')).toBeNull();
    act(() => framesPanel.set(true));
    expect(q('[data-testid="canvas-frames-empty"]')).not.toBeNull();
    let made: string[] = [];
    act(() => {
      made = r.make(frame(0, ''), frame(500, 'Boris'));
    });
    const [a] = made;
    const rows = document.querySelectorAll('[data-testid^="canvas-frame-row-"]');
    expect(rows).toHaveLength(2);
    // An untitled frame reads as such; each row paints its preview canvas.
    expect(q(`[data-testid="canvas-frame-open-${a}"]`)?.textContent).toContain('Без названия');
    expect(document.querySelectorAll('[data-testid="canvas-frames-panel"] canvas')).toHaveLength(2);
  });

  it('a click brings the frame into view and selects it', () => {
    const r = rig();
    const [, b] = r.make(frame(0, 'Anna'), frame(3000, 'Boris'));
    mount(r);
    act(() => framesPanel.set(true));
    const zoom = vi.spyOn(r.engine, 'zoomToFrame');
    act(() => q(`[data-testid="canvas-frame-open-${b}"]`)?.click());
    expect(zoom).toHaveBeenCalledWith(b);
    expect(r.engine.getState().selectedId).toBe(b);
  });

  it('renames in place: Enter writes the name, Esc keeps the old one; read-only offers no rename', () => {
    const r = rig();
    const [a] = r.make(frame(0, 'Anna'));
    mount(r);
    act(() => framesPanel.set(true));
    act(() => q(`[data-testid="canvas-frame-rename-${a}"]`)?.click());
    const input = q('[data-testid="canvas-frame-rename"]') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    if (!input) return;
    act(() => {
      Reflect.apply(Reflect.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set ?? (() => undefined), input, ['Team A']);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(r.engine.doc.snapshot(a ?? '')).toMatchObject({ title: 'Team A' });
    expect(q('[data-testid="canvas-frame-rename"]')).toBeNull();
    act(() => {
      q(`[data-testid="canvas-frame-open-${a}"]`)?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    const again = q('[data-testid="canvas-frame-rename"]');
    act(() => {
      again?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(r.engine.doc.snapshot(a ?? '')).toMatchObject({ title: 'Team A' });
    act(() => root?.unmount());
    root = null;
    mount(r, false);
    expect(q(`[data-testid="canvas-frame-rename-${a}"]`)).toBeNull();
  });

  it('Escape closes it', () => {
    const r = rig();
    r.make(frame(0, 'Anna'));
    mount(r);
    act(() => framesPanel.set(true));
    act(() => {
      q('[data-testid="canvas-frames-panel"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(q('[data-testid="canvas-frames-panel"]')).toBeNull();
  });
});

// @vitest-environment jsdom
import { CANVAS_BITS } from '@calaba/protocol';
import { Profiler, act, createElement, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { CanvasDoc } from '../../../lib/canvas/doc';
import { canvasDocHandle } from '../../../lib/canvas/docHandle';
import { MockRelay } from '../../../lib/ySyncMock';
import { canvasApi, restoreVersion } from '../../../services/canvas';
import { fakeCtx } from '../engine/testing';
import { CanvasView, getCanvasViewHandle, type CanvasViewDeps } from './index';

vi.mock('../../../platform', () => ({ platform: { kind: 'web', apiBase: '', auth: { accessToken: () => Promise.resolve('t'), forceRefresh: () => Promise.resolve('t') } } }));

const WRITE = CANVAS_BITS.VIEW | CANVAS_BITS.WRITE;
const VIEW = CANVAS_BITS.VIEW;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const fake = fakeCtx();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fake.ctx as never);
  HTMLCanvasElement.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 800, right: 1000, bottom: 800, x: 0, y: 0, toJSON: () => ({}) });
  // Radix poppers measure with ResizeObserver; jsdom has none.
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  Element.prototype.scrollIntoView = () => undefined;
});

interface Mounted {
  host: HTMLElement;
  root: Root;
  relay: MockRelay;
  commits: { n: number };
  q: (testId: string) => HTMLElement | null;
  canvas: HTMLCanvasElement;
  key(key: string, init?: KeyboardEventInit): void;
  ptr(type: string, x: number, y: number, init?: MouseEventInit): void;
  unmount(): void;
}

const mounted: Mounted[] = [];
const memoryClipboard = { readText: () => Promise.resolve(''), writeText: () => Promise.resolve() };

function deps(relay: MockRelay, canWrite: boolean, name = 'Ann'): CanvasViewDeps {
  return {
    serverUrl: () => 'https://x.test',
    getToken: () => Promise.resolve('t'),
    createSocket: relay.socketFactory({ canWrite }),
    user: () => ({ id: `u-${name}`, name }),
    clipboard: memoryClipboard,
  };
}

async function mount(opts: { bits?: bigint; relay?: MockRelay; name?: string; id?: string; props?: Partial<ComponentProps<typeof CanvasView>> } = {}): Promise<Mounted> {
  const relay = opts.relay ?? new MockRelay();
  const bits = opts.bits ?? WRITE;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const commits = { n: 0 };
  const props: ComponentProps<typeof CanvasView> = {
    canvasId: opts.id ?? 'c1',
    workspaceId: 'w1',
    bits,
    onOpenHistory: () => undefined,
    onShare: () => undefined,
    deps: deps(relay, (bits & CANVAS_BITS.WRITE) !== 0n, opts.name ?? 'Ann'),
    ...opts.props,
  };
  await act(async () => {
    root.render(createElement(Profiler, { id: 'cv', onRender: () => {
      commits.n++;
    } }, createElement(CanvasView, props)));
    await vi.advanceTimersByTimeAsync(0);
  });
  const canvas = host.querySelector('canvas') as HTMLCanvasElement;
  const m: Mounted = {
    host, root, relay, commits, canvas,
    q: (id) => host.querySelector(`[data-testid="${id}"]`),
    key: (key, init = {}) => {
      act(() => void canvas.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })));
    },
    ptr: (type, x, y, init = {}) => {
      const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, ...init });
      Object.defineProperty(e, 'pointerId', { value: 1 });
      Object.defineProperty(e, 'pointerType', { value: 'mouse' });
      act(() => void canvas.dispatchEvent(e));
    },
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
  mounted.push(m);
  return m;
}

const pressed = (m: Mounted, id: string): string | null | undefined => m.q(id)?.getAttribute('aria-pressed');
const settle = async (ms = 0): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

let sizes: Array<[number, number]> = [];

beforeEach(() => {
  vi.useFakeTimers();
  sizes = [];
  // jsdom cannot encode: record the size of every canvas asked for a PNG.
  HTMLCanvasElement.prototype.toBlob = function toBlob(this: HTMLCanvasElement, cb: BlobCallback): void {
    sizes.push([this.width, this.height]);
    cb(new Blob(['png'], { type: 'image/png' }));
  };
  URL.createObjectURL = vi.fn(() => 'blob:canvas');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  for (const m of mounted.splice(0)) {
    try {
      m.unmount();
    } catch {
      // already unmounted by the test
    }
  }
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('toolbar and hotkeys', () => {
  it('shows the five tools with «Выбор» active, and the hotkeys switch the tool', async () => {
    const m = await mount();
    for (const t of ['select', 'sticky', 'text', 'shape', 'connector']) expect(m.q(`canvas-tool-${t}`)).not.toBeNull();
    expect(pressed(m, 'canvas-tool-select')).toBe('true');
    m.key('s');
    expect(pressed(m, 'canvas-tool-sticky')).toBe('true');
    expect(pressed(m, 'canvas-tool-select')).toBe('false');
    m.key('t');
    expect(pressed(m, 'canvas-tool-text')).toBe('true');
    m.key('r');
    expect(pressed(m, 'canvas-tool-shape')).toBe('true');
    m.key('c');
    expect(pressed(m, 'canvas-tool-connector')).toBe('true');
    m.key('v');
    expect(pressed(m, 'canvas-tool-select')).toBe('true');
  });

  it('a tool button picks the tool, and the object it creates returns to «Выбор»', async () => {
    const m = await mount();
    act(() => m.q('canvas-tool-sticky')?.click());
    expect(pressed(m, 'canvas-tool-sticky')).toBe('true');
    m.ptr('pointerdown', 200, 200);
    m.ptr('pointerup', 200, 200);
    expect(pressed(m, 'canvas-tool-select')).toBe('true');
  });

  it('a double click pins the tool: it stays after creating an object; V releases it', async () => {
    const m = await mount();
    act(() => {
      m.q('canvas-tool-sticky')?.click();
      m.q('canvas-tool-sticky')?.click();
      m.q('canvas-tool-sticky')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(m.q('canvas-tool-sticky')?.getAttribute('data-pinned')).toBe('true');
    m.ptr('pointerdown', 200, 200);
    m.ptr('pointerup', 200, 200);
    expect(pressed(m, 'canvas-tool-sticky')).toBe('true');
    // leave the text editor, then release the pin with V
    const ta = m.host.querySelector('textarea');
    if (ta) act(() => void ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    m.canvas.focus();
    m.key('v');
    expect(pressed(m, 'canvas-tool-select')).toBe('true');
    expect(m.q('canvas-tool-sticky')?.getAttribute('data-pinned')).toBeNull();
  });
});

describe('properties panel', () => {
  it('exists only while something is selected, and edits the selection', async () => {
    const m = await mount();
    expect(m.q('canvas-props')).toBeNull();
    m.key('s');
    m.ptr('pointerdown', 200, 200);
    m.ptr('pointerup', 200, 200);
    const ta = m.host.querySelector('textarea');
    if (ta) act(() => void ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(m.q('canvas-props')).not.toBeNull();
    expect(m.q('canvas-prop-sticky-color')).not.toBeNull();
    expect(m.q('canvas-prop-width')).toBeNull(); // sticky has no outline
    // delete through the panel
    act(() => m.q('canvas-prop-delete')?.click());
    expect(m.q('canvas-props')).toBeNull();
  });

  it('a shape gets fill, outline and line width; a connector gets route and arrows', async () => {
    const m = await mount();
    m.key('r');
    m.ptr('pointerdown', 200, 200);
    m.ptr('pointermove', 260, 240);
    m.ptr('pointermove', 340, 300);
    m.ptr('pointerup', 340, 300);
    expect(m.q('canvas-prop-fill')).not.toBeNull();
    expect(m.q('canvas-prop-stroke')).not.toBeNull();
    expect(m.q('canvas-prop-width-4')).not.toBeNull();
    act(() => m.q('canvas-prop-width-4')?.click());
    expect(m.q('canvas-prop-width-4')?.getAttribute('aria-pressed')).toBe('true');
    expect(m.q('canvas-prop-arrow')).toBeNull();
  });

  it('does not re-render React for a drag, a pan, a zoom-less camera move or a remote edit of another object', async () => {
    const relay = new MockRelay();
    const a = await mount({ relay, name: 'Ann' });
    a.key('s');
    a.ptr('pointerdown', 200, 200);
    a.ptr('pointerup', 200, 200);
    const ta = a.host.querySelector('textarea');
    if (ta) act(() => void ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    await settle(400);
    const objects = relay.doc.getMap<Y.Map<unknown>>('objects');
    const startX = [...objects.values()][0]?.get('x');
    const before = a.commits.n;
    // drag the selected sticky around
    a.ptr('pointerdown', 250, 250);
    for (let i = 1; i <= 20; i++) a.ptr('pointermove', 250 + i * 5, 250 + i * 3);
    a.ptr('pointerup', 350, 310);
    // wheel pan
    for (let i = 0; i < 10; i++) act(() => void a.canvas.dispatchEvent(new WheelEvent('wheel', { deltaX: 12, deltaY: 7, bubbles: true, cancelable: true })));
    await settle(400);
    expect(a.commits.n).toBe(before);
    // the controls: the drag really moved the object, and a zoom change does re-render (the percentage leaf)
    expect([...objects.values()][0]?.get('x')).not.toBe(startX);
    act(() => a.q('canvas-zoom-in')?.click());
    await settle(400);
    expect(a.commits.n).toBeGreaterThan(before);
  });
});

describe('read-only', () => {
  it('without CANVAS_WRITE: no tools, no panel, a «view only» chip, and nothing is sent', async () => {
    const m = await mount({ bits: VIEW });
    expect(m.q('canvas-toolbar')).toBeNull();
    expect(m.q('canvas-history')).toBeNull();
    expect(m.q('canvas-view-only')).not.toBeNull();
    expect(m.q('canvas-zoom')).not.toBeNull();
    m.key('s');
    m.ptr('pointerdown', 200, 200);
    m.ptr('pointerup', 200, 200);
    expect(m.q('canvas-props')).toBeNull();
    await settle(500);
    expect(m.relay.violations).toEqual([]);
    expect(m.relay.doc.getMap('objects').size).toBe(0);
  });

  it('follows the grant while open', async () => {
    const relay = new MockRelay();
    const m = await mount({ relay, bits: VIEW });
    expect(m.q('canvas-toolbar')).toBeNull();
    await act(async () => {
      m.root.render(createElement(CanvasView, { canvasId: 'c1', workspaceId: 'w1', bits: WRITE, onOpenHistory: () => undefined, onShare: () => undefined, deps: deps(relay, true) }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(m.q('canvas-toolbar')).not.toBeNull();
    expect(m.q('canvas-view-only')).toBeNull();
  });
});

describe('connection banners', () => {
  it('shows «Подключение…» only if it lasts, and «Переподключение…» after a drop', async () => {
    const relay = new MockRelay();
    const m = await mount({ relay });
    await settle(50);
    expect(m.q('canvas-connecting')).toBeNull();
    expect(m.q('canvas-offline')).toBeNull();
    await act(async () => {
      relay.dropAll(1006);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(m.q('canvas-offline')).not.toBeNull();
    // the provider reconnects with backoff
    await settle(40_000);
    expect(m.q('canvas-offline')).toBeNull();
  });

  it('shows the gone notice when the server closes for good (4404), tells the shell, and reopens on request', async () => {
    const relay = new MockRelay({ accept: () => true });
    const codes: number[] = [];
    const m = await mount({ relay, props: { onFatal: (c) => void codes.push(c) } });
    await settle(50);
    await act(async () => {
      relay.dropAll(4404);
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(m.q('canvas-gone')).not.toBeNull();
    expect(codes).toEqual([4404]);
    await act(async () => {
      m.q('canvas-retry')?.click();
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(m.q('canvas-gone')).toBeNull();
    expect(relay.size).toBe(1);
  });
});

describe('zoom and help', () => {
  it('shows the percentage, steps with +/−, fits everything', async () => {
    const m = await mount({ props: { bits: WRITE } });
    expect(m.q('canvas-zoom-pct')?.textContent).toContain('100');
    act(() => m.q('canvas-zoom-in')?.click());
    await settle(400);
    expect(Number(/\d+/.exec(m.q('canvas-zoom-pct')?.textContent ?? '')?.[0])).toBeGreaterThan(100);
    act(() => m.q('canvas-zoom-pct')?.click());
    await settle(400);
    expect(m.q('canvas-zoom-pct')?.textContent).toContain('100');
    m.key('1', { shiftKey: true, code: 'Digit1' });
    await settle(400);
    expect(m.q('canvas-zoom-pct')?.textContent).toBeTruthy();
  });

  it('? opens the shortcut help', async () => {
    const m = await mount();
    m.key('?', { shiftKey: true });
    expect(document.querySelector('[data-testid="canvas-help-panel"]')).not.toBeNull();
  });
});

describe('lifecycle', () => {
  it('opens one socket per canvas and closes it (with a compaction when edited) on unmount', async () => {
    const relay = new MockRelay();
    const m = await mount({ relay });
    await settle(50);
    expect(relay.size).toBe(1);
    m.key('s');
    m.ptr('pointerdown', 200, 200);
    m.ptr('pointerup', 200, 200);
    const ta = m.host.querySelector('textarea');
    if (ta) act(() => void ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(getCanvasViewHandle('c1')).not.toBeNull();
    m.unmount();
    await settle(50);
    expect(relay.size).toBe(0);
    expect(relay.doc.getMap('objects').size).toBe(1);
    expect(relay.posts.length).toBeGreaterThan(0);
    expect(getCanvasViewHandle('c1')).toBeNull();
  });

  it('at rest: no frames, no React commits, one timer (the 15 s awareness heartbeat); hidden: no timer at all', async () => {
    const m = await mount();
    await settle(5000); // opening a new canvas writes its schema: the first compaction (3 s) has run
    const commits = m.commits.n;
    expect(vi.getTimerCount()).toBe(1);
    let hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    try {
      await settle(15_000); // the heartbeat fires once: it keeps our presence alive, and nothing else wakes up
      expect(m.commits.n).toBe(commits);
      expect(vi.getTimerCount()).toBe(1);
      hidden = true;
      act(() => void document.dispatchEvent(new Event('visibilitychange')));
      await settle(0);
      expect(vi.getTimerCount()).toBe(0);
      await settle(60_000);
      expect(m.commits.n).toBe(commits);
      expect(vi.getTimerCount()).toBe(0);
      const aw = m.relay.size; // still connected: only the cursor traffic stopped
      expect(aw).toBe(1);
    } finally {
      Reflect.deleteProperty(document, 'hidden');
    }
  });

  it('leaves no timers or frames behind after unmount', async () => {
    const m = await mount();
    await settle(50);
    m.unmount();
    await settle(50);
    expect(vi.getTimerCount()).toBe(0);
  });
});

const escapeEditor = (m: Mounted): void => {
  const ta = m.host.querySelector('textarea');
  if (ta) act(() => void ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
};

describe('two clients on one document', () => {
  it('see each other’s objects, edits and presence — without re-rendering React for cursors or foreign objects', async () => {
    const relay = new MockRelay();
    const a = await mount({ relay, name: 'Ann' });
    const b = await mount({ relay, name: 'Bob' });
    await settle(50);
    // Ann creates a sticky and a shape
    a.key('s');
    a.ptr('pointerdown', 200, 200);
    a.ptr('pointerup', 200, 200);
    escapeEditor(a);
    a.key('r');
    a.ptr('pointerdown', 500, 300);
    a.ptr('pointermove', 560, 340);
    a.ptr('pointermove', 640, 400);
    a.ptr('pointerup', 640, 400);
    await settle(400);
    expect(relay.doc.getMap('objects').size).toBe(2);

    // Bob's engine has them (his export is non-empty), Bob's presence bar lists Ann once
    const saved = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    expect(await getCanvasViewHandle('c1')?.exportPng({ area: 'all', name: 'Board' })).toBe(true);
    saved.mockRestore();
    const people = [...b.host.querySelectorAll('[data-testid="canvas-presence-user"]')];
    expect(people.map((p) => p.textContent)).toEqual(['A']);
    expect([...a.host.querySelectorAll('[data-testid="canvas-presence-user"]')].map((p) => p.textContent)).toEqual(['B']);

    // Ann keeps moving the mouse and editing; Bob (nothing selected) re-renders nothing
    const before = b.commits.n;
    for (let i = 0; i < 30; i++) a.ptr('pointermove', 100 + i * 4, 100 + i * 2);
    a.key('Escape');
    a.ptr('pointerdown', 250, 250);
    for (let i = 1; i <= 10; i++) a.ptr('pointermove', 250 + i * 6, 250);
    a.ptr('pointerup', 310, 250);
    await settle(400);
    expect(b.commits.n).toBe(before);
    expect(relay.doc.getMap('objects').size).toBe(2);
  });

  it('a viewer sees the editor’s changes live', async () => {
    const relay = new MockRelay();
    const editor = await mount({ relay, name: 'Ann' });
    const viewer = await mount({ relay, name: 'Bob', bits: VIEW });
    await settle(50);
    editor.key('s');
    editor.ptr('pointerdown', 300, 300);
    editor.ptr('pointerup', 300, 300);
    escapeEditor(editor);
    await settle(400);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    expect(await getCanvasViewHandle('c1')?.exportPng()).toBe(true);
    click.mockRestore();
    expect(viewer.q('canvas-toolbar')).toBeNull();
    expect(relay.violations).toEqual([]);
  });
});

describe('version restore', () => {
  const versionWith = (text: string): Uint8Array => {
    const d = new CanvasDoc(new Y.Doc());
    d.ensureSchema();
    d.create({ kind: 'sticky', x: 0, y: 0, text });
    return Y.encodeStateAsUpdate(d.ydoc);
  };
  const texts = (relay: MockRelay): string[] => {
    const d = new CanvasDoc(relay.doc);
    return d.orderedIds().map((id) => d.getText(id));
  };

  it('registers the live document while mounted; «Восстановить» replaces the objects in one step that my undo takes back', async () => {
    const relay = new MockRelay();
    const m = await mount({ relay });
    await settle(50);
    expect(canvasDocHandle('c1')?.writable()).toBe(true);
    m.key('s');
    m.ptr('pointerdown', 200, 200);
    m.ptr('pointerup', 200, 200);
    escapeEditor(m);
    await settle(400);
    expect(texts(relay)).toEqual(['']);
    const state = vi.spyOn(canvasApi, 'versionState').mockResolvedValue(versionWith('old version'));
    await act(async () => {
      expect(await restoreVersion('c1', 'v1')).toBe(true);
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(state).toHaveBeenCalledWith('c1', 'v1');
    expect(texts(relay)).toEqual(['old version']);
    // my undo (one step) brings the sticky I drew back
    m.canvas.focus();
    m.key('z', { ctrlKey: true, metaKey: true });
    await settle(400);
    expect(texts(relay)).toEqual(['']);
    expect(relay.violations).toEqual([]);
  });

  it('is not writable without CANVAS_WRITE, and the registration goes away on unmount', async () => {
    const m = await mount({ bits: VIEW });
    await settle(50);
    expect(canvasDocHandle('c1')?.writable()).toBe(false);
    expect(await restoreVersion('c1', 'v1')).toBe(false);
    m.unmount();
    expect(canvasDocHandle('c1')).toBeNull();
  });

  it('is not writable while the connection is down', async () => {
    const relay = new MockRelay();
    await mount({ relay });
    await settle(50);
    expect(canvasDocHandle('c1')?.writable()).toBe(true);
    act(() => relay.dropAll(1006));
    await settle(0);
    expect(canvasDocHandle('c1')?.writable()).toBe(false);
  });
});

describe('PNG export', () => {

  it('saves a PNG named after the canvas, capped in size; an empty canvas saves nothing', async () => {
    const m = await mount();
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this.download);
    });
    const handle = getCanvasViewHandle('c1');
    expect(await handle?.exportPng({ name: 'Plan' })).toBe(false); // empty
    expect(clicked).toEqual([]);

    m.key('s');
    m.ptr('pointerdown', 200, 200);
    m.ptr('pointerup', 200, 200);
    escapeEditor(m);
    // a far-away sticky makes the whole canvas huge
    m.key('s');
    m.ptr('pointerdown', 900, 700);
    m.ptr('pointerup', 900, 700);
    escapeEditor(m);
    expect(await handle?.exportPng({ area: 'all', name: 'Plan: Q4' })).toBe(true);
    expect(clicked).toEqual(['Plan Q4.png']);
    const [w, h] = sizes[0] ?? [0, 0];
    expect(w).toBeGreaterThan(0);
    expect(Math.max(w, h)).toBeLessThanOrEqual(8192);

    expect(await handle?.exportPng({ area: 'visible' })).toBe(true);
    const [vw, vh] = sizes[1] ?? [0, 0];
    expect(vw).toBeGreaterThan(0);
    expect(vh).toBeGreaterThan(0);
  });

  it('exportCanvasPng caps a very large canvas', async () => {
    const { exportCanvasPng } = await import('./exportPng');
    const { CanvasEngine, defaultPalette } = await import('../engine');
    const Yjs = await import('yjs');
    const host = document.createElement('div');
    const canvas = document.createElement('canvas');
    host.append(canvas);
    document.body.append(host);
    const engine = new CanvasEngine({ canvas, doc: new Yjs.Doc(), palette: defaultPalette('light'), measure: (t, s) => t.length * s * 0.5 });
    engine.doc.createMany([
      { init: { kind: 'sticky', x: 0, y: 0 } },
      { init: { kind: 'sticky', x: 90_000, y: 70_000 } },
    ]);
    const blob = await exportCanvasPng(engine, { area: 'all' });
    expect(blob).not.toBeNull();
    const [w, h] = sizes[0] ?? [0, 0];
    expect(Math.max(w, h)).toBeLessThanOrEqual(8192);
    expect(w * h).toBeLessThanOrEqual(40_000_000);
    engine.destroy();
  });
});

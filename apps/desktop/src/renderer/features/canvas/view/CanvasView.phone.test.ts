// @vitest-environment jsdom
import { CANVAS_BITS } from '@calaba/protocol';
import { act, createElement, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockRelay } from '../../../lib/ySyncMock';
import { fakeCtx } from '../engine/testing';
import { CanvasView, type CanvasViewDeps } from './index';
import { EDIT_NOTE_KEY, NOTE_KEY } from './PhoneChrome';

vi.mock('../../../platform', () => ({ platform: { kind: 'web', apiBase: '', auth: { accessToken: () => Promise.resolve('t'), forceRefresh: () => Promise.resolve('t') } } }));

/** `phone` mode of CanvasView (ADR-0114 §5): read-only whatever the grant, no tools, touch navigation. */
const WRITE = CANVAS_BITS.VIEW | CANVAS_BITS.WRITE;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fakeCtx().ctx as never);
  HTMLCanvasElement.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 800, right: 400, bottom: 800, x: 0, y: 0, toJSON: () => ({}) });
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
  canvas: HTMLCanvasElement;
  q: (testId: string) => HTMLElement | null;
  touch(type: string, id: number, x: number, y: number): void;
  key(key: string): void;
  /** Re-renders with other props (the phone's edit mode switches on a live viewer). */
  rerender(next: Partial<ComponentProps<typeof CanvasView>>): Promise<void>;
  unmount(): void;
}

const mounted: Mounted[] = [];

function deps(relay: MockRelay, name: string): CanvasViewDeps {
  return {
    serverUrl: () => 'https://x.test',
    getToken: () => Promise.resolve('t'),
    createSocket: relay.socketFactory({ canWrite: true }),
    user: () => ({ id: `u-${name}`, name }),
    clipboard: { readText: () => Promise.resolve(''), writeText: () => Promise.resolve() },
  };
}

async function mount(opts: { relay?: MockRelay; name?: string; phone?: boolean; id?: string; bits?: bigint; phoneEdit?: boolean } = {}): Promise<Mounted> {
  const relay = opts.relay ?? new MockRelay();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const props: ComponentProps<typeof CanvasView> = {
    canvasId: opts.id ?? 'c1',
    workspaceId: 'w1',
    bits: opts.bits ?? WRITE,
    phone: opts.phone ?? true,
    phoneEdit: opts.phoneEdit ?? false,
    onOpenHistory: () => undefined,
    onShare: () => undefined,
    deps: deps(relay, opts.name ?? 'Ann'),
  };
  await act(async () => {
    root.render(createElement(CanvasView, props));
    await vi.advanceTimersByTimeAsync(0);
  });
  const canvas = host.querySelector('canvas') as HTMLCanvasElement;
  const m: Mounted = {
    host, root, relay, canvas,
    q: (id) => host.querySelector(`[data-testid="${id}"]`),
    touch: (type, id, x, y) => {
      const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
      Object.defineProperty(e, 'pointerId', { value: id });
      Object.defineProperty(e, 'pointerType', { value: 'touch' });
      act(() => void canvas.dispatchEvent(e));
    },
    key: (key) => act(() => void canvas.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))),
    rerender: async (next) => {
      await act(async () => {
        root.render(createElement(CanvasView, { ...props, ...next }));
        await vi.advanceTimersByTimeAsync(0);
      });
    },
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
  mounted.push(m);
  return m;
}

const settle = async (ms = 0): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
const pct = (m: Mounted): number => Number(/\d+/.exec(m.q('canvas-zoom-pct')?.textContent ?? '')?.[0]);

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
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

describe('phone viewer', () => {
  it('is read-only even with CANVAS_WRITE: no tools, panels, help, avatars or chip, and nothing is sent', async () => {
    const m = await mount();
    for (const id of ['canvas-toolbar', 'canvas-history', 'canvas-props', 'canvas-help', 'canvas-fit-selection', 'canvas-presence', 'canvas-view-only']) expect(m.q(id), id).toBeNull();
    // what stays: the zoom bar with «вписать всё»
    expect(m.q('canvas-zoom')).not.toBeNull();
    expect(m.q('canvas-fit-all')).not.toBeNull();
    // keys, taps and a double tap edit nothing
    m.key('s');
    m.touch('pointerdown', 1, 200, 200);
    m.touch('pointerup', 1, 200, 200);
    act(() => void m.canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 200, clientY: 200 })));
    expect(m.q('canvas-props')).toBeNull();
    await settle(500);
    expect(m.relay.violations).toEqual([]);
    expect(m.relay.doc.getMap('objects').size).toBe(0);
  });

  it('the desktop mode is unchanged: the same grant gets the tools', async () => {
    const m = await mount({ phone: false });
    expect(m.q('canvas-toolbar')).not.toBeNull();
    expect(m.q('canvas-help')).not.toBeNull();
    expect(m.q('canvas-phone-note')).toBeNull();
  });

  it('pinch with two fingers zooms, and the zoom bar follows', async () => {
    const m = await mount();
    expect(pct(m)).toBe(100);
    m.touch('pointerdown', 1, 150, 400);
    m.touch('pointerdown', 2, 250, 400);
    m.touch('pointermove', 1, 100, 400);
    m.touch('pointermove', 2, 300, 400);
    await settle(50);
    expect(pct(m)).toBe(200);
    m.touch('pointerup', 2, 300, 400);
    m.touch('pointerup', 1, 100, 400);
    // the «100 %» button resets it
    act(() => m.q('canvas-zoom-pct')?.click());
    await settle(400);
    expect(pct(m)).toBe(100);
  });

  it('long press does not open the context menu', async () => {
    const m = await mount();
    m.touch('pointerdown', 1, 200, 200);
    await settle(1000);
    act(() => void m.canvas.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 })));
    await settle(50);
    expect(document.querySelector('[data-testid="canvas-menu"]')).toBeNull();
    m.touch('pointerup', 1, 200, 200);
  });

  it('shows the others as a count, not as avatars', async () => {
    const relay = new MockRelay();
    const phone = await mount({ relay, name: 'Ann' });
    expect(phone.q('canvas-others')).toBeNull();
    await mount({ relay, name: 'Bob', phone: false });
    await settle(100);
    expect(phone.q('canvas-others')?.textContent).toMatch(/1/);
    expect(phone.q('canvas-presence')).toBeNull();
  });
});

describe('the «view only» note (no CANVAS_WRITE)', () => {
  it('is not shown to a person who can edit: «Править» is the way in', async () => {
    const m = await mount();
    expect(m.q('canvas-phone-note')).toBeNull();
  });

  it('shows once on this device: the first canvas shows it, later ones do not', async () => {
    const first = await mount({ bits: CANVAS_BITS.VIEW });
    expect(first.q('canvas-phone-note')?.textContent).toBeTruthy();
    expect(localStorage.getItem(NOTE_KEY)).toBe('1');
    first.unmount();
    const second = await mount({ id: 'c2', bits: CANVAS_BITS.VIEW });
    expect(second.q('canvas-phone-note')).toBeNull();
  });

  it('closes with the cross', async () => {
    const m = await mount({ bits: CANVAS_BITS.VIEW });
    act(() => m.q('canvas-phone-note-close')?.click());
    expect(m.q('canvas-phone-note')).toBeNull();
  });
});

describe('the edit mode (ADR-0115 wave 5b)', () => {
  it('switches a live viewer between view and edit; leaving commits the open editor', async () => {
    const m = await mount();
    m.key('s');
    m.touch('pointerdown', 1, 200, 200);
    m.touch('pointerup', 1, 200, 200);
    expect(m.relay.doc.getMap('objects').size).toBe(0);
    await m.rerender({ phoneEdit: true });
    // In edit mode the engine is writable: the zoom bar hangs from the top and the hint explains the gestures.
    expect(m.q('canvas-zoom')?.className).toContain('top-3');
    expect(m.q('canvas-phone-edit-hint')?.textContent).toBeTruthy();
    expect(m.q('canvas-phone-note')).toBeNull();
    m.key('s');
    m.touch('pointerdown', 1, 200, 200);
    m.touch('pointerup', 1, 200, 200);
    // A new sticky opens its text editor; leaving the edit mode commits it and closes the editor.
    expect(m.host.querySelector('textarea')).not.toBeNull();
    await m.rerender({ phoneEdit: false });
    expect(m.host.querySelector('textarea')).toBeNull();
    await settle(600);
    expect(m.relay.doc.getMap('objects').size).toBe(1);
    expect(m.q('canvas-zoom')?.className).toContain('bottom-3');
    // View mode again: a tap changes nothing and nothing is sent.
    m.key('s');
    m.touch('pointerdown', 1, 300, 300);
    m.touch('pointerup', 1, 300, 300);
    await settle(600);
    expect(m.relay.doc.getMap('objects').size).toBe(1);
    expect(m.relay.violations).toEqual([]);
  });

  it('shows its hint once per device', async () => {
    const first = await mount({ phoneEdit: true });
    expect(first.q('canvas-phone-edit-hint')).not.toBeNull();
    expect(localStorage.getItem(EDIT_NOTE_KEY)).toBe('1');
    act(() => first.q('canvas-phone-edit-hint-close')?.click());
    expect(first.q('canvas-phone-edit-hint')).toBeNull();
    first.unmount();
    const second = await mount({ id: 'c2', phoneEdit: true });
    expect(second.q('canvas-phone-edit-hint')).toBeNull();
  });

  it('does nothing without CANVAS_WRITE, whatever the flag says', async () => {
    const m = await mount({ bits: CANVAS_BITS.VIEW, phoneEdit: true });
    expect(m.q('canvas-phone-edit-hint')).toBeNull();
    expect(m.q('canvas-phone-note')).not.toBeNull();
    m.key('s');
    m.touch('pointerdown', 1, 200, 200);
    m.touch('pointerup', 1, 200, 200);
    await settle(100);
    expect(m.relay.doc.getMap('objects').size).toBe(0);
  });

  it('is ignored off the phone', async () => {
    const m = await mount({ phone: false, phoneEdit: false });
    expect(m.q('canvas-toolbar')).not.toBeNull();
    expect(m.q('canvas-phone-edit-hint')).toBeNull();
  });
});

describe('the edit mode tool bar', () => {
  const click = (m: Mounted, id: string): void => act(() => m.q(id)?.click());
  const objects = (m: Mounted): Array<Record<string, unknown>> => [...m.relay.doc.getMap<{ toJSON(): Record<string, unknown> }>('objects').values()].map((o) => o.toJSON());

  it('exists only in edit mode, with 44 px targets above the home indicator', async () => {
    const m = await mount();
    expect(m.q('canvas-phone-toolbar')).toBeNull();
    await m.rerender({ phoneEdit: true });
    const bar = m.q('canvas-phone-toolbar');
    expect(bar?.getAttribute('role')).toBe('toolbar');
    expect(bar?.className).toContain('--safe-bottom');
    const buttons = [...(bar?.querySelectorAll('button') ?? [])];
    // select · sticky · text · shape · connector · «+» · undo · redo
    expect(buttons).toHaveLength(8);
    for (const b of buttons) expect(b.className, b.getAttribute('aria-label') ?? '').toContain('size-11');
    await m.rerender({ phoneEdit: false });
    expect(m.q('canvas-phone-toolbar')).toBeNull();
  });

  it('a tool button arms the tool, says what to do, and a tap on the canvas places the object', async () => {
    const m = await mount({ phoneEdit: true });
    expect(m.q('canvas-tool-select')?.getAttribute('aria-pressed')).toBe('true');
    expect(m.q('canvas-phone-armed')).toBeNull();
    click(m, 'canvas-tool-sticky');
    expect(m.q('canvas-tool-sticky')?.getAttribute('aria-pressed')).toBe('true');
    expect(m.q('canvas-tool-select')?.getAttribute('aria-pressed')).toBe('false');
    expect(m.q('canvas-phone-armed')?.textContent).toMatch(/стикер/);
    m.touch('pointerdown', 1, 200, 300);
    m.touch('pointerup', 1, 200, 300);
    // Its text editor is open (the bar steps aside); after it the tool is back on «Выбор».
    expect(m.host.querySelector('textarea')).not.toBeNull();
    act(() => void m.host.querySelector('textarea')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(m.q('canvas-tool-select')?.getAttribute('aria-pressed')).toBe('true');
    expect(m.q('canvas-phone-armed')).toBeNull();
    await settle(600);
    expect(objects(m).map((o) => o['kind'])).toEqual(['sticky']);
  });

  it('the shape button offers the shapes in a grid; the chosen one is what a tap places', async () => {
    const m = await mount({ phoneEdit: true });
    click(m, 'canvas-tool-shape');
    const sheet = m.q('canvas-phone-shapes');
    expect(sheet).not.toBeNull();
    const cells = [...(sheet?.querySelectorAll('button') ?? [])];
    expect(cells).toHaveLength(11);
    for (const b of cells) expect(b.className).toContain('size-11');
    click(m, 'canvas-shape-star');
    expect(m.q('canvas-phone-shapes')).toBeNull();
    expect(m.q('canvas-tool-shape')?.getAttribute('aria-pressed')).toBe('true');
    m.touch('pointerdown', 1, 200, 300);
    m.touch('pointerup', 1, 200, 300);
    act(() => void m.host.querySelector('textarea')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    await settle(600);
    expect(objects(m).map((o) => [o['kind'], o['shape']])).toEqual([['shape', 'star']]);
    // A second tap on the button puts the sheet away without disarming the tool.
    click(m, 'canvas-tool-shape');
    expect(m.q('canvas-phone-shapes')).not.toBeNull();
    click(m, 'canvas-tool-shape');
    expect(m.q('canvas-phone-shapes')).toBeNull();
  });

  it('«+» inserts a template at the view center; vote and countdown start from the same sheet', async () => {
    const m = await mount({ phoneEdit: true });
    click(m, 'canvas-phone-plus');
    expect(m.q('canvas-phone-plus-sheet')).not.toBeNull();
    click(m, 'canvas-template-kanban');
    expect(m.q('canvas-phone-plus-sheet')).toBeNull();
    await settle(600);
    expect(objects(m).length).toBeGreaterThan(3);
    click(m, 'canvas-phone-plus');
    click(m, 'canvas-vote-start');
    click(m, 'canvas-phone-plus');
    click(m, 'canvas-timer-preset-5');
    await settle(600);
    const meta = m.relay.doc.getMap('meta');
    expect((meta.get('vote') as { open: boolean }).open).toBe(true);
    expect(meta.get('timer')).toBeDefined();
    // Both show as plaques on the canvas; the vote can be finished from «+» again.
    click(m, 'canvas-phone-plus');
    click(m, 'canvas-vote-finish');
    await settle(600);
    expect((m.relay.doc.getMap('meta').get('vote') as { open: boolean }).open).toBe(false);
  });

  it('undo and redo follow the history', async () => {
    const m = await mount({ phoneEdit: true });
    expect((m.q('canvas-undo') as HTMLButtonElement).disabled).toBe(true);
    expect((m.q('canvas-redo') as HTMLButtonElement).disabled).toBe(true);
    click(m, 'canvas-tool-text');
    m.touch('pointerdown', 1, 200, 300);
    m.touch('pointerup', 1, 200, 300);
    act(() => void m.host.querySelector('textarea')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    // An empty text object is not kept; a sticky is.
    click(m, 'canvas-tool-sticky');
    m.touch('pointerdown', 1, 200, 300);
    m.touch('pointerup', 1, 200, 300);
    act(() => void m.host.querySelector('textarea')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect((m.q('canvas-undo') as HTMLButtonElement).disabled).toBe(false);
    click(m, 'canvas-undo');
    expect((m.q('canvas-redo') as HTMLButtonElement).disabled).toBe(false);
    click(m, 'canvas-redo');
    expect((m.q('canvas-redo') as HTMLButtonElement).disabled).toBe(true);
  });

  it('is replaced by nothing while a text is edited, and comes back after', async () => {
    const m = await mount({ phoneEdit: true });
    click(m, 'canvas-tool-sticky');
    m.touch('pointerdown', 1, 200, 300);
    m.touch('pointerup', 1, 200, 300);
    expect(m.host.querySelector('textarea')).not.toBeNull();
    expect(m.q('canvas-phone-toolbar')).toBeNull();
    act(() => void m.host.querySelector('textarea')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(m.q('canvas-phone-toolbar')).not.toBeNull();
  });
});

describe('the properties sheet', () => {
  const click = (m: Mounted, id: string): void => act(() => m.q(id)?.click());
  const objects = (m: Mounted): Array<Record<string, unknown>> => [...m.relay.doc.getMap<{ toJSON(): Record<string, unknown> }>('objects').values()].map((o) => o.toJSON());
  const esc = (m: Mounted): void => act(() => void m.host.querySelector('textarea')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  /** Arms a tool, taps the canvas and closes the editor the object opens: the new object stays selected. */
  const place = (m: Mounted, tool: string, x: number, y: number): void => {
    click(m, `canvas-tool-${tool}`);
    m.touch('pointerdown', 1, x, y);
    m.touch('pointerup', 1, x, y);
    esc(m);
  };

  it('exists only in edit mode and only for a selection', async () => {
    const m = await mount();
    expect(m.q('canvas-phone-props')).toBeNull();
    await m.rerender({ phoneEdit: true });
    expect(m.q('canvas-phone-props')).toBeNull();
    place(m, 'sticky', 200, 300);
    const sheet = m.q('canvas-phone-props');
    expect(sheet?.getAttribute('role')).toBe('toolbar');
    // The sheet sits in the dock, above the tool bar; every target is 44 px.
    expect(m.q('canvas-phone-dock')?.contains(sheet)).toBe(true);
    for (const b of sheet?.querySelectorAll('button') ?? []) expect(b.className, b.getAttribute('aria-label') ?? '').toContain('size-11');
    await m.rerender({ phoneEdit: false });
    expect(m.q('canvas-phone-props')).toBeNull();
  });

  it('colors, sizes, lock, duplicate and delete act on the selection', async () => {
    const m = await mount({ phoneEdit: true });
    place(m, 'sticky', 200, 300);
    click(m, 'canvas-prop-sticky-color');
    expect(m.q('canvas-phone-panel')).not.toBeNull();
    const first = m.host.querySelectorAll<HTMLElement>('[data-testid^="canvas-phone-color-"]')[2];
    const token = first?.dataset['testid']?.replace('canvas-phone-color-', '');
    act(() => first?.click());
    expect(m.q('canvas-phone-panel')).toBeNull();
    click(m, 'canvas-prop-size-more');
    click(m, 'canvas-prop-lock');
    await settle(600);
    expect(objects(m)).toHaveLength(1);
    expect(objects(m)[0]).toMatchObject({ color: token, fontPx: 19, locked: true });
    // A locked selection offers no color or size, only «unlock», duplicate and delete.
    expect(m.q('canvas-prop-sticky-color')).toBeNull();
    expect(m.q('canvas-prop-size')).toBeNull();
    click(m, 'canvas-prop-lock');
    click(m, 'canvas-prop-duplicate');
    await settle(600);
    expect(objects(m)).toHaveLength(2);
    click(m, 'canvas-prop-delete');
    await settle(600);
    expect(objects(m)).toHaveLength(1);
    // The copy is gone with its selection (and the sheet); a tap on the original selects it again.
    expect(m.q('canvas-phone-props')).toBeNull();
    m.touch('pointerdown', 1, 200, 300);
    m.touch('pointerup', 1, 200, 300);
    click(m, 'canvas-prop-delete');
    await settle(600);
    expect(objects(m)).toHaveLength(0);
    expect(m.q('canvas-phone-props')).toBeNull();
  });

  it('a shape gets its shape, fill, stroke and align choices in a grid above the row; picking closes it', async () => {
    const m = await mount({ phoneEdit: true });
    place(m, 'shape', 120, 200);
    place(m, 'shape', 300, 500);
    // Both selected (an external keyboard's ⌘A here; on the touch screen it is «Выбрать несколько»).
    act(() => void m.canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true })));
    expect(m.q('canvas-phone-count')?.textContent).toMatch(/2/);
    click(m, 'canvas-prop-align');
    expect(m.host.querySelectorAll('[data-testid^="canvas-prop-arrange-"]')).toHaveLength(6);
    click(m, 'canvas-prop-arrange-left');
    expect(m.q('canvas-phone-panel')).toBeNull();
    click(m, 'canvas-prop-shape');
    expect(m.host.querySelectorAll('[data-testid^="canvas-prop-shape-"]')).toHaveLength(11);
    click(m, 'canvas-prop-shape-hexagon');
    click(m, 'canvas-prop-fill');
    click(m, 'canvas-phone-color-white');
    await settle(600);
    const o = objects(m);
    expect(o.map((x) => x['shape'])).toEqual(['hexagon', 'hexagon']);
    expect(o.map((x) => x['fill'])).toEqual(['white', 'white']);
    expect(new Set(o.map((x) => x['x'])).size).toBe(1);
  });

  it('«Выбрать несколько» stays on with an empty selection, with its hint, and goes off with the edit mode', async () => {
    const m = await mount({ phoneEdit: true });
    expect(m.q('canvas-phone-multi')).toBeNull();
    place(m, 'sticky', 200, 300);
    click(m, 'canvas-phone-multi');
    // Tapping the empty canvas clears the selection; the mode and its sheet remain.
    m.touch('pointerdown', 1, 350, 700);
    m.touch('pointerup', 1, 350, 700);
    expect(m.q('canvas-phone-multi-hint')).not.toBeNull();
    expect(m.q('canvas-phone-multi')?.getAttribute('aria-pressed')).toBe('true');
    click(m, 'canvas-phone-multi');
    expect(m.q('canvas-phone-props')).toBeNull();
    click(m, 'canvas-phone-multi');
    await m.rerender({ phoneEdit: false });
    await m.rerender({ phoneEdit: true });
    expect(m.q('canvas-phone-multi-hint')).toBeNull();
  });

  it('a connector offers its arrow and route; a plain shape does not', async () => {
    const m = await mount({ phoneEdit: true });
    place(m, 'sticky', 100, 200);
    expect(m.q('canvas-prop-arrow-end')).toBeNull();
    place(m, 'sticky', 100, 500);
    click(m, 'canvas-tool-connector');
    m.touch('pointerdown', 1, 100, 200);
    m.touch('pointermove', 1, 100, 350);
    m.touch('pointermove', 1, 100, 500);
    m.touch('pointerup', 1, 100, 500);
    expect(m.q('canvas-prop-arrow-end')?.getAttribute('aria-pressed')).toBe('true');
    click(m, 'canvas-prop-arrow-both');
    click(m, 'canvas-prop-route-elbow');
    await settle(600);
    const conn = objects(m).find((o) => o['kind'] === 'connector');
    expect(conn).toMatchObject({ arrow: 'both', route: 'elbow' });
    expect(m.q('canvas-prop-size')).toBeNull();
  });
});

describe('touch editing in the viewer', () => {
  const objects = (m: Mounted): Array<Record<string, unknown>> => [...m.relay.doc.getMap<{ toJSON(): Record<string, unknown> }>('objects').values()].map((o) => o.toJSON());
  const click = (m: Mounted, id: string): void => act(() => m.q(id)?.click());
  const esc = (m: Mounted): void => act(() => void m.host.querySelector('textarea')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  const place = (m: Mounted, tool: string, x: number, y: number): void => {
    click(m, `canvas-tool-${tool}`);
    m.touch('pointerdown', 1, x, y);
    m.touch('pointerup', 1, x, y);
    esc(m);
  };

  it('a long press on empty canvas opens the menu; its items paste, write a text, or open the templates', async () => {
    const m = await mount({ phoneEdit: true });
    m.touch('pointerdown', 1, 200, 400);
    await settle(600);
    expect(m.q('canvas-phone-menu')).not.toBeNull();
    m.touch('pointerup', 1, 200, 400);
    expect(m.q('canvas-phone-menu')).not.toBeNull();
    for (const b of m.q('canvas-phone-menu')?.querySelectorAll('button') ?? []) expect(b.className).toContain('h-11');
    // the backdrop closes it
    click(m, 'canvas-phone-menu-backdrop');
    expect(m.q('canvas-phone-menu')).toBeNull();
    // «Текст здесь» starts a text at the finger
    m.touch('pointerdown', 1, 200, 400);
    await settle(600);
    m.touch('pointerup', 1, 200, 400);
    click(m, 'canvas-phone-menu-text');
    expect(m.q('canvas-phone-menu')).toBeNull();
    expect(m.host.querySelector('textarea')).not.toBeNull();
    esc(m);
    // «Шаблон…» opens the «+» sheet
    m.touch('pointerdown', 1, 200, 600);
    await settle(600);
    m.touch('pointerup', 1, 200, 600);
    click(m, 'canvas-phone-menu-templates');
    expect(m.q('canvas-phone-plus-sheet')).not.toBeNull();
  });

  it('there is no menu in view mode, on an object, or while the finger moves', async () => {
    const m = await mount();
    m.touch('pointerdown', 1, 200, 400);
    await settle(700);
    m.touch('pointerup', 1, 200, 400);
    expect(m.q('canvas-phone-menu')).toBeNull();
    await m.rerender({ phoneEdit: true });
    m.touch('pointerdown', 1, 200, 400);
    await settle(300);
    m.touch('pointermove', 1, 240, 440);
    await settle(600);
    m.touch('pointerup', 1, 240, 440);
    expect(m.q('canvas-phone-menu')).toBeNull();
    place(m, 'sticky', 200, 300);
    m.touch('pointerdown', 1, 200, 300);
    await settle(700);
    m.touch('pointerup', 1, 200, 300);
    expect(m.q('canvas-phone-menu')).toBeNull();
  });

  it('«Выбрать несколько» takes taps into the selection; the sheet counts them', async () => {
    const m = await mount({ phoneEdit: true });
    place(m, 'sticky', 100, 200);
    place(m, 'sticky', 100, 500);
    // deselect, then collect both
    m.touch('pointerdown', 1, 350, 750);
    m.touch('pointerup', 1, 350, 750);
    expect(m.q('canvas-phone-props')).toBeNull();
    m.touch('pointerdown', 1, 100, 200);
    m.touch('pointerup', 1, 100, 200);
    click(m, 'canvas-phone-multi');
    m.touch('pointerdown', 1, 100, 500);
    m.touch('pointerup', 1, 100, 500);
    expect(m.q('canvas-phone-count')?.textContent).toMatch(/2/);
    expect(m.q('canvas-phone-multi')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('the sheet’s pencil edits the selected object’s text', async () => {
    const m = await mount({ phoneEdit: true });
    place(m, 'sticky', 200, 300);
    expect(m.host.querySelector('textarea')).toBeNull();
    click(m, 'canvas-prop-edit-text');
    expect(m.host.querySelector('textarea')).not.toBeNull();
  });

  it('while a text is edited the format bar sits at the bottom with 44 px targets and «Готово» ends the edit', async () => {
    const m = await mount({ phoneEdit: true });
    expect(m.q('canvas-format-bar')).toBeNull();
    click(m, 'canvas-tool-sticky');
    m.touch('pointerdown', 1, 200, 300);
    m.touch('pointerup', 1, 200, 300);
    const bar = m.q('canvas-format-bar');
    expect(bar).not.toBeNull();
    expect(bar?.className).toContain('inset-x-0');
    for (const b of bar?.querySelectorAll('button') ?? []) expect(b.className, b.getAttribute('aria-label') ?? '').toContain('size-11');
    expect(m.q('canvas-phone-toolbar')).toBeNull();
    // B toggles bold at the caret and keeps the textarea focused (the keyboard stays up)
    const ta = m.host.querySelector('textarea') as HTMLTextAreaElement;
    ta.focus();
    const down = new MouseEvent('pointerdown', { bubbles: true, cancelable: true });
    act(() => void m.q('canvas-format-bold')?.dispatchEvent(down));
    expect(down.defaultPrevented).toBe(true);
    click(m, 'canvas-format-bold');
    expect(m.q('canvas-format-bold')?.getAttribute('aria-pressed')).toBe('true');
    expect(m.q('canvas-format-size-input')?.getAttribute('inputmode')).toBe('numeric');
    click(m, 'canvas-format-size-more');
    expect(m.q('canvas-format-size-input')?.getAttribute('aria-valuenow')).toBe('19');
    ta.value = 'Привет';
    act(() => void ta.dispatchEvent(new Event('input', { bubbles: true })));
    click(m, 'canvas-format-done');
    expect(m.host.querySelector('textarea')).toBeNull();
    expect(m.q('canvas-format-bar')).toBeNull();
    expect(m.q('canvas-phone-toolbar')).not.toBeNull();
    await settle(600);
    // One step up from the sticky's 18 px: an exact size next to the nearest token («m», stored as absence).
    expect(objects(m)[0]).toMatchObject({ text: 'Привет', fontPx: 19 });
    expect(objects(m)[0]).not.toHaveProperty('fontSize');
  });

  it('has no format bar in view mode', async () => {
    const m = await mount();
    expect(m.q('canvas-format-bar')).toBeNull();
  });

  it('adds no timer or frame at rest beyond what a writable desktop canvas has (the socket keeps its own)', async () => {
    const desk = await mount({ phone: false });
    desk.key('s'); desk.touch('pointerdown', 1, 200, 300); desk.touch('pointerup', 1, 200, 300); act(() => void desk.host.querySelector('textarea')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    await settle(2000);
    const writable = vi.getTimerCount();
    desk.unmount();
    const m = await mount({ phoneEdit: true });
    place(m, 'sticky', 200, 300);
    m.touch('pointerdown', 1, 200, 300);
    m.touch('pointermove', 1, 240, 340);
    m.touch('pointerup', 1, 240, 340);
    await settle(2000);
    expect(vi.getTimerCount()).toBeLessThanOrEqual(writable);
    // and back in view mode the viewer is as quiet as a view-only one (no timer of the phone chrome survives)
    await m.rerender({ phoneEdit: false });
    await settle(2000);
    expect(vi.getTimerCount()).toBeLessThanOrEqual(writable);
  });
});

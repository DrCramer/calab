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

/** `phone` mode of CanvasView (ADR-0113 §5): read-only whatever the grant, no tools, touch navigation. */
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

describe('the edit mode (ADR-0114 wave 5b)', () => {
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

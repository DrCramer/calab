// @vitest-environment jsdom
import { create } from '@bufbuild/protobuf';
import { CANVAS_BITS, CanvasItemKind, CanvasItemResponseSchema, CanvasItemSchema, ListCanvasItemsResponseSchema, SearchResponseSchema, type CanvasItem } from '@calaba/protocol';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { topScreen } from '../../lib/phoneNav';
import { api } from '../../lib/api/endpoints';
import { canvasApi } from '../../services/canvas';
import { useCanvas } from '../../stores/canvas';
import { useCanvasUi } from '../../stores/canvasUi';
import { useUi } from '../../stores/ui';
import { PhoneCanvas, PhoneCanvasScreen } from './PhoneCanvas';

vi.mock('../../platform', () => ({ platform: { kind: 'web', app: { log: () => undefined, attention: () => undefined } } }));
/** The viewer is its own lazy chunk (engine, Yjs, socket): a stand-in that records the props the screen gives it. */
const view = vi.hoisted(() => ({ props: null as Record<string, unknown> | null, mounts: 0, unmounts: 0 }));
vi.mock('./lazy', async () => {
  const { createElement: h, useEffect } = await import('react');
  return {
    CanvasViewLazy: (p: Record<string, unknown>) => {
      view.props = p;
      useEffect(() => {
        view.mounts++;
        return () => {
          view.unmounts++;
        };
      }, []);
      return h('div', { 'data-testid': 'stub-view' });
    },
    preloadCanvasView: () => undefined,
  };
});

const W = 'w';
const WRITE = CANVAS_BITS.VIEW | CANVAS_BITS.WRITE | CANVAS_BITS.MANAGE;
const item = (id: string, parentId: string, name: string, kind = CanvasItemKind.CANVAS): CanvasItem =>
  create(CanvasItemSchema, { id, workspaceId: W, parentId, kind, name, myBits: WRITE, ownerId: 'me' });

const TREE: Record<string, CanvasItem[]> = {
  '': [item('f1', '', 'Продукт', CanvasItemKind.FOLDER), item('c1', '', 'Планирование спринта')],
  f1: [item('c2', 'f1', 'Дорожная карта Q1'), item('c3', 'f1', 'Ретро-доска')],
};

/** A canvas the person may only look at. */
const VIEWONLY = create(CanvasItemSchema, { id: 'c9', workspaceId: W, parentId: '', kind: CanvasItemKind.CANVAS, name: 'Только чтение', myBits: CANVAS_BITS.VIEW, ownerId: 'x' });

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root;
let host: HTMLElement;

/** What MobileShell does for the tab: the root list, or the top pushed `canvas` screen. */
function Shell(): ReactNode {
  const top = useUi((s) => topScreen(s.phone));
  return top?.kind === 'canvas' ? createElement(PhoneCanvasScreen, { key: top.itemId, workspaceId: W, itemId: top.itemId }) : createElement(PhoneCanvas, { workspaceId: W });
}

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};
const q = (id: string): HTMLElement | null => host.querySelector(`[data-testid="${id}"]`);
const all = (id: string): HTMLElement[] => [...host.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const names = (): Array<string | null> => all('phone-canvas-row').map((r) => r.textContent);

beforeEach(async () => {
  view.props = null;
  view.mounts = 0;
  view.unmounts = 0;
  useCanvas.setState({ items: {}, lists: {}, load: {} });
  useCanvasUi.setState({ active: false, itemOf: {}, trashOf: {}, expanded: {}, query: '', renaming: null, dialog: null });
  useUi.setState({ activeWorkspaceId: W });
  useUi.getState().setPhone(() => ({ on: true, tab: 'canvas', stack: [] }));
  vi.spyOn(canvasApi, 'list').mockImplementation((_ws, p) => Promise.resolve(create(ListCanvasItemsResponseSchema, { items: TREE[p.parent ?? ''] ?? [] })));
  vi.spyOn(canvasApi, 'get').mockImplementation((id) => {
    const it = [...Object.values(TREE).flat(), VIEWONLY].find((x) => x.id === id);
    return it ? Promise.resolve(create(CanvasItemResponseSchema, { item: it })) : Promise.reject(new Error('404'));
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root.render(createElement(Shell));
  });
  await flush();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('«Холст» on the phone: tree → canvas → back', () => {
  it('lists the top level: folders and canvases, no trash, no create', () => {
    expect(names()).toHaveLength(2);
    expect(all('phone-canvas-row').map((r) => r.dataset['kind'])).toEqual(['folder', 'canvas']);
    expect(q('phone-canvas')).not.toBeNull();
    // Nothing to create or to trash on a view-only phone: the bar holds the magnifier and an empty slot.
    expect(host.querySelector('[data-testid="phone-canvas-create"]')).toBeNull();
    expect(host.textContent).not.toMatch(/Корзина|Trash/);
  });

  it('a folder pushes a screen with its children; a canvas pushes the viewer; «←» walks back', async () => {
    act(() => all('phone-canvas-row')[0]?.querySelector('button')?.click());
    await flush();
    expect(useUi.getState().phone.stack).toEqual([{ kind: 'canvas', itemId: 'f1' }]);
    expect(q('phone-canvas-folder')).not.toBeNull();
    expect(names().sort()).toEqual(['Дорожная карта Q1', 'Ретро-доска'].sort());

    act(() => all('phone-canvas-row')[0]?.querySelector('button')?.click());
    await flush();
    expect(useUi.getState().phone.stack.map((s) => (s.kind === 'canvas' ? s.itemId : ''))).toEqual(['f1', 'c2']);
    expect(q('phone-canvas-screen')).not.toBeNull();
    expect(q('stub-view')).not.toBeNull();
    expect(q('phone-header')?.textContent).toContain('Дорожная карта Q1');

    act(() => q('phone-back')?.click());
    await flush();
    expect(useUi.getState().phone.stack).toEqual([{ kind: 'canvas', itemId: 'f1' }]);
    expect(q('phone-canvas-folder')).not.toBeNull();
    expect(view.unmounts).toBe(1);

    act(() => q('phone-back')?.click());
    await flush();
    expect(useUi.getState().phone.stack).toEqual([]);
    expect(q('phone-canvas')).not.toBeNull();
  });

  it('the viewer opens in view mode, whatever the grant says', async () => {
    act(() => all('phone-canvas-row')[1]?.querySelector('button')?.click());
    await flush();
    expect(view.props).toMatchObject({ canvasId: 'c1', workspaceId: W, phone: true, phoneEdit: false, name: 'Планирование спринта' });
    // The item carries write and manage bits; the phone flag, not the bits, makes the viewer read-only until «Править».
    expect((view.props?.['bits'] as bigint) & CANVAS_BITS.WRITE).toBe(CANVAS_BITS.WRITE);
  });

  it('leaving a canvas unmounts the viewer (its socket closes); the section is «on screen» only while a screen is mounted', async () => {
    expect(useCanvasUi.getState().active).toBe(true);
    act(() => all('phone-canvas-row')[1]?.querySelector('button')?.click());
    await flush();
    expect(view.mounts).toBe(1);
    act(() => q('phone-back')?.click());
    await flush();
    expect(view.unmounts).toBe(1);
    act(() => root.unmount());
    expect(useCanvasUi.getState().active).toBe(false);
    root = createRoot(host);
  });

  it('a canvas opened by link (unknown to the stores) is fetched and shown', async () => {
    act(() => useUi.getState().setPhone(() => ({ on: true, tab: 'canvas', stack: [{ kind: 'canvas', itemId: 'c3' }] })));
    await flush();
    expect(canvasApi.get).toHaveBeenCalledWith('c3');
    expect(q('stub-view')).not.toBeNull();
  });

  it('a canvas that is gone says so instead of spinning forever', async () => {
    act(() => useUi.getState().setPhone(() => ({ on: true, tab: 'canvas', stack: [{ kind: 'canvas', itemId: 'nope' }] })));
    await flush();
    expect(q('phone-canvas-gone')).not.toBeNull();
    expect(q('stub-view')).toBeNull();
  });

  it('a canvas removed or trashed while open closes its screen', async () => {
    act(() => all('phone-canvas-row')[1]?.querySelector('button')?.click());
    await flush();
    expect(q('stub-view')).not.toBeNull();
    act(() => useCanvas.getState().remove('c1'));
    await flush();
    expect(useUi.getState().phone.stack).toEqual([]);
  });

  it('the magnifier filters by name, the server search adds what is not loaded', async () => {
    useCanvas.getState().put(Object.values(TREE).flat());
    const search = vi.spyOn(api, 'search').mockResolvedValue(create(SearchResponseSchema, {}));
    act(() => q('phone-search')?.click());
    expect(q('phone-canvas-search-field')).not.toBeNull();
    act(() => useCanvasUi.getState().setQuery('ретро'));
    expect(all('phone-canvas-row').map((r) => r.textContent)).toEqual([expect.stringContaining('Ретро-доска')]);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ q: 'ретро', scope: W, type: 'canvas' }), expect.anything());
    act(() => useCanvasUi.getState().setQuery('zzz'));
    expect(q('phone-canvas-search-results')?.textContent).toMatch(/Ничего не найдено|Nothing found/);
    // The magnifier again closes the filter and brings the list back.
    act(() => q('phone-search')?.click());
    expect(useCanvasUi.getState().query).toBe('');
    expect(names()).toHaveLength(2);
  });
});

describe('«Править» (ADR-0127 wave 5b)', () => {
  const open = async (id: string): Promise<void> => {
    act(() => useUi.getState().setPhone((p) => ({ ...p, stack: [{ kind: 'canvas', itemId: id }] })));
    await flush();
  };

  it('the header button turns the edit mode on and «Готово» off; the viewer is told', async () => {
    await open('c1');
    const btn = q('phone-canvas-edit');
    expect(btn?.textContent).toBe('Править');
    expect(btn?.getAttribute('aria-pressed')).toBe('false');
    expect(view.props?.['phoneEdit']).toBe(false);
    act(() => btn?.click());
    expect(q('phone-canvas-edit')?.textContent).toBe('Готово');
    expect(q('phone-canvas-edit')?.getAttribute('aria-pressed')).toBe('true');
    expect(view.props?.['phoneEdit']).toBe(true);
    act(() => q('phone-canvas-edit')?.click());
    expect(q('phone-canvas-edit')?.textContent).toBe('Править');
    expect(view.props?.['phoneEdit']).toBe(false);
  });

  it('is in memory only, and another canvas opens in view mode again', async () => {
    const before = Object.keys(localStorage).length;
    await open('c1');
    act(() => q('phone-canvas-edit')?.click());
    expect(view.props?.['phoneEdit']).toBe(true);
    expect(Object.keys(localStorage).length).toBe(before);
    await open('c2');
    expect(view.props).toMatchObject({ canvasId: 'c2', phoneEdit: false });
    expect(q('phone-canvas-edit')?.textContent).toBe('Править');
  });

  it('is not offered without CANVAS_WRITE: no button, the viewer stays in view mode', async () => {
    await open('c9');
    expect(q('phone-canvas-screen')).not.toBeNull();
    expect(q('phone-canvas-edit')).toBeNull();
    expect(view.props).toMatchObject({ canvasId: 'c9', phoneEdit: false });
    expect((view.props?.['bits'] as bigint) & CANVAS_BITS.WRITE).toBe(0n);
  });

  it('a folder screen has no edit button', async () => {
    await open('f1');
    expect(q('phone-canvas-folder')).not.toBeNull();
    expect(q('phone-canvas-edit')).toBeNull();
  });
});

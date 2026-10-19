// @vitest-environment jsdom
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { CANVAS_BITS, CanvasItemKind, CanvasItemSchema, type CanvasItem } from '@calaba/protocol';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCanvas } from '../../stores/canvas';
import { DROP, ItemMenuEntries } from './ItemMenu';
import { registerCanvasViewHandle, type CanvasViewHandle } from './view/handle';

vi.mock('../../platform', () => ({ platform: { kind: 'web', app: { log: () => undefined, attention: () => undefined } } }));

const W = 'w';
const item = (id: string, extra: Omit<Partial<CanvasItem>, '$typeName' | '$unknown'> = {}): CanvasItem =>
  create(CanvasItemSchema, { id, workspaceId: W, kind: CanvasItemKind.CANVAS, name: 'Roadmap', myBits: CANVAS_BITS.VIEW | CANVAS_BITS.WRITE, ...extra });

let root: Root;
let host: HTMLElement;
let unregister: (() => void) | null = null;
const handle = (): CanvasViewHandle => ({ exportPng: vi.fn(() => Promise.resolve(true)), fitAll: vi.fn() });

function menu(id: string, withExport: boolean): ReactNode {
  return createElement(
    Dropdown.Root,
    { open: true, modal: false },
    createElement(Dropdown.Trigger, null, 'x'),
    createElement(Dropdown.Content, null, createElement(ItemMenuEntries, { itemId: id, parts: DROP, hideOpen: true, withExport, onRename: () => undefined })),
  );
}
const show = (id: string, withExport: boolean): void => act(() => root.render(menu(id, withExport)));
const q = (testId: string): HTMLElement | null => document.querySelector(`[data-testid="${testId}"]`);

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
});
beforeEach(() => {
  useCanvas.setState({ items: {}, lists: {}, load: {} });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  unregister?.();
  unregister = null;
  act(() => root.unmount());
  document.body.innerHTML = '';
});

describe('«Экспорт PNG» in the header menu', () => {
  it('is offered for the open canvas whose view is mounted; both entries call the handle with the canvas name', () => {
    useCanvas.getState().put([item('c')]);
    const h = handle();
    unregister = registerCanvasViewHandle('c', h);
    show('c', true);
    act(() => q('canvas-menu-export')?.click());
    expect(h.exportPng).toHaveBeenLastCalledWith({ area: 'all', name: 'Roadmap' });
    show('c', true);
    act(() => q('canvas-menu-export-visible')?.click());
    expect(h.exportPng).toHaveBeenLastCalledWith({ area: 'visible', name: 'Roadmap' });
  });

  it('is absent without a mounted view, for tree rows, folders and canvases in the trash', () => {
    useCanvas.getState().put([item('c'), item('f', { kind: CanvasItemKind.FOLDER }), item('t', { trashedAt: timestampFromMs(1) })]);
    show('c', true);
    expect(q('canvas-menu-export')).toBeNull(); // no handle yet
    unregister = registerCanvasViewHandle('c', handle());
    show('c', false);
    expect(q('canvas-menu-export')).toBeNull(); // a tree row's menu
    const other = registerCanvasViewHandle('f', handle());
    show('f', true);
    expect(q('canvas-menu-export')).toBeNull(); // folder
    other();
    const gone = registerCanvasViewHandle('t', handle());
    show('t', true);
    expect(q('canvas-menu-export')).toBeNull(); // trashed
    gone();
  });

  it('a viewer without write access may export as well', () => {
    useCanvas.getState().put([item('c', { myBits: CANVAS_BITS.VIEW })]);
    unregister = registerCanvasViewHandle('c', handle());
    show('c', true);
    expect(q('canvas-menu-export')).not.toBeNull();
  });
});

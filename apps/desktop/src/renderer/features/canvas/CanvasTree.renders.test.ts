// @vitest-environment jsdom
import { DndContext } from '@dnd-kit/core';
import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { CanvasItemKind, CanvasItemSchema, type CanvasItem } from '@calaba/protocol';
import { Profiler, act, createElement, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { childKey } from '../../lib/canvas/tree';
import { useCanvas } from '../../stores/canvas';
import { useCanvasUi } from '../../stores/canvasUi';
import { CanvasTree } from './CanvasTree';

/** Renders per row: ItemContextMenu is a child of every TreeNode and re-renders exactly when its row does. */
const rowRenders = vi.hoisted(() => new Map<string, number>());
vi.mock('./ItemMenu', async (orig) => {
  const m = await orig<typeof import('./ItemMenu')>();
  return {
    ...m,
    ItemContextMenu: (p: ComponentProps<typeof m.ItemContextMenu>) => {
      rowRenders.set(p.itemId, (rowRenders.get(p.itemId) ?? 0) + 1);
      return createElement(m.ItemContextMenu, p);
    },
  };
});
vi.mock('../../platform', () => ({ platform: { kind: 'web', apiBase: '', auth: { accessToken: () => Promise.resolve('t'), forceRefresh: () => Promise.resolve('t') } } }));
vi.mock('../../services/canvas', async (orig) => ({
  ...(await orig<typeof import('../../services/canvas')>()),
  loadChildren: vi.fn(() => Promise.resolve()),
  loadTrash: vi.fn(() => Promise.resolve()),
}));

const W = 'w';
const item = (id: string, extra: Omit<Partial<CanvasItem>, '$typeName' | '$unknown'> = {}): CanvasItem =>
  create(CanvasItemSchema, { id, workspaceId: W, parentId: '', kind: CanvasItemKind.CANVAS, name: id, ...extra });

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
});

function mountTree(): { commits: { n: number }; names: () => string[] } {
  const el = document.createElement('div');
  document.body.append(el);
  host = el;
  root = createRoot(el);
  const commits = { n: 0 };
  const onRender = (): void => {
    commits.n++;
  };
  act(() => {
    root?.render(createElement(Profiler, { id: 't', onRender }, createElement(DndContext, null, createElement(CanvasTree, { workspaceId: W, canCreate: true }))));
  });
  return { commits, names: () => [...el.querySelectorAll('[data-testid="canvas-node"]')].map((n) => n.textContent) };
}

describe('CanvasTree renders (CLAUDE.md «Ререндеры под контролем», ADR-0107 §4)', () => {
  beforeEach(() => {
    rowRenders.clear();
    useCanvas.setState({ items: {}, lists: {}, load: {} });
    useCanvasUi.setState({ query: '', trashOf: {}, expanded: {}, renaming: null, itemOf: {} });
    useCanvas.getState().setList(childKey(W, ''), Array.from({ length: 40 }, (_, i) => item(`c${i}`, { position: i, preview: 'first words' })));
  });

  it('a foreign edit of a canvas (only preview / updated_at change on one row) renders no row', () => {
    const { commits, names } = mountTree();
    expect(names()).toHaveLength(40);
    const before = commits.n;
    const rows = new Map(rowRenders);
    for (let i = 0; i < 20; i++) {
      const prev = useCanvas.getState().items['c7'] as CanvasItem;
      act(() => {
        useCanvas.getState().upsert({ ...prev, preview: `words ${i}`, updatedAt: timestampFromMs(1000 + i) }, true);
      });
    }
    expect(commits.n).toBe(before);
    expect(rowRenders).toEqual(rows);
  });

  it('a rename re-renders only that row', () => {
    const { commits, names } = mountTree();
    const before = commits.n;
    const rows = new Map(rowRenders);
    act(() => {
      useCanvas.getState().upsert({ ...(useCanvas.getState().items['c7'] as CanvasItem), name: 'Roadmap' }, true);
    });
    expect(names()[7]).toContain('Roadmap');
    expect(commits.n).toBe(before + 1);
    const changed = [...rowRenders].filter(([id, n]) => n !== rows.get(id)).map(([id]) => id);
    expect(changed).toEqual(['c7']);
  });
});

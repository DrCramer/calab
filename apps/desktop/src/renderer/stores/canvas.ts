import type { CanvasItem } from '@calaba/protocol';
import { create } from 'zustand';
import { applyList, applyRemove, applyUpsert, dropWorkspace, type CanvasData } from '../lib/canvas/tree';

/**
 * Canvas data (ADR-0107), normalized like the Disk and the Wiki (docs/08 «Производительность»):
 * items by id, child lists as ordered id lists per folder (loaded lazily when a node is expanded;
 * lib/canvas/tree childKey) and the trash per workspace (trashKey), with each list's load state.
 * A tree row reads its item by id and its children's ids (useShallow) — an upsert re-renders that
 * row and the one list it moved through. The reducers are pure (lib/canvas/tree.ts).
 */
export type LoadState = 'loading' | 'ready' | 'error';

interface CanvasState extends CanvasData {
  load: Readonly<Record<string, LoadState>>;
  setLoad: (key: string, v: LoadState) => void;
  setList: (key: string, items: readonly CanvasItem[]) => void;
  upsert: (item: CanvasItem, fromEvent?: boolean) => void;
  /** Items known without touching any list (GET …/path, GET an item). */
  put: (items: readonly CanvasItem[]) => void;
  remove: (id: string) => void;
  dropWorkspace: (wsId: string) => void;
  /** The lists of a workspace are stale (events while the section was closed): reloaded on the next open. */
  forgetLists: (wsId: string) => void;
}

export const useCanvas = create<CanvasState>()((set) => ({
  items: {},
  lists: {},
  load: {},
  setLoad: (key, v) => set((s) => (s.load[key] === v ? s : { load: { ...s.load, [key]: v } })),
  setList: (key, items) =>
    set((s) => ({
      ...applyList(s, key, items),
      load: { ...s.load, [key]: 'ready' },
    })),
  upsert: (item, fromEvent) => set((s) => applyUpsert(s, item, fromEvent)),
  put: (list) =>
    set((s) => {
      if (!list.length) return s;
      const items = { ...s.items };
      for (const i of list) items[i.id] = i;
      return { items };
    }),
  remove: (id) => set((s) => applyRemove(s, id)),
  dropWorkspace: (wsId) => set((s) => ({ ...dropWorkspace(s, wsId), load: dropKeys(s.load, wsId) })),
  forgetLists: (wsId) =>
    set((s) => ({
      lists: dropKeys(s.lists, wsId),
      load: dropKeys(s.load, wsId),
    })),
}));

function dropKeys<T>(m: Readonly<Record<string, T>>, wsId: string): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(m)) if (!k.startsWith(`${wsId}/`)) out[k] = v;
  return out;
}

import type { CanvasComment } from '@calaba/protocol';
import { create } from 'zustand';

/**
 * Comments of the open canvases (ADR-0115 wave 4): a store of its own, by id, apart from the tree's. A
 * canvas's threads are kept only once it was loaded (`loaded`); gateway events for other canvases are
 * dropped, the next open reads them fresh. Components select primitives or `useShallow` id lists:
 * a pin or a thread re-renders for its own comment only.
 *
 * The UI part (`panel`, `filterOpen`, `active`, `draft`, `focus`) is one per app: only one canvas is
 * on screen at a time.
 */

/** Where a new thread goes: the object under the click (offset from its corner) or a point on the field. */
export interface CommentDraft {
  canvasId: string;
  objectId: string;
  x: number;
  y: number;
}

interface CanvasCommentsState {
  byId: Readonly<Record<string, CanvasComment>>;
  /** Canvas → its thread roots, the oldest first. */
  threads: Readonly<Record<string, readonly string[]>>;
  /** Root → its replies, the oldest first. */
  replies: Readonly<Record<string, readonly string[]>>;
  /** Canvases whose comments were read (events apply to them only). */
  loaded: Readonly<Record<string, true>>;
  /** Replaces a canvas's comments (a full read). */
  setCanvas: (canvasId: string, list: readonly CanvasComment[]) => void;
  /** A comment written, edited, resolved — ignored for a canvas that was not read. */
  upsert: (c: CanvasComment) => void;
  /** A comment deleted (a root takes its replies along). */
  remove: (canvasId: string, id: string) => void;
  /** The canvas is gone or out of reach: its comments go. */
  forget: (canvasId: string) => void;

  panel: boolean;
  setPanel: (on: boolean) => void;
  /** «Только открытые» in the panel. */
  filterOpen: boolean;
  setFilterOpen: (on: boolean) => void;
  /** The thread shown expanded (its pin highlighted). */
  active: string | null;
  setActive: (id: string | null) => void;
  /** A new thread being written (the pin is placed, the input open). */
  draft: CommentDraft | null;
  setDraft: (d: CommentDraft | null) => void;
  /** A thread to show once its canvas is open (a notification, a link): the view centres on its pin. */
  focus: { canvasId: string; threadId: string } | null;
  setFocus: (f: { canvasId: string; threadId: string } | null) => void;
}

const without = <T,>(rec: Readonly<Record<string, T>>, keys: readonly string[]): Record<string, T> => {
  const out = { ...rec };
  for (const k of keys) delete out[k];
  return out;
};

export const useCanvasComments = create<CanvasCommentsState>()((set) => ({
  byId: {},
  threads: {},
  replies: {},
  loaded: {},
  setCanvas: (canvasId, list) =>
    set((s) => {
      const gone = (s.threads[canvasId] ?? []).flatMap((r) => [r, ...(s.replies[r] ?? [])]);
      const byId = without(s.byId, gone);
      const replies = without(s.replies, s.threads[canvasId] ?? []);
      const roots: string[] = [];
      for (const c of list) {
        byId[c.id] = c;
        if (!c.parentId) {
          roots.push(c.id);
          replies[c.id] = [];
        }
      }
      for (const c of list) {
        if (c.parentId && replies[c.parentId]) replies[c.parentId] = [...(replies[c.parentId] ?? []), c.id];
      }
      return { byId, replies, threads: { ...s.threads, [canvasId]: roots }, loaded: { ...s.loaded, [canvasId]: true } };
    }),
  upsert: (c) =>
    set((s) => {
      if (!s.loaded[c.canvasId]) return s;
      const known = !!s.byId[c.id];
      const byId = { ...s.byId, [c.id]: c };
      if (known) return { byId };
      if (!c.parentId) {
        return { byId, threads: { ...s.threads, [c.canvasId]: [...(s.threads[c.canvasId] ?? []), c.id] }, replies: { ...s.replies, [c.id]: [] } };
      }
      // A reply to a thread this client does not hold (deleted meanwhile): nothing to attach it to.
      if (!s.replies[c.parentId]) return s;
      return { byId, replies: { ...s.replies, [c.parentId]: [...(s.replies[c.parentId] ?? []), c.id] } };
    }),
  remove: (canvasId, id) =>
    set((s) => {
      const c = s.byId[id];
      if (!c) return s;
      if (c.parentId) {
        return { byId: without(s.byId, [id]), replies: { ...s.replies, [c.parentId]: (s.replies[c.parentId] ?? []).filter((r) => r !== id) } };
      }
      return {
        byId: without(s.byId, [id, ...(s.replies[id] ?? [])]),
        replies: without(s.replies, [id]),
        threads: { ...s.threads, [canvasId]: (s.threads[canvasId] ?? []).filter((r) => r !== id) },
        active: s.active === id ? null : s.active,
      };
    }),
  forget: (canvasId) =>
    set((s) => {
      if (!s.loaded[canvasId] && !s.threads[canvasId]) return s;
      const roots = s.threads[canvasId] ?? [];
      return {
        byId: without(s.byId, roots.flatMap((r) => [r, ...(s.replies[r] ?? [])])),
        replies: without(s.replies, roots),
        threads: without(s.threads, [canvasId]),
        loaded: without(s.loaded, [canvasId]),
        draft: s.draft?.canvasId === canvasId ? null : s.draft,
      };
    }),

  panel: false,
  setPanel: (panel) => set((s) => (s.panel === panel ? s : { panel })),
  filterOpen: false,
  setFilterOpen: (filterOpen) => set({ filterOpen }),
  active: null,
  setActive: (active) => set((s) => (s.active === active ? s : { active })),
  draft: null,
  setDraft: (draft) => set({ draft }),
  focus: null,
  setFocus: (focus) => set({ focus }),
}));

/** Open threads of a canvas (the counter on the button). */
export function openThreads(s: Pick<CanvasCommentsState, 'byId' | 'threads'>, canvasId: string): number {
  let n = 0;
  for (const id of s.threads[canvasId] ?? []) if (s.byId[id] && !s.byId[id].resolved) n++;
  return n;
}

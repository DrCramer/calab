import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useBoardsUi } from './boardsUi';
import { useDiskUi } from './diskUi';
import { useWikiUi } from './wikiUi';

/**
 * The «Холст» section's UI state (ADR-0126 §5): whether the section covers the column and the
 * centre, the open item of each workspace, the trash view, the expanded tree nodes, the tree
 * column's width (persisted), the tree's name filter and the dialog on top. The open canvas's own
 * chrome (connection notices, who else is on it) belongs to the lazy canvas view, not to this store.
 *
 * Exclusive with the other workspace modes like the Wiki: the boards, the Disk or the Wiki turned
 * on anywhere turn it off (below); a room, a day or history travel turn it off in stores/ui.ts
 * (leaveCanvas); the rail's sections go through features/shell/sectionNav.ts showMode.
 */
export type CanvasDialog =
  | { kind: 'share'; itemId: string }
  | { kind: 'versions'; itemId: string }
  | { kind: 'move'; itemId: string };

export const TREE_MIN = 220;
export const TREE_MAX = 360;
export const TREE_DEFAULT = 260;

export const clampTree = (w: number): number => Math.round(Math.min(TREE_MAX, Math.max(TREE_MIN, Number.isFinite(w) ? w : TREE_DEFAULT)));

interface CanvasUiState {
  active: boolean;
  setActive: (on: boolean) => void;
  /** Workspace → the open canvas id ('' = none yet). A folder row only expands; it never opens in the centre. */
  itemOf: Readonly<Record<string, string>>;
  openItem: (wsId: string, itemId: string) => void;
  /** Workspace → the tree column shows the trash. */
  trashOf: Readonly<Record<string, true>>;
  openTrash: (wsId: string, on: boolean) => void;
  /** Expanded tree nodes (folder ids, any workspace). */
  expanded: Readonly<Record<string, true>>;
  setExpanded: (id: string, on: boolean) => void;
  treeWidth: number;
  setTreeWidth: (w: number) => void;
  /** The tree's name filter; cleared when the section closes. */
  query: string;
  setQuery: (q: string) => void;
  /** The item whose tree row is being renamed in place (not persisted). */
  renaming: string | null;
  setRenaming: (id: string | null) => void;
  dialog: CanvasDialog | null;
  openDialog: (d: CanvasDialog | null) => void;
}

export const useCanvasUi = create<CanvasUiState>()(
  persist(
    (set) => ({
      active: false,
      setActive: (active) => set((s) => (s.active === active ? s : active ? { active } : { active, query: '', dialog: null })),
      itemOf: {},
      openItem: (wsId, itemId) =>
        set((s) => {
          if (s.itemOf[wsId] === itemId && !s.trashOf[wsId]) return s;
          return { itemOf: { ...s.itemOf, [wsId]: itemId }, dialog: null };
        }),
      trashOf: {},
      openTrash: (wsId, on) =>
        set((s) => {
          const trashOf = { ...s.trashOf };
          if (on) trashOf[wsId] = true;
          else delete trashOf[wsId];
          return { trashOf, query: '' };
        }),
      expanded: {},
      setExpanded: (id, on) =>
        set((s) => {
          if (!!s.expanded[id] === on) return s;
          const expanded = { ...s.expanded };
          if (on) expanded[id] = true;
          else delete expanded[id];
          return { expanded };
        }),
      treeWidth: TREE_DEFAULT,
      setTreeWidth: (w) => set((s) => (s.treeWidth === clampTree(w) ? s : { treeWidth: clampTree(w) })),
      query: '',
      setQuery: (query) => set({ query }),
      renaming: null,
      // The rename field lives in the tree row: a filter or the trash in its place is put away first.
      setRenaming: (renaming) =>
        set((s) => (s.renaming === renaming ? s : renaming === null ? { renaming } : { renaming, query: '', trashOf: {} })),
      dialog: null,
      openDialog: (dialog) => set({ dialog }),
    }),
    {
      name: 'calaba-canvas-ui',
      version: 1,
      partialize: (s) => ({
        itemOf: s.itemOf,
        expanded: s.expanded,
        treeWidth: s.treeWidth,
      }),
      merge: (stored, cur) => {
        const p = (stored ?? {}) as Partial<CanvasUiState>;
        const itemOf: Record<string, string> = {};
        if (p.itemOf && typeof p.itemOf === 'object') for (const [k, v] of Object.entries(p.itemOf)) if (typeof v === 'string') itemOf[k] = v;
        const expanded: Record<string, true> = {};
        if (p.expanded && typeof p.expanded === 'object') for (const [k, v] of Object.entries(p.expanded as Record<string, unknown>)) if (v === true) expanded[k] = true;
        return {
          ...cur,
          itemOf,
          expanded,
          treeWidth: clampTree(typeof p.treeWidth === 'number' ? p.treeWidth : TREE_DEFAULT),
        };
      },
    },
  ),
);

/** The open item of a workspace (a string: a selector re-renders only when it changes). */
export const itemOf = (s: Pick<CanvasUiState, 'itemOf'>, wsId: string): string => s.itemOf[wsId] ?? '';

/** Leaves the section (a room, a day, a board, the Disk or the Wiki opened from anywhere). */
export function leaveCanvas(): void {
  if (useCanvasUi.getState().active) useCanvasUi.getState().setActive(false);
}

// The boards, the Disk or the Wiki turned on from anywhere leave the canvas.
useBoardsUi.subscribe((s, prev) => {
  if (s.active && !prev.active) leaveCanvas();
});
useDiskUi.subscribe((s, prev) => {
  if (s.active && !prev.active) leaveCanvas();
});
useWikiUi.subscribe((s, prev) => {
  if (s.active && !prev.active) leaveCanvas();
});

import type { SavedTaskSearch } from '@calaba/protocol';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { EMPTY_QUERY, isSearchState, type TaskQuery } from '../lib/boards/taskSearch';

/**
 * The task search's state (ADR-0139): the last conditions per workspace (localStorage: «последние
 * условия запоминаются»), the text of each board's search (not persisted: a board opens as the
 * kanban), the caller's saved searches per workspace (loaded from the server) and which of them
 * is open on the results page.
 */
interface TaskSearchStore {
  /** Workspace → the last query of ⌘K «Задачи» and the results page. */
  byWs: Record<string, TaskQuery>;
  setQuery: (workspaceId: string, q: TaskQuery) => void;
  /** Board → its search text (the board's filter is the board's own, stores/boardsUi). */
  boardText: Record<string, string>;
  setBoardText: (boardId: string, q: string) => void;
  /** Board → its search's «Все / Незавершённые / Завершённые / В архиве» and sort. */
  boardState: Record<string, Pick<TaskQuery, 'state' | 'sort'>>;
  setBoardState: (boardId: string, v: Pick<TaskQuery, 'state' | 'sort'>) => void;
  /** Workspace → saved searches by position; absent = not loaded. */
  saved: Record<string, SavedTaskSearch[]>;
  setSaved: (workspaceId: string, list: SavedTaskSearch[]) => void;
  /** Workspace → the saved search open on the page ('' = an unsaved query). */
  activeSaved: Record<string, string>;
  setActiveSaved: (workspaceId: string, id: string) => void;
  /** «Мои задачи» should open on the search tab (a saved search or ⌘↩ from ⌘K); the page clears it. */
  wantPage: boolean;
  setWantPage: (v: boolean) => void;
}

export const useTaskSearch = create<TaskSearchStore>()(
  persist(
    (set) => ({
      byWs: {},
      setQuery: (ws, q) => set((s) => (s.byWs[ws] === q ? {} : { byWs: { ...s.byWs, [ws]: q } })),
      boardText: {},
      setBoardText: (id, q) => set((s) => ((s.boardText[id] ?? '') === q ? {} : { boardText: { ...s.boardText, [id]: q } })),
      boardState: {},
      setBoardState: (id, v) => set((s) => ({ boardState: { ...s.boardState, [id]: v } })),
      saved: {},
      setSaved: (ws, list) => set((s) => ({ saved: { ...s.saved, [ws]: list } })),
      activeSaved: {},
      setActiveSaved: (ws, id) => set((s) => ((s.activeSaved[ws] ?? '') === id ? {} : { activeSaved: { ...s.activeSaved, [ws]: id } })),
      wantPage: false,
      setWantPage: (wantPage) => set({ wantPage }),
    }),
    {
      name: 'calaba-task-search',
      version: 1,
      partialize: (s) => ({ byWs: s.byWs, boardState: s.boardState }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<Pick<TaskSearchStore, 'byWs' | 'boardState'>>;
        return { ...current, byWs: migrateQueries(p.byWs), boardState: p.boardState && typeof p.boardState === 'object' ? p.boardState : {} };
      },
    },
  ),
);

/** Stored queries, each checked: a broken entry falls back to an empty search. */
function migrateQueries(stored: unknown): Record<string, TaskQuery> {
  if (!stored || typeof stored !== 'object') return {};
  const out: Record<string, TaskQuery> = {};
  for (const [ws, raw] of Object.entries(stored as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const v = raw as Partial<TaskQuery>;
    const conds = Array.isArray(v.filter?.conds) ? v.filter.conds : [];
    out[ws] = {
      q: typeof v.q === 'string' ? v.q : '',
      state: isSearchState(v.state) ? v.state : 'all',
      filter: { conds, any: !!v.filter?.any },
      sort: typeof v.sort === 'string' ? v.sort : '',
    };
  }
  return out;
}

/** The workspace's last query (a stable object per workspace). */
export function queryOf(s: Pick<TaskSearchStore, 'byWs'>, workspaceId: string): TaskQuery {
  return s.byWs[workspaceId] ?? EMPTY_QUERY;
}

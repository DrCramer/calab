import type { Task } from '@calaba/protocol';
import { create } from 'zustand';

/**
 * The archive view of one board (a separate, small store: archived tasks never enter the main
 * boards store, so they cannot leak into the kanban, the lists, «Мои задачи» or the counters).
 * Newest archived first, as the server pages them; `ids` keep that order, `tasks` hold the rows.
 */
export interface ArchiveData {
  boardId: string;
  /** The text the loaded pages answer (the search box debounces into it). */
  query: string;
  ids: string[];
  tasks: Readonly<Record<string, Task>>;
  /** The server's cursor for the next page; '' = the last page. */
  cursor: string;
  load: 'idle' | 'loading' | 'ready' | 'error';
  /** A next page is being fetched. */
  more: boolean;
}

interface ArchiveState extends ArchiveData {
  reset: (boardId: string, query: string) => void;
  setLoading: (more: boolean) => void;
  setPage: (list: readonly Task[], cursor: string, append: boolean) => void;
  setError: () => void;
  drop: (taskId: string) => void;
}

export const EMPTY_ARCHIVE: ArchiveData = { boardId: '', query: '', ids: [], tasks: {}, cursor: '', load: 'idle', more: false };

export const useBoardArchive = create<ArchiveState>()((set) => ({
  ...EMPTY_ARCHIVE,
  reset: (boardId, query) => set({ ...EMPTY_ARCHIVE, boardId, query, load: 'loading' }),
  setLoading: (more) => set(more ? { more: true } : { load: 'loading' }),
  setPage: (list, cursor, append) =>
    set((s) => {
      const tasks: Record<string, Task> = append ? { ...s.tasks } : {};
      const ids = append ? [...s.ids] : [];
      for (const x of list) {
        if (!tasks[x.id]) ids.push(x.id);
        tasks[x.id] = x;
      }
      return { ids, tasks, cursor, load: 'ready', more: false };
    }),
  setError: () => set((s) => (s.more ? { more: false } : { load: 'error' })),
  drop: (taskId) =>
    set((s) => {
      if (!s.tasks[taskId]) return {};
      const { [taskId]: _gone, ...tasks } = s.tasks;
      return { tasks, ids: s.ids.filter((x) => x !== taskId) };
    }),
}));

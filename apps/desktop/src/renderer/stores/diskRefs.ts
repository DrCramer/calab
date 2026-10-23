import { create } from 'zustand';

/**
 * Disk items referenced from outside the Disk (CBF-20): a chip in the chat, a deep link. The item
 * itself goes into `useDisk.items` (one source of names and sizes); this store only says how its
 * lookup went, per id, once per session (services/diskLink `resolveDiskItem`). A chip reads
 * `state[id]` — a primitive, so a resolve re-renders that chip only.
 *
 * - loading: the GET is in flight;
 * - ok: the item was read (a trashed one counts as gone);
 * - gone: 404 / 403 / in the trash — deleted or not mine to see (nothing about it is shown);
 * - error: a network / server failure; the next mount tries again.
 */
export type DiskRefState = 'loading' | 'ok' | 'gone' | 'error';

interface DiskRefsState {
  state: Readonly<Record<string, DiskRefState>>;
  /** A folder's contents as the caller sees them (CBF-66), from the item GET; a listing does not carry them. */
  counts: Readonly<Record<string, FolderCounts>>;
  set: (id: string, v: DiskRefState) => void;
  setCounts: (id: string, c: FolderCounts) => void;
}

export interface FolderCounts {
  files: number;
  folders: number;
}

export const useDiskRefs = create<DiskRefsState>()((set) => ({
  state: {},
  counts: {},
  set: (id, v) => set((s) => (s.state[id] === v ? s : { state: { ...s.state, [id]: v } })),
  setCounts: (id, c) => set((s) => ({ counts: { ...s.counts, [id]: c } })),
}));

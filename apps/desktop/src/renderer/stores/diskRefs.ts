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
  set: (id: string, v: DiskRefState) => void;
}

export const useDiskRefs = create<DiskRefsState>()((set) => ({
  state: {},
  set: (id, v) => set((s) => (s.state[id] === v ? s : { state: { ...s.state, [id]: v } })),
}));

import type { Room } from '@calaba/protocol';
import { create } from 'zustand';
import { api } from '../lib/api/endpoints';
import { log } from '../lib/log';

/**
 * The archive of temporary rooms per workspace (ADR-0044 addendum 14.10): the closed rooms I may
 * manage, newest first. Loaded on demand (the «Архив · N» button, the archive window); a room
 * closing refreshes a loaded list, a room coming back (restore, make permanent: ROOM_CREATE)
 * leaves it. The count on the button is `byWs[ws].length`.
 */
interface TempArchiveState {
  byWs: Record<string, readonly Room[]>;
  /** Loads the list unless it is there already (`force`: always). */
  load: (workspaceId: string, force?: boolean) => Promise<void>;
  /** A live room appeared: it is no longer archived. */
  drop: (roomId: string) => void;
  /** A temporary room closed: a loaded list is refetched. */
  refresh: (workspaceId: string) => void;
}

const inflight = new Map<string, Promise<void>>();

export const useTempArchive = create<TempArchiveState>()((set, get) => ({
  byWs: {},
  load: (workspaceId, force = false) => {
    if (!force && get().byWs[workspaceId]) return Promise.resolve();
    const known = inflight.get(workspaceId);
    if (known) return known;
    const p = api.rooms
      .archived(workspaceId)
      // Only temporary rooms: permanent archived rooms are not readable (404, ADR-0044 «Архив»).
      .then((r) => set((s) => ({ byWs: { ...s.byWs, [workspaceId]: r.rooms.filter((x) => !!x.expiresAt) } })))
      .catch((e: unknown) => log.warn('temp archive load failed', e))
      .finally(() => inflight.delete(workspaceId));
    inflight.set(workspaceId, p);
    return p;
  },
  drop: (roomId) => {
    const { byWs } = get();
    for (const [ws, rooms] of Object.entries(byWs)) {
      if (rooms.some((r) => r.id === roomId)) set({ byWs: { ...byWs, [ws]: rooms.filter((r) => r.id !== roomId) } });
    }
  },
  refresh: (workspaceId) => {
    if (get().byWs[workspaceId]) void get().load(workspaceId, true);
  },
}));

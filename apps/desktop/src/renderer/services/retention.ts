import { useBoards } from '../stores/boards';
import { useBoardsUi } from '../stores/boardsUi';
import { useMessages } from '../stores/messages';
import { useUi } from '../stores/ui';

/**
 * Long sessions (review M10): every room ever opened used to keep its whole loaded history.
 * Background rooms are cut to their newest KEEP messages right away and dropped completely
 * after IDLE_MS unopened (they reload from the API when opened; events for an unloaded room
 * are ignored by the store). The open rooms (the chat's and the open task's comments, CBF-30) and
 * rooms with unsent messages are never touched here; the open chat's own window is capped by the
 * store (WINDOW_CAP, stores/messages) as it pages.
 */
export const KEEP = 200;
export const IDLE_MS = 10 * 60_000;
const SWEEP_MS = 60_000;

/** Pure decision for one room (unit-tested). */
export function retentionAction(opts: { open: boolean; hasPending: boolean; idleMs: number }): 'keep' | 'trim' | 'unload' {
  if (opts.open) return 'keep';
  if (opts.idleMs >= IDLE_MS && !opts.hasPending) return 'unload';
  return 'trim';
}

/**
 * The rooms on screen (pure, unit-tested): the open chat and the open task's room — its comments
 * feed reads the same store and loads only on open, so an unloaded room left it blank (CBF-30).
 */
export function openRoomIds(chatRoomId: string | null | undefined, taskRoomId: string | null | undefined): string[] {
  return [chatRoomId, taskRoomId].filter((id): id is string => !!id);
}

function currentOpenRooms(): string[] {
  const ui = useUi.getState();
  const taskId = useBoardsUi.getState().taskId;
  return openRoomIds(ui.activeWorkspaceId ? ui.lastRoom[ui.activeWorkspaceId] : null, taskId ? useBoards.getState().tasks[taskId]?.roomId : null);
}

let started = false;

export function startMessageRetention(): void {
  if (started) return;
  started = true;
  const lastSeen = new Map<string, number>();
  let current = currentOpenRooms();
  const sweep = (): void => {
    const now = Date.now();
    const open = currentOpenRooms();
    const store = useMessages.getState();
    for (const [roomId, r] of Object.entries(store.rooms)) {
      if (!lastSeen.has(roomId)) lastSeen.set(roomId, now);
      const action = retentionAction({
        open: open.includes(roomId),
        hasPending: r.items.some((c) => c.status !== 'sent'),
        idleMs: now - (lastSeen.get(roomId) ?? now),
      });
      if (action === 'unload') {
        store.unload(roomId);
        lastSeen.delete(roomId);
      } else if (action === 'trim') store.trim(roomId, KEEP);
    }
  };
  const onOpenChange = (): void => {
    const next = currentOpenRooms();
    if (next.join() === current.join()) return;
    const now = Date.now();
    // Left them now: idle from here (and the newly open ones are fresh).
    for (const id of [...current, ...next]) lastSeen.set(id, now);
    current = next;
    sweep();
  };
  useUi.subscribe(onOpenChange);
  useBoardsUi.subscribe(onOpenChange);
  window.setInterval(sweep, SWEEP_MS);
}

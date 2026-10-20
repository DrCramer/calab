import { boardsPath, isManagedPath } from '../lib/boards/address';
import { useBoards } from '../stores/boards';
import { useBoardsUi } from '../stores/boardsUi';
import { useSession } from '../stores/session';
import { useUi } from '../stores/ui';

/**
 * Web only: keeps the address bar at the open board (`/b/<id>`), task (`/t/<KEY-N>`) or `/`.
 * `replaceState`, not `pushState`: a board / task is a place inside one page, so Back leaves the
 * app as before instead of walking through every card the viewer opened (the app has its own
 * ⌘[ / ⌘] history). Only `/`, `/b/…`, `/t/…` are rewritten — a wiki, meeting or invite address
 * stays as it is.
 */
let hold = false;
let started = false;

/** A `/b/…` or `/t/…` address at load is kept until its link has been opened (or refused). */
export function holdBoardsAddress(on: boolean): void {
  hold = on;
  if (!on) syncBoardsAddress();
}

export function syncBoardsAddress(): void {
  if (!started || hold || typeof location === 'undefined' || !useSession.getState().ready) return;
  if (!isManagedPath(location.pathname)) return;
  const ws = useUi.getState().activeWorkspaceId;
  const bu = useBoardsUi.getState();
  const path = boardsPath({
    active: bu.active,
    boardId: ws ? bu.boardOf[ws] : undefined,
    taskKey: bu.taskId ? useBoards.getState().tasks[bu.taskId]?.key : undefined,
  });
  if (path === location.pathname) return;
  try {
    history.replaceState(null, '', path + location.search);
  } catch {
    // not fatal: the address is a convenience
  }
}

export function startBoardsAddress(): void {
  if (started) return;
  started = true;
  useBoardsUi.subscribe(syncBoardsAddress);
  useUi.subscribe(syncBoardsAddress);
  useSession.subscribe(syncBoardsAddress);
  useBoards.subscribe(syncBoardsAddress);
}

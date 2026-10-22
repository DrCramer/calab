import { BoardStatusType, Permission, type Board, type BoardStatus, type Task } from '@calaba/protocol';
import { isDone, matchTask, type FilterState, type MatchCtx } from '../../lib/boards/filter';
import { byPosition } from '../../lib/boards/position';
import type { BoardsData } from '../../lib/boards/reducers';
import type { BoardPrefs } from '../../stores/boardsUi';
import { statusShown } from '../../lib/boards/completion';

/**
 * What the board views show (ADR-0042 §5): permissions of the viewer (Board.permissions, the
 * server's bits — the client only hides UI), the visible columns and the tasks of each after the
 * filter and «Показывать завершённые». Pure: used inside store selectors (useShallow over id lists).
 */
export const VIEW_BOARD = BigInt(Permission.VIEW_BOARD);
export const CREATE_TASKS = BigInt(Permission.CREATE_TASKS);
export const EDIT_TASKS = BigInt(Permission.EDIT_TASKS);
export const MANAGE_BOARD = BigInt(Permission.MANAGE_BOARD);

export const hasBit = (perms: bigint | undefined, bit: bigint): boolean => ((perms ?? 0n) & bit) === bit;

/** CBF-73: statuses, labels and milestones of a board are EDIT_TASKS' («Править любые задачи»). */
export const mayEditBoardItems = (perms: bigint | undefined): boolean => hasBit(perms, EDIT_TASKS);

/** The board-settings sections of statuses, labels and milestones (EDIT_TASKS); the rest is MANAGE_BOARD's. */
const ITEM_SETTINGS_TABS: readonly string[] = ['statuses', 'labels', 'milestones'];

/** Whether the viewer sees a board-settings section (the server decides; this only hides). */
export function settingsTabShown(id: string, perms: bigint | undefined): boolean {
  return ITEM_SETTINGS_TABS.includes(id) ? mayEditBoardItems(perms) : hasBit(perms, MANAGE_BOARD);
}

/** Where «Настройки доски» opens: «Основное» for a manager, «Статусы» for an editor only; null — no entry. */
export function settingsEntryTab(perms: bigint | undefined): 'general' | 'statuses' | null {
  return hasBit(perms, MANAGE_BOARD) ? 'general' : mayEditBoardItems(perms) ? 'statuses' : null;
}

/** Why edit controls are locked (tooltip of a disabled «Добавить»): archived task, or no right to edit it. */
export function editLockKey(archived: boolean): 'boards.err.archivedTask' | 'boards.needEditRight' {
  return archived ? 'boards.err.archivedTask' : 'boards.needEditRight';
}

/** CREATE_TASKS edits tasks one created or is assigned to; EDIT_TASKS any (boards.proto). */
export function mayEditTask(t: Pick<Task, 'createdBy' | 'assignees' | 'archivedAt'>, perms: bigint | undefined, me: string): boolean {
  if (t.archivedAt) return false;
  if (hasBit(perms, EDIT_TASKS)) return true;
  return hasBit(perms, CREATE_TASKS) && (t.createdBy === me || t.assignees.some((a) => a.userId === me));
}

/** EDIT_TASKS, or the author with CREATE_TASKS — the server's rule for both archive and restore. */
export function mayRestoreTask(t: Pick<Task, 'createdBy'>, perms: bigint | undefined, me: string): boolean {
  return hasBit(perms, EDIT_TASKS) || (hasBit(perms, CREATE_TASKS) && t.createdBy === me);
}

export function mayArchiveTask(t: Pick<Task, 'createdBy' | 'archivedAt'>, perms: bigint | undefined, me: string): boolean {
  return !t.archivedAt && mayRestoreTask(t, perms, me);
}

export const sortedStatuses = (b: Pick<Board, 'statuses'> | undefined): BoardStatus[] => [...(b?.statuses ?? [])].sort((x, y) => x.position - y.position);

export const doneType = (type: BoardStatusType | undefined): boolean => type === BoardStatusType.COMPLETED || type === BoardStatusType.CANCELLED;

export function statusMap(b: Pick<Board, 'statuses'> | undefined): Record<string, BoardStatus> {
  const out: Record<string, BoardStatus> = {};
  for (const s of b?.statuses ?? []) out[s.id] = s;
  return out;
}

/** The kanban's columns: shown (in order) and hidden (the «Скрытые» strip: hidden by hand or by the completion filter). */
export function columnsOf(b: Board | undefined, prefs: Pick<BoardPrefs, 'hidden' | 'completion'>): { shown: BoardStatus[]; hidden: BoardStatus[] } {
  const shown: BoardStatus[] = [];
  const hidden: BoardStatus[] = [];
  for (const s of sortedStatuses(b)) {
    if (prefs.hidden.includes(s.id) || !statusShown(prefs.completion, s.type)) hidden.push(s);
    else shown.push(s);
  }
  return { shown, hidden };
}

const EMPTY: readonly string[] = [];

/** A status column after the filter (ids in board order). */
export function visibleColumn(s: BoardsData, boardId: string, statusId: string, filter: FilterState, ctx: MatchCtx): readonly string[] {
  const ids = s.columns[boardId]?.[statusId] ?? EMPTY;
  if (filter.conds.length === 0) return ids;
  return ids.filter((id) => {
    const t = s.tasks[id];
    return !!t && matchTask(t, filter, ctx);
  });
}

/** Every visible task of the board (list view, keyboard navigation), status by status. */
export function visibleTasks(s: BoardsData, b: Board, prefs: Pick<BoardPrefs, 'filter' | 'completion'>, ctx: MatchCtx): Task[] {
  const out: Task[] = [];
  for (const st of sortedStatuses(b)) {
    if (!statusShown(prefs.completion, st.type)) continue;
    for (const id of s.columns[b.id]?.[st.id] ?? EMPTY) {
      const t = s.tasks[id];
      if (t && matchTask(t, prefs.filter, ctx)) out.push(t);
    }
  }
  return out;
}

export { byPosition, isDone };

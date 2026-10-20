import type { Board } from '@calaba/protocol';
import type { MatchCtx } from '../../lib/boards/filter';
import type { BoardsData } from '../../lib/boards/reducers';
import { GROUP_ROW, timelineRows } from '../../lib/boards/timeline';
import type { BoardPrefs, ViewKind } from '../../stores/boardsUi';
import { sortOn } from '../../lib/boards/features';
import { sortColumnIds } from './columnSort';
import { listItems } from './ListView';
import { columnsOf, visibleColumn, visibleTasks } from './model';

/**
 * The full-screen task's «3 / 24» and ↑/↓ (J/K) (docs/08 «Доски задач», owner 14.10, Linear):
 * the tasks in the order of the board view the task was opened from — the same pure functions the
 * views render with (filter, completion, hidden columns, grouping, sort). Computed on demand by the
 * task view (memo on the view's inputs), never inside a store selector.
 */
export function boardOrder(s: BoardsData, b: Board, prefs: BoardPrefs, kind: ViewKind, ctx: MatchCtx, workspaceId: string): string[] {
  if (kind === 'kanban') {
    const sort = sortOn(prefs.sort, b.disabledFeatures) ? prefs.sort : 'manual';
    return columnsOf(b, prefs).shown.flatMap((st) => [...sortColumnIds(visibleColumn(s, b.id, st.id, prefs.filter, ctx), s.tasks, sort)]);
  }
  const tasks = visibleTasks(s, b, prefs, ctx);
  if (kind === 'list') return listItems(tasks, b, prefs, workspaceId).flatMap((x) => (x.kind === 'row' ? [x.id] : []));
  const { rows, undated } = timelineRows(tasks, prefs.tlGroup ?? 'none');
  return [...rows.filter((r) => !r.startsWith(GROUP_ROW)), ...undated];
}

/**
 * A fresh order replaces the kept one unless it lost the open task while the kept one has it (an
 * unread task leaves «Непрочитанное» once opened, a task moved to a hidden status, a subtask
 * opened from its parent): then ↑/↓ keep walking the list the viewer started from.
 */
export function keepOrder(kept: readonly string[], fresh: readonly string[], taskId: string): readonly string[] {
  if (fresh.includes(taskId) || !kept.includes(taskId)) return fresh;
  return kept;
}

/** «3 / 24» (1-based); null when the task is not in the order (a subtask, a deep link to a filtered task). */
export function positionOf(order: readonly string[], taskId: string): { n: number; total: number } | null {
  const i = order.indexOf(taskId);
  return i < 0 ? null : { n: i + 1, total: order.length };
}

/** The neighbour in `dir` (−1 previous, +1 next); null at the ends or off the list. */
export function stepTask(order: readonly string[], taskId: string, dir: -1 | 1): string | null {
  const i = order.indexOf(taskId);
  if (i < 0) return null;
  return order[i + dir] ?? null;
}

/** What Esc does in boards mode, first match wins (owner 14.10: Esc closes the task). */
export type EscStep = 'none' | 'blur' | 'closeTask' | 'clearSelection' | 'unfocus' | 'leave';

export function escStep(o: { inField: boolean; layer: boolean; taskOpen: boolean; fieldInTask: boolean; selected: boolean; focused: boolean }): EscStep {
  // A menu / dialog closes itself; a field's own Esc (title, description) never gets here.
  if (o.layer) return 'none';
  // First Esc leaves the field of the open task, the second closes the task.
  if (o.inField) return o.taskOpen && o.fieldInTask ? 'blur' : 'none';
  if (o.taskOpen) return 'closeTask';
  if (o.selected) return 'clearSelection';
  if (o.focused) return 'unfocus';
  return 'leave';
}

/**
 * The open full-screen task view's handle for the board keys (useBoardHotkeys): ↑/↓, J/K step
 * through the order instead of moving the board's focus. Set by TaskView while mounted.
 */
export interface TaskNav {
  step: (dir: -1 | 1) => void;
  contains: (el: Element | null) => boolean;
}
let current: TaskNav | null = null;
export const taskNav = {
  get: (): TaskNav | null => current,
  set: (nav: TaskNav | null): void => {
    current = nav;
  },
};

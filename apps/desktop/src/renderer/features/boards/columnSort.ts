import type { Task } from '@calaba/protocol';
import type { BoardsData } from '../../lib/boards/reducers';
import type { BoardPrefs } from '../../stores/boardsUi';
import { sortTasks } from './ListView';

const NO_ORDER: Map<string, number> = new Map();

/**
 * A kanban column's ids under the board's view sort (the same option as the list's). `manual`
 * returns the ids as they are (board order, the only order drag-and-drop edits); any other sort
 * orders by the sort key and leaves the stored position alone.
 */
export function sortColumnIds(
  ids: readonly string[],
  tasks: BoardsData['tasks'],
  sort: BoardPrefs['sort'],
): readonly string[] {
  if (sort === 'manual' || ids.length < 2) return ids;
  const list: Task[] = [];
  for (const id of ids) {
    const t = tasks[id];
    if (t) list.push(t);
  }
  return sortTasks(list, sort, NO_ORDER).map((t) => t.id);
}

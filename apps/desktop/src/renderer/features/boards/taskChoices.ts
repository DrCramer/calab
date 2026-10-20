import type { Task } from '@calaba/protocol';
import type { Choice } from './menus';

/** Live tasks of a board as picker choices, newest first, without `exclude` (parent, relations). */
export function taskChoices(tasks: Readonly<Record<string, Task>> | null, boardId: string, exclude: string): Choice[] {
  if (!tasks) return [];
  return Object.values(tasks)
    .filter((x) => x.boardId === boardId && x.id !== exclude && !x.archivedAt)
    .sort((a, b) => b.number - a.number)
    .slice(0, 500)
    .map((x) => ({ id: x.id, search: [x.key, x.title], label: `${x.key} ${x.title}` }));
}

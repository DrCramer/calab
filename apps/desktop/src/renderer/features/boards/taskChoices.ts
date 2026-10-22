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

/**
 * The relation picker (CBF-47): `found` — the workspace search's hits (every board the server lets
 * the caller see, in its order) first, then the board's own live tasks; without `exclude`, archived
 * tasks and repeats. Each choice carries its board's name (`boardName`) to tell the boards apart.
 */
export function linkChoices(tasks: Readonly<Record<string, Task>> | null, boardId: string, exclude: string, found: readonly string[], boardName: (boardId: string) => string): Choice[] {
  if (!tasks) return [];
  const seen = new Set<string>();
  const out: Choice[] = [];
  const add = (x: Task | undefined): void => {
    if (!x || x.id === exclude || x.archivedAt || seen.has(x.id)) return;
    seen.add(x.id);
    const caption = boardName(x.boardId);
    out.push({ id: x.id, search: [x.key, x.title], label: `${x.key} ${x.title}`, ...(caption ? { caption } : {}) });
  };
  for (const id of found) add(tasks[id]);
  for (const c of taskChoices(tasks, boardId, exclude)) add(tasks[c.id]);
  return out;
}

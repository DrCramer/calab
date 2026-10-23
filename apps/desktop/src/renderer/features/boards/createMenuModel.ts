/**
 * The boards section's «+» menu (CBF-58): «Создать задачу» · the boards where I may create tasks ·
 * separator · «Создать категорию» · «Создать доску». Pure bits, so they are testable.
 */

export interface CreateMenuPlan {
  /** «Создать задачу» + the board list: some board accepts my tasks. */
  tasks: boolean;
  /** «Создать категорию» + «Создать доску»: CREATE_BOARDS. */
  manage: boolean;
  /** A separator between the two groups. */
  separator: boolean;
  /** Nothing to offer: no «+» at all. */
  empty: boolean;
}

export function createMenuPlan(creator: boolean, taskBoards: readonly string[]): CreateMenuPlan {
  const tasks = taskBoards.length > 0;
  return { tasks, manage: creator, separator: tasks && creator, empty: !tasks && !creator };
}

/** The board «Создать задачу» goes to: the last used one, else the open one, else the first ('' = none). */
export function pickTaskBoard(taskBoards: readonly string[], last: string | undefined, open: string | undefined): string {
  for (const id of [last, open]) if (id && taskBoards.includes(id)) return id;
  return taskBoards[0] ?? '';
}

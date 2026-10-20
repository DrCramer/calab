import { MY_TASKS } from '../../stores/boardsUi';

/**
 * The web address bar for boards (docs/08 «Доски задач»): `/b/<boardId>` for an open board,
 * `/t/<KEY-N>` for an open task — the same links «Копировать ссылку» gives — and `/` otherwise.
 * Pure: the subscription in services/boardsAddress.ts feeds it the store state.
 */
export function boardsPath(o: { active: boolean; boardId: string | undefined; taskKey: string | undefined }): string {
  if (!o.active) return '/';
  if (o.taskKey) return `/t/${encodeURIComponent(o.taskKey)}`;
  if (o.boardId && o.boardId !== MY_TASKS) return `/b/${encodeURIComponent(o.boardId)}`;
  return '/';
}

/** The paths this feature may rewrite: `/`, `/b/<id>`, `/t/<key>`. Wiki, meetings, invites and the rest are never touched. */
export function isManagedPath(pathname: string): boolean {
  return pathname === '/' || /^\/(b|t)\/[^/]+\/?$/.test(pathname);
}

import { memo, type ReactNode } from 'react';
import { t } from '../../i18n';
import { useBoards } from '../../stores/boards';

/**
 * The bright accent dot of a task with something unseen (kanban card, list row): a leaf with its
 * own primitive selector, so a task being marked read re-renders this dot, not the row. Opening
 * the task clears it (services/boards markTaskRead); the board's sidebar count then turns grey.
 */
export const UnreadDot = memo(function UnreadDot({ id }: { id: string }): ReactNode {
  const unread = useBoards((s) => !!s.tasks[id]?.unread);
  if (!unread) return null;
  return <span role="img" className="size-2 shrink-0 rounded-full bg-accent" aria-label={t('boards.unread')} data-testid="task-unread-dot" />;
});

/**
 * The assignees of a card / list row as plain 20 px circles (no ring, border or badge; 2 px gap) (#92): ≤ 3, the last one «+N»
 * when there are more; the same height whatever the count, so rows and the right edge never move.
 * Order: assigned earlier first. Names are in the button's tip (the caller), `title` per circle.
 */
import type { TaskAssignee } from '@calaba/protocol';
import { memo, useMemo, type ReactNode } from 'react';
import { stackLayout } from '../../lib/boards/assigneeStack';
import { memberName } from '../../stores/workspaces';
import { MemberAvatar } from './menus';

export const AssigneeStack = memo(function AssigneeStack({ workspaceId, assignees }: { workspaceId: string; assignees: readonly TaskAssignee[] }): ReactNode {
  const { shown, more } = useMemo(() => {
    const byId = new Map(assignees.map((a) => [a.userId, a]));
    const l = stackLayout(assignees.map((a) => ({ userId: a.userId, atMs: a.assignedAt ? Number(a.assignedAt.seconds) * 1000 : 0 })));
    return { shown: l.shown.map((s) => byId.get(s.userId) as TaskAssignee), more: l.more };
  }, [assignees]);
  const hidden = more ? assignees.filter((a) => !shown.includes(a)) : [];
  return (
    <span className="flex items-center gap-0.5" data-testid="assignee-stack" aria-hidden>
      {shown.map((a) => (
        <span key={a.userId} className="shrink-0 rounded-full" title={a.note ? `${memberName(workspaceId, a.userId)} — ${a.note}` : memberName(workspaceId, a.userId)}>
          <MemberAvatar workspaceId={workspaceId} userId={a.userId} size={20} />
        </span>
      ))}
      {more ? (
        <span className={`grid size-5 shrink-0 place-items-center rounded-full bg-active text-micro font-medium tabular-nums text-fg`} title={hidden.map((a) => memberName(workspaceId, a.userId)).join(', ')} data-testid="assignee-more">
          +{more}
        </span>
      ) : null}
    </span>
  );
});

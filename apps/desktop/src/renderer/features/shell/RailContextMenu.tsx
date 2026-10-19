import * as ContextMenu from '../../components/radix/context-menu';
import { WorkspaceRole } from '@calaba/protocol';
import { CheckCheck, LogOut, Settings, UserPlus, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { confirmAction } from '../../components/Confirm';
import { Tip, cx } from '../../components/ui';
import { t } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { mayInviteMembers, mayOpenWorkspaceSettings } from '../../lib/permissions';
import { markRead } from '../../services/chat';
import { isUnread, useRooms } from '../../stores/rooms';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { useUi } from '../../stores/ui';
import { useMemberRoles, useWorkspaces } from '../../stores/workspaces';
import { menuBox, menuItem, menuSeparator } from './menu';

/**
 * Right-click on a workspace icon in the rail (docs/09 #21, like Discord): mark everything read,
 * invite, members, settings, leave. Items follow the role (the server re-checks everything).
 * `children` is the rail button itself; `tip` its tooltip (the tooltip wraps the menu trigger).
 */
export function RailContextMenu({ workspaceId, tip, children }: { workspaceId: string; tip: string; children: ReactNode }): ReactNode {
  // ws and role, not the whole entry (it changes on every voice state).
  const ws = useWorkspaces((s) => s.byId[workspaceId]?.ws);
  const role = useWorkspaces((s) => s.byId[workspaceId]?.role);
  const open = useUi((s) => s.openDialog);
  const me = useSession((s) => s.me?.user?.id ?? '');
  const myRoles = useMemberRoles(workspaceId, me);
  if (!ws) return <Tip label={tip} side="right">{children}</Tip>;
  // Settings: any tab beyond «Участники» (ADR-0048); invites: INVITE_MEMBERS (ADR-0043).
  const admin = mayOpenWorkspaceSettings(myRoles);
  const inviter = mayInviteMembers(myRoles); // ADR-0043
  const owner = role === WorkspaceRole.OWNER;

  const markAllRead = (): void => {
    const { byId, readState, lastMessage, unread } = useRooms.getState();
    for (const r of Object.values(byId)) {
      const last = lastMessage[r.id];
      if (r.workspaceId === workspaceId && last && isUnread(r.id, { readState, lastMessage, unread })) markRead(r.id, last);
    }
  };
  const leave = async (): Promise<void> => {
    if (!(await confirmAction(t('ws.leave'), t('ws.leaveConfirm', { name: ws.name }), t('ws.leave')))) return;
    try {
      await api.workspaces.removeMember(workspaceId, '@me');
    } catch (e) {
      toast.fail(e, t('ws.leave'));
    }
  };

  return (
    <ContextMenu.Root modal={false}>
      <Tip label={tip} side="right">
        <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      </Tip>
      <ContextMenu.Portal>
        <ContextMenu.Content className={menuBox} collisionPadding={8}>
          <ContextMenu.Item className={menuItem} onSelect={markAllRead}>
            <CheckCheck className="size-4" aria-hidden /> {t('room.markRead')}
          </ContextMenu.Item>
          <ContextMenu.Separator className={menuSeparator} />
          {inviter ? (
            <ContextMenu.Item className={menuItem} onSelect={() => open({ kind: 'workspace-settings', workspaceId, tab: 'invites' })}>
              <UserPlus className="size-4" aria-hidden /> {t('ws.invite')}
            </ContextMenu.Item>
          ) : null}
          <ContextMenu.Item className={menuItem} onSelect={() => open({ kind: 'workspace-settings', workspaceId, tab: 'members' })}>
            <Users className="size-4" aria-hidden /> {t('ws.members')}
          </ContextMenu.Item>
          {admin ? (
            <ContextMenu.Item className={menuItem} onSelect={() => open({ kind: 'workspace-settings', workspaceId })}>
              <Settings className="size-4" aria-hidden /> {t('ws.settings')}
            </ContextMenu.Item>
          ) : null}
          {!owner ? (
            <>
              <ContextMenu.Separator className={menuSeparator} />
              <ContextMenu.Item className={cx(menuItem, 'text-danger-text')} onSelect={() => void leave()}>
                <LogOut className="size-4" aria-hidden /> {t('ws.leaveItem')}
              </ContextMenu.Item>
            </>
          ) : null}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

import { PERMISSION_BITS, WorkspaceRole } from '@calaba/protocol';
import { useState, type ReactNode } from 'react';
import { Choice } from '../../components/Choice';
import { Card, Row, Toggle } from '../../components/ui';
import { plural, t } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { errorText } from '../../lib/api/errors';
import { toast } from '../../stores/toasts';
import { useWorkspaces } from '../../stores/workspaces';

const { CREATE_TEMP_ROOMS } = PERMISSION_BITS;

/**
 * Workspace settings → «Комнаты», temporary rooms (ADR-0044): «могут создавать все участники» — the
 * CREATE_TEMP_ROOMS bit of the built-in Member role (MANAGE_ROLES; other roles in the role
 * editor), and «Удалять из архива через» — the workspace's retention of closed rooms
 * (MANAGE_WORKSPACE). The archive itself is a button at the end of the room list's «Временные»
 * group (addendum 14.10).
 */
export function TempRoomsCards({ workspaceId, manageRoles }: { workspaceId: string; manageRoles: boolean }): ReactNode {
  return (
    <>
      {manageRoles ? <AllowCard workspaceId={workspaceId} /> : null}
      <RetentionCard workspaceId={workspaceId} />
    </>
  );
}

function AllowCard({ workspaceId }: { workspaceId: string }): ReactNode {
  const role = useWorkspaces((s) => s.byId[workspaceId]?.roles.find((r) => r.builtin === WorkspaceRole.MEMBER));
  const [busy, setBusy] = useState(false);
  if (!role) return null;
  const on = (role.permissions & CREATE_TEMP_ROOMS) !== 0n;
  const set = async (v: boolean): Promise<void> => {
    setBusy(true);
    try {
      const permissions = v ? role.permissions | CREATE_TEMP_ROOMS : role.permissions & ~CREATE_TEMP_ROOMS;
      const r = await api.roles.update(workspaceId, role.id, { permissions });
      if (r.role) useWorkspaces.getState().upsertRole(r.role);
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <Row label={t('temp.allowAll')} hint={t('temp.allowAllHint')}>
        <Toggle label={t('temp.allowAll')} checked={on} disabled={busy} onChange={(v) => void set(v)} />
      </Row>
    </Card>
  );
}

/** «Удалять из архива через» (ADR-0044 addendum 14.10): the workspace's retention of closed temporary rooms (MANAGE_WORKSPACE). */
const RETENTION_DAYS = [1, 7, 30, 90, 365] as const;

function RetentionCard({ workspaceId }: { workspaceId: string }): ReactNode {
  const days = useWorkspaces((s) => s.byId[workspaceId]?.ws.tempArchiveDays || 30);
  const set = async (v: string): Promise<void> => {
    try {
      const r = await api.workspaces.update(workspaceId, { tempArchiveDays: Number(v) });
      if (r.workspace) useWorkspaces.getState().updateWorkspace(r.workspace);
    } catch (e) {
      toast.error(errorText(e));
    }
  };
  return (
    <Card footer={t('temp.retentionHint')}>
      <Row label={t('temp.retention')}>
        <Choice<string>
          label={t('temp.retention')}
          value={String(RETENTION_DAYS.includes(days as (typeof RETENTION_DAYS)[number]) ? days : 30)}
          onChange={(v) => void set(v)}
          options={RETENTION_DAYS.map((d) => ({ value: String(d), label: plural('temp.retentionDays', d) }))}
          phone="picker"
        />
      </Row>
    </Card>
  );
}

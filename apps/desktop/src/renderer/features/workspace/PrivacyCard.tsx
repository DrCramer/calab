import { WorkspaceAuditKind, type WorkspaceAuditEntry } from '@calaba/protocol';
import { useQuery } from '@tanstack/react-query';
import { memo, type ReactNode } from 'react';
import { Card, Empty, Row, Spinner, Toggle } from '../../components/ui';
import { t } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { errorText } from '../../lib/api/errors';
import { fmt, toDate } from '../../lib/format';
import { mayViewJournals } from '../../lib/permissions';
import { useBoards } from '../../stores/boards';
import { useDisk } from '../../stores/disk';
import { useRooms } from '../../stores/rooms';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { useWiki } from '../../stores/wiki';
import { memberName, useMemberRoles, useWorkspaces } from '../../stores/workspaces';

/*
 * «Приватное» in the workspace's general settings (addenda 2026-10-14 to ADR-0058 / ADR-0078 /
 * ADR-0094 / ADR-0096): the owner's switch «Владелец видит приватное» (the owner only — the server
 * refuses anyone else) and «Журнал доступа» (the owner or VIEW_JOURNALS): the switch flips and the
 * take-overs. Items are named only when this client knows them (they are visible to the viewer),
 * otherwise «скрытый объект» — the journal carries ids only.
 */
export function PrivacyCard({ workspaceId }: { workspaceId: string }): ReactNode {
  const me = useSession((s) => s.me?.user?.id ?? '');
  const isOwner = useWorkspaces((s) => !!me && s.byId[workspaceId]?.ws.ownerId === me);
  const on = useWorkspaces((s) => s.byId[workspaceId]?.ws.ownerSeesPrivate ?? false);
  const journals = mayViewJournals(useMemberRoles(workspaceId, me));
  const seesLog = isOwner || journals;
  const audit = useQuery({
    queryKey: ['ws-audit', workspaceId, on],
    queryFn: ({ signal }) => api.workspaces.audit(workspaceId, '', signal),
    enabled: seesLog,
    retry: false,
    refetchOnWindowFocus: false,
  });
  if (!isOwner && !seesLog) return null;
  const set = (v: boolean): void => {
    void api.workspaces
      .update(workspaceId, { ownerSeesPrivate: v })
      .then((r) => r.workspace && useWorkspaces.getState().updateWorkspace(r.workspace))
      .catch((e: unknown) => toast.error(errorText(e)));
  };
  return (
    <Card title={t('privacy.card')}>
      {isOwner ? (
        <Row label={t('privacy.ownerSees')} hint={t('privacy.ownerSeesHint')}>
          <Toggle label={t('privacy.ownerSees')} checked={on} onChange={set} />
        </Row>
      ) : null}
      {seesLog ? (
        <div className="flex flex-col px-3 py-2" data-testid="privacy-audit">
          <span className="pb-1 text-caption font-medium text-muted">{t('privacy.audit')}</span>
          {audit.isPending ? (
            <div className="grid h-10 place-items-center">
              <Spinner />
            </div>
          ) : audit.error ? (
            <p className="text-caption text-danger-text">{errorText(audit.error)}</p>
          ) : audit.data.entries.length === 0 ? (
            <Empty>{t('privacy.auditEmpty')}</Empty>
          ) : (
            audit.data.entries.slice(0, 20).map((e) => <AuditRow key={e.id} workspaceId={workspaceId} entry={e} />)
          )}
        </div>
      ) : null}
    </Card>
  );
}

/** One journal line: who did what, when; the subject's name only if this client knows it. */
const AuditRow = memo(function AuditRow({ workspaceId, entry }: { workspaceId: string; entry: WorkspaceAuditEntry }): ReactNode {
  const subjectName = useSubjectName(entry.subjectType, entry.subjectId);
  const who = entry.actorId ? memberName(workspaceId, entry.actorId) : t('privacy.someone');
  let text: string;
  switch (entry.kind) {
    case WorkspaceAuditKind.OWNER_SEES_PRIVATE_ON:
      text = t('privacy.audit.on', { name: who });
      break;
    case WorkspaceAuditKind.OWNER_SEES_PRIVATE_OFF:
      text = t('privacy.audit.off', { name: who });
      break;
    default:
      text = t('privacy.audit.takeOver', {
        name: who,
        subject: subjectLabel(entry.subjectType, subjectName),
        prev: entry.previousOwnerId ? memberName(workspaceId, entry.previousOwnerId) : t('privacy.someone'),
      });
  }
  return (
    <div className="flex min-h-8 items-baseline gap-3 py-1" data-testid="privacy-audit-row">
      <span className="min-w-0 flex-1 text-body">{text}</span>
      <span className="shrink-0 text-caption tabular-nums text-faint">{fmt.stamp(toDate(entry.createdAt))}</span>
    </div>
  );
});

/** The name of a journal subject if this client has the item (a primitive selector per store). */
function useSubjectName(type: string, id: string): string {
  const room = useRooms((s) => (type === 'room' ? (s.byId[id]?.name ?? '') : ''));
  const board = useBoards((s) => (type === 'board' ? (s.boards[id]?.name ?? '') : ''));
  const disk = useDisk((s) => (type === 'disk_item' ? (s.items[id]?.name ?? '') : ''));
  const wiki = useWiki((s) => (type === 'wiki_page' ? (s.pages[id]?.title ?? '') : ''));
  return room || board || disk || wiki;
}

function subjectLabel(type: string, name: string): string {
  if (!name) return t('privacy.subject.hidden');
  switch (type) {
    case 'room':
      return t('privacy.subject.room', { name });
    case 'board':
      return t('privacy.subject.board', { name });
    case 'disk_item':
      return t('privacy.subject.disk', { name });
    case 'wiki_page':
      return t('privacy.subject.wiki', { name });
    default:
      return t('privacy.subject.hidden');
  }
}

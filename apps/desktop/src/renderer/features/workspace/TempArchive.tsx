import { timestampDate } from '@bufbuild/protobuf/wkt';
import type { Room } from '@calaba/protocol';
import { Archive, Timer } from 'lucide-react';
import { memo, useEffect, type ReactNode } from 'react';
import { PhoneHeader } from '../../components/PhoneHeader';
import { Button, Empty, Modal, Spinner } from '../../components/ui';
import { plural, t } from '../../i18n';
import { fmt } from '../../lib/format';
import { mayArrangeRooms, mayManageRoom } from '../../lib/permissions';
import { makeTempRoomPermanent, restoreTempRoom } from '../../services/tempRooms';
import { useArchiveView } from '../../stores/archiveView';
import { myUserId } from '../../stores/session';
import { useTempArchive } from '../../stores/tempArchive';
import { useUi } from '../../stores/ui';
import { memberName, useMemberRoles, useWorkspaces } from '../../stores/workspaces';

/**
 * The archive of temporary rooms (ADR-0044 addendum 14.10), opened by «Архив · N» at the end of the
 * «Временные» group: a dialog on the desktop, a pushed screen on the phone (a `temp-archive`
 * dialog kind that services/phoneNav turns into a screen). Rows: «Открыть историю», «Вернуть»
 * (the creator / MANAGE_ROOM of the room) and «Сделать постоянной» (workspace MANAGE_ROOM — the
 * server checks both); «удалится …» is archived_at + the workspace's retention.
 */

const DAY_MS = 86_400_000;

/** How many rooms are in the workspace's archive (loads it once; `enabled` false = guests: no archive, no request). */
export function useArchiveCount(workspaceId: string, enabled: boolean): number {
  useEffect(() => {
    if (enabled) void useTempArchive.getState().load(workspaceId);
  }, [workspaceId, enabled]);
  return useTempArchive((s) => s.byWs[workspaceId]?.length ?? 0);
}

/** «Архив · N» — a small quiet button at the end of the «Временные» group. */
export const TempArchiveButton = memo(function TempArchiveButton({ workspaceId, n }: { workspaceId: string; n: number }): ReactNode {
  return (
    <button
      type="button"
      onClick={() => useUi.getState().openDialog({ kind: 'temp-archive', workspaceId })}
      className="mb-1 ml-2 flex h-7 items-center gap-1.5 rounded-[var(--radius-row)] px-2 text-caption font-medium text-muted transition-colors duration-[var(--motion-fast)] hover:bg-row-hover hover:text-fg mobile:ml-3 mobile:h-9"
      data-testid="temp-archive-button"
    >
      <Archive className="size-3.5" aria-hidden />
      {t('temp.archiveButton', { n })}
    </button>
  );
});

function useArchiveRooms(workspaceId: string): readonly Room[] | undefined {
  useEffect(() => {
    void useTempArchive.getState().load(workspaceId, true);
  }, [workspaceId]);
  return useTempArchive((s) => s.byWs[workspaceId]);
}

function ArchiveList({ workspaceId }: { workspaceId: string }): ReactNode {
  const rooms = useArchiveRooms(workspaceId);
  if (!rooms) {
    return (
      <div className="grid place-items-center py-6">
        <Spinner />
      </div>
    );
  }
  if (rooms.length === 0) return <Empty>{t('temp.archiveEmpty')}</Empty>;
  return (
    <div className="flex flex-col divide-y divide-[var(--color-card-line)]" data-testid="temp-archive">
      {rooms.map((r) => (
        <ArchiveRow key={r.id} workspaceId={workspaceId} room={r} />
      ))}
    </div>
  );
}

const ArchiveRow = memo(function ArchiveRow({ workspaceId, room }: { workspaceId: string; room: Room }): ReactNode {
  const me = myUserId();
  const roles = useMemberRoles(workspaceId, me);
  const days = useWorkspaces((s) => s.byId[workspaceId]?.ws.tempArchiveDays || 30);
  const creator = useWorkspaces(() => (room.createdBy ? memberName(workspaceId, room.createdBy) : '—'));
  const closed = room.archivedAt ?? room.expiresAt;
  const closedAt = closed ? timestampDate(closed) : null;
  const when = closedAt ? fmt.stamp(closedAt) : '—';
  const deleteOn = closedAt ? fmt.dayMonth(new Date(closedAt.getTime() + days * DAY_MS)) : '—';
  const canRestore = mayManageRoom(roles, me, room);
  const canPermanent = mayArrangeRooms(roles);
  return (
    <div className="flex flex-col gap-2 px-3 py-2.5" data-testid="temp-archive-row">
      <div className="flex min-w-0 items-center gap-3">
        <Timer className="size-5 shrink-0 text-muted" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="truncate text-body font-medium" title={room.name}>
            {room.name}
          </div>
          <div className="truncate text-caption text-faint">
            {t('temp.archiveMeta', { creator, when })} · {plural('temp.archiveMessages', room.messageCount)}
          </div>
          <div className="truncate text-caption text-faint" data-testid="temp-archive-deletes">
            {t('temp.archiveDeletes', { date: deleteOn })}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button size="sm" variant="secondary" onClick={() => useArchiveView.getState().open(room)}>
          {t('temp.openHistory')}
        </Button>
        {canRestore ? (
          <Button size="sm" variant="secondary" onClick={() => void restoreTempRoom(room)} data-testid="temp-archive-restore">
            {t('temp.restore')}
          </Button>
        ) : null}
        {canPermanent ? (
          <Button size="sm" variant="secondary" onClick={() => void makeTempRoomPermanent(room)} data-testid="temp-archive-permanent">
            {t('temp.permanent')}
          </Button>
        ) : null}
      </div>
    </div>
  );
});

/** Desktop: the archive in a dialog. */
export function TempArchiveDialog({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }): ReactNode {
  return (
    <Modal open onClose={onClose} title={t('temp.archive')} description={t('temp.archiveHint')} wide>
      <ArchiveList workspaceId={workspaceId} />
    </Modal>
  );
}

/** Phone: the archive as a pushed screen. */
export function TempArchivePage({ workspaceId }: { workspaceId: string }): ReactNode {
  return (
    <section className="mat-content flex min-h-0 flex-1 flex-col" data-testid="temp-archive-page">
      <PhoneHeader title={t('temp.archive')} subtitle={t('temp.archiveHint')} />
      <div className="scrollbar-none min-h-0 flex-1 overflow-y-auto pb-4">
        <ArchiveList workspaceId={workspaceId} />
      </div>
    </section>
  );
}

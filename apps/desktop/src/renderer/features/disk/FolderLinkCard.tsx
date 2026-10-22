import { Folder } from 'lucide-react';
import { memo, type MouseEvent, type ReactNode } from 'react';
import { cx } from '../../components/ui';
import { plural, t, useLocale } from '../../i18n';
import { folderCountParts } from '../../lib/disk';
import { openDiskLink } from '../../services/diskLink';
import { diskItemUrl } from '../../services/links';
import { useDisk } from '../../stores/disk';
import { useDiskRefs } from '../../stores/diskRefs';
import { useMemberName } from '../../stores/workspaces';

/** «Поделился: Имя» — a leaf of its own so a late profile re-renders this line only. */
function SharedBy({ workspaceId, userId }: { workspaceId: string; userId: string }): ReactNode {
  const name = useMemberName(workspaceId, userId);
  return <span className="truncate text-caption text-fg">{t('disk.folder.from', { name })}</span>;
}

/**
 * A Disk folder link in a message or a task comment (CBF-66): its own card — folder icon, name,
 * who shared it, how many files and sub-folders are inside (those the viewer sees — the server
 * counts by their rights), «Открыть». Not the file chip: it is taller and says what is inside.
 * Drawn by DiskLinkChip once the item is known to be a folder. A click opens the Disk on the folder.
 */
export const FolderLinkCard = memo(function FolderLinkCard({ itemId, workspaceId, sharedBy }: { itemId: string; workspaceId?: string; sharedBy?: string }): ReactNode {
  useLocale();
  const name = useDisk((s) => s.items[itemId]?.name ?? '');
  const files = useDiskRefs((s) => s.counts[itemId]?.files);
  const folders = useDiskRefs((s) => s.counts[itemId]?.folders);
  const parts = files === undefined || folders === undefined ? null : folderCountParts(files, folders);
  const summary = parts === null ? t('disk.chip.folder') : parts.length ? parts.map((p) => plural(p.kind === 'files' ? 'disk.folder.files' : 'disk.folder.folders', p.n)).join(' · ') : t('disk.folder.empty');
  const open = (e: MouseEvent): void => {
    e.preventDefault();
    openDiskLink(itemId);
  };
  return (
    <a
      href={diskItemUrl(itemId) ?? undefined}
      onClick={open}
      className={cx(
        'group/disk mt-1.5 flex w-full min-w-0 max-w-[400px] items-center gap-3 rounded-[var(--radius-card)] border border-[color-mix(in_srgb,var(--bubble-accent)_35%,transparent)] bg-[color-mix(in_srgb,var(--bubble-accent)_10%,transparent)] p-2.5 text-left',
        'hover:bg-[color-mix(in_srgb,var(--bubble-accent)_16%,transparent)]',
      )}
      data-testid="disk-folder-card"
    >
      <span className="grid size-11 shrink-0 place-items-center rounded-[var(--radius-row)] bg-[color-mix(in_srgb,var(--color-bg)_45%,transparent)]" aria-hidden>
        <Folder className="size-6 fill-[color-mix(in_srgb,var(--color-accent)_35%,transparent)] text-accent" strokeWidth={1.5} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-body font-semibold leading-5 text-fg" data-testid="disk-folder-card-name">
          {name}
        </span>
        <span className="truncate text-caption text-fg" data-testid="disk-folder-card-summary">
          {summary}
        </span>
        {sharedBy && workspaceId ? <SharedBy workspaceId={workspaceId} userId={sharedBy} /> : null}
      </span>
      <span className="shrink-0 rounded-[var(--radius-row)] border border-[color-mix(in_srgb,var(--bubble-accent)_55%,transparent)] px-2.5 py-1 text-caption font-semibold text-fg group-hover/disk:border-[color:var(--bubble-accent)]">
        {t('disk.open')}
      </span>
    </a>
  );
});

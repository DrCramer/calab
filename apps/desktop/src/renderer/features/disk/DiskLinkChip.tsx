import { FileX } from 'lucide-react';
import { memo, useEffect, type MouseEvent, type ReactNode } from 'react';
import { cx } from '../../components/ui';
import { t, useLocale } from '../../i18n';
import { fmt } from '../../lib/format';
import type { MdNode } from '../../lib/markdown/parse';
import { ensureDiskItem, openDiskLink } from '../../services/diskLink';
import { diskItemUrl, ownDiskItemId } from '../../services/links';
import { useDisk } from '../../stores/disk';
import { useDiskRefs } from '../../stores/diskRefs';
import { ItemGlyph } from './visuals';

/** The first link of a message to a Disk item of this server (its chip goes under the text), or null. */
export function firstDiskItem(nodes: readonly MdNode[]): string | null {
  for (const n of nodes) {
    if (n.t === 'link') {
      const id = ownDiskItemId(n.href);
      if (id) return id;
    } else if (n.t === 'b' || n.t === 'i' || n.t === 's') {
      const inner = firstDiskItem(n.c);
      if (inner) return inner;
    }
  }
  return null;
}

const BOX =
  'mt-1.5 flex w-full min-w-0 max-w-[400px] items-center gap-2 rounded-[var(--radius-row)] border-l-[3px] border-l-[color:var(--bubble-accent)] bg-[color-mix(in_srgb,var(--bubble-accent)_10%,transparent)] py-1.5 pl-2 pr-2 text-left';

/**
 * A Disk file link in a message (CBF-20): a compact chip under the text — type icon, name, size,
 * «Открыть». Resolved on this computer by the item GET (once per id), so each viewer sees it by
 * their own Disk rights: no access → «Файл больше недоступен» and no name. A leaf with its own
 * selectors: resolving re-renders this chip only, never the feed. A click opens the Disk on the file.
 */
export const DiskLinkChip = memo(function DiskLinkChip({ itemId }: { itemId: string }): ReactNode {
  useLocale();
  const known = useDisk((s) => !!s.items[itemId]);
  const name = useDisk((s) => s.items[itemId]?.name ?? '');
  const size = useDisk((s) => s.items[itemId]?.file?.size);
  const st = useDiskRefs((s) => s.state[itemId]);
  useEffect(() => ensureDiskItem(itemId), [itemId]);
  const item = useDisk.getState().items[itemId];
  const view = known && st !== 'gone' ? 'item' : st === undefined || st === 'loading' ? 'loading' : 'unavailable';

  if (view === 'unavailable') {
    return (
      <div className={cx(BOX, 'text-[color:var(--bubble-meta)]')} data-testid="disk-link-chip" data-state="unavailable">
        <FileX className="size-5 shrink-0" strokeWidth={1.75} aria-hidden />
        <span className="min-w-0 truncate text-body">{t('disk.err.gone')}</span>
      </div>
    );
  }
  const open = (e: MouseEvent): void => {
    e.preventDefault();
    openDiskLink(itemId);
  };
  return (
    <a href={diskItemUrl(itemId) ?? undefined} onClick={open} className={cx(BOX, 'group/disk hover:bg-[color-mix(in_srgb,var(--bubble-accent)_16%,transparent)]')} data-testid="disk-link-chip" data-state={view}>
      <span className="grid size-6 shrink-0 place-items-center" aria-hidden>
        {item ? <ItemGlyph item={item} className="size-5" /> : null}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-body font-semibold leading-5 text-fg">{view === 'loading' ? t('disk.chip.label') : name}</span>
        <span className="truncate text-caption text-[color:var(--bubble-meta)]">{view === 'loading' || size === undefined ? t('disk.chip.label') : fmt.size(size)}</span>
      </span>
      <span className="shrink-0 rounded-[var(--radius-row)] px-2 py-1 text-caption font-medium text-[color:var(--bubble-accent)] group-hover/disk:bg-[color-mix(in_srgb,var(--bubble-accent)_14%,transparent)]">
        {t('disk.open')}
      </span>
    </a>
  );
});

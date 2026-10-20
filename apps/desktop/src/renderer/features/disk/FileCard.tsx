import { timestampDate } from '@bufbuild/protobuf/wkt';
import { Copy, Download, Send } from 'lucide-react';
import { memo, type ReactNode } from 'react';
import { Button, Modal } from '../../components/ui';
import { t, useLocale } from '../../i18n';
import { canShare } from '../../lib/disk';
import { fmt } from '../../lib/format';
import { copyItemLink, downloadItem, openSendToChat } from '../../services/disk';
import { diskItemUrl } from '../../services/links';
import { useDisk } from '../../stores/disk';
import { myUserId } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { useMemberName } from '../../stores/workspaces';
import { LinkPanel } from './LinkPanel';
import { ItemPicture } from './visuals';

/**
 * The file card (CBF-20): thumbnail or type glyph, name, size / owner / modified, «Скачать»,
 * «Отправить в чат», «Копировать ссылку» (the item's address in the app — a chat link opens the
 * Disk on it) and, for the owner or DISK_MANAGE, the public link switch. Content only — no
 * dialog shell — so the same panel sits in the dialog below and in a Finder-like preview column.
 * `onNavigate` runs after an action that leaves the card (the picker opens over it).
 */
export const FileCardPanel = memo(function FileCardPanel({ itemId, onNavigate }: { itemId: string; onNavigate?: () => void }): ReactNode {
  useLocale();
  const item = useDisk((s) => s.items[itemId]);
  const ws = item?.workspaceId ?? null;
  const owner = useMemberName(ws, item?.ownerId ?? '');
  if (!item?.file) return null;
  const share = canShare(item, myUserId());
  const changed = item.updatedAt ? fmt.stamp(timestampDate(item.updatedAt)) : '—';
  const copyAddress = (): void => {
    const url = diskItemUrl(item.id);
    if (!url) {
      toast.error(t('disk.err.link'));
      return;
    }
    void navigator.clipboard.writeText(url).then(
      () => toast.success(t('disk.card.linkCopied')),
      (e: unknown) => toast.fail(e),
    );
  };
  return (
    <div className="flex flex-col gap-4" data-testid="disk-file-card">
      <div className="flex items-center gap-4">
        <div className="size-24 shrink-0 overflow-hidden rounded-[var(--radius-card)] border border-line bg-elev" data-testid="disk-file-card-picture">
          <ItemPicture item={item} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="break-words text-body font-semibold leading-5 text-fg [overflow-wrap:anywhere]" data-testid="disk-file-card-name">
            {item.name}
          </p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-caption">
            <dt className="text-muted">{t('disk.col.size')}</dt>
            <dd className="min-w-0 truncate text-fg">{fmt.size(item.file.size)}</dd>
            <dt className="text-muted">{t('disk.col.owner')}</dt>
            <dd className="min-w-0 truncate text-fg">{item.ownerId ? owner : '—'}</dd>
            <dt className="text-muted">{t('disk.col.changed')}</dt>
            <dd className="min-w-0 truncate text-fg">{changed}</dd>
          </dl>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={() => downloadItem(item)} data-testid="disk-card-download">
          <Download className="size-4" aria-hidden />
          {t('disk.download')}
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            onNavigate?.();
            openSendToChat(item.id);
          }}
          data-testid="disk-card-send"
        >
          <Send className="size-4" aria-hidden />
          {t('disk.sendToChat')}
        </Button>
        <Button variant="secondary" onClick={copyAddress} data-testid="disk-card-copy">
          <Copy className="size-4" aria-hidden />
          {t('disk.card.copyLink')}
        </Button>
      </div>
      {share ? (
        <section className="flex flex-col gap-2 overflow-x-clip border-t border-line pt-3" aria-label={t('disk.card.public')}>
          <h3 className="text-caption font-semibold uppercase tracking-wide text-muted">{t('disk.card.public')}</h3>
          <LinkPanel itemId={item.id} />
        </section>
      ) : item.link ? (
        <Button variant="secondary" className="self-start" onClick={() => void copyItemLink(item.id)} data-testid="disk-card-copy-public">
          <Copy className="size-4" aria-hidden />
          {t('disk.card.copyPublic')}
        </Button>
      ) : null}
    </div>
  );
});

/** The card in a dialog (a sheet on the phone, like every dialog): a generic title (the name is in the panel). */
export function DiskFileDialog({ itemId, onClose }: { itemId: string; onClose: () => void }): ReactNode {
  const known = useDisk((s) => !!s.items[itemId]);
  if (!known) return null;
  return (
    <Modal open onClose={onClose} medium initialFocus="body" title={t('disk.card.title')}>
      <FileCardPanel itemId={itemId} onNavigate={onClose} />
    </Modal>
  );
}

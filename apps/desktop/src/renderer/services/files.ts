import type { FileMeta } from '@calaba/protocol';
import { t } from '../i18n';
import { filePreview } from '../lib/filePreview';
import { platform } from '../platform';
import { toast } from '../stores/toasts';
import { useUi } from '../stores/ui';

/**
 * Saves an API file the one way every attachment is saved (desktop: main's download manager into
 * ~/Downloads, quarantined; web: an authenticated fetch + <a download>). Never a plain link to
 * `/api/files/{id}`: the packaged renderer is a file:// page (the link resolves to file:///api/…,
 * which the window-open guard drops) and the API wants a bearer header a link cannot send.
 */
export function downloadFile(f: Pick<FileMeta, 'id' | 'name'>): void {
  void platform.files.download({ fileId: f.id, name: f.name }).then(
    () => toast.success(t('chat.downloaded', { name: f.name })),
    (e: unknown) => toast.fail(e, t('err.ctx.download')),
  );
}

/**
 * A click on an attachment of a list (a task's description, ADR-0103): a picture opens the
 * Lightbox with the list's other pictures (←/→), a PDF the PDF viewer, anything else is downloaded.
 */
export function openAttachment(f: FileMeta, list: readonly FileMeta[]): void {
  const ui = useUi.getState();
  const kind = filePreview(f, ui.phone.on);
  if (kind === 'image') {
    const images = list.filter((g) => filePreview(g, ui.phone.on) === 'image');
    ui.openDialog({
      kind: 'image',
      images: images.map((g) => ({ fileId: g.id, name: g.name, mime: g.mime, width: g.width, height: g.height })),
      index: Math.max(0, images.findIndex((g) => g.id === f.id)),
    });
  } else if (kind === 'pdf') {
    ui.openDialog({ kind: 'pdf', file: { id: f.id, name: f.name, size: f.size } });
  } else {
    downloadFile(f);
  }
}

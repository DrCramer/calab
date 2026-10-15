import type { FileMeta } from '@calaba/protocol';
import { Paperclip, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { t } from '../../i18n';
import { fmt } from '../../lib/format';
import { openAttachment } from '../../services/files';

/**
 * One attachment of a task's description: the name opens it (ADR-0103: a picture → the Lightbox,
 * a PDF → the PDF viewer, the rest is downloaded) — a button, never a link to `/api/files/{id}`
 * (services/files.ts downloadFile: such a link did nothing in the desktop app). `onRemove`: «×».
 */
export function AttachmentChip({ file, list, onRemove }: { file: FileMeta; list: readonly FileMeta[]; onRemove?: (f: FileMeta) => void }): ReactNode {
  return (
    <span className="inline-flex h-7 max-w-[240px] items-center gap-1.5 rounded-full border border-line pl-2 pr-1 text-caption" data-testid="task-attachment">
      <Paperclip className="size-3.5 shrink-0 text-muted" aria-hidden />
      <button type="button" onClick={() => openAttachment(file, list)} title={`${file.name} · ${fmt.size(file.size)}`} className="min-w-0 truncate rounded-[var(--radius-row)] text-left hover:underline" data-testid="task-attachment-open">
        {file.name}
      </button>
      {onRemove ? (
        <button type="button" aria-label={t('boards.removeAttachment', { name: file.name })} onClick={() => onRemove(file)} className="grid size-5 shrink-0 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg">
          <X className="size-3" aria-hidden />
        </button>
      ) : null}
    </span>
  );
}

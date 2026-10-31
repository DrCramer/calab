/**
 * A task description being written (docs/08 «Доски»; owner 23.10: «как в Wiki редакторе»): the
 * wiki's editor in its standalone mode (no Yjs) — `/` blocks, the selection bar, markdown
 * shortcuts and paste, `@` people of the workspace, pictures by paste / drop / «/Картинка». The
 * editor's chunk loads when editing starts (`fallback` meanwhile); only one exists while editing.
 * The text stays markdown-lite: descriptionDoc.ts converts in and out, the menus offer only blocks
 * the task view shows.
 */
import { memo, Suspense, useMemo, useState, type ReactNode } from 'react';
import { t } from '../../i18n';
import { thumbnailPath } from '../../lib/api/endpoints';
import { useMobile } from '../../lib/mobile';
import { THUMB_LARGE, thumbWidthPath } from '../../lib/thumbs';
import { myUserId } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { memberName } from '../../stores/workspaces';
import { WikiEditor, type BlockId, type UploadedImage, type WikiEditorApi } from '../wiki/editor';
import { workspaceMentions } from '../wiki/workspaceMentions';
import { descriptionToDoc } from './descriptionDoc';

/** Blocks a description offers: what the markdown-lite view shows as it was written (no headings, quotes, tables, callouts, toggles, page links). */
export const TASK_BLOCKS: readonly BlockId[] = ['text', 'bullet', 'ordered', 'task', 'code', 'image'];

/** Pictures through the thumbnail the read view shows (CBF-59), not the original. */
const imagePath = (id: string): string => thumbWidthPath(thumbnailPath(id), THUMB_LARGE);
const onError = (m: string): void => toast.error(m);

export interface RichDescriptionProps {
  workspaceId: string;
  /** The description when editing starts (read once). */
  initial: string;
  /** Uploads a picture as an attachment of the task (absent: no pictures). */
  onUploadImage?: ((file: File) => Promise<UploadedImage>) | undefined;
  onReady: (api: WikiEditorApi | null) => void;
  /** ⌘↩ / Esc of the page (true = handled). */
  onKey?: ((event: KeyboardEvent) => boolean) | undefined;
  /** Shown while the editor's chunk loads. */
  fallback: ReactNode;
  className?: string | undefined;
}

export const RichDescription = memo(function RichDescription({ workspaceId, initial, onUploadImage, onReady, onKey, fallback, className }: RichDescriptionProps): ReactNode {
  const phone = useMobile();
  const me = myUserId();
  const [content] = useState(() => descriptionToDoc(initial, (id) => memberName(workspaceId, id)));
  const user = useMemo(() => ({ id: me, name: '' }), [me]);
  const mentions = useMemo(() => workspaceMentions(workspaceId, me), [workspaceId, me]);
  return (
    <Suspense fallback={fallback}>
      <WikiEditor
        doc={null}
        content={content}
        editable
        me={user}
        onUploadImage={onUploadImage}
        mentionSource={mentions}
        imagePath={imagePath}
        onError={onError}
        onReady={onReady}
        onKey={onKey}
        phone={phone}
        blocks={TASK_BLOCKS}
        highlight={false}
        placeholder={t('boards.descriptionEditorPlaceholder')}
        label={t('boards.description')}
        compact
        className={className}
      />
    </Suspense>
  );
});

/**
 * The comments panel of a canvas (ADR-0127 wave 4): threads on the right (a sheet on the phone), «Только
 * открытые», a new thread's composer at the bottom after a click of the «Комментарий» tool, replies,
 * «Решить», editing and deleting. Comments look and write like the chat (owner 23.10): chat rows
 * (chat/CommentRow) grouped like the feed, the chat's composer (chat/CommentComposer) — the reply
 * field at the bottom of the active thread, editing in that same field. What the buttons offer follows
 * the rights (lib/canvas/comments commentRights); the server decides. Each thread and comment is a memo
 * row subscribed to its own ids.
 */
import { timestampMs } from '@bufbuild/protobuf/wkt';
import { Check, MapPin, MessageCirclePlus, RotateCcw, X } from 'lucide-react';
import { memo, useCallback, useMemo, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { confirmAction } from '../../../../components/Confirm';
import { ALT, Button, IconButton, Toggle, cx } from '../../../../components/ui';
import { t, useLocale } from '../../../../i18n';
import { mayChange, pinWorld, type CommentRights } from '../../../../lib/canvas/comments';
import { createThread, deleteComment, editComment, loadComments, replyTo, resolveThread } from '../../../../services/canvasComments';
import { useCanvasComments } from '../../../../stores/canvasComments';
import { fmt } from '../../../../lib/format';
import { myUserId } from '../../../../stores/session';
import { ContextBar } from '../../../chat/ComposerField';
import { CommentRow, commentShape, useCommentGroups } from '../../../chat/CommentRow';
import type { RowMeta } from '../../../chat/grouping';
import type { CanvasEngine } from '../../engine';
import { PANEL } from '../chrome';
import { CommentInput } from './CommentInput';

const EMPTY: readonly string[] = [];

interface Ctx {
  canvasId: string;
  workspaceId: string;
  rights: CommentRights;
  engine: CanvasEngine;
}

/** One comment of a thread: subscribed to its own id, drawn as a chat row. */
const Item = memo(function Item({ id, meta, ctx, editing, onEdit, onDelete }: { id: string; meta: RowMeta; ctx: Ctx; editing: boolean; onEdit: (id: string) => void; onDelete: (id: string) => void }): ReactNode {
  const c = useCanvasComments((s) => s.byId[id]);
  if (!c) return null;
  const me = myUserId();
  const changeable = mayChange(c, ctx.rights, me);
  return (
    <CommentRow
      id={id}
      authorId={c.authorId}
      body={c.body}
      atMs={c.createdAt ? timestampMs(c.createdAt) : 0}
      edited={!!c.editedAt}
      meta={meta}
      own={!!me && c.authorId === me}
      workspaceId={ctx.workspaceId}
      canEdit={changeable}
      canDelete={changeable}
      onEdit={onEdit}
      onDelete={onDelete}
      editing={editing}
      testId="canvas-comment"
    />
  );
});

const Thread = memo(function Thread({ id, ctx }: { id: string; ctx: Ctx }): ReactNode {
  const resolved = useCanvasComments((s) => !!s.byId[id]?.resolved);
  const active = useCanvasComments((s) => s.active === id);
  // The grouping's input as one primitive: an edit or a resolve does not re-group the thread.
  const shape = useCanvasComments((s) =>
    [id, ...(s.replies[id] ?? EMPTY)]
      .map((k) => {
        const c = s.byId[k];
        return c ? commentShape(k, c.authorId, c.createdAt ? timestampMs(c.createdAt) : 0) : '';
      })
      .filter(Boolean)
      .join('\n'),
  );
  // The thread's day is in its header: no date pill over the first row of every card.
  const { items, metas } = useCommentGroups(shape, false);
  const startMs = items[0]?.ms ?? 0;
  const [editId, setEditId] = useState<string | null>(null);
  const editBody = useCanvasComments((s) => (editId ? s.byId[editId]?.body : undefined));
  // The edited comment went away (deleted elsewhere): the field goes back to a reply.
  const editing = editId && editBody !== undefined ? { id: editId, wire: editBody } : null;

  const onEdit = useCallback(
    (cid: string) => {
      setEditId(cid);
      useCanvasComments.getState().setActive(id);
    },
    [id],
  );
  const onDelete = useCallback(
    (cid: string) => {
      void (async () => {
        const c = useCanvasComments.getState().byId[cid];
        if (!c) return;
        const thread = !c.parentId;
        if (!(await confirmAction(t(thread ? 'canvasComments.deleteThreadTitle' : 'canvasComments.deleteTitle'), t(thread ? 'canvasComments.deleteThreadText' : 'canvasComments.deleteText'), t('canvasComments.delete')))) return;
        await deleteComment(c);
      })();
    },
    [],
  );
  const cancelEdit = useCallback(() => setEditId(null), []);
  const submit = useCallback((wire: string, eid?: string) => (eid ? editComment(eid, wire) : replyTo(ctx.canvasId, id, wire)), [ctx.canvasId, id]);

  const show = (): void => {
    const st = useCanvasComments.getState();
    st.setActive(id);
    const c = st.byId[id];
    const p = c ? pinWorld(c, (o) => ctx.engine.scene.get(o)) : null;
    if (p) ctx.engine.centerOn(p);
  };
  const composer = (active && ctx.rights.write) || !!editing;
  return (
    <li
      className={cx('overflow-hidden rounded-[var(--radius-card)] border bg-feed', active ? 'border-accent' : 'border-line')}
      data-testid="canvas-comment-thread"
      data-thread-id={id}
      data-resolved={resolved || undefined}
    >
      <div className="flex h-8 items-center gap-1 border-b border-line bg-main px-1">
        <Button variant="ghost" size="sm" className="min-w-0 text-muted hover:text-fg" onClick={show} data-testid="canvas-comment-show"
          aria-label={resolved ? `${t('canvasComments.resolved')} · ${t('canvasComments.showPin')}` : undefined}
        >
          {resolved ? <Check className="size-3.5 shrink-0 text-success" aria-hidden /> : <MapPin className="size-3.5 shrink-0" aria-hidden />}
          <span className="truncate">{resolved ? t('canvasComments.resolved') : t('canvasComments.showPin')}</span>
        </Button>
        <span className="flex-1" />
        {startMs ? <span className="shrink-0 px-1 text-caption text-muted">{fmt.dayLabel(new Date(startMs))}</span> : null}
        {ctx.rights.write || ctx.rights.moderate ? (
          <IconButton
            size="sm"
            label={resolved ? t('canvasComments.reopen') : t('canvasComments.resolve')}
            onClick={() => void resolveThread(id, !resolved)}
            data-testid="canvas-comment-resolve"
          >
            {resolved ? <RotateCcw className="size-4" aria-hidden /> : <Check className="size-4" aria-hidden />}
          </IconButton>
        ) : null}
      </div>
      <div className="pb-2 pt-1" onClick={() => useCanvasComments.getState().setActive(id)} role="presentation">
        {items.map((it, i) => (
          <Item key={it.key} id={it.key} meta={metas[i] as RowMeta} ctx={ctx} editing={editing?.id === it.key} onEdit={onEdit} onDelete={onDelete} />
        ))}
      </div>
      {composer ? (
        <CommentInput
          canvasId={ctx.canvasId}
          workspaceId={ctx.workspaceId}
          placeholder={t('canvasComments.replyPlaceholder')}
          editing={editing}
          onCancelEdit={cancelEdit}
          onSubmit={submit}
          className="border-t border-line bg-main px-2 pb-2 pt-2"
        />
      ) : null}
    </li>
  );
});

function Draft({ ctx }: { ctx: Ctx }): ReactNode {
  const draft = useCanvasComments((s) => (s.draft?.canvasId === ctx.canvasId ? s.draft : null));
  if (!draft) return null;
  const cancel = (): void => useCanvasComments.getState().setDraft(null);
  return (
    <div className="border-t border-line" data-testid="canvas-comment-draft">
      <CommentInput
        key={`${draft.objectId}:${draft.x}:${draft.y}`}
        canvasId={ctx.canvasId}
        workspaceId={ctx.workspaceId}
        placeholder={t('canvasComments.newPlaceholder')}
        autoFocus
        onEscape={cancel}
        bar={<ContextBar icon={<MessageCirclePlus className="size-4" aria-hidden />} title={t('canvasComments.newThread')} onClose={cancel} />}
        className="px-2 pb-2 pt-2"
        onSubmit={async (wire) => {
          const c = await createThread(ctx.canvasId, wire, draft);
          if (!c) return false;
          const st = useCanvasComments.getState();
          st.setDraft(null);
          st.setActive(c.id);
          return true;
        }}
      />
    </div>
  );
}

export const CommentsPanel = memo(function CommentsPanel({
  canvasId, workspaceId, rights, engine, phone = false,
}: {
  canvasId: string;
  workspaceId: string;
  rights: CommentRights;
  engine: CanvasEngine;
  phone?: boolean;
}): ReactNode {
  useLocale();
  const open = useCanvasComments((s) => s.panel);
  const filterOpen = useCanvasComments((s) => s.filterOpen);
  const loaded = useCanvasComments((s) => !!s.loaded[canvasId]);
  const failed = useCanvasComments((s) => !!s.failed[canvasId]);
  const ids = useCanvasComments(useShallow((s) => (s.threads[canvasId] ?? EMPTY).filter((id) => !s.filterOpen || !s.byId[id]?.resolved)));
  const ctx = useMemo<Ctx>(() => ({ canvasId, workspaceId, rights, engine }), [canvasId, workspaceId, rights, engine]);
  if (!open) return null;
  const close = (): void => {
    const st = useCanvasComments.getState();
    st.setPanel(false);
    st.setDraft(null);
    st.setActive(null);
    // The panel unmounts with the focused element: give focus back so the canvas hotkeys keep working.
    engine.canvas.focus({ preventScroll: true });
  };
  return (
    <aside
      aria-label={t('canvasComments.title')}
      data-testid="canvas-comments-panel"
      className={cx(
        PANEL,
        'absolute z-20 flex flex-col p-0',
        phone ? 'inset-x-2 bottom-2 max-h-[70%]' : 'bottom-16 right-3 top-14 w-[320px]',
      )}
      onKeyDown={(e) => {
        if (e.key === 'Escape') close();
      }}
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line pl-3 pr-1.5">
        <h2 className="flex-1 truncate text-body font-semibold text-fg">{t('canvasComments.title')}</h2>
        <label className="flex items-center gap-2">
          <span className="text-caption text-muted">{t('canvasComments.onlyOpen')}</span>
          <Toggle checked={filterOpen} onChange={(v) => useCanvasComments.getState().setFilterOpen(v)} label={t('canvasComments.onlyOpen')} />
        </label>
        <IconButton size="sm" label={t('common.close')} onClick={close} data-testid="canvas-comments-close">
          <X className="size-4" aria-hidden />
        </IconButton>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {ids.length === 0 ? (
          <p className="px-1 py-6 text-center text-caption text-muted">
            {!loaded ? (failed ? t('canvasComments.loadFailed') : t('canvasComments.loading')) : rights.write ? t('canvasComments.emptyWrite', { alt: ALT }) : t('canvasComments.empty')}
            {!loaded && failed ? (
              <button type="button" className="ml-2 text-accent underline" onClick={() => void loadComments(canvasId)} data-testid="canvas-comments-retry">
                {t('canvasComments.retry')}
              </button>
            ) : null}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {ids.map((id) => (
              <Thread key={id} id={id} ctx={ctx} />
            ))}
          </ul>
        )}
      </div>
      {rights.write ? <Draft ctx={ctx} /> : null}
    </aside>
  );
});

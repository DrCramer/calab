/**
 * The comments panel of a canvas (ADR-0115 wave 4): threads on the right (a sheet on the phone), «Только
 * открытые», a new thread's input after a click of the «Комментарий» tool, replies, «Решить», editing and
 * deleting. What the buttons offer follows the rights (lib/canvas/comments commentRights); the server
 * decides. Each thread and comment is a memo row subscribed to its own ids.
 */
import { Check, Pencil, RotateCcw, Trash2, X } from 'lucide-react';
import { memo, useMemo, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { Avatar } from '../../../../components/Avatar';
import { confirmAction } from '../../../../components/Confirm';
import { IconButton, Toggle, cx } from '../../../../components/ui';
import { t, useLocale } from '../../../../i18n';
import { bodyParts, mayChange, pinWorld, type CommentRights } from '../../../../lib/canvas/comments';
import { fmt } from '../../../../lib/format';
import { createThread, deleteComment, editComment, replyTo, resolveThread } from '../../../../services/canvasComments';
import { useCanvasComments } from '../../../../stores/canvasComments';
import { myUserId } from '../../../../stores/session';
import { memberName, useWorkspaces } from '../../../../stores/workspaces';
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

function Body({ body, workspaceId }: { body: string; workspaceId: string }): ReactNode {
  return (
    <p className="whitespace-pre-wrap break-words text-body text-fg">
      {bodyParts(body, (id) => memberName(workspaceId, id)).map((p, i) =>
        p.kind === 'mention' ? (
          <span key={i} className="font-medium text-accent">
            @{p.name}
          </span>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </p>
  );
}

const CommentRow = memo(function CommentRow({ id, ctx }: { id: string; ctx: Ctx }): ReactNode {
  const c = useCanvasComments((s) => s.byId[id]);
  const avatar = useWorkspaces((s) => (c ? s.users[c.authorId]?.avatarFileId : undefined));
  const [editing, setEditing] = useState(false);
  if (!c) return null;
  const me = myUserId();
  const name = memberName(ctx.workspaceId, c.authorId);
  const changeable = mayChange(c, ctx.rights, me);
  const when = c.createdAt ? fmt.relative(timestampDate(c.createdAt)) : '';
  return (
    <div className="group flex gap-2" data-testid="canvas-comment">
      <Avatar userId={c.authorId} name={name} fileId={avatar || undefined} size={24} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="truncate text-caption font-semibold text-fg">{name}</span>
          <span className="shrink-0 text-micro text-muted">
            {when}
            {c.editedAt ? ` · ${t('canvasComments.edited')}` : ''}
          </span>
          {changeable && !editing ? (
            <span className="ml-auto flex shrink-0 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 mobile:opacity-100">
              <IconButton size="sm" label={t('canvasComments.edit')} onClick={() => setEditing(true)} data-testid="canvas-comment-edit">
                <Pencil className="size-3.5" aria-hidden />
              </IconButton>
              <IconButton
                size="sm"
                label={t('canvasComments.delete')}
                onClick={() => {
                  void (async () => {
                    const thread = !c.parentId;
                    if (!(await confirmAction(t(thread ? 'canvasComments.deleteThreadTitle' : 'canvasComments.deleteTitle'), t(thread ? 'canvasComments.deleteThreadText' : 'canvasComments.deleteText'), t('canvasComments.delete')))) return;
                    await deleteComment(c);
                  })();
                }}
                data-testid="canvas-comment-delete"
              >
                <Trash2 className="size-3.5" aria-hidden />
              </IconButton>
            </span>
          ) : null}
        </div>
        {editing ? (
          <CommentInput
            canvasId={ctx.canvasId}
            workspaceId={ctx.workspaceId}
            initial={c.body}
            placeholder={t('canvasComments.editPlaceholder')}
            submitLabel={t('canvasComments.save')}
            autoFocus
            onCancel={() => setEditing(false)}
            onSubmit={async (wire) => {
              const ok = await editComment(c.id, wire);
              if (ok) setEditing(false);
              return ok;
            }}
          />
        ) : (
          <Body body={c.body} workspaceId={ctx.workspaceId} />
        )}
      </div>
    </div>
  );
});

const Thread = memo(function Thread({ id, ctx }: { id: string; ctx: Ctx }): ReactNode {
  const resolved = useCanvasComments((s) => !!s.byId[id]?.resolved);
  const replies = useCanvasComments(useShallow((s) => s.replies[id] ?? EMPTY));
  const active = useCanvasComments((s) => s.active === id);
  const show = (): void => {
    const st = useCanvasComments.getState();
    st.setActive(id);
    const c = st.byId[id];
    const p = c ? pinWorld(c, (o) => ctx.engine.scene.get(o)) : null;
    if (p) ctx.engine.centerOn(p);
  };
  return (
    <li
      className={cx('rounded-[var(--radius-card)] border p-2', active ? 'border-accent' : 'border-line', resolved && !active && 'opacity-70')}
      data-testid="canvas-comment-thread"
      data-thread-id={id}
      data-resolved={resolved || undefined}
    >
      <div className="mb-1 flex items-center gap-1">
        <button type="button" className="min-w-0 flex-1 text-left text-micro text-muted hover:text-fg" onClick={show} data-testid="canvas-comment-show">
          {resolved ? t('canvasComments.resolved') : t('canvasComments.showPin')}
        </button>
        {ctx.rights.write || ctx.rights.moderate ? (
          <IconButton
            size="sm"
            label={resolved ? t('canvasComments.reopen') : t('canvasComments.resolve')}
            onClick={() => void resolveThread(id, !resolved)}
            data-testid="canvas-comment-resolve"
          >
            {resolved ? <RotateCcw className="size-3.5" aria-hidden /> : <Check className="size-3.5" aria-hidden />}
          </IconButton>
        ) : null}
      </div>
      <div className="flex flex-col gap-2" onClick={() => useCanvasComments.getState().setActive(id)} role="presentation">
        <CommentRow id={id} ctx={ctx} />
        {replies.map((r) => (
          <CommentRow key={r} id={r} ctx={ctx} />
        ))}
      </div>
      {active && ctx.rights.write ? (
        <div className="mt-2">
          <CommentInput
            canvasId={ctx.canvasId}
            workspaceId={ctx.workspaceId}
            placeholder={t('canvasComments.replyPlaceholder')}
            submitLabel={t('canvasComments.reply')}
            onSubmit={(wire) => replyTo(ctx.canvasId, id, wire)}
          />
        </div>
      ) : null}
    </li>
  );
});

function Draft({ ctx }: { ctx: Ctx }): ReactNode {
  const draft = useCanvasComments((s) => (s.draft?.canvasId === ctx.canvasId ? s.draft : null));
  if (!draft) return null;
  const cancel = (): void => useCanvasComments.getState().setDraft(null);
  return (
    <div className="border-b border-line p-2" data-testid="canvas-comment-draft">
      <CommentInput
        key={`${draft.objectId}:${draft.x}:${draft.y}`}
        canvasId={ctx.canvasId}
        workspaceId={ctx.workspaceId}
        placeholder={t('canvasComments.newPlaceholder')}
        submitLabel={t('canvasComments.send')}
        autoFocus
        onCancel={cancel}
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
  const ids = useCanvasComments(useShallow((s) => (s.threads[canvasId] ?? EMPTY).filter((id) => !s.filterOpen || !s.byId[id]?.resolved)));
  const ctx = useMemo<Ctx>(() => ({ canvasId, workspaceId, rights, engine }), [canvasId, workspaceId, rights, engine]);
  if (!open) return null;
  const close = (): void => {
    const st = useCanvasComments.getState();
    st.setPanel(false);
    st.setDraft(null);
    st.setActive(null);
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
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        <h2 className="flex-1 text-body font-semibold text-fg">{t('canvasComments.title')}</h2>
        <Toggle checked={filterOpen} onChange={(v) => useCanvasComments.getState().setFilterOpen(v)} label={t('canvasComments.onlyOpen')} />
        <span className="text-caption text-muted">{t('canvasComments.onlyOpen')}</span>
        <IconButton size="sm" label={t('common.close')} onClick={close} data-testid="canvas-comments-close">
          <X className="size-4" aria-hidden />
        </IconButton>
      </header>
      {rights.write ? <Draft ctx={ctx} /> : null}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {ids.length === 0 ? (
          <p className="px-1 py-6 text-center text-caption text-muted">
            {!loaded ? t('canvasComments.loading') : rights.write ? t('canvasComments.emptyWrite') : t('canvasComments.empty')}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {ids.map((id) => (
              <Thread key={id} id={id} ctx={ctx} />
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
});

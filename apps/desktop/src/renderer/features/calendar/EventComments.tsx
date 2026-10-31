import { timestampMs } from '@bufbuild/protobuf/wkt';
import type { CalendarEvent } from '@calaba/protocol';
import { memo, useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { confirmAction } from '../../components/Confirm';
import { Button, Spinner } from '../../components/ui';
import { t } from '../../i18n';
import { addComment, deleteComment, editComment, loadComments, loadOlderComments } from '../../services/eventComments';
import { useEventComments } from '../../stores/eventComments';
import { myUserId } from '../../stores/session';
import { CommentComposer } from '../chat/CommentComposer';
import { CommentRow, commentShape, useCommentGroups } from '../chat/CommentRow';
import type { RowMeta } from '../chat/grouping';

/** A comment's length limit (calendar/comments.go MaxCommentBody). */
const MAX_COMMENT = 4000;

/**
 * «Комментарии — N» of the meeting card (ADR-0104, docs/08 «Календарь»): the thread of the series
 * (loaded once, kept fresh by EVENT_COMMENT_*), «Показать ранние», and — like the chat (owner 23.10)
 * — chat rows grouped like the feed (chat/CommentRow) and the chat's composer below
 * (chat/CommentComposer), which also edits. Rows subscribe by comment id. Not for guests (the caller
 * hides it). `moderate`: may delete others' comments (CalendarEvent.can_edit).
 */
export const EventComments = memo(function EventComments({ ev, moderate }: { ev: CalendarEvent; moderate: boolean }): ReactNode {
  const eventId = ev.id;
  // The grouping's input as one primitive: an edit does not re-group the thread.
  const shape = useEventComments((s) => {
    const th = s.threads[eventId];
    if (!th) return '';
    return th.ids
      .map((id) => {
        const c = th.byId[id];
        return c ? commentShape(id, c.authorId, c.createdAt ? timestampMs(c.createdAt) : 0) : '';
      })
      .filter(Boolean)
      .join('\n');
  });
  const { items, metas } = useCommentGroups(shape);
  const loaded = useEventComments((s) => !!s.threads[eventId]?.loaded);
  const loading = useEventComments((s) => !!s.threads[eventId]?.loading);
  const hasMore = useEventComments((s) => !!s.threads[eventId]?.hasMore);
  const live = useEventComments((s) => s.counts[eventId]);
  const count = loaded && !hasMore ? items.length : (live ?? ev.counts?.comments ?? 0);
  const cancelled = !!ev.cancelledAt;
  const headId = useId();
  const field = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // A READY reset the threads (comments missed while away): the open card loads again.
    if (!loaded && !loading) void loadComments(eventId);
  }, [eventId, loaded, loading]);

  const [editId, setEditId] = useState<string | null>(null);
  const editBody = useEventComments((s) => (editId ? s.threads[eventId]?.byId[editId]?.body : undefined));
  // The edited comment went away (deleted elsewhere): the field goes back to a new comment.
  const editing = editId && editBody !== undefined ? { id: editId, wire: editBody } : null;
  const onEdit = useCallback((id: string) => setEditId(id), []);
  const onDelete = useCallback(
    (id: string) => {
      void (async () => {
        if (await confirmAction(t('cal.comments.deleteTitle'), t('cal.comments.deleteText'), t('cal.comments.delete'))) await deleteComment(eventId, id);
      })();
    },
    [eventId],
  );
  const cancelEdit = useCallback(() => setEditId(null), []);
  const submit = useCallback(
    async (wire: string, eid?: string): Promise<boolean> => {
      if (eid) return editComment(eventId, eid, wire);
      const ok = await addComment(eventId, wire);
      // My comment pushed the field down: keep it in sight for the next one.
      if (ok) requestAnimationFrame(() => field.current?.scrollIntoView({ block: 'nearest' }));
      return ok;
    },
    [eventId],
  );

  return (
    <section className="mt-4" aria-labelledby={headId} data-testid="event-comments">
      <h3 id={headId} className="text-micro font-semibold uppercase tracking-wide text-faint">
        {t('cal.comments.title')} — {count}
      </h3>
      {hasMore ? (
        <Button variant="ghost" size="sm" onClick={() => void loadOlderComments(eventId)} className="mt-1 text-accent-text" data-testid="event-comments-older">
          {t('cal.comments.older')}
        </Button>
      ) : null}
      {!loaded && loading ? (
        <div className="mt-2 flex justify-center">
          <Spinner className="size-4" />
        </div>
      ) : items.length > 0 ? (
        <div className="mt-2 flex flex-col overflow-hidden rounded-[var(--radius-card)] bg-feed pb-2">
          {items.map((it, i) => (
            <Comment
              key={it.key}
              eventId={eventId}
              commentId={it.key}
              meta={metas[i] as RowMeta}
              workspaceId={ev.workspaceId}
              moderate={moderate}
              readOnly={cancelled}
              editing={editing?.id === it.key}
              onEdit={onEdit}
              onDelete={onDelete}
            />
          ))}
        </div>
      ) : loaded ? (
        <p className="mt-1 text-caption text-muted" data-testid="event-comments-empty">
          {t('cal.comments.empty')}
        </p>
      ) : null}
      {cancelled ? null : (
        <div ref={field}>
          <CommentComposer
            workspaceId={ev.workspaceId}
            placeholder={t('cal.comments.placeholder')}
            maxLength={MAX_COMMENT}
            editing={editing}
            onCancelEdit={cancelEdit}
            onSubmit={submit}
            className="pb-1 pt-2"
            testId="event-comment-input"
            sendTestId="event-comment-send"
          />
        </div>
      )}
    </section>
  );
});

/** One comment as a chat row: «Изменить» (author), «Удалить» (author, organizer). */
const Comment = memo(function Comment({
  eventId,
  commentId,
  meta,
  workspaceId,
  moderate,
  readOnly,
  editing,
  onEdit,
  onDelete,
}: {
  eventId: string;
  commentId: string;
  meta: RowMeta;
  workspaceId: string;
  moderate: boolean;
  readOnly: boolean;
  editing: boolean;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}): ReactNode {
  const c = useEventComments((s) => s.threads[eventId]?.byId[commentId]);
  if (!c) return null;
  const mine = !!c.authorId && c.authorId === myUserId();
  return (
    <CommentRow
      id={commentId}
      authorId={c.authorId}
      body={c.body}
      atMs={c.createdAt ? timestampMs(c.createdAt) : 0}
      edited={!!c.editedAt}
      meta={meta}
      own={mine}
      workspaceId={workspaceId}
      canEdit={mine && !readOnly}
      canDelete={mine || moderate}
      onEdit={onEdit}
      onDelete={onDelete}
      editing={editing}
      testId="event-comment"
    />
  );
});

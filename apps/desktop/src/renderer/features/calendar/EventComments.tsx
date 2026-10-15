import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { timestampMs } from '@bufbuild/protobuf/wkt';
import type { CalendarEvent } from '@calaba/protocol';
import { ArrowUp, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { memo, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Avatar } from '../../components/Avatar';
import { confirmAction } from '../../components/Confirm';
import { ProfileTarget } from '../../components/ProfileTarget';
import { Button, IconButton, Spinner, cx } from '../../components/ui';
import { t } from '../../i18n';
import { fmt } from '../../lib/format';
import { Markdown } from '../../lib/markdown/Markdown';
import { addComment, deleteComment, editComment, loadComments, loadOlderComments } from '../../services/eventComments';
import { useEventComments } from '../../stores/eventComments';
import { myUserId } from '../../stores/session';
import { useFormerInfo, useMemberName, useWorkspaces } from '../../stores/workspaces';
import { menuBox, menuItem } from '../shell/menu';

/** A comment's length limit (calendar/comments.go MaxCommentBody). */
const MAX_COMMENT = 4000;
const NO_IDS: readonly string[] = [];

/**
 * «Комментарии — N» of the meeting card (ADR-0104, docs/08 «Календарь»): the thread of the series
 * (loaded once, kept fresh by EVENT_COMMENT_*), «Показать ранние», rows with their own
 * subscription by comment id, and the field below. Not for guests (the caller hides it).
 * `moderate`: may delete others' comments (CalendarEvent.can_edit).
 */
export const EventComments = memo(function EventComments({ ev, moderate }: { ev: CalendarEvent; moderate: boolean }): ReactNode {
  const eventId = ev.id;
  const ids = useEventComments(useShallow((s) => s.threads[eventId]?.ids ?? NO_IDS));
  const loaded = useEventComments((s) => !!s.threads[eventId]?.loaded);
  const loading = useEventComments((s) => !!s.threads[eventId]?.loading);
  const hasMore = useEventComments((s) => !!s.threads[eventId]?.hasMore);
  const live = useEventComments((s) => s.counts[eventId]);
  const count = loaded && !hasMore ? ids.length : (live ?? ev.counts?.comments ?? 0);
  const cancelled = !!ev.cancelledAt;
  const headId = useId();
  useEffect(() => {
    // A READY reset the threads (comments missed while away): the open card loads again.
    if (!loaded && !loading) void loadComments(eventId);
  }, [eventId, loaded, loading]);
  return (
    <section className="mt-4" aria-labelledby={headId} data-testid="event-comments">
      <h3 id={headId} className="text-micro font-semibold uppercase tracking-wide text-faint">
        {t('cal.comments.title')} — {count}
      </h3>
      {hasMore ? (
        <button
          type="button"
          onClick={() => void loadOlderComments(eventId)}
          className="mt-1 h-7 rounded-full px-2 text-caption text-accent-text hover:bg-hover"
          data-testid="event-comments-older"
        >
          {t('cal.comments.older')}
        </button>
      ) : null}
      {!loaded && loading ? (
        <div className="mt-2 flex justify-center">
          <Spinner className="size-4" />
        </div>
      ) : ids.length > 0 ? (
        <ul className="mt-1 flex flex-col">
          {ids.map((id) => (
            <CommentRow key={id} eventId={eventId} commentId={id} workspaceId={ev.workspaceId} moderate={moderate} readOnly={cancelled} />
          ))}
        </ul>
      ) : loaded ? (
        <p className="mt-1 text-caption text-muted" data-testid="event-comments-empty">
          {t('cal.comments.empty')}
        </p>
      ) : null}
      {cancelled ? null : <CommentField eventId={eventId} />}
    </section>
  );
});

/** One comment: avatar, name, time («изменено»), the text; «…» — edit (author) / delete (author, organizer). */
const CommentRow = memo(function CommentRow({
  eventId,
  commentId,
  workspaceId,
  moderate,
  readOnly,
}: {
  eventId: string;
  commentId: string;
  workspaceId: string;
  moderate: boolean;
  readOnly: boolean;
}): ReactNode {
  const c = useEventComments((s) => s.threads[eventId]?.byId[commentId]);
  const author = c?.authorId ?? '';
  const name = useMemberName(workspaceId, author);
  const avatar = useWorkspaces((s) => (author ? (s.byId[workspaceId]?.members[author]?.user?.avatarFileId ?? s.users[author]?.avatarFileId ?? '') : ''));
  const former = !!useFormerInfo(workspaceId, author);
  const [editing, setEditing] = useState(false);
  if (!c) return null;
  const mine = author === myUserId();
  const at = c.createdAt ? new Date(timestampMs(c.createdAt)) : null;
  const canEdit = mine && !readOnly;
  const canDelete = mine || moderate;
  const remove = async (): Promise<void> => {
    if (await confirmAction(t('cal.comments.deleteTitle'), t('cal.comments.deleteText'), t('cal.comments.delete'))) await deleteComment(eventId, commentId);
  };
  return (
    <li className="group flex gap-2 py-1.5" data-testid="event-comment">
      <ProfileTarget userId={author} name={name} workspaceId={workspaceId} className="mt-0.5 shrink-0 self-start rounded-full">
        <Avatar userId={author} name={name} {...(avatar ? { fileId: avatar } : {})} size={20} former={former} />
      </ProfileTarget>
      <div className="min-w-0 flex-1">
        <div className="flex min-h-5 items-center gap-1.5">
          <span className="min-w-0 truncate text-caption font-semibold text-fg">{name}</span>
          {at ? (
            <time className="shrink-0 text-caption text-faint" dateTime={at.toISOString()} title={fmt.full(at)}>
              {fmt.until(at)}
            </time>
          ) : null}
          {c.editedAt ? <span className="shrink-0 text-caption text-faint">· {t('cal.comments.edited')}</span> : null}
          <span className="flex-1" />
          {(canEdit || canDelete) && !editing ? (
            <Dropdown.Root modal={false}>
              <Dropdown.Trigger asChild>
                <IconButton
                  size="sm"
                  label={t('cal.comments.menu')}
                  tip={false}
                  className="-my-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 mobile:opacity-100"
                  data-testid="event-comment-menu"
                >
                  <MoreHorizontal className="size-4" />
                </IconButton>
              </Dropdown.Trigger>
              <Dropdown.Portal>
                <Dropdown.Content className={menuBox} sideOffset={4} align="end" collisionPadding={16}>
                  {canEdit ? (
                    <Dropdown.Item className={menuItem} onSelect={() => setEditing(true)}>
                      <Pencil className="size-4" aria-hidden />
                      {t('cal.comments.edit')}
                    </Dropdown.Item>
                  ) : null}
                  {canDelete ? (
                    <Dropdown.Item className={cx(menuItem, 'text-danger-text')} onSelect={() => void remove()}>
                      <Trash2 className="size-4" aria-hidden />
                      {t('cal.comments.delete')}
                    </Dropdown.Item>
                  ) : null}
                </Dropdown.Content>
              </Dropdown.Portal>
            </Dropdown.Root>
          ) : null}
        </div>
        {editing ? (
          <EditBox eventId={eventId} commentId={commentId} initial={c.body} onDone={() => setEditing(false)} />
        ) : (
          <div className="select-text whitespace-pre-wrap break-words text-body text-fg [&_a]:text-accent-text" data-testid="event-comment-body">
            <Markdown text={c.body} mention={(v, k) => <span key={k}>@{v}</span>} />
          </div>
        )}
      </div>
    </li>
  );
});

const fieldBox =
  'w-full resize-none rounded-[12px] bg-input px-3 py-1.5 text-body text-fg outline-none placeholder:text-faint [field-sizing:content] max-h-32 min-h-8 border border-transparent focus:border-[var(--color-focus)]';

/** Enter sends, Shift+Enter (or composing IME text) adds a line. */
function enterSends(e: KeyboardEvent<HTMLTextAreaElement>, send: () => void): void {
  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
    e.preventDefault();
    send();
  }
}

/** The field under the thread: a growing text box and the send button. */
function CommentField({ eventId }: { eventId: string }): ReactNode {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const body = text.trim();
  const send = (): void => {
    if (!body || busy) return;
    setBusy(true);
    void addComment(eventId, body).then((ok) => {
      setBusy(false);
      if (ok) setText('');
      // My comment pushed the field down: keep it in sight for the next one.
      requestAnimationFrame(() => ref.current?.scrollIntoView({ block: 'nearest' }));
      ref.current?.focus();
    });
  };
  return (
    <div className="mt-2 flex items-end gap-1.5">
      <textarea
        ref={ref}
        value={text}
        rows={1}
        maxLength={MAX_COMMENT}
        placeholder={t('cal.comments.placeholder')}
        aria-label={t('cal.comments.placeholder')}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => enterSends(e, send)}
        className={fieldBox}
        data-testid="event-comment-input"
      />
      <IconButton
        size="sm"
        label={t('cal.comments.send')}
        onClick={send}
        disabled={!body || busy}
        className="mb-1 shrink-0 bg-accent-strong text-accent-fg hover:bg-accent-strong hover:text-accent-fg disabled:opacity-40"
        data-testid="event-comment-send"
      >
        <ArrowUp className="size-4" />
      </IconButton>
    </div>
  );
}

function EditBox({ eventId, commentId, initial, onDone }: { eventId: string; commentId: string; initial: string; onDone: () => void }): ReactNode {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const body = text.trim();
  const save = (): void => {
    if (!body || busy) return;
    if (body === initial) {
      onDone();
      return;
    }
    setBusy(true);
    void editComment(eventId, commentId, body).then((ok) => {
      setBusy(false);
      if (ok) onDone();
    });
  };
  return (
    <div className="mt-1 flex flex-col gap-1.5">
      <textarea
        value={text}
        rows={1}
        maxLength={MAX_COMMENT}
        aria-label={t('cal.comments.edit')}
        autoFocus
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onDone();
            return;
          }
          enterSends(e, save);
        }}
        className={fieldBox}
        data-testid="event-comment-edit"
      />
      <div className="flex justify-end gap-1.5">
        <Button size="sm" variant="ghost" onClick={onDone}>
          {t('cal.comments.cancelEdit')}
        </Button>
        <Button size="sm" onClick={save} busy={busy} disabled={!body}>
          {t('cal.comments.save')}
        </Button>
      </div>
    </div>
  );
}

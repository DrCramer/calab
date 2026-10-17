import type { CalendarEventComment, CalendarEventCommentDelete, CalendarEventCommentUpsert } from '@calaba/protocol';
import { t } from '../i18n';
import { api } from '../lib/api/endpoints';
import { errorText } from '../lib/api/errors';
import { withComment, withPage, withoutComment } from '../lib/calendar/comments';
import { EMPTY_THREAD, useEventComments, type EventThread } from '../stores/eventComments';
import { toast } from '../stores/toasts';

/*
 * Comments on a meeting (ADR-0104): the card loads its thread once per session; the gateway's
 * EVENT_COMMENT_* keep loaded threads and every count fresh.
 */

function patch(eventId: string, fn: (th: EventThread) => EventThread, count?: number): void {
  useEventComments.setState((s) => {
    const cur = s.threads[eventId];
    const next = cur ? fn(cur) : undefined;
    const counts = count === undefined || s.counts[eventId] === count ? s.counts : { ...s.counts, [eventId]: count };
    if (next === cur && counts === s.counts) return s;
    return { threads: next && next !== cur ? { ...s.threads, [eventId]: next } : s.threads, counts };
  });
}

/** The first page of a meeting's comments, once (later changes arrive on the gateway). */
export async function loadComments(eventId: string): Promise<void> {
  const cur = useEventComments.getState().threads[eventId];
  if (cur?.loaded || cur?.loading) return;
  useEventComments.setState((s) => ({ threads: { ...s.threads, [eventId]: { ...EMPTY_THREAD, loading: true } } }));
  try {
    const r = await api.calendar.comments(eventId);
    useEventComments.setState((s) => ({ threads: { ...s.threads, [eventId]: withPage(s.threads[eventId] ?? EMPTY_THREAD, r.comments, r.hasMore) } }));
  } catch {
    // Not loaded: the card offers nothing to retry but reopening; drop the marker so it can.
    useEventComments.setState((s) => {
      const threads = { ...s.threads };
      delete threads[eventId];
      return { threads };
    });
  }
}

/** «Показать ранние»: the page before the oldest loaded comment. */
export async function loadOlderComments(eventId: string): Promise<void> {
  const cur = useEventComments.getState().threads[eventId];
  if (!cur?.loaded || cur.loading || !cur.hasMore) return;
  patch(eventId, (th) => ({ ...th, loading: true }));
  try {
    const r = await api.calendar.comments(eventId, cur.ids[0]);
    patch(eventId, (th) => ({ ...withPage(th, r.comments, r.hasMore), hasMore: r.hasMore }));
  } catch (e) {
    patch(eventId, (th) => ({ ...th, loading: false }));
    toast.error(errorText(e));
  }
}

/** Sends a comment; true when it was saved (the field clears). */
export async function addComment(eventId: string, text: string): Promise<boolean> {
  try {
    const r = await api.calendar.addComment(eventId, text);
    if (r.comment) apply(r.comment);
    return true;
  } catch (e) {
    toast.error(errorText(e));
    return false;
  }
}

export async function editComment(eventId: string, commentId: string, text: string): Promise<boolean> {
  try {
    const r = await api.calendar.editComment(eventId, commentId, text);
    if (r.comment) apply(r.comment);
    return true;
  } catch (e) {
    toast.error(errorText(e));
    return false;
  }
}

export async function deleteComment(eventId: string, commentId: string): Promise<void> {
  try {
    await api.calendar.deleteComment(eventId, commentId);
    patch(eventId, (th) => withoutComment(th, commentId));
  } catch (e) {
    toast.error(errorText(e, t('cal.comments.deleteFailed')));
  }
}

function apply(c: CalendarEventComment): void {
  patch(c.eventId, (th) => withComment(th, c));
}

export function onCommentUpsert(v: CalendarEventCommentUpsert): void {
  const c = v.comment;
  if (!c) return;
  patch(v.eventId, (th) => withComment(th, c), v.comments);
}

export function onCommentDelete(v: CalendarEventCommentDelete): void {
  patch(v.eventId, (th) => withoutComment(th, v.commentId), v.comments);
}

import type { CalendarEventComment } from '@calaba/protocol';
import type { EventThread } from '../../stores/eventComments';

/*
 * Pure transitions of a meeting's comment thread (ADR-0104): a page from the server, a comment
 * added or edited (ours or EVENT_COMMENT_UPSERT), a comment removed. Ids are uuidv7 — their order
 * is the time order, so a thread stays sorted by id.
 */

const byIdOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A page of older comments (or the first page) merged in; `hasMore` is the page's answer. */
export function withPage(th: EventThread, page: readonly CalendarEventComment[], hasMore: boolean): EventThread {
  const byId: Record<string, CalendarEventComment> = { ...th.byId };
  for (const c of page) {
    const cur = byId[c.id];
    byId[c.id] = cur && newer(cur, c) ? cur : c;
  }
  const ids = [...new Set([...th.ids, ...page.map((c) => c.id)])].sort(byIdOrder);
  return { ids, byId, hasMore: th.loaded ? th.hasMore && hasMore : hasMore, loading: false, loaded: true };
}

/** A comment added or edited: kept in id order; an older copy never replaces an edit. */
export function withComment(th: EventThread, c: CalendarEventComment): EventThread {
  const cur = th.byId[c.id];
  if (cur && newer(cur, c)) return th;
  const ids = cur ? th.ids : [...th.ids, c.id].sort(byIdOrder);
  return { ...th, ids, byId: { ...th.byId, [c.id]: c } };
}

export function withoutComment(th: EventThread, id: string): EventThread {
  if (!th.byId[id]) return th;
  const byId = { ...th.byId };
  delete byId[id];
  return { ...th, ids: th.ids.filter((x) => x !== id), byId };
}

const editedMs = (c: CalendarEventComment): number => (c.editedAt ? Number(c.editedAt.seconds) * 1000 + Math.floor(c.editedAt.nanos / 1e6) : 0);

/** `a` was edited after `b` (b is a stale copy). */
function newer(a: CalendarEventComment, b: CalendarEventComment): boolean {
  return editedMs(a) > editedMs(b);
}

/**
 * Where the reader left a room's feed while another phone screen covers it (owner 14.10). The
 * phone keeps only the top screen mounted (ADR-0073), so «Участники» (or the room's settings, a
 * profile…) pushed over a room unmounts its feed, and «‹» mounts it again: without this it came
 * back at the bottom. The feed saves its topmost visible row and that row's offset when it unmounts
 * under a pushed screen and restores them on mount; a room closed with «‹» (no longer in the stack)
 * or left at the bottom is not saved — it opens as usual (first unread, else the bottom).
 *
 * Module state, not a store: nothing renders from it, and it lives as long as the page.
 */
export interface FeedPosition {
  /** The row (ChatMessage.key) at the top of the viewport. */
  key: string;
  /** Its top edge relative to the viewport's top, px (≤ 0 when partly scrolled past). */
  offset: number;
}

const saved = new Map<string, FeedPosition>();

export function saveFeedPosition(roomId: string, pos: FeedPosition | null): void {
  if (pos) saved.set(roomId, pos);
  else saved.delete(roomId);
}

/** The saved position of the room, forgotten once read (a later open starts as usual). */
export function takeFeedPosition(roomId: string): FeedPosition | undefined {
  const pos = saved.get(roomId);
  saved.delete(roomId);
  return pos;
}

/** The topmost row of the scroller's viewport and its offset; null when no row is on screen. */
export function readFeedPosition(scroller: HTMLElement): FeedPosition | null {
  const top = scroller.getBoundingClientRect().top;
  for (const row of scroller.querySelectorAll<HTMLElement>('[data-message-id]')) {
    const r = row.getBoundingClientRect();
    if (r.bottom <= top + 1) continue;
    const key = row.dataset['messageId'];
    return key ? { key, offset: Math.round(r.top - top) } : null;
  }
  return null;
}

/**
 * Pure logic behind «the feed stays at the bottom» (docs/09 #149 and its follow-up): while the
 * reader sits at the bottom of the feed, any change of the feed's geometry that is not their own
 * scroll — the last row growing (a reaction pill, an upload turning into its preview, an image or
 * link preview loading, an edit), the scroller shrinking (the composer growing to several lines or
 * gaining attachment chips) — re-anchors the scroll to the true bottom.
 *
 * Why not Virtuoso's atBottom: it is recomputed *from* the grown geometry, so a growth taller than
 * its threshold (an image) flips it to false before we can react, and Virtuoso itself only follows
 * size increases for 100 ms after a new item. «Stuck» here is decided by scrolling alone: arriving
 * at the bottom sticks, moving up unsticks, content changes never stick or unstick.
 *
 * Content changes never *stick* (2.4.1 regression, «the feed flickers while scrolling»): scrolling
 * up near the bottom mounts a row above the viewport whose real height differs from Virtuoso's
 * estimate; for a moment the content is shorter than the reader's offset, so the browser clamps
 * scrollTop to the bottom, and Virtuoso restores the reader's offset right after. Counting that
 * clamp as «at the bottom» turned Virtuoso's restore into a «growth while stuck» and threw the
 * reader back to the bottom. A clamp is told apart from the reader's own scroll by its direction:
 * it moves *up* and lands exactly on the bottom; the reader arrives at the bottom moving down.
 *
 * One exception, by intent (owner, 15.10, «sent a text / sticker / image — the feed is not at the
 * bottom»): sending my own message sticks the pin (`stick()`), wherever the reader was, and the pin
 * takes the feed to the bottom and holds it through the row's real height (several lines, a sticker
 * or an image loading, upload → preview, the server echo re-rendering it). A send is the reader's own action,
 * never a clamp, so it cannot reintroduce the 2.4.1 flicker; it is undone, like any stick, by the
 * reader scrolling up. Sent from a window away from the present (`setLive(false)` until the present
 * loads), the intent survives until the window is live again, then pins to the new bottom.
 *
 * The pin is the feed's only writer of «scroll to the bottom» (CBF-13, ADR-0110): every geometry
 * change while stuck — someone's new message appended, a row growing, the scroller shrinking — is
 * pinned at once, the same way. Earlier the first resize after someone else's new row was left to
 * Virtuoso's followOutput ('smooth'), which scrolls to the bottom computed from the row's
 * *estimated* height: a row taller than the estimate (several lines, a link preview, a meeting
 * card) ended under the composer, and no later resize came to fix it — the bug of CBF-13. With two
 * writers, a smooth scroll still on its way to a stale target could also move the reader up.
 * Which new last row is my own send is `isOwnSend` below.
 *
 * Stateless about the DOM (like hoverIntent.ts): the caller feeds geometry from scroll events and
 * ResizeObserver callbacks and does the actual scrolling. No timers, no frame loops.
 */
export interface FeedGeometry {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export interface BottomPin {
  /** A scroll event (the reader's, or ours/Virtuoso's programmatic one). */
  scrolled(g: FeedGeometry): void;
  /** A ResizeObserver report (the scroller or its content). Returns whether the caller should
   * set scrollTop to the bottom now. */
  resized(g: FeedGeometry): boolean;
  /** False while newer history is not loaded (hasMoreAfter): the bottom is not the present, and
   * pinning there would keep triggering endReached. */
  setLive(live: boolean): void;
  /** My own message was just sent: stick to the bottom (and keep that through a window that is not
   * live yet) until the reader scrolls up. */
  stick(): void;
  /** The reader unfolded something in the feed («Показать всё» of a meeting summary or a long code
   * block): they read on from where they clicked, so its growth must not pin the bottom and throw
   * them to the end of the text. Stuck again only by scrolling down to the bottom. */
  release(): void;
  /** The reader sits at the bottom (what the feed's position is saved as, feedPosition.ts). */
  isStuck(): boolean;
}

/** Distance from the bottom (px) still counted as «arrived at the bottom» when scrolling down —
 * sub-pixel zoom rounding and the last wheel step; deliberately far below Virtuoso's 48 px «show
 * the to-bottom button». */
export const STICK_PX = 8;
/** Sub-pixel noise (zoom rounding): a move or a distance this small is no move. */
const EPS = 1;

const distance = (g: FeedGeometry): number => g.scrollHeight - g.clientHeight - g.scrollTop;

/** `stuck`: start stuck — the feed opens at the bottom (no unread), so growth before the first
 * scroll event (rows measured, images loading) keeps it there. */
export function createBottomPin(stuck = false): BottomPin {
  let live = true;
  // A send's intent to stick that must outlive a window away from the present (see stick()).
  let sent = false;
  let lastTop: number | null = null;
  return {
    scrolled(g) {
      const d = distance(g);
      const moved = lastTop === null ? 0 : g.scrollTop - lastTop;
      lastTop = g.scrollTop;
      if (moved < -EPS) {
        // Up, and not just clamped onto the bottom: the reader (or a jump) leaves the bottom.
        if (d > EPS) stuck = sent = false;
        return;
      }
      // Down or in place, at the bottom: the reader arrived (or our pin landed).
      if (d <= STICK_PX) stuck = true;
    },
    resized(g) {
      if (!live) {
        // The window's bottom is not the present: nothing to stick to until the reader scrolls
        // down to the bottom again with newer history loaded — unless they just sent a message:
        // the present is loading, and its bottom is where they want to be.
        if (!sent) stuck = false;
        return false;
      }
      sent = false;
      if (stuck && distance(g) > 0.5) return true;
      // A feed shorter than its scroller is at its bottom by definition (no scroll event comes).
      // Anything else is decided by scrolling only: a clamp onto the bottom here is transient.
      if (g.scrollHeight <= g.clientHeight + EPS) stuck = true;
      return false;
    },
    setLive(v) {
      live = v;
    },
    stick() {
      stuck = sent = true;
    },
    release() {
      stuck = sent = false;
    },
    isStuck() {
      return stuck;
    },
  };
}

/** A new last row that is my own optimistic one (`local:<nonce>`, not yet sent): a send, which
 * sticks the pin from anywhere (see stick()). Someone else's message, the server echo of mine or my
 * message from another device change nothing: they are pinned while stuck, like any growth. */
export function isOwnSend(last: { key: string; own: boolean; pending: boolean }): boolean {
  return last.own && last.pending && last.key.startsWith('local:');
}

/** Where the feed opens: at the first unread row (docs/09 #39, `firstNew` ≥ 0), else at the
 * bottom — the last row's *bottom* (align end): a bare index aligns the row's top, so a last
 * message taller than the feed opened cut off above the composer. `stuck` seeds the pin: opened at
 * the present's bottom, rows growing before the first scroll event (images, previews being
 * measured) keep the feed there. */
export function initialFeedLocation(
  firstNew: number,
  hasMoreAfter: boolean,
): { location: { index: number | 'LAST'; align: 'start' | 'end'; offset?: number }; stuck: boolean } {
  if (firstNew >= 0) return { location: { index: firstNew, align: 'start', offset: -40 }, stuck: false };
  return { location: { index: 'LAST', align: 'end' }, stuck: !hasMoreAfter };
}

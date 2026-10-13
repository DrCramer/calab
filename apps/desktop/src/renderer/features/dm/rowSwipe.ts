import { useRef, useState, type TouchEvent } from 'react';
import { haptics } from '../../lib/haptics';

/** Width of the action revealed behind a DM row on a phone (docs/09 #51). */
export const SWIPE_ACTION_PX = 88;
/** Movement before a gesture is judged: a scroll (vertical) or a row swipe (horizontal). */
const SLOP_PX = 10;

export interface SwipeGesture {
  x: number;
  y: number;
  /** The row's offset when the gesture started (0 closed, −SWIPE_ACTION_PX open). */
  base: number;
  claimed: boolean;
  /** Where the row would settle if released now (swipeSettle); undefined = where it started. */
  side?: number;
}

/**
 * One touch move of a row swipe: the new offset (≤ 0), `null` while undecided, or 'scroll' when
 * the gesture is a vertical scroll (the row lets it go). A right swipe on a closed row is not the
 * row's (the drawer may use it).
 */
export function swipeMove(g: SwipeGesture, x: number, y: number): number | null | 'scroll' {
  const dx = x - g.x;
  const dy = y - g.y;
  if (!g.claimed) {
    if (Math.abs(dy) > SLOP_PX && Math.abs(dy) >= Math.abs(dx)) return 'scroll';
    if (Math.abs(dx) < SLOP_PX || (dx > 0 && g.base === 0)) return null;
    g.claimed = true;
  }
  return Math.max(-SWIPE_ACTION_PX, Math.min(0, g.base + dx));
}

/** Where a released row settles: open past half the action's width, else closed. */
export const swipeSettle = (offset: number): number => (offset < -SWIPE_ACTION_PX / 2 ? -SWIPE_ACTION_PX : 0);

/**
 * The drag crossed the settle point (half the action's width) since the last call, either way:
 * the haptic «impact» fires once per crossing, not on every move.
 */
export function swipeCrossed(g: SwipeGesture, offset: number): boolean {
  const side = swipeSettle(offset);
  const crossed = side !== (g.side ?? swipeSettle(g.base));
  g.side = side;
  return crossed;
}

/**
 * Phone (ADR-0021, docs/09 #51): swiping a DM row left reveals its action, swiping right or
 * tapping the row hides it. A claimed gesture stops at the row, so the drawer's own left swipe
 * (close) does not fire.
 */
export function useRowSwipe(enabled: boolean): {
  offset: number;
  dragging: boolean;
  close: () => void;
  handlers: { onTouchStart?: (e: TouchEvent) => void; onTouchMove?: (e: TouchEvent) => void; onTouchEnd?: (e: TouchEvent) => void };
} {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const gesture = useRef<SwipeGesture | null>(null);
  if (!enabled) return { offset: 0, dragging: false, close: () => undefined, handlers: {} };
  return {
    offset,
    dragging,
    close: () => setOffset(0),
    handlers: {
      onTouchStart: (e) => {
        const p = e.touches[0];
        gesture.current = p && e.touches.length === 1 ? { x: p.clientX, y: p.clientY, base: offset, claimed: false } : null;
      },
      onTouchMove: (e) => {
        const g = gesture.current;
        const p = e.touches[0];
        if (!g || !p) return;
        const next = swipeMove(g, p.clientX, p.clientY);
        if (next === 'scroll') {
          gesture.current = null;
          return;
        }
        if (next === null) return;
        e.stopPropagation();
        if (swipeCrossed(g, next)) haptics.impact();
        setDragging(true);
        setOffset(next);
      },
      onTouchEnd: (e) => {
        const g = gesture.current;
        gesture.current = null;
        if (!g?.claimed) return;
        e.stopPropagation();
        setDragging(false);
        setOffset(swipeSettle);
      },
    },
  };
}

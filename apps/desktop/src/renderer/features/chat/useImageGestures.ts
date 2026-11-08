import { useEffect, useRef, type RefObject } from 'react';
import {
  IDENTITY,
  anchorAt,
  clampPan,
  clampScale,
  distance,
  doubleTapTarget,
  isDoubleTap,
  lockAxis,
  midpoint,
  placeAnchor,
  swipeAction,
  type Pt,
  type ViewT,
} from '../../lib/lightbox';

/** Movement (px) under which a touch release counts as a tap (for the double tap). */
const TAP_PX = 8;

interface Opts {
  hasPrev: boolean;
  hasNext: boolean;
  onStep: (delta: -1 | 1) => void;
  onClose: () => void;
}

/**
 * Touch gestures of the photo viewer (board #118, the Telegram media viewer): pinch to zoom,
 * double tap to zoom in / out, drag to pan a zoomed picture, and on a fitted one a horizontal swipe
 * to the previous / next photo and a swipe down to close. Pointer events with touch / pen only (a
 * mouse keeps the drag-out of the file and the click-to-close). The state lives in plain variables
 * and is applied as one CSS transform on the frame `ref` — React never re-renders while a finger
 * moves, and requestAnimationFrame runs only while a gesture is active (no timers when idle).
 */
export function useImageGestures(ref: RefObject<HTMLDivElement | null>, { hasPrev, hasNext, onStep, onClose }: Opts): void {
  const opts = useRef<Opts>({ hasPrev, hasNext, onStep, onClose });
  useEffect(() => {
    opts.current = { hasPrev, hasNext, onStep, onClose };
  });
  useEffect(() => {
    const el = ref.current;
    return el ? attach(el, opts) : undefined;
  }, [ref]);
}

/** Wires the gestures to `el` with native listeners; returns the cleanup. */
function attach(el: HTMLDivElement, opts: { current: Opts }): () => void {
  let t: ViewT = IDENTITY;
  /** The swipe offset of a fitted picture (follows the finger). */
  let drag: Pt = { x: 0, y: 0 };
  const pts = new Map<number, Pt>();
  let start: (Pt & { t: number }) | null = null;
  let last: Pt | null = null;
  let axis: 'x' | 'y' | null = null;
  let moved = false;
  let lastTap: { t: number; x: number; y: number } | null = null;
  let pinch: { d0: number; s0: number; anchor: Pt } | null = null;
  let raf = 0;

  /** Frame (unscaled) and view (the stage around it) sizes, and the view centre on screen. */
  const geom = (): { frame: { w: number; h: number }; view: { w: number; h: number }; cx: number; cy: number } | null => {
    const stage = el.parentElement;
    if (!stage) return null;
    const r = stage.getBoundingClientRect();
    return { frame: { w: el.offsetWidth, h: el.offsetHeight }, view: { w: r.width, h: r.height }, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  };
  const rel = (p: Pt): Pt => {
    const m = geom();
    return m ? { x: p.x - m.cx, y: p.y - m.cy } : p;
  };

  const paint = (animate: boolean): void => {
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.style.transition = animate && !reduce ? 'transform 180ms cubic-bezier(0.2, 0, 0, 1)' : 'none';
    const x = t.x + drag.x;
    const y = t.y + drag.y;
    el.style.transform = x === 0 && y === 0 && t.s === 1 ? '' : `translate3d(${x}px, ${y}px, 0) scale(${t.s})`;
  };
  const schedule = (): void => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      paint(false);
    });
  };
  const flush = (animate: boolean): void => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    paint(animate);
  };

  const touchLike = (e: PointerEvent): boolean => e.pointerType === 'touch' || e.pointerType === 'pen';

  const onDown = (e: PointerEvent): void => {
    if (!touchLike(e)) return;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // A pointer that is already gone: the events keep coming to the frame anyway.
    }
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) {
      start = { x: e.clientX, y: e.clientY, t: e.timeStamp };
      last = { x: e.clientX, y: e.clientY };
      axis = null;
      moved = false;
    } else if (pts.size === 2) {
      const [a, b] = [...pts.values()] as [Pt, Pt];
      pinch = { d0: Math.max(1, distance(a, b)), s0: t.s, anchor: anchorAt(t, rel(midpoint(a, b))) };
      drag = { x: 0, y: 0 };
      moved = true;
      lastTap = null;
    }
  };

  const onMove = (e: PointerEvent): void => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const m = geom();
    if (!m) return;
    if (pts.size >= 2 && pinch) {
      const [a, b] = [...pts.values()] as [Pt, Pt];
      const sc = clampScale(pinch.s0 *(distance(a, b) / pinch.d0));
      // The pinched picture point stays under the fingers' midpoint (this pans with two fingers too).
      t = sc > 1 ? clampPan(placeAnchor(pinch.anchor, sc, rel(midpoint(a, b))), m.frame, m.view) : IDENTITY;
      schedule();
      return;
    }
    if (!start || !last) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (!moved && Math.hypot(dx, dy) > TAP_PX) moved = true;
    if (t.s > 1) {
      // Zoomed: the drag pans the picture inside the view.
      t = clampPan({ s: t.s, x: t.x + (e.clientX - last.x), y: t.y + (e.clientY - last.y) }, m.frame, m.view);
    } else {
      axis ??= lockAxis(dx, dy);
      if (axis === 'x') drag = { x: dx, y: 0 };
      else if (axis === 'y') drag = { x: 0, y: Math.max(0, dy) };
    }
    last = { x: e.clientX, y: e.clientY };
    if (moved) schedule();
  };

  const finish = (e: PointerEvent, cancelled: boolean): void => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    const m = geom();
    if (pinch) {
      if (pts.size < 2) pinch = null;
      if (pts.size === 1) {
        // The remaining finger carries on as a pan from where it is.
        const [p] = [...pts.values()] as [Pt];
        start = { ...p, t: e.timeStamp };
        last = p;
        axis = null;
      }
      if (t.s < 1.02) t = IDENTITY;
      if (pts.size === 0) flush(true);
      return;
    }
    if (pts.size > 0) return;
    const o = opts.current;
    const from = start;
    start = null;
    if (!from || !m) return;
    if (cancelled) {
      drag = { x: 0, y: 0 };
      flush(true);
      return;
    }
    if (t.s <= 1 && axis) {
      const act = swipeAction(axis, e.clientX - from.x, e.clientY - from.y, m.view.w, o.hasPrev, o.hasNext);
      drag = { x: 0, y: 0 };
      if (act === 'prev') o.onStep(-1);
      else if (act === 'next') o.onStep(1);
      else if (act === 'close') o.onClose();
      else flush(true);
      return;
    }
    if (!moved) {
      // A tap: the second one close to the first zooms (no timer: judged at the second tap).
      const now = { t: e.timeStamp, x: e.clientX, y: e.clientY };
      if (isDoubleTap(lastTap, now)) {
        lastTap = null;
        t = doubleTapTarget(t, rel(now), m.frame, m.view);
        flush(true);
      } else {
        lastTap = now;
      }
    } else {
      flush(true);
    }
  };
  const onUp = (e: PointerEvent): void => finish(e, false);
  const onCancel = (e: PointerEvent): void => finish(e, true);

  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onCancel);
  return () => {
    cancelAnimationFrame(raf);
    el.removeEventListener('pointerdown', onDown);
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp);
    el.removeEventListener('pointercancel', onCancel);
  };
}

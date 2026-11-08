/**
 * «Continue» handles (Miro-style): dots beside one selected sticky or shape; hovering a dot previews the next object on
 * that side, a click creates it — the same kind, size and colors, no text — wired from the source with an arrow and
 * opens its text. Pure geometry and the new objects' fields; the engine owns the state, input the pointer.
 */
import { rectInflate, type Point, type Rect } from '../../../lib/canvas/geometry';
import type { ConcreteSide } from '../../../lib/canvas/route';
import { DEFAULTS, type ObjectInit, type RouteKind, type ShapeKind, type ShapeRec, type StickyRec } from '../../../lib/canvas/types';

/** No dot on top: the rotation knob is there. */
export const QUICK_SIDES: readonly ConcreteSide[] = ['right', 'bottom', 'left'];
/** Distance of a dot from the selection frame, screen px. */
export const QUICK_OFFSET_PX = 22;
/** Hit radius of a dot, screen px. */
export const QUICK_HIT_PX = 10;
/** World gap between the source and the new object. */
export const QUICK_GAP = 80;
/** How long a hovered dot takes to grow into its button (the preview fades in with it). */
export const QUICK_ANIM_MS = 140;

/** The wire a handle makes is a curve whatever the connector setting: the dragged preview is an arc and the result keeps it. */
export const QUICK_ROUTE: RouteKind = 'curve';

export const OPPOSITE: Readonly<Record<ConcreteSide, ConcreteSide>> = { right: 'left', left: 'right', top: 'bottom', bottom: 'top' };

/** The dot of `side` for the frame `r` (`px` = world units per screen px). */
export function quickDot(r: Rect, side: ConcreteSide, px: number): Point {
  const d = QUICK_OFFSET_PX * px;
  switch (side) {
    case 'right': return { x: r.x + r.w + d, y: r.y + r.h / 2 };
    case 'left': return { x: r.x - d, y: r.y + r.h / 2 };
    case 'bottom': return { x: r.x + r.w / 2, y: r.y + r.h + d };
    case 'top': return { x: r.x + r.w / 2, y: r.y - d };
  }
}

/** The middle of a frame's side (the preview's wire ends). */
export function edgeMid(r: Rect, side: ConcreteSide): Point {
  return quickDot(r, side, 0);
}

/** The dot under `w`, if any. */
export function quickSideAt(r: Rect, w: Point, px: number): ConcreteSide | null {
  const hit = QUICK_HIT_PX * px;
  for (const s of QUICK_SIDES) {
    const d = quickDot(r, s, px);
    if (Math.hypot(w.x - d.x, w.y - d.y) <= hit) return s;
  }
  return null;
}

const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Where the new object goes: one gap beyond `side`, same size. If that spot is taken by another object (`taken`: the
 * boxes near it), it steps on across the side — down for right / left, right for bottom — like a list that grows.
 */
export function quickTarget(src: Rect, side: ConcreteSide, taken: readonly Rect[]): Rect {
  const horizontal = side === 'right' || side === 'left';
  let r: Rect = {
    x: side === 'right' ? src.x + src.w + QUICK_GAP : side === 'left' ? src.x - QUICK_GAP - src.w : src.x,
    y: side === 'bottom' ? src.y + src.h + QUICK_GAP : side === 'top' ? src.y - QUICK_GAP - src.h : src.y,
    w: src.w,
    h: src.h,
  };
  for (let i = 0; i < 12 && taken.some((t) => overlaps(rectInflate(r, 8), t)); i++) {
    r = horizontal ? { ...r, y: r.y + src.h + QUICK_GAP / 2 } : { ...r, x: r.x + src.w + QUICK_GAP / 2 };
  }
  return r;
}

/** The new object's fields: the source's kind, size and look, at `at`, empty. */
export function quickInit(src: StickyRec | ShapeRec, at: Rect): ObjectInit {
  const size = { ...(src.fontSize ? { fontSize: src.fontSize } : {}), ...(src.fontPx ? { fontPx: src.fontPx } : {}) };
  if (src.kind === 'sticky') return { kind: 'sticky', x: at.x, y: at.y, w: at.w, h: at.h, color: src.color, ...size };
  return {
    kind: 'shape', shape: src.shape, x: at.x, y: at.y, w: at.w, h: at.h,
    fill: src.soft ? `soft:${src.fill}` : src.fill, stroke: src.stroke, strokeWidth: src.strokeWidth, ...size,
  };
}

/** What the drop menu offers (view/QuickDropMenu): the source's copy, a text, a sticky (square or wide), a shape. */
export type QuickChoice =
  | { kind: 'same' }
  | { kind: 'text' }
  | { kind: 'sticky'; wide?: boolean }
  | { kind: 'shape'; shape: ShapeKind };

/** A wide sticky (the menu's second note): the default height, twice as long. */
export const WIDE_STICKY_W = 2 * DEFAULTS.stickySize;

/**
 * Where an object of size `w × h` goes when the line from `from` ends at `at`: its side facing the line's start sits
 * on the end (left side for a line going right, top side for a line going down…).
 */
export function dropRect(from: Point, at: Point, w: number, h: number): { rect: Rect; side: ConcreteSide } {
  const dx = at.x - from.x;
  const dy = at.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? { rect: { x: at.x, y: at.y - h / 2, w, h }, side: 'left' } : { rect: { x: at.x - w, y: at.y - h / 2, w, h }, side: 'right' };
  }
  return dy >= 0 ? { rect: { x: at.x - w / 2, y: at.y, w, h }, side: 'top' } : { rect: { x: at.x - w / 2, y: at.y - h, w, h }, side: 'bottom' };
}

/** The size a choice makes (the copy keeps the source's). */
export function choiceSize(c: QuickChoice, src: Rect): { w: number; h: number } {
  switch (c.kind) {
    case 'same': return { w: src.w, h: src.h };
    case 'text': return { w: DEFAULTS.textW, h: DEFAULTS.textSize * 1.5 };
    case 'sticky': return { w: c.wide ? WIDE_STICKY_W : DEFAULTS.stickySize, h: DEFAULTS.stickySize };
    case 'shape': return { w: DEFAULTS.shapeW, h: c.shape === 'ellipse' || c.shape === 'diamond' || c.shape === 'triangle' ? DEFAULTS.shapeW : DEFAULTS.shapeH };
  }
}

/** The new object's fields for a choice at `r`, with an optional first text. */
export function choiceInit(c: QuickChoice, src: StickyRec | ShapeRec, r: Rect, stickyColor: string, text: string): ObjectInit {
  const t = text ? { text } : {};
  switch (c.kind) {
    case 'same': return { ...quickInit(src, r), ...t };
    case 'text': return { kind: 'text', x: r.x, y: r.y + r.h / 2 - DEFAULTS.textSize, w: r.w, ...t };
    case 'sticky': return { kind: 'sticky', x: r.x, y: r.y, w: r.w, h: r.h, color: stickyColor, ...t };
    case 'shape': return { kind: 'shape', shape: c.shape, x: r.x, y: r.y, w: r.w, h: r.h, ...t };
  }
}

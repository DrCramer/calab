import type { Rect } from './geometry';
import { SHAPE_PAD, STICKY_PAD, TEXT_PAD } from './textLayout';
import type { BoxRec, ShapeKind } from './types';

/** The subset of path methods shared by CanvasRenderingContext2D, OffscreenCanvasRenderingContext2D and Path2D. */
export interface PathTarget {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arcTo(x1: number, y1: number, x2: number, y2: number, r: number): void;
  closePath(): void;
  ellipse(x: number, y: number, rx: number, ry: number, rot: number, a0: number, a1: number): void;
}

export const STICKY_RADIUS = 6;
/** Bubble: the body takes this share of the height, the tail the rest; the tip sits at this x. */
const BUBBLE_BODY = 0.8;
const BUBBLE_TIP_X = 0.12;

/** Outline of a polygonal shape as normalized [0..1] points of its frame (star, hexagon, parallelogram, arrow, …). */
type Poly = readonly (readonly [number, number])[];

function starPoly(): Poly {
  // Regular five-pointed star, apex up; stretched to fill the frame.
  const pts: [number, number][] = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const r = i % 2 === 0 ? 1 : 0.382;
    pts.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  const sx = Math.max(...xs) - x0;
  const sy = Math.max(...ys) - y0;
  return pts.map(([x, y]) => [(x - x0) / sx, (y - y0) / sy] as const);
}

const STAR = starPoly();
/** Bottom notch of the star (between the two lower tips) and the height of the side tips, normalized. */
const STAR_NOTCH_Y = STAR[5]?.[1] ?? 0.8;
const STAR_TIP_Y = STAR[2]?.[1] ?? 0.38;
const PAR_SKEW = 0.2;
const ARROW_NECK = 0.6;

const POLYS: Partial<Record<ShapeKind, Poly>> = {
  rect: [[0, 0], [1, 0], [1, 1], [0, 1]],
  diamond: [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]],
  triangle: [[0.5, 0], [1, 1], [0, 1]],
  star: STAR,
  hexagon: [[0.25, 0], [0.75, 0], [1, 0.5], [0.75, 1], [0.25, 1], [0, 0.5]],
  parallelogram: [[PAR_SKEW, 0], [1, 0], [1 - PAR_SKEW, 1], [0, 1]],
  arrow: [[0, 0.25], [ARROW_NECK, 0.25], [ARROW_NECK, 0], [1, 0.5], [ARROW_NECK, 1], [ARROW_NECK, 0.75], [0, 0.75]],
};

type Anchors = Record<'top' | 'right' | 'bottom' | 'left', readonly [number, number]>;
const BOX_ANCHORS: Anchors = { top: [0.5, 0], right: [1, 0.5], bottom: [0.5, 1], left: [0, 0.5] };

/** Where a connector touches each side, normalized: always a point of the outline. */
const ANCHORS: Partial<Record<ShapeKind, Anchors>> = {
  triangle: { top: [0.5, 0], right: [0.75, 0.5], bottom: [0.5, 1], left: [0.25, 0.5] },
  star: { top: [0.5, 0], right: [1, STAR_TIP_Y], bottom: [0.5, STAR_NOTCH_Y], left: [0, STAR_TIP_Y] },
  parallelogram: { top: [0.5 + PAR_SKEW / 2, 0], right: [1 - PAR_SKEW / 2, 0.5], bottom: [0.5 - PAR_SKEW / 2, 1], left: [PAR_SKEW / 2, 0.5] },
  arrow: { top: [ARROW_NECK / 2, 0.25], right: [1, 0.5], bottom: [ARROW_NECK / 2, 0.75], left: [0, 0.5] },
  bubble: { top: [0.5, 0], right: [1, BUBBLE_BODY / 2], bottom: [BUBBLE_TIP_X, 1], left: [0, BUBBLE_BODY / 2] },
};

/** Normalized anchor of a side of a shape (a frame's own side; the caller rotates it). Unknown kinds anchor like a rectangle. */
export function anchorFraction(shape: ShapeKind | undefined, side: 'top' | 'right' | 'bottom' | 'left'): readonly [number, number] {
  return (shape ? ANCHORS[shape] : undefined)?.[side] ?? BOX_ANCHORS[side];
}

/** Height of the elliptical cap of a cylinder (world units). */
export const cylinderCap = (w: number, h: number): number => Math.min(h * 0.2, w * 0.3);

/** Adds the outline of a shape to the current path (caller does beginPath/fill/stroke). Unknown kinds are drawn as rectangles. */
export function traceShape(p: PathTarget, kind: ShapeKind, r: Rect): void {
  const { x, y, w, h } = r;
  switch (kind) {
    case 'rounded':
      traceRounded(p, r, Math.min(16, w / 4, h / 4));
      return;
    case 'ellipse':
      p.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      return;
    case 'bubble': {
      const bh = h * BUBBLE_BODY;
      const k = Math.max(0, Math.min(12, w * 0.15, bh / 4));
      p.moveTo(x + k, y);
      p.arcTo(x + w, y, x + w, y + bh, k);
      p.arcTo(x + w, y + bh, x + w * 0.4, y + bh, k);
      p.lineTo(x + w * 0.4, y + bh);
      p.lineTo(x + w * BUBBLE_TIP_X, y + h);
      p.lineTo(x + w * 0.2, y + bh);
      p.arcTo(x, y + bh, x, y, k);
      p.arcTo(x, y, x + w, y, k);
      p.closePath();
      return;
    }
    case 'cylinder': {
      const ry = cylinderCap(w, h);
      const cx = x + w / 2;
      p.moveTo(x, y + ry);
      p.ellipse(cx, y + ry, w / 2, ry, 0, Math.PI, Math.PI * 2);
      p.lineTo(x + w, y + h - ry);
      p.ellipse(cx, y + h - ry, w / 2, ry, 0, 0, Math.PI);
      p.closePath();
      // The front rim of the top cap: strokes over the body.
      p.moveTo(x + w, y + ry);
      p.ellipse(cx, y + ry, w / 2, ry, 0, 0, Math.PI);
      return;
    }
    default: {
      const poly = POLYS[kind] ?? POLYS.rect;
      if (!poly) return;
      poly.forEach(([nx, ny], i) => {
        if (i === 0) p.moveTo(x + nx * w, y + ny * h);
        else p.lineTo(x + nx * w, y + ny * h);
      });
      p.closePath();
    }
  }
}

function inPoly(poly: Poly, nx: number, ny: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (!a || !b) continue;
    if (a[1] > ny !== b[1] > ny && nx < ((b[0] - a[0]) * (ny - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/** Is `p` inside the shape (kind-specific outline) occupying `r`? Unknown kinds count as rectangles. */
export function pointInShape(kind: ShapeKind, r: Rect, p: { x: number; y: number }): boolean {
  if (r.w <= 0 || r.h <= 0) return false;
  if (p.x < r.x || p.x > r.x + r.w || p.y < r.y || p.y > r.y + r.h) return false;
  const nx = (p.x - r.x) / r.w; // 0..1
  const ny = (p.y - r.y) / r.h;
  switch (kind) {
    case 'rect':
    case 'rounded':
      return true;
    case 'ellipse': {
      const dx = nx - 0.5;
      const dy = ny - 0.5;
      return dx * dx + dy * dy <= 0.25;
    }
    case 'bubble': {
      if (ny <= BUBBLE_BODY) return true;
      // The tail: a triangle from the body's bottom (x 0.2..0.4) down to the tip.
      const t = (ny - BUBBLE_BODY) / (1 - BUBBLE_BODY);
      const left = 0.2 + (BUBBLE_TIP_X - 0.2) * t;
      const right = 0.4 + (BUBBLE_TIP_X - 0.4) * t;
      return nx >= left && nx <= right;
    }
    case 'cylinder': {
      const cap = cylinderCap(r.w, r.h) / r.h;
      if (ny >= cap && ny <= 1 - cap) return true;
      const rx = 0.5;
      const cy = ny < 0.5 ? cap : 1 - cap;
      const dx = (nx - 0.5) / rx;
      const dy = (ny - cy) / cap;
      return dx * dx + dy * dy <= 1;
    }
    default: {
      const poly = POLYS[kind];
      return poly ? inPoly(poly, nx, ny) : true;
    }
  }
}

export function traceRounded(p: PathTarget, r: Rect, radius: number): void {
  const { x, y, w, h } = r;
  const k = Math.max(0, Math.min(radius, w / 2, h / 2));
  p.moveTo(x + k, y);
  p.arcTo(x + w, y, x + w, y + h, k);
  p.arcTo(x + w, y + h, x, y + h, k);
  p.arcTo(x, y + h, x, y, k);
  p.arcTo(x, y, x + w, y, k);
  p.closePath();
}

/** Where an object's text lives (inside the outline, clear of the corners that the shape cuts away). */
export function contentRect(o: BoxRec): Rect {
  const inset = (r: Rect, d: number): Rect => ({ x: r.x + d, y: r.y + d, w: Math.max(1, r.w - 2 * d), h: Math.max(1, r.h - 2 * d) });
  if (o.kind === 'sticky') return inset(o, STICKY_PAD);
  if (o.kind === 'text') return inset(o, TEXT_PAD);
  switch (o.shape) {
    case 'ellipse': {
      const dx = o.w * 0.146;
      const dy = o.h * 0.146;
      return inset({ x: o.x + dx, y: o.y + dy, w: o.w - 2 * dx, h: o.h - 2 * dy }, SHAPE_PAD / 2);
    }
    case 'diamond':
      return inset({ x: o.x + o.w * 0.25, y: o.y + o.h * 0.25, w: o.w * 0.5, h: o.h * 0.5 }, SHAPE_PAD / 2);
    case 'triangle':
      return inset({ x: o.x + o.w * 0.25, y: o.y + o.h * 0.45, w: o.w * 0.5, h: o.h * 0.5 }, SHAPE_PAD / 2);
    case 'star':
      return inset({ x: o.x + o.w * 0.28, y: o.y + o.h * 0.34, w: o.w * 0.44, h: o.h * 0.4 }, SHAPE_PAD / 2);
    case 'hexagon':
      return inset({ x: o.x + o.w * 0.18, y: o.y + o.h * 0.18, w: o.w * 0.64, h: o.h * 0.64 }, SHAPE_PAD);
    case 'parallelogram':
      return inset({ x: o.x + o.w * 0.2, y: o.y, w: o.w * 0.6, h: o.h }, SHAPE_PAD);
    case 'arrow':
      return inset({ x: o.x, y: o.y + o.h * 0.25, w: o.w * ARROW_NECK, h: o.h * 0.5 }, SHAPE_PAD / 2);
    case 'bubble':
      return inset({ x: o.x, y: o.y, w: o.w, h: o.h * BUBBLE_BODY }, SHAPE_PAD);
    case 'cylinder': {
      const cap = cylinderCap(o.w, o.h);
      return inset({ x: o.x, y: o.y + cap * 1.6, w: o.w, h: Math.max(1, o.h - cap * 2.6) }, SHAPE_PAD / 2);
    }
    default:
      return inset(o, SHAPE_PAD);
  }
}

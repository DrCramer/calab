/** Plain geometry for the canvas engine (ADR-0113 §4). World units, y grows downwards. No DOM. */

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export const HANDLE_IDS: readonly HandleId[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export const rect = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });

export const rectFromPoints = (a: Point, b: Point): Rect => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  w: Math.abs(a.x - b.x),
  h: Math.abs(a.y - b.y),
});

export const rectRight = (r: Rect): number => r.x + r.w;
export const rectBottom = (r: Rect): number => r.y + r.h;
export const rectCenter = (r: Rect): Point => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

export function rectContains(outer: Rect, inner: Rect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
}

export function rectContainsPoint(r: Rect, p: Point, pad = 0): boolean {
  return p.x >= r.x - pad && p.x <= r.x + r.w + pad && p.y >= r.y - pad && p.y <= r.y + r.h + pad;
}

export function rectUnion(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

export function rectInflate(r: Rect, d: number): Rect {
  return { x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d };
}

/** Bounding box of several rects; null for none. */
export function boundsOf(rects: Iterable<Rect>): Rect | null {
  let out: Rect | null = null;
  for (const r of rects) out = out ? rectUnion(out, r) : { x: r.x, y: r.y, w: r.w, h: r.h };
  return out;
}

/** Bounding box of a flat [x0, y0, x1, y1, …] polyline. */
export function pointsBounds(pts: readonly number[]): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const x = pts[i] ?? 0;
    const y = pts[i + 1] ?? 0;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  if (x0 === Infinity) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Distance from p to the segment ab. */
export function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return dist(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Distance from p to a flat polyline. */
export function distToPolyline(p: Point, pts: readonly number[]): number {
  let best = Infinity;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const d = distToSegment(p, { x: pts[i] ?? 0, y: pts[i + 1] ?? 0 }, { x: pts[i + 2] ?? 0, y: pts[i + 3] ?? 0 });
    if (d < best) best = d;
  }
  return best;
}

/** Length of a flat polyline and the point at its half. */
export function polylineMidpoint(pts: readonly number[]): Point {
  let total = 0;
  for (let i = 0; i + 3 < pts.length; i += 2) total += Math.hypot((pts[i + 2] ?? 0) - (pts[i] ?? 0), (pts[i + 3] ?? 0) - (pts[i + 1] ?? 0));
  let left = total / 2;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const ax = pts[i] ?? 0;
    const ay = pts[i + 1] ?? 0;
    const bx = pts[i + 2] ?? 0;
    const by = pts[i + 3] ?? 0;
    const seg = Math.hypot(bx - ax, by - ay);
    if (seg >= left && seg > 0) {
      const t = left / seg;
      return { x: ax + (bx - ax) * t, y: ay + (by - ay) * t };
    }
    left -= seg;
  }
  return { x: pts[0] ?? 0, y: pts[1] ?? 0 };
}

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export const snapTo = (v: number, step: number): number => Math.round(v / step) * step;

/** Point of a handle on a rect. */
export function handlePoint(r: Rect, h: HandleId): Point {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  switch (h) {
    case 'nw': return { x: r.x, y: r.y };
    case 'n': return { x: cx, y: r.y };
    case 'ne': return { x: r.x + r.w, y: r.y };
    case 'e': return { x: r.x + r.w, y: cy };
    case 'se': return { x: r.x + r.w, y: r.y + r.h };
    case 's': return { x: cx, y: r.y + r.h };
    case 'sw': return { x: r.x, y: r.y + r.h };
    case 'w': return { x: r.x, y: cy };
  }
}

/** The handle opposite to `h` (the fixed point of a resize). */
export function oppositeHandle(h: HandleId): HandleId {
  const m: Record<HandleId, HandleId> = { nw: 'se', n: 's', ne: 'sw', e: 'w', se: 'nw', s: 'n', sw: 'ne', w: 'e' };
  return m[h];
}

export interface ResizeOptions {
  /** Keep the aspect ratio (corner handles only; edge handles ignore it). */
  keepAspect?: boolean;
  minW?: number;
  minH?: number;
  /** Resize around the center instead of the opposite handle. */
  fromCenter?: boolean;
}

/**
 * New rect after dragging `handle` of `start` to the world point `p`. The opposite side/corner stays put;
 * the rect never flips (it stops at the minimum size).
 */
export function resizeRect(start: Rect, handle: HandleId, p: Point, o: ResizeOptions = {}): Rect {
  const minW = o.minW ?? 1;
  const minH = o.minH ?? 1;
  const movesW = handle.includes('w');
  const movesE = handle.includes('e');
  const movesN = handle.includes('n');
  const movesS = handle.includes('s');
  let left = start.x;
  let right = start.x + start.w;
  let top = start.y;
  let bottom = start.y + start.h;
  if (o.fromCenter) {
    const c = rectCenter(start);
    if (movesW) {
      left = Math.min(p.x, c.x - minW / 2);
      right = 2 * c.x - left;
    }
    if (movesE) {
      right = Math.max(p.x, c.x + minW / 2);
      left = 2 * c.x - right;
    }
    if (movesN) {
      top = Math.min(p.y, c.y - minH / 2);
      bottom = 2 * c.y - top;
    }
    if (movesS) {
      bottom = Math.max(p.y, c.y + minH / 2);
      top = 2 * c.y - bottom;
    }
  } else {
    if (movesW) left = Math.min(p.x, right - minW);
    if (movesE) right = Math.max(p.x, left + minW);
    if (movesN) top = Math.min(p.y, bottom - minH);
    if (movesS) bottom = Math.max(p.y, top + minH);
  }
  let w = right - left;
  let h = bottom - top;
  const corner = (movesW || movesE) && (movesN || movesS);
  if (o.keepAspect && corner && start.w > 0 && start.h > 0) {
    const ratio = start.w / start.h;
    // The dominant axis (the one moved more, relative to the start size) drives the other.
    const sx = w / start.w;
    const sy = h / start.h;
    if (sx >= sy) h = Math.max(minH, w / ratio);
    else w = Math.max(minW, h * ratio);
    if (o.fromCenter) {
      const c = rectCenter(start);
      return { x: c.x - w / 2, y: c.y - h / 2, w, h };
    }
    const x = movesW ? start.x + start.w - w : start.x;
    const y = movesN ? start.y + start.h - h : start.y;
    return { x, y, w, h };
  }
  return { x: left, y: top, w, h };
}

/** Hit-test of the handles at a point, with a world-space radius. Handles sit on the rect's outline. */
export function hitHandle(r: Rect, p: Point, radius: number): HandleId | null {
  let best: HandleId | null = null;
  let bestD = radius;
  for (const h of HANDLE_IDS) {
    const d = dist(p, handlePoint(r, h));
    if (d <= bestD) {
      best = h;
      bestD = d;
    }
  }
  return best;
}

/** Maps a rect through a resize of the group box `from` → `to` (used for multi-selection resize). */
export function mapRect(r: Rect, from: Rect, to: Rect): Rect {
  const sx = from.w > 0 ? to.w / from.w : 1;
  const sy = from.h > 0 ? to.h / from.h : 1;
  return { x: to.x + (r.x - from.x) * sx, y: to.y + (r.y - from.y) * sy, w: r.w * sx, h: r.h * sy };
}

/** Is `p` inside the shape (kind-specific outline) occupying `r`? */
export function pointInShape(kind: 'rect' | 'ellipse' | 'diamond' | 'triangle' | 'rounded', r: Rect, p: Point): boolean {
  if (!rectContainsPoint(r, p)) return false;
  if (r.w <= 0 || r.h <= 0) return false;
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
    case 'diamond':
      return Math.abs(nx - 0.5) + Math.abs(ny - 0.5) <= 0.5;
    case 'triangle':
      // Apex at the top middle; the half-width grows linearly with y.
      return Math.abs(nx - 0.5) <= ny / 2;
  }
}

// ── rotation (ADR-0114 §Волна 1) ───────────────────────────────────────────────
// A rotated object keeps its unrotated frame (x, y, w, h) and an angle `rot` in degrees, clockwise (y grows
// downwards), about the frame's center. Everything object-local (hit-testing, handles, resize) works in the
// local frame: the point is rotated back about the center.

export const DEG = Math.PI / 180;

/** Angle step of Shift+rotate. */
export const ROT_STEP = 15;

/** Degrees folded into [0, 360), rounded to 0.01° (what is stored: no float dust, 360 → 0). */
export function normRot(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  const r = Math.round((((deg % 360) + 360) % 360) * 100) / 100;
  return r >= 360 ? 0 : r;
}

/** `p` rotated by `deg` clockwise about `c`. */
export function rotatePoint(p: Point, c: Point, deg: number): Point {
  if (deg === 0) return p;
  const a = deg * DEG;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
}

/** A world point in the local (unrotated) frame of `r` rotated by `rot`. */
export const toLocal = (r: Rect, rot: number, p: Point): Point => (rot === 0 ? p : rotatePoint(p, rectCenter(r), -rot));

/** A point of the local frame in the world. */
export const fromLocal = (r: Rect, rot: number, p: Point): Point => (rot === 0 ? p : rotatePoint(p, rectCenter(r), rot));

/** The four corners (nw, ne, se, sw) of `r` rotated by `rot`. */
export function rotatedCorners(r: Rect, rot: number): [Point, Point, Point, Point] {
  const c = rectCenter(r);
  return [
    rotatePoint({ x: r.x, y: r.y }, c, rot),
    rotatePoint({ x: r.x + r.w, y: r.y }, c, rot),
    rotatePoint({ x: r.x + r.w, y: r.y + r.h }, c, rot),
    rotatePoint({ x: r.x, y: r.y + r.h }, c, rot),
  ];
}

/** The circumscribed axis-aligned rect of `r` rotated by `rot` (the grid, culling, snapping, export and align use it). */
export function rotatedBounds(r: Rect, rot: number): Rect {
  if (rot === 0) return r;
  const c = rectCenter(r);
  const a = rot * DEG;
  // A quarter turn has cos = 6e-17, not 0: that dust would round a 40-unit side up to 41 pixels in an export.
  const trim = (v: number): number => (Math.abs(v) < 1e-12 ? 0 : Math.abs(v));
  const cos = trim(Math.cos(a));
  const sin = trim(Math.sin(a));
  const w = r.w * cos + r.h * sin;
  const h = r.w * sin + r.h * cos;
  return { x: c.x - w / 2, y: c.y - h / 2, w, h };
}

/** Does the rotated rect touch the axis-aligned `q` (separating axis test)? */
export function rotatedRectHitsRect(r: Rect, rot: number, q: Rect): boolean {
  if (rot === 0) return rectsIntersect(r, q);
  if (!rectsIntersect(rotatedBounds(r, rot), q)) return false;
  // The axes of q are the world axes (already covered by the bounds); the remaining ones are r's own.
  const a = rot * DEG;
  const axes: Point[] = [{ x: Math.cos(a), y: Math.sin(a) }, { x: -Math.sin(a), y: Math.cos(a) }];
  const rc = rotatedCorners(r, rot);
  const qc: Point[] = [{ x: q.x, y: q.y }, { x: q.x + q.w, y: q.y }, { x: q.x + q.w, y: q.y + q.h }, { x: q.x, y: q.y + q.h }];
  for (const ax of axes) {
    let r0 = Infinity;
    let r1 = -Infinity;
    for (const p of rc) {
      const d = p.x * ax.x + p.y * ax.y;
      if (d < r0) r0 = d;
      if (d > r1) r1 = d;
    }
    let q0 = Infinity;
    let q1 = -Infinity;
    for (const p of qc) {
      const d = p.x * ax.x + p.y * ax.y;
      if (d < q0) q0 = d;
      if (d > q1) q1 = d;
    }
    if (r1 < q0 || q1 < r0) return false;
  }
  return true;
}

/** Hit-test of the 8 handles of a rotated frame at a world point. */
export const hitHandleRot = (r: Rect, rot: number, p: Point, radius: number): HandleId | null => hitHandle(r, toLocal(r, rot, p), radius);

/** World position of a handle of a rotated frame. */
export const handlePointRot = (r: Rect, rot: number, h: HandleId): Point => fromLocal(r, rot, handlePoint(r, h));

/** The rotation handle sits `offset` world units above the middle of the top side (in the local frame). */
export const rotateHandlePoint = (r: Rect, rot: number, offset: number): Point => fromLocal(r, rot, { x: r.x + r.w / 2, y: r.y - offset });

/** The angle (degrees, [0, 360)) that points the object's top at the world point `p`, seen from `c`. */
export const angleToward = (c: Point, p: Point): number => normRot(Math.atan2(p.y - c.y, p.x - c.x) / DEG + 90);

/** Rounds `deg` to the nearest `step`. */
export const snapAngle = (deg: number, step = ROT_STEP): number => Math.round(deg / step) * step;

/**
 * Resize of a rotated frame by one handle, along its own axes: `p` (world) is taken into the local frame, the
 * rect resized there, and the result placed back so the opposite side/corner (or the center, with
 * `fromCenter`) stays where it was in the world. Returns the new unrotated frame (its rotation is unchanged).
 */
export function resizeRotated(start: Rect, rot: number, handle: HandleId, p: Point, o: ResizeOptions = {}): Rect {
  if (rot === 0) return resizeRect(start, handle, p, o);
  const c0 = rectCenter(start);
  const next = resizeRect(start, handle, rotatePoint(p, c0, -rot), o);
  const c1 = rotatePoint(rectCenter(next), c0, rot);
  return { x: c1.x - next.w / 2, y: c1.y - next.h / 2, w: next.w, h: next.h };
}

/** Resize cursor for a handle of a frame rotated by `rot`: the handle's direction turns with it. */
export function resizeCursorAt(h: HandleId, rot: number): string {
  const base: Record<HandleId, number> = { e: 0, se: 45, s: 90, sw: 135, w: 180, nw: 225, n: 270, ne: 315 };
  const a = Math.round(((((base[h] + rot) % 180) + 180) % 180) / 45) % 4;
  return ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][a] ?? 'default';
}

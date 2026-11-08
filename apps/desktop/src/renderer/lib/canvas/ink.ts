/**
 * Freehand strokes (ADR-0127 addendum 2026-10-29 «Рисование от руки и ластик»): simplification of a captured
 * stroke into the stored point list, the frame scaling of a stored stroke, its hit test and its path. Pure, no DOM.
 */
import { distToSegment, pointsBounds, type Point, type Rect } from './geometry';

/** Points a stored stroke keeps at most (after simplification; a longer one is simplified harder). */
export const INK_MAX_POINTS = 2000;
/** Points a stroke in progress collects at most; the rest of a very long drag is not recorded. */
export const INK_RAW_MAX = 20_000;
/** Tolerance of the simplification, screen px (the gesture turns it into world units at the current zoom). */
export const INK_EPS_PX = 0.75;
/** Stored stroke width range, world units. */
export const INK_MIN_WIDTH = 1;
export const INK_MAX_WIDTH = 64;
/** How opaque a marker stroke is drawn (the color stays a plain hue in the doc). */
export const MARKER_ALPHA = 0.4;

/** Pen and marker widths the tool offers (world units). */
export const PEN_WIDTHS: readonly number[] = [2, 4, 8];
export const MARKER_WIDTHS: readonly number[] = [12, 20, 32];
/** Eraser radii the tool offers, screen px (its cursor is a ring of that size). */
export const ERASER_SIZES: readonly number[] = [6, 12, 24];
/** Swaths one stroke keeps at most (`erase`: 5 numbers each); a drag past it stops cutting that stroke. */
export const INK_MAX_ERASE = 1500;

// `+ 0` folds a rounded -0 into 0.
const round2 = (v: number): number => Math.round(v * 2) / 2 + 0;

/**
 * Ramer–Douglas–Peucker on a flat [x0, y0, x1, y1, …] list: the points that keep the line within `eps` of the
 * original. Iterative (a long stroke would overflow a recursive one); the first and last points always stay.
 */
export function simplify(pts: readonly number[], eps: number): number[] {
  const n = Math.floor(pts.length / 2);
  if (n <= 2) return pts.slice(0, n * 2);
  return kept(pts, rdpKeep(pts, n, eps));
}

const kept = (pts: readonly number[], keep: Uint8Array): number[] => {
  const out: number[] = [];
  for (let i = 0; i < keep.length; i++) if (keep[i]) out.push(pts[2 * i] ?? 0, pts[2 * i + 1] ?? 0);
  return out;
};

/** The RDP mask of the `n > 2` points: 1 for a kept point. */
function rdpKeep(pts: readonly number[], n: number, eps: number): Uint8Array {
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: number[] = [0, n - 1];
  while (stack.length > 0) {
    const b = stack.pop() ?? 0;
    const a = stack.pop() ?? 0;
    const ax = pts[2 * a] ?? 0;
    const ay = pts[2 * a + 1] ?? 0;
    const dx = (pts[2 * b] ?? 0) - ax;
    const dy = (pts[2 * b + 1] ?? 0) - ay;
    const len2 = dx * dx + dy * dy;
    let best = -1;
    // Squared distances, no allocations: this loop is the whole cost of a release.
    let bestD = eps * eps;
    // Of equally far points the one nearest the middle: an even zigzag then splits in halves (n log n), not one by one (n²).
    const mid = (a + b) / 2;
    for (let i = a + 1; i < b; i++) {
      const px = (pts[2 * i] ?? 0) - ax;
      const py = (pts[2 * i + 1] ?? 0) - ay;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
      const ex = px - t * dx;
      const ey = py - t * dy;
      const d = ex * ex + ey * ey;
      if (d > bestD || (d === bestD && best >= 0 && Math.abs(i - mid) < Math.abs(best - mid))) {
        bestD = d;
        best = i;
      }
    }
    if (best < 0) continue;
    keep[best] = 1;
    stack.push(a, best, best, b);
  }
  return keep;
}

/** Samples per spline piece when checking it against the raw points. */
const FIT_STEPS = 12;
/** Refinement passes at most (each adds the worst raw point of every piece still off). */
const FIT_PASSES = 8;

/**
 * Simplifies a stroke for drawing with `traceInk`: RDP keeps the polyline within `eps`, but the spline through far
 * apart kept points bows away from a straight run (the zigzag of a marker scribble: up to several px, visible as the
 * line changing on release). So every piece of the spline is checked against the raw points it replaces, and the
 * worst one goes back in while it is further than `eps`.
 */
export function simplifyStroke(pts: readonly number[], eps: number): number[] {
  const n = Math.floor(pts.length / 2);
  if (n <= 2) return pts.slice(0, n * 2);
  const keep = rdpKeep(pts, n, eps);
  const e2 = eps * eps;
  const xs = (i: number): number => pts[2 * i] ?? 0;
  const ys = (i: number): number => pts[2 * i + 1] ?? 0;
  const curve: number[] = [];
  for (let pass = 0; pass < FIT_PASSES; pass++) {
    const idx: number[] = [];
    for (let i = 0; i < n; i++) if (keep[i]) idx.push(i);
    let added = false;
    for (let j = 0; j + 1 < idx.length; j++) {
      const a = idx[j] ?? 0;
      const b = idx[j + 1] ?? 0;
      if (b - a < 2) continue;
      const p = idx[Math.max(0, j - 1)] ?? 0;
      const q = idx[Math.min(idx.length - 1, j + 2)] ?? 0;
      const [c1x, c1y, c2x, c2y] = splineControls(xs(p), ys(p), xs(a), ys(a), xs(b), ys(b), xs(q), ys(q));
      curve.length = 0;
      for (let k = 0; k <= FIT_STEPS; k++) {
        const t = k / FIT_STEPS;
        const u = 1 - t;
        curve.push(
          u * u * u * xs(a) + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * xs(b),
          u * u * u * ys(a) + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * ys(b),
        );
      }
      let worst = -1;
      let worstD = e2;
      for (let i = a + 1; i < b; i++) {
        const d = distToPolyline2(xs(i), ys(i), curve);
        if (d > worstD) {
          worstD = d;
          worst = i;
        }
      }
      if (worst >= 0) {
        keep[worst] = 1;
        added = true;
      }
    }
    if (!added) break;
  }
  return kept(pts, keep);
}

/** Squared distance from (x, y) to a flat polyline. */
function distToPolyline2(x: number, y: number, line: readonly number[]): number {
  let best = Infinity;
  for (let i = 0; i + 3 < line.length; i += 2) {
    const ax = line[i] ?? 0;
    const ay = line[i + 1] ?? 0;
    const dx = (line[i + 2] ?? 0) - ax;
    const dy = (line[i + 3] ?? 0) - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
    const ex = x - ax - t * dx;
    const ey = y - ay - t * dy;
    const d = ex * ex + ey * ey;
    if (d < best) best = d;
  }
  return best;
}

/** A captured stroke as it is stored: its frame and its points relative to the frame's corner. */
export interface InkShape {
  x: number;
  y: number;
  w: number;
  h: number;
  points: number[];
}

/**
 * Turns the world points of a finished stroke into the stored form: simplified within `eps` (harder until it fits
 * INK_MAX_POINTS), moved to the frame's corner, rounded to 0.5, repeated points dropped. A click without a drag is a
 * dot: one point, stored twice so it is still a segment. Null for no points.
 */
export function inkFromStroke(world: readonly number[], eps: number): InkShape | null {
  if (world.length < 2) return null;
  let e = Math.max(eps, 0.01);
  let pts = simplifyStroke(world, e);
  while (pts.length / 2 > INK_MAX_POINTS) {
    e *= 2;
    pts = simplifyStroke(world, e);
  }
  const b = pointsBounds(pts);
  const x = round2(b.x);
  const y = round2(b.y);
  const out: number[] = [];
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const px = round2((pts[i] ?? 0) - x);
    const py = round2((pts[i + 1] ?? 0) - y);
    if (out.length >= 2 && out[out.length - 2] === px && out[out.length - 1] === py) continue;
    out.push(px, py);
  }
  if (out.length === 2) out.push(out[0] ?? 0, out[1] ?? 0);
  const nb = pointsBounds(out);
  return { x, y, w: Math.max(1, nb.x + nb.w), h: Math.max(1, nb.y + nb.h), points: out };
}

/** Stored points as the doc may hold them: an even list of 2…2·INK_MAX_POINTS finite numbers, else null. */
export function inkPoints(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length < 2 || v.length % 2 !== 0 || v.length > 2 * INK_MAX_POINTS) return null;
  for (const n of v) if (typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > 1e7) return null;
  return v as number[];
}

/** How stored points map into a `w × h` frame: shift by `-b`, scale, center an axis the points do not span. */
interface InkFit {
  bx: number;
  by: number;
  sx: number;
  sy: number;
  ox: number;
  oy: number;
}

function inkFit(raw: readonly number[], w: number, h: number): InkFit {
  const b = pointsBounds(raw);
  return {
    bx: b.x, by: b.y,
    sx: b.w >= 1 ? w / b.w : 1, sy: b.h >= 1 ? h / b.h : 1,
    ox: b.w >= 1 ? 0 : (w - b.w) / 2, oy: b.h >= 1 ? 0 : (h - b.h) / 2,
  };
}

const scaled = new WeakMap<readonly number[], { w: number; h: number; pts: readonly number[] }>();

/**
 * The stored points fitted to the frame `w × h` (a resized stroke stretches with it; an axis the points do not span —
 * a straight line — stays centered). Cached per stored array and size, so a record rebuilt by a move keeps the same
 * array.
 */
export function fitInk(raw: readonly number[], w: number, h: number): readonly number[] {
  const hit = scaled.get(raw);
  if (hit && hit.w === w && hit.h === h) return hit.pts;
  const f = inkFit(raw, w, h);
  let pts: readonly number[];
  if (f.sx === 1 && f.sy === 1 && f.ox === 0 && f.oy === 0 && f.bx === 0 && f.by === 0) pts = raw;
  else {
    const out = new Array<number>(raw.length);
    for (let i = 0; i + 1 < raw.length; i += 2) {
      out[i] = ((raw[i] ?? 0) - f.bx) * f.sx + f.ox;
      out[i + 1] = ((raw[i + 1] ?? 0) - f.by) * f.sy + f.oy;
    }
    pts = out;
  }
  scaled.set(raw, { w, h, pts });
  return pts;
}

const scaledErase = new WeakMap<readonly number[], { w: number; h: number; raw: readonly number[]; out: readonly number[] }>();

/**
 * The eraser's swaths fitted like the points they cut (same shift and scale; a stretched stroke stretches its holes,
 * the radius by the mean scale). Cached per stored array and size.
 */
export function fitErase(raw: readonly number[], erase: readonly number[], w: number, h: number): readonly number[] {
  const hit = scaledErase.get(erase);
  if (hit && hit.w === w && hit.h === h && hit.raw === raw) return hit.out;
  const f = inkFit(raw, w, h);
  let out: readonly number[];
  if (f.sx === 1 && f.sy === 1 && f.ox === 0 && f.oy === 0 && f.bx === 0 && f.by === 0) out = erase;
  else {
    const k = Math.sqrt(f.sx * f.sy);
    const o = new Array<number>(erase.length);
    for (let i = 0; i + 4 < erase.length; i += 5) {
      o[i] = ((erase[i] ?? 0) - f.bx) * f.sx + f.ox;
      o[i + 1] = ((erase[i + 1] ?? 0) - f.by) * f.sy + f.oy;
      o[i + 2] = ((erase[i + 2] ?? 0) - f.bx) * f.sx + f.ox;
      o[i + 3] = ((erase[i + 3] ?? 0) - f.by) * f.sy + f.oy;
      o[i + 4] = (erase[i + 4] ?? 0) * k;
    }
    out = o;
  }
  scaledErase.set(erase, { w, h, raw, out });
  return out;
}

/** Stored swaths as the doc may hold them: [x0, y0, x1, y1, r] × 1…INK_MAX_ERASE, finite, r > 0; else null. */
export function inkErase(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length < 5 || v.length % 5 !== 0 || v.length > 5 * INK_MAX_ERASE) return null;
  for (let i = 0; i < v.length; i++) {
    const n: unknown = v[i];
    if (typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > 1e7) return null;
    if (i % 5 === 4 && n <= 0) return null;
  }
  return v as number[];
}

/** Whether `p` (relative to the stroke's corner) lies under one of the swaths: erased there. */
export function inSwath(p: Point, erase: readonly number[] | undefined): boolean {
  if (!erase) return false;
  for (let i = 0; i + 4 < erase.length; i += 5) {
    const r = erase[i + 4] ?? 0;
    if (distToSegment(p, { x: erase[i] ?? 0, y: erase[i + 1] ?? 0 }, { x: erase[i + 2] ?? 0, y: erase[i + 3] ?? 0 }) <= r) return true;
  }
  return false;
}

/**
 * Whether the swaths cover the whole visible stroke (then the eraser deletes it instead of keeping an invisible
 * object): the center line is walked every quarter width and each sample's disc — its center and four points on
 * its rim — must be under a swath.
 */
export function swathsCover(pts: readonly number[], width: number, erase: readonly number[]): boolean {
  const h = width / 2;
  const step = Math.max(width / 4, 0.5);
  const covered = (x: number, y: number): boolean =>
    inSwath({ x, y }, erase) && inSwath({ x: x + h, y }, erase) && inSwath({ x: x - h, y }, erase) && inSwath({ x, y: y + h }, erase) && inSwath({ x, y: y - h }, erase);
  if (pts.length < 4) return covered(pts[0] ?? 0, pts[1] ?? 0);
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const ax = pts[i] ?? 0;
    const ay = pts[i + 1] ?? 0;
    const dx = (pts[i + 2] ?? 0) - ax;
    const dy = (pts[i + 3] ?? 0) - ay;
    const n = Math.max(1, Math.ceil(Math.hypot(dx, dy) / step));
    for (let k = i === 0 ? 0 : 1; k <= n; k++) if (!covered(ax + (dx * k) / n, ay + (dy * k) / n)) return false;
  }
  return true;
}

/** Distance from `p` (relative to the stroke's corner) to the stroke's center line. */
export function inkDistance(p: Point, pts: readonly number[]): number {
  if (pts.length < 4) return Math.hypot(p.x - (pts[0] ?? 0), p.y - (pts[1] ?? 0));
  let best = Infinity;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const d = distToSegment(p, { x: pts[i] ?? 0, y: pts[i + 1] ?? 0 }, { x: pts[i + 2] ?? 0, y: pts[i + 3] ?? 0 });
    if (d < best) best = d;
  }
  return best;
}

/** Whether all points coincide (a dot): drawn as a filled circle, a zero-length line having no caps in every engine. */
export function isDot(pts: readonly number[]): boolean {
  const x = pts[0] ?? 0;
  const y = pts[1] ?? 0;
  for (let i = 2; i + 1 < pts.length; i += 2) if (pts[i] !== x || pts[i + 1] !== y) return false;
  return true;
}

interface PathSink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void;
}

/**
 * Traces the smoothed stroke at offset `ox, oy`: a centripetal Catmull–Rom spline as cubic pieces, through every
 * point. Passing through the points matters: the stored stroke keeps only the simplified ones, and a curve that cut
 * its corners (through the midpoints) visibly shrank the line on release. Centripetal (α = 0.5) does not overshoot
 * where a long straight run meets a short one. The live preview and the stored stroke use the same path.
 */
export function traceInk(ctx: PathSink, pts: readonly number[], ox: number, oy: number): void {
  const n = Math.floor(pts.length / 2);
  if (n === 0) return;
  const x = (i: number): number => pts[2 * Math.max(0, Math.min(n - 1, i))] ?? 0;
  const y = (i: number): number => pts[2 * Math.max(0, Math.min(n - 1, i)) + 1] ?? 0;
  ctx.moveTo(ox + x(0), oy + y(0));
  if (n === 2) {
    ctx.lineTo(ox + x(1), oy + y(1));
    return;
  }
  for (let i = 0; i < n - 1; i++) {
    if (x(i) === x(i + 1) && y(i) === y(i + 1)) continue;
    const [c1x, c1y, c2x, c2y] = splineControls(x(i - 1), y(i - 1), x(i), y(i), x(i + 1), y(i + 1), x(i + 2), y(i + 2));
    ctx.bezierCurveTo(ox + c1x, oy + c1y, ox + c2x, oy + c2y, ox + x(i + 1), oy + y(i + 1));
  }
}

/**
 * The Bézier controls of the centripetal Catmull–Rom piece P1 → P2 (neighbours P0, P3; Yuksel et al.). A neighbour
 * equal to its end (the stroke's first and last piece) leaves that control on the end.
 */
export function splineControls(
  x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number,
): [number, number, number, number] {
  // |Pi+1 − Pi|^α with α = 0.5.
  const d1 = Math.sqrt(Math.hypot(x1 - x0, y1 - y0));
  const d2 = Math.sqrt(Math.hypot(x2 - x1, y2 - y1));
  const d3 = Math.sqrt(Math.hypot(x3 - x2, y3 - y2));
  let c1x = x1;
  let c1y = y1;
  if (d1 > 0) {
    const k = 3 * d1 * (d1 + d2);
    const a = 2 * d1 * d1 + 3 * d1 * d2 + d2 * d2;
    c1x = (d1 * d1 * x2 - d2 * d2 * x0 + a * x1) / k;
    c1y = (d1 * d1 * y2 - d2 * d2 * y0 + a * y1) / k;
  }
  let c2x = x2;
  let c2y = y2;
  if (d3 > 0) {
    const k = 3 * d3 * (d3 + d2);
    const a = 2 * d3 * d3 + 3 * d3 * d2 + d2 * d2;
    c2x = (d3 * d3 * x1 - d2 * d2 * x3 + a * x2) / k;
    c2y = (d3 * d3 * y1 - d2 * d2 * y3 + a * y2) / k;
  }
  return [c1x, c1y, c2x, c2y];
}

/** World rect a stroke's last few points (what one more point repaints) cover, padded by `pad`. */
export function tailRect(pts: readonly number[], count: number, pad: number): Rect {
  const from = Math.max(0, pts.length - 2 * count);
  const b = pointsBounds(pts.slice(from));
  return { x: b.x - pad, y: b.y - pad, w: b.w + 2 * pad, h: b.h + 2 * pad };
}


/** A swath segment in the fitted frame (what the scene shows) mapped back to the stored points' frame (what is written). */
export function swathToStored(raw: readonly number[], w: number, h: number, ax: number, ay: number, bx: number, by: number, r: number): number[] {
  const f = inkFit(raw, w, h);
  return [(ax - f.ox) / f.sx + f.bx, (ay - f.oy) / f.sy + f.by, (bx - f.ox) / f.sx + f.bx, (by - f.oy) / f.sy + f.by, r / Math.sqrt(f.sx * f.sy)];
}

const cross = (ox: number, oy: number, ax: number, ay: number, bx: number, by: number): number => (ax - ox) * (by - oy) - (ay - oy) * (bx - ox);

/** Distance between the segments a→b and c→d (0 when they cross). */
function segSegDistance(a: Point, b: Point, c: Point, d: Point): number {
  const d1 = cross(c.x, c.y, d.x, d.y, a.x, a.y);
  const d2 = cross(c.x, c.y, d.x, d.y, b.x, b.y);
  const d3 = cross(a.x, a.y, b.x, b.y, c.x, c.y);
  const d4 = cross(a.x, a.y, b.x, b.y, d.x, d.y);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  return Math.min(distToSegment(a, c, d), distToSegment(b, c, d), distToSegment(c, a, b), distToSegment(d, a, b));
}

/** Distance from the segment a→b (relative to the stroke's corner) to the stroke's center line. */
export function inkSegDistance(a: Point, b: Point, pts: readonly number[]): number {
  if (pts.length < 4) return distToSegment({ x: pts[0] ?? 0, y: pts[1] ?? 0 }, a, b);
  let best = Infinity;
  for (let i = 0; i + 3 < pts.length && best > 0; i += 2) {
    const d = segSegDistance(a, b, { x: pts[i] ?? 0, y: pts[i + 1] ?? 0 }, { x: pts[i + 2] ?? 0, y: pts[i + 3] ?? 0 });
    if (d < best) best = d;
  }
  return best;
}

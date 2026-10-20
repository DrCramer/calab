import { rectCenter, dist, rotatePoint, type Point, type Rect } from './geometry';
import type { BoxRec, Endpoint, RouteKind, ShapeKind, Side } from './types';

export type ConcreteSide = Exclude<Side, 'auto'>;
export const SIDES: readonly ConcreteSide[] = ['top', 'right', 'bottom', 'left'];

/** Outward unit direction of each side. */
export const SIDE_DIR: Record<ConcreteSide, Point> = {
  top: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
};

/** Length of the straight stub that leaves an object before an elbow connector turns. */
export const STUB = 20;

/** Where a connector touches side `side` of an object occupying `r` (triangles: the slanted edges' midpoints). */
export function anchorPoint(r: Rect, shape: ShapeKind | undefined, side: ConcreteSide): Point {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  if (shape === 'triangle') {
    if (side === 'left') return { x: r.x + r.w * 0.25, y: cy };
    if (side === 'right') return { x: r.x + r.w * 0.75, y: cy };
  }
  switch (side) {
    case 'top': return { x: cx, y: r.y };
    case 'right': return { x: r.x + r.w, y: cy };
    case 'bottom': return { x: cx, y: r.y + r.h };
    case 'left': return { x: r.x, y: cy };
  }
}

/** Nearest side (by its anchor) to a world point: the "auto" side. */
export function nearestSide(r: Rect, shape: ShapeKind | undefined, toward: Point, rot = 0): ConcreteSide {
  let best: ConcreteSide = 'right';
  let bestD = Infinity;
  for (const s of SIDES) {
    const d = dist(rot === 0 ? anchorPoint(r, shape, s) : rotatePoint(anchorPoint(r, shape, s), rectCenter(r), rot), toward);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

const shapeOf = (b: BoxRec): ShapeKind | undefined => (b.kind === 'shape' ? b.shape : undefined);

/**
 * Where a connector touches side `side` of a box: the local anchor turned with the box. A side is the box's own
 * (its top stays its top when it is rotated), so the glued end follows the rotated side.
 */
export function anchorOf(b: BoxRec, side: ConcreteSide): Point {
  const p = anchorPoint(b, shapeOf(b), side);
  return b.rot ? rotatePoint(p, rectCenter(b), b.rot) : p;
}

/**
 * Outward direction of a side of a box, snapped to the nearest world axis: orthogonal routes leave a rotated
 * box along an axis, from the (exactly rotated) anchor.
 */
export function sideDirOf(b: BoxRec, side: ConcreteSide): Point {
  const d = SIDE_DIR[side];
  if (!b.rot) return d;
  const q = rotatePoint(d, { x: 0, y: 0 }, b.rot);
  return Math.abs(q.x) >= Math.abs(q.y) ? { x: q.x >= 0 ? 1 : -1, y: 0 } : { x: 0, y: q.y >= 0 ? 1 : -1 };
}

export interface ResolvedEnd {
  p: Point;
  /** Outward direction of the glued side; null for a free end. */
  dir: Point | null;
  /** Object glued to (null when free or dangling). */
  target: string | null;
  side: ConcreteSide | null;
}

export type BoxLookup = (id: string) => BoxRec | undefined;


function refPoint(e: Endpoint, lookup: BoxLookup, last: Point | undefined): Point | null {
  if (!('id' in e)) return { x: e.x, y: e.y };
  const t = lookup(e.id);
  if (t) return rectCenter(t);
  return last ?? null;
}

function resolveEnd(e: Endpoint, other: Point | null, lookup: BoxLookup, last: Point | undefined): ResolvedEnd {
  if (!('id' in e)) return { p: { x: e.x, y: e.y }, dir: null, target: null, side: null };
  const t = lookup(e.id);
  if (!t) return { p: last ?? other ?? { x: 0, y: 0 }, dir: null, target: null, side: null };
  const side = e.side === 'auto' ? nearestSide(t, shapeOf(t), other ?? rectCenter(t), t.rot ?? 0) : e.side;
  return { p: anchorOf(t, side), dir: sideDirOf(t, side), target: t.id, side };
}

export interface RoutedConnector {
  points: number[];
  from: ResolvedEnd;
  to: ResolvedEnd;
}

/** Bounded memo for elbow routes (keyed by the resolved end positions and directions). */
export class RouteCache {
  private readonly map = new Map<string, number[]>();
  hits = 0;
  misses = 0;
  constructor(private readonly cap = 2000) {}

  get(key: string): number[] | undefined {
    const v = this.map.get(key);
    if (v) this.hits++;
    else this.misses++;
    return v;
  }

  set(key: string, pts: number[]): void {
    if (this.map.size >= this.cap) {
      const first = this.map.keys().next();
      if (!first.done) this.map.delete(first.value);
    }
    this.map.set(key, pts);
  }

  clear(): void {
    this.map.clear();
  }
}

const f = (n: number): string => (Math.round(n * 100) / 100).toString();
const endKey = (e: ResolvedEnd): string => `${f(e.p.x)},${f(e.p.y)},${e.dir ? `${e.dir.x}${e.dir.y}` : '-'}`;

/** Resolves both ends against the scene and routes. `last*` keep a dangling end where it was. */
export function routeConnector(
  from: Endpoint,
  to: Endpoint,
  kind: RouteKind,
  lookup: BoxLookup,
  last: { from?: Point; to?: Point } = {},
  cache?: RouteCache,
): RoutedConnector {
  const refTo = refPoint(to, lookup, last.to);
  const refFrom = refPoint(from, lookup, last.from);
  const a = resolveEnd(from, refTo, lookup, last.from);
  const b = resolveEnd(to, refFrom, lookup, last.to);
  // A glued end whose target is gone and that has no remembered position collapses onto the other end.
  if (!a.target && 'id' in from && !last.from) a.p = { ...b.p };
  if (!b.target && 'id' in to && !last.to) b.p = { ...a.p };
  if (kind === 'straight') return { points: [a.p.x, a.p.y, b.p.x, b.p.y], from: a, to: b };
  const key = `${endKey(a)}|${endKey(b)}`;
  let pts = cache?.get(key);
  if (!pts) {
    pts = elbowPath(a, b);
    cache?.set(key, pts);
  }
  return { points: pts, from: a, to: b };
}

const axisDir = (from: Point, to: Point): Point => {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  return Math.abs(dx) >= Math.abs(dy) ? { x: dx >= 0 ? 1 : -1, y: 0 } : { x: 0, y: dy >= 0 ? 1 : -1 };
};

/** Orthogonal path between two ends: leaves/enters glued sides along their normal, at most 3 bends. */
export function elbowPath(a: ResolvedEnd, b: ResolvedEnd): number[] {
  const da = a.dir ?? axisDir(a.p, b.p);
  const db = b.dir ?? axisDir(b.p, a.p);
  const sa = a.dir ? STUB : 0;
  const sb = b.dir ? STUB : 0;
  const s0 = { x: a.p.x + da.x * sa, y: a.p.y + da.y * sa };
  const e1 = { x: b.p.x + db.x * sb, y: b.p.y + db.y * sb };
  const pts: Point[] = [a.p, s0];
  const hA = da.x !== 0;
  const hB = db.x !== 0;
  if (hA && hB) {
    const mx = da.x === db.x ? (da.x > 0 ? Math.max(s0.x, e1.x) : Math.min(s0.x, e1.x)) : (s0.x + e1.x) / 2;
    pts.push({ x: mx, y: s0.y }, { x: mx, y: e1.y });
  } else if (!hA && !hB) {
    const my = da.y === db.y ? (da.y > 0 ? Math.max(s0.y, e1.y) : Math.min(s0.y, e1.y)) : (s0.y + e1.y) / 2;
    pts.push({ x: s0.x, y: my }, { x: e1.x, y: my });
  } else if (hA) {
    const ok = (e1.x - s0.x) * da.x >= 0 && (s0.y - e1.y) * db.y >= 0;
    pts.push(ok ? { x: e1.x, y: s0.y } : { x: s0.x, y: e1.y });
  } else {
    const ok = (e1.y - s0.y) * da.y >= 0 && (s0.x - e1.x) * db.x >= 0;
    pts.push(ok ? { x: s0.x, y: e1.y } : { x: e1.x, y: s0.y });
  }
  pts.push(e1, b.p);
  return simplify(pts);
}

/** Drops repeated points and the middle one of collinear triples. */
export function simplify(pts: readonly Point[]): number[] {
  const out: Point[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 1e-6 && Math.abs(last.y - p.y) < 1e-6) continue;
    out.push(p);
  }
  for (let i = 1; i < out.length - 1; ) {
    const a = out[i - 1];
    const b = out[i];
    const c = out[i + 1];
    if (a && b && c && ((Math.abs(a.x - b.x) < 1e-6 && Math.abs(b.x - c.x) < 1e-6) || (Math.abs(a.y - b.y) < 1e-6 && Math.abs(b.y - c.y) < 1e-6))) {
      out.splice(i, 1);
    } else i++;
  }
  const flat: number[] = [];
  for (const p of out) flat.push(p.x, p.y);
  return flat;
}

/** Unit direction of the last segment (for the arrowhead at the end); mirrored for the start. */
export function endDirection(pts: readonly number[], atEnd: boolean): Point {
  const n = pts.length;
  if (n < 4) return { x: 1, y: 0 };
  const [px, py, qx, qy] = atEnd
    ? [pts[n - 4] ?? 0, pts[n - 3] ?? 0, pts[n - 2] ?? 0, pts[n - 1] ?? 0]
    : [pts[2] ?? 0, pts[3] ?? 0, pts[0] ?? 0, pts[1] ?? 0];
  const len = Math.hypot(qx - px, qy - py);
  return len === 0 ? { x: 1, y: 0 } : { x: (qx - px) / len, y: (qy - py) / len };
}

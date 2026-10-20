import { snapTo, type HandleId, type Point, type Rect } from './geometry';

/** A guide line to draw: vertical (axis 'x' at x=`at`) or horizontal ('y'), spanning [from, to] on the other axis. */
export interface Guide {
  axis: 'x' | 'y';
  at: number;
  from: number;
  to: number;
}

export interface SnapResult {
  dx: number;
  dy: number;
  guides: Guide[];
}

export interface SnapOptions {
  /** Max distance (world units) at which edges attract. */
  threshold: number;
  /** Grid step; 0 = no grid snapping. */
  grid: number;
}

const xs = (r: Rect): [number, number, number] => [r.x, r.x + r.w / 2, r.x + r.w];
const ys = (r: Rect): [number, number, number] => [r.y, r.y + r.h / 2, r.y + r.h];

/** Best offset to bring any of `mine` onto any of `theirs`, within `threshold`; null if none. */
function bestOffset(mine: readonly number[], theirs: readonly number[], threshold: number): number | null {
  let best: number | null = null;
  for (const a of mine) {
    for (const b of theirs) {
      const d = b - a;
      if (Math.abs(d) <= threshold && (best === null || Math.abs(d) < Math.abs(best))) best = d;
    }
  }
  return best;
}

/**
 * Snaps a moved rect to the edges/centers of neighbours (guide lines), else to the grid. `moving` is the
 * rect at its raw (unsnapped) position. Returns the correction to add and the guides to draw.
 */
export function snapMove(moving: Rect, others: readonly Rect[], o: SnapOptions): SnapResult {
  const ox = others.flatMap(xs);
  const oy = others.flatMap(ys);
  let dx = bestOffset(xs(moving), ox, o.threshold);
  let dy = bestOffset(ys(moving), oy, o.threshold);
  const guided = { x: dx !== null, y: dy !== null };
  if (dx === null) dx = o.grid > 0 ? snapTo(moving.x, o.grid) - moving.x : 0;
  if (dy === null) dy = o.grid > 0 ? snapTo(moving.y, o.grid) - moving.y : 0;
  const snapped: Rect = { x: moving.x + dx, y: moving.y + dy, w: moving.w, h: moving.h };
  return { dx, dy, guides: guides(snapped, others, guided) };
}

/** Guide lines for the edges/centers of `r` that coincide with a neighbour's (only on guided axes). */
export function guides(r: Rect, others: readonly Rect[], on: { x: boolean; y: boolean } = { x: true, y: true }): Guide[] {
  const out: Guide[] = [];
  const eps = 0.5;
  if (on.x) {
    for (const a of xs(r)) {
      let lo = r.y;
      let hi = r.y + r.h;
      let hit = false;
      for (const t of others) {
        if (xs(t).some((b) => Math.abs(a - b) <= eps)) {
          hit = true;
          lo = Math.min(lo, t.y);
          hi = Math.max(hi, t.y + t.h);
        }
      }
      if (hit) out.push({ axis: 'x', at: a, from: lo, to: hi });
    }
  }
  if (on.y) {
    for (const a of ys(r)) {
      let lo = r.x;
      let hi = r.x + r.w;
      let hit = false;
      for (const t of others) {
        if (ys(t).some((b) => Math.abs(a - b) <= eps)) {
          hit = true;
          lo = Math.min(lo, t.x);
          hi = Math.max(hi, t.x + t.w);
        }
      }
      if (hit) out.push({ axis: 'y', at: a, from: lo, to: hi });
    }
  }
  return dedupe(out);
}

function dedupe(g: Guide[]): Guide[] {
  const seen = new Set<string>();
  return g.filter((x) => {
    const k = `${x.axis}${Math.round(x.at * 2)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Snaps the dragged resize point so the moved edge(s) land on neighbours' edges or the grid. */
export function snapResizePoint(p: Point, handle: HandleId, others: readonly Rect[], o: SnapOptions): { p: Point; guides: Guide[] } {
  const out = { ...p };
  const on = { x: false, y: false };
  if (handle.includes('e') || handle.includes('w')) {
    const d = bestOffset([p.x], others.flatMap(xs), o.threshold);
    if (d !== null) {
      out.x = p.x + d;
      on.x = true;
    } else if (o.grid > 0) out.x = snapTo(p.x, o.grid);
  }
  if (handle.includes('n') || handle.includes('s')) {
    const d = bestOffset([p.y], others.flatMap(ys), o.threshold);
    if (d !== null) {
      out.y = p.y + d;
      on.y = true;
    } else if (o.grid > 0) out.y = snapTo(p.y, o.grid);
  }
  const probe: Rect = { x: out.x, y: out.y, w: 0, h: 0 };
  return { p: out, guides: guides(probe, others, on) };
}

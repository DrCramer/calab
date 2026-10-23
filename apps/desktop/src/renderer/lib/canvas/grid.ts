import { pointsBounds, rectsIntersect, type Rect } from './geometry';

const CELL = 512;
/** Objects covering more cells than this live in a flat "big" list (a rare huge shape / long connector). */
const BIG_CELLS = 64;
const OFF = 1 << 15;

interface Entry {
  rect: Rect;
  c0x: number;
  c0y: number;
  c1x: number;
  c1y: number;
  big: boolean;
  stamp: number;
}

const cellKey = (cx: number, cy: number): number => (cx + OFF) * 65536 + (cy + OFF);
const cellOf = (v: number): number => Math.max(-OFF + 1, Math.min(OFF - 1, Math.floor(v / CELL)));

/**
 * Uniform grid as a spatial index (ADR-0126 §4): culling by the visible rect and hit-testing touch
 * only the cells they cover. Ids are dedup'd with a query stamp, no allocation per object.
 */
export class SpatialGrid {
  private readonly cells = new Map<number, string[]>();
  private readonly entries = new Map<string, Entry>();
  private readonly big = new Set<string>();
  private stamp = 0;

  get size(): number {
    return this.entries.size;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  insert(id: string, r: Rect): void {
    if (this.entries.has(id)) this.remove(id);
    const c0x = cellOf(r.x);
    const c0y = cellOf(r.y);
    const c1x = cellOf(r.x + r.w);
    const c1y = cellOf(r.y + r.h);
    const big = (c1x - c0x + 1) * (c1y - c0y + 1) > BIG_CELLS;
    this.entries.set(id, { rect: r, c0x, c0y, c1x, c1y, big, stamp: 0 });
    if (big) {
      this.big.add(id);
      return;
    }
    for (let cx = c0x; cx <= c1x; cx++) {
      for (let cy = c0y; cy <= c1y; cy++) {
        const k = cellKey(cx, cy);
        const list = this.cells.get(k);
        if (list) list.push(id);
        else this.cells.set(k, [id]);
      }
    }
  }

  remove(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    this.entries.delete(id);
    if (e.big) {
      this.big.delete(id);
      return;
    }
    for (let cx = e.c0x; cx <= e.c1x; cx++) {
      for (let cy = e.c0y; cy <= e.c1y; cy++) {
        const k = cellKey(cx, cy);
        const list = this.cells.get(k);
        if (!list) continue;
        const i = list.indexOf(id);
        if (i >= 0) {
          list[i] = list[list.length - 1] ?? id;
          list.pop();
        }
        if (list.length === 0) this.cells.delete(k);
      }
    }
  }

  update(id: string, r: Rect): void {
    const e = this.entries.get(id);
    if (e && e.rect.x === r.x && e.rect.y === r.y && e.rect.w === r.w && e.rect.h === r.h) return;
    this.insert(id, r);
  }

  clear(): void {
    this.cells.clear();
    this.entries.clear();
    this.big.clear();
  }

  /** Ids whose bounds intersect `r` (unordered). */
  query(r: Rect): string[] {
    const out: string[] = [];
    this.forEach(r, (id) => out.push(id));
    return out;
  }

  forEach(r: Rect, fn: (id: string) => void): void {
    this.stamp++;
    const stamp = this.stamp;
    const visit = (id: string): void => {
      const e = this.entries.get(id);
      if (!e || e.stamp === stamp) return;
      e.stamp = stamp;
      if (rectsIntersect(e.rect, r)) fn(id);
    };
    const c0x = cellOf(r.x);
    const c0y = cellOf(r.y);
    const c1x = cellOf(r.x + r.w);
    const c1y = cellOf(r.y + r.h);
    const span = (c1x - c0x + 1) * (c1y - c0y + 1);
    if (span > this.cells.size) {
      // Wider than the populated area: walking the cells map beats walking the rect.
      for (const [k, list] of this.cells) {
        const cx = Math.floor(k / 65536) - OFF;
        const cy = (k % 65536) - OFF;
        if (cx < c0x || cx > c1x || cy < c0y || cy > c1y) continue;
        for (const id of list) visit(id);
      }
    } else {
      for (let cx = c0x; cx <= c1x; cx++) {
        for (let cy = c0y; cy <= c1y; cy++) {
          const list = this.cells.get(cellKey(cx, cy));
          if (list) for (const id of list) visit(id);
        }
      }
    }
    for (const id of this.big) visit(id);
  }
}

/** Convenience for connectors: index rect of a flat path. */
export const pathRect = (pts: readonly number[]): Rect => pointsBounds(pts);

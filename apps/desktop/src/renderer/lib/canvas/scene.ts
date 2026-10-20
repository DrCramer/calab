import * as Y from 'yjs';
import { CanvasDoc, color, endpoint, isKind, isShapeKind, num } from './doc';
import {
  boundsOf, distToPolyline, pointInShape, pointsBounds, polylineMidpoint, rectContainsPoint, rectInflate, rectsIntersect,
  type Point, type Rect,
} from './geometry';
import { isValidKey } from './fracIndex';
import { SpatialGrid } from './grid';
import { RouteCache, routeConnector } from './route';
import { SHAPE_PAD, STICKY_PAD, TEXT_PAD, TextLayouter } from './textLayout';
import {
  DEFAULTS, MAX_SIZE, isBound, isBox, isConnector,
  type BoxRec, type ConnectorRec, type Endpoint, type ObjectRec, type RouteKind, type Arrow,
} from './types';

/** What a scene update touched: ids, the screen-relevant rects to repaint, and whether z-order moved. */
export interface SceneChange {
  readonly ids: ReadonlySet<string>;
  /** World rects (old and new visual bounds of everything that changed). */
  readonly dirty: readonly Rect[];
  /** More than a handful of objects changed: repaint everything. */
  readonly full: boolean;
  /** Added / removed objects or z changed (the draw order may differ). */
  readonly order: boolean;
}

const FULL_REPAINT_OVER = 256;
const ARROW_PAD = 14;
const LABEL_W = 180;
const LABEL_H = 28;

/** Visual bounds: where pixels of the object can land (stroke, arrowheads, connector label). */
export function visualBounds(o: ObjectRec): Rect {
  if (isConnector(o)) {
    let r = rectInflate(o, ARROW_PAD + o.strokeWidth);
    if (o.label) {
      const m = polylineMidpoint(o.points);
      r = {
        x: Math.min(r.x, m.x - LABEL_W / 2), y: Math.min(r.y, m.y - LABEL_H / 2),
        w: Math.max(r.x + r.w, m.x + LABEL_W / 2) - Math.min(r.x, m.x - LABEL_W / 2),
        h: Math.max(r.y + r.h, m.y + LABEL_H / 2) - Math.min(r.y, m.y - LABEL_H / 2),
      };
    }
    return r;
  }
  return rectInflate(o, o.kind === 'shape' ? o.strokeWidth : 1);
}

function segHitsRect(ax: number, ay: number, bx: number, by: number, r: Rect): boolean {
  // Liang–Barsky against the rect.
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dy = by - ay;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  return clip(-dx, ax - r.x) && clip(dx, r.x + r.w - ax) && clip(-dy, ay - r.y) && clip(dy, r.y + r.h - ay);
}

/**
 * The engine's read model: immutable records by id, built from the Y.Doc by its events (never through
 * Zustand/React), with a grid index for culling and hit-testing. Connectors are re-routed when a
 * glued object changes.
 */
export class Scene {
  readonly grid = new SpatialGrid();
  readonly routes = new RouteCache();
  private recs = new Map<string, ObjectRec>();
  /** target id → connectors that reference it (even if the target does not exist right now). */
  private readonly byTarget = new Map<string, Set<string>>();
  private order: string[] | null = null;
  private ranks: Map<string, number> | null = null;
  private readonly listeners = new Set<(c: SceneChange) => void>();
  /** Bumped on every update; renderers use it to invalidate caches. */
  version = 0;
  private readonly onDeep: (events: Y.YEvent<Y.AbstractType<unknown>>[]) => void;

  constructor(
    readonly doc: CanvasDoc,
    readonly text: TextLayouter = new TextLayouter(),
  ) {
    this.rebuildAll();
    this.onDeep = (events) => this.handleEvents(events);
    doc.objects.observeDeep(this.onDeep);
  }

  destroy(): void {
    this.doc.objects.unobserveDeep(this.onDeep);
    this.listeners.clear();
  }

  subscribe(fn: (c: SceneChange) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get size(): number {
    return this.recs.size;
  }

  get(id: string): ObjectRec | undefined {
    return this.recs.get(id);
  }

  has(id: string): boolean {
    return this.recs.has(id);
  }

  /** Ids bottom → top. Cached until the set or a z changes. */
  orderedIds(): readonly string[] {
    if (!this.order) {
      const arr = Array.from(this.recs.values());
      arr.sort((a, b) => (a.z < b.z ? -1 : a.z > b.z ? 1 : a.id < b.id ? -1 : 1));
      this.order = arr.map((r) => r.id);
    }
    return this.order;
  }

  rankOf(id: string): number {
    if (!this.ranks) {
      const m = new Map<string, number>();
      this.orderedIds().forEach((i, n) => m.set(i, n));
      this.ranks = m;
    }
    return this.ranks.get(id) ?? -1;
  }

  /** All records bottom → top. */
  all(): ObjectRec[] {
    const out: ObjectRec[] = [];
    for (const id of this.orderedIds()) {
      const r = this.recs.get(id);
      if (r) out.push(r);
    }
    return out;
  }

  /** Records whose visual bounds intersect `r`, bottom → top. */
  query(r: Rect): ObjectRec[] {
    // Decorate with the layer rank once, sort by number: thousands of Map lookups inside the comparator cost more than the draw.
    if (!this.ranks) this.rankOf('');
    const ranks = this.ranks;
    const hits: { rank: number; rec: ObjectRec }[] = [];
    this.grid.forEach(r, (id) => {
      const rec = this.recs.get(id);
      if (rec) hits.push({ rank: ranks?.get(id) ?? -1, rec });
    });
    hits.sort((a, b) => a.rank - b.rank);
    return hits.map((h) => h.rec);
  }

  connectorsOf(id: string): ReadonlySet<string> {
    return this.byTarget.get(id) ?? new Set<string>();
  }

  /** Resolved position of a connector end (for keeping it in place when its target is deleted). */
  pointOf(connectorId: string, end: 'from' | 'to'): Point | null {
    const c = this.recs.get(connectorId);
    if (!c || !isConnector(c) || c.points.length < 4) return null;
    return end === 'from' ? { x: c.points[0] ?? 0, y: c.points[1] ?? 0 } : { x: c.points[c.points.length - 2] ?? 0, y: c.points[c.points.length - 1] ?? 0 };
  }

  bounds(ids?: Iterable<string>): Rect | null {
    const rects: Rect[] = [];
    if (ids) {
      for (const id of ids) {
        const r = this.recs.get(id);
        if (r) rects.push(r);
      }
    } else for (const r of this.recs.values()) rects.push(r);
    return boundsOf(rects);
  }

  /**
   * Topmost object at a world point; `tol` is the pick radius in world units. An unfilled, textless shape is picked
   * by its outline only, so a big empty frame never swallows the clicks (and the marquee) inside it.
   */
  hit(p: Point, tol: number, accept?: (o: ObjectRec) => boolean): ObjectRec | null {
    return this.pick(p, tol, accept, false);
  }

  /**
   * Topmost object whose whole area (a shape's transparent interior included) contains the point, `tol` around its
   * edge counted in. For wiring connectors, not for selection: releasing a wire anywhere inside a frame glues to it.
   */
  hitArea(p: Point, tol: number, accept?: (o: ObjectRec) => boolean): ObjectRec | null {
    return this.pick(p, tol, accept, true);
  }

  private pick(p: Point, tol: number, accept: ((o: ObjectRec) => boolean) | undefined, area: boolean): ObjectRec | null {
    const cands = this.query({ x: p.x - tol, y: p.y - tol, w: 2 * tol, h: 2 * tol });
    for (let i = cands.length - 1; i >= 0; i--) {
      const o = cands[i];
      if (!o || (accept && !accept(o))) continue;
      if (this.hitsObject(o, p, tol, area)) return o;
    }
    return null;
  }

  private hitsObject(o: ObjectRec, p: Point, tol: number, area: boolean): boolean {
    if (isConnector(o)) {
      if (distToPolyline(p, o.points) <= tol) return true;
      if (o.label) {
        const m = polylineMidpoint(o.points);
        return Math.abs(p.x - m.x) <= LABEL_W / 2 && Math.abs(p.y - m.y) <= LABEL_H / 2 && o.label.length > 0;
      }
      return false;
    }
    if (o.kind !== 'shape') return rectContainsPoint(o, p, 0);
    if (!pointInShape(o.shape, rectInflate(o, tol), p)) return false;
    if (area || o.fill !== 'none' || o.text !== '') return pointInShape(o.shape, o, p) || distNearOutline(o, p, tol);
    // Unfilled and empty: only the outline picks.
    const inner = rectInflate(o, -2 * tol);
    return !(inner.w > 0 && inner.h > 0 && pointInShape(o.shape, inner, p));
  }

  /** Objects touching the rect (marquee). */
  inRect(r: Rect): ObjectRec[] {
    return this.query(r).filter((o) => {
      if (!isConnector(o)) return rectsIntersect(o, r);
      for (let i = 0; i + 3 < o.points.length; i += 2) {
        if (segHitsRect(o.points[i] ?? 0, o.points[i + 1] ?? 0, o.points[i + 2] ?? 0, o.points[i + 3] ?? 0, r)) return true;
      }
      return false;
    });
  }

  // ── building ────────────────────────────────────────────────────────────────

  private boxLookup = (id: string): BoxRec | undefined => {
    const r = this.recs.get(id);
    return r && isBox(r) ? r : undefined;
  };

  private rebuildAll(): void {
    this.recs = new Map();
    this.byTarget.clear();
    this.grid.clear();
    this.order = null;
    this.ranks = null;
    const conns: [string, Y.Map<unknown>][] = [];
    for (const [id, m] of this.doc.objects) {
      if (m.get('kind') === 'connector') {
        conns.push([id, m]);
        continue;
      }
      const rec = this.buildBox(id, m);
      if (rec) {
        this.recs.set(id, rec);
        this.grid.insert(id, visualBounds(rec));
      }
    }
    for (const [id, m] of conns) this.putConnector(id, m);
    this.version++;
  }

  private handleEvents(events: Y.YEvent<Y.AbstractType<unknown>>[]): void {
    const ids = new Set<string>();
    for (const ev of events) {
      if (ev.target === this.doc.objects) {
        for (const k of ev.changes.keys.keys()) ids.add(k);
      } else {
        const first = ev.path[0];
        if (typeof first === 'string') ids.add(first);
      }
    }
    if (ids.size > 0) this.refresh(ids);
  }

  /** Rebuilds the records of `ids` (and the connectors glued to them) from the doc and notifies. */
  refresh(ids: Iterable<string>): SceneChange {
    const changed = new Set<string>();
    const dirty: Rect[] = [];
    let order = false;
    const touch = (id: string): void => {
      changed.add(id);
      const old = this.recs.get(id);
      if (old) dirty.push(visualBounds(old));
    };
    const connIds = new Set<string>();
    // Phase 1: boxes (and removals).
    for (const id of ids) {
      const m = this.doc.objects.get(id);
      const old = this.recs.get(id);
      if (!m || !isKind(m.get('kind'))) {
        if (old) {
          touch(id);
          this.drop(id);
          order = true;
        }
        continue;
      }
      if (m.get('kind') === 'connector') {
        connIds.add(id);
        continue;
      }
      const rec = this.buildBox(id, m);
      if (!rec) {
        if (old) {
          touch(id);
          this.drop(id);
          order = true;
        }
        continue;
      }
      touch(id);
      if (!old || old.z !== rec.z) order = true;
      this.recs.set(id, rec);
      this.grid.update(id, visualBounds(rec));
      dirty.push(visualBounds(rec));
      for (const c of this.byTarget.get(id) ?? []) connIds.add(c);
    }
    // Deleted targets also re-route their connectors (dangling → keep last position).
    for (const id of ids) if (!this.recs.has(id)) for (const c of this.byTarget.get(id) ?? []) connIds.add(c);
    // Phase 2: connectors, against the final boxes.
    for (const id of connIds) {
      const m = this.doc.objects.get(id);
      const old = this.recs.get(id);
      if (!m || !isKind(m.get('kind')) || m.get('kind') !== 'connector') {
        if (old) {
          touch(id);
          this.drop(id);
          order = true;
        }
        continue;
      }
      touch(id);
      const rec = this.putConnector(id, m);
      if (!old || old.z !== rec?.z) order = true;
      if (rec) dirty.push(visualBounds(rec));
    }
    if (order) {
      this.order = null;
      this.ranks = null;
    }
    this.version++;
    const change: SceneChange = { ids: changed, dirty, full: changed.size > FULL_REPAINT_OVER, order };
    for (const fn of this.listeners) fn(change);
    return change;
  }

  private drop(id: string): void {
    const old = this.recs.get(id);
    if (old && isConnector(old)) this.unlinkConnector(old);
    this.recs.delete(id);
    this.grid.remove(id);
  }

  private link(connId: string, e: Endpoint): void {
    if (!isBound(e)) return;
    let set = this.byTarget.get(e.id);
    if (!set) this.byTarget.set(e.id, (set = new Set()));
    set.add(connId);
  }

  private unlinkConnector(c: ConnectorRec): void {
    for (const e of [c.from, c.to]) {
      if (!isBound(e)) continue;
      const set = this.byTarget.get(e.id);
      if (set) {
        set.delete(c.id);
        if (set.size === 0) this.byTarget.delete(e.id);
      }
    }
  }

  private zOf(m: Y.Map<unknown>): string {
    const z = m.get('z');
    return isValidKey(z) ? z : '';
  }

  private buildBox(id: string, m: Y.Map<unknown>): BoxRec | null {
    const kind = m.get('kind');
    const z = this.zOf(m);
    const x = num(m.get('x'), 0);
    const y = num(m.get('y'), 0);
    const textOf = (): string => {
      const t = m.get('text');
      return t instanceof Y.Text ? t.toJSON() : '';
    };
    switch (kind) {
      case 'sticky':
        return {
          kind, id, z, x, y,
          w: num(m.get('w'), DEFAULTS.stickySize, DEFAULTS.minBox, MAX_SIZE), h: num(m.get('h'), DEFAULTS.stickySize, DEFAULTS.minBox, MAX_SIZE),
          color: color(m.get('color'), DEFAULTS.stickyColor), text: textOf(),
        };
      case 'text': {
        const w = num(m.get('w'), DEFAULTS.textW, DEFAULTS.minTextW, MAX_SIZE);
        const size = num(m.get('size'), DEFAULTS.textSize, DEFAULTS.minTextSize, DEFAULTS.maxTextSize);
        const text = textOf();
        const h = Math.max(size * 1.3, this.text.layout(text, size, w - 2 * TEXT_PAD).height) + 2 * TEXT_PAD;
        return { kind, id, z, x, y, w, h, size, color: color(m.get('color'), DEFAULTS.textColor), text };
      }
      case 'shape': {
        const shape = m.get('shape');
        return {
          kind, id, z, x, y,
          w: num(m.get('w'), DEFAULTS.shapeW, DEFAULTS.minBox, MAX_SIZE), h: num(m.get('h'), DEFAULTS.shapeH, DEFAULTS.minBox, MAX_SIZE),
          shape: isShapeKind(shape) ? shape : 'rect',
          fill: color(m.get('fill'), DEFAULTS.shapeFill), stroke: color(m.get('stroke'), DEFAULTS.shapeStroke),
          strokeWidth: num(m.get('strokeWidth'), DEFAULTS.strokeWidth, 0, 24), text: textOf(),
        };
      }
      default:
        return null;
    }
  }

  private putConnector(id: string, m: Y.Map<unknown>): ConnectorRec | null {
    const old = this.recs.get(id);
    if (old && isConnector(old)) this.unlinkConnector(old);
    const from = endpoint(m.get('from')) ?? { x: 0, y: 0 };
    const to = endpoint(m.get('to')) ?? { x: 0, y: 0 };
    const arrowRaw = m.get('arrow');
    const routeRaw = m.get('route');
    const arrow: Arrow = arrowRaw === 'none' || arrowRaw === 'both' ? arrowRaw : 'end';
    const route: RouteKind = routeRaw === 'elbow' ? 'elbow' : 'straight';
    const last: { from?: Point; to?: Point } = {};
    if (old && isConnector(old) && old.points.length >= 4) {
      last.from = { x: old.points[0] ?? 0, y: old.points[1] ?? 0 };
      last.to = { x: old.points[old.points.length - 2] ?? 0, y: old.points[old.points.length - 1] ?? 0 };
    }
    const routed = routeConnector(from, to, route, this.boxLookup, last, this.routes);
    const b = pointsBounds(routed.points);
    const lab = m.get('label');
    const rec: ConnectorRec = {
      kind: 'connector', id, z: this.zOf(m), x: b.x, y: b.y, w: b.w, h: b.h,
      from, to, arrow, route, stroke: color(m.get('stroke'), DEFAULTS.connectorStroke),
      strokeWidth: num(m.get('strokeWidth'), DEFAULTS.strokeWidth, 0, 24), label: typeof lab === 'string' ? lab : '',
      points: routed.points,
    };
    this.recs.set(id, rec);
    this.grid.update(id, visualBounds(rec));
    this.link(id, from);
    this.link(id, to);
    return rec;
  }
}

function distNearOutline(o: BoxRec, p: Point, tol: number): boolean {
  const inner = rectInflate(o, -2 * tol);
  if (o.kind !== 'shape') return false;
  return !(inner.w > 0 && inner.h > 0 && pointInShape(o.shape, inner, p));
}

export const boxPad = (o: BoxRec): number => (o.kind === 'sticky' ? STICKY_PAD : o.kind === 'shape' ? SHAPE_PAD : TEXT_PAD);

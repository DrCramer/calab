import { pinchStep, type Camera } from '../../../lib/canvas/camera';
import { duplicate } from '../../../lib/canvas/clipboard';
import type { CanvasDoc } from '../../../lib/canvas/doc';
import {
  boundsOf, dist, mapRect, rectFromPoints, rectInflate, resizeRect, snapTo,
  type HandleId, type Point, type Rect,
} from '../../../lib/canvas/geometry';
import { anchorPoint, SIDES, type ConcreteSide } from '../../../lib/canvas/route';
import type { Scene } from '../../../lib/canvas/scene';
import { snapMove, snapResizePoint, type SnapOptions } from '../../../lib/canvas/snap';
import {
  DEFAULTS, isBound, isBox, isConnector,
  type BoxRec, type ConnectorRec, type Endpoint, type ObjectPatch, type RouteKind, type ShapeKind,
} from '../../../lib/canvas/types';
import type { OverlayState } from './overlay';

export interface Mods {
  shift: boolean;
  alt: boolean;
  /** Ctrl or ⌘: temporarily disables snapping. */
  mod: boolean;
}

/** What gestures need from the engine. */
export interface Core {
  readonly doc: CanvasDoc;
  readonly scene: Scene;
  readonly camera: Camera;
  /** The camera including queued gesture input; continuous gestures (pan, pinch) build on it. */
  readonly liveCamera: Camera;
  readonly selection: ReadonlySet<string>;
  readonly shapeKind: ShapeKind;
  readonly connectorRoute: RouteKind;
  readonly gridSize: number;
  setCamera(c: Camera): void;
  /** Queues the next camera of a continuous gesture (applied once per frame). */
  steerCamera(c: Camera): void;
  flushCamera(): void;
  setSelection(ids: Iterable<string>): void;
  setOverlay(p: Partial<OverlayState>): void;
  /** px on screen → world units at the current zoom. */
  px(n: number): number;
  /** Created objects: select, leave the creation tool, and optionally open the text editor. */
  finishCreate(ids: readonly string[], edit: boolean): void;
}

export interface Gesture {
  readonly kind: 'pan' | 'move' | 'resize' | 'marquee' | 'create' | 'wire' | 'endpoint' | 'pinch';
  move(w: Point, s: Point, m: Mods): void;
  end(w: Point, s: Point, m: Mods): void;
  cancel(): void;
}

const DRAG_PX = 3;

const snapOpts = (core: Core): SnapOptions => ({ threshold: core.px(6), grid: core.gridSize });

/** Rects of objects near `r` that can attract (boxes only), up to a cap. */
function neighbours(core: Core, r: Rect, exclude: ReadonlySet<string>): Rect[] {
  const out: Rect[] = [];
  for (const o of core.scene.query(rectInflate(r, core.px(240)))) {
    if (exclude.has(o.id) || isConnector(o)) continue;
    out.push(o);
    if (out.length >= 64) break;
  }
  return out;
}

// ── pan ─────────────────────────────────────────────────────────────────────

export class PanGesture implements Gesture {
  readonly kind = 'pan';
  private readonly start: Camera;
  constructor(private readonly core: Core, private readonly from: Point) {
    this.start = core.liveCamera;
  }
  move(_w: Point, s: Point): void {
    this.core.steerCamera({ ...this.start, tx: this.start.tx + (s.x - this.from.x), ty: this.start.ty + (s.y - this.from.y) });
  }
  end(): void {
    this.core.flushCamera();
  }
  cancel(): void {
    this.core.setCamera(this.start);
  }
}

// ── pinch ───────────────────────────────────────────────────────────────────

/**
 * Two fingers: zoom around their midpoint and follow it (pan + zoom in one gesture). Every step is relative
 * to the previous finger positions, so a scale held at a limit does not stick and a change of fingers
 * (`rebase`) continues from the new positions without a jump.
 */
export class PinchGesture implements Gesture {
  readonly kind = 'pinch';
  constructor(private readonly core: Core, private a: Point, private b: Point) {}
  /** Screen points of the two fingers. */
  update(a: Point, b: Point): void {
    this.core.steerCamera(pinchStep(this.core.liveCamera, this.a, this.b, a, b));
    this.a = a;
    this.b = b;
  }
  /** A different pair of fingers took over: measure from them now. */
  rebase(a: Point, b: Point): void {
    this.a = a;
    this.b = b;
  }
  move(): void {}
  end(): void {
    this.core.flushCamera();
  }
  cancel(): void {
    this.core.flushCamera();
  }
}

// ── move (+ Alt-duplicate) ──────────────────────────────────────────────────

export class MoveGesture implements Gesture {
  readonly kind = 'move';
  private ids: string[];
  private started = false;
  private wrote = false;
  private boxStart = new Map<string, Rect>();
  private freeStart = new Map<string, { from?: Point; to?: Point }>();
  private startRect: Rect | null = null;

  /** `onClickOnly` runs on release if the pointer never moved beyond the drag threshold. */
  constructor(
    private readonly core: Core,
    ids: Iterable<string>,
    private readonly fromWorld: Point,
    private readonly fromScreen: Point,
    private readonly onClickOnly: () => void,
  ) {
    this.ids = Array.from(ids);
    this.capture();
  }

  private capture(): void {
    this.boxStart.clear();
    this.freeStart.clear();
    const rects: Rect[] = [];
    for (const id of this.ids) {
      const o = this.core.scene.get(id);
      if (!o) continue;
      if (isConnector(o)) {
        const f: { from?: Point; to?: Point } = {};
        if (!isBound(o.from)) f.from = { x: o.from.x, y: o.from.y };
        if (!isBound(o.to)) f.to = { x: o.to.x, y: o.to.y };
        if (f.from || f.to) this.freeStart.set(id, f);
      } else {
        this.boxStart.set(id, { x: o.x, y: o.y, w: o.w, h: o.h });
        rects.push(o);
      }
    }
    this.startRect = boundsOf(rects);
  }

  move(w: Point, s: Point, m: Mods): void {
    if (!this.started) {
      if (Math.hypot(s.x - this.fromScreen.x, s.y - this.fromScreen.y) < DRAG_PX) return;
      this.started = true;
      this.core.doc.beginGesture();
      if (m.alt) {
        const copies = duplicate(this.core.scene, this.core.doc, this.ids, 0, 0);
        if (copies.length > 0) {
          this.ids = copies;
          this.core.setSelection(copies);
          this.capture();
        }
      }
    }
    let dx = w.x - this.fromWorld.x;
    let dy = w.y - this.fromWorld.y;
    if (m.shift) {
      if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
      else dx = 0;
    }
    let guides: OverlayState['guides'] = [];
    if (this.startRect && !m.mod) {
      const moving = { x: this.startRect.x + dx, y: this.startRect.y + dy, w: this.startRect.w, h: this.startRect.h };
      const snap = snapMove(moving, neighbours(this.core, moving, new Set(this.ids)), snapOpts(this.core));
      if (!m.shift || dx !== 0) dx += snap.dx;
      if (!m.shift || dy !== 0) dy += snap.dy;
      guides = snap.guides;
    }
    const patches = new Map<string, ObjectPatch>();
    for (const [id, r] of this.boxStart) patches.set(id, { x: r.x + dx, y: r.y + dy });
    for (const [id, f] of this.freeStart) {
      const p: ObjectPatch = {};
      if (f.from) p.from = { x: f.from.x + dx, y: f.from.y + dy };
      if (f.to) p.to = { x: f.to.x + dx, y: f.to.y + dy };
      patches.set(id, p);
    }
    this.core.doc.patchMany(patches);
    this.wrote = true;
    this.core.setOverlay({ guides });
  }

  end(): void {
    if (!this.started) {
      this.onClickOnly();
      return;
    }
    this.core.doc.endGesture();
    this.core.setOverlay({ guides: [] });
  }

  cancel(): void {
    if (!this.started) return;
    this.core.doc.endGesture();
    if (this.wrote) this.core.doc.undo.undo();
    this.core.setOverlay({ guides: [] });
  }
}

// ── resize ──────────────────────────────────────────────────────────────────

export class ResizeGesture implements Gesture {
  readonly kind = 'resize';
  private readonly group: Rect;
  private readonly items = new Map<string, BoxRec>();
  private began = false;

  constructor(private readonly core: Core, private readonly handle: HandleId, ids: Iterable<string>) {
    const rects: Rect[] = [];
    for (const id of ids) {
      const o = core.scene.get(id);
      if (o && isBox(o)) {
        this.items.set(id, o);
        rects.push(o);
      }
    }
    this.group = boundsOf(rects) ?? { x: 0, y: 0, w: 1, h: 1 };
  }

  move(w: Point, _s: Point, m: Mods): void {
    if (!this.began) {
      this.began = true;
      this.core.doc.beginGesture();
    }
    const single = this.items.size === 1 ? Array.from(this.items.values())[0] : undefined;
    const isText = single?.kind === 'text';
    // Text boxes size by width only; their height follows the content.
    const handle: HandleId = isText ? (this.handle.includes('w') ? 'w' : this.handle.includes('e') ? 'e' : this.handle) : this.handle;
    if (isText && handle !== 'w' && handle !== 'e') return;
    let p = w;
    let guides: OverlayState['guides'] = [];
    const keepAspect = m.shift && !isText;
    if (!m.mod && !keepAspect) {
      const sn = snapResizePoint(p, handle, neighbours(this.core, this.group, new Set(this.items.keys())), snapOpts(this.core));
      p = sn.p;
      guides = sn.guides;
    }
    const minW = isText ? DEFAULTS.minTextW : DEFAULTS.minBox;
    const next = resizeRect(this.group, handle, p, { keepAspect, minW, minH: isText ? 1 : DEFAULTS.minBox });
    const patches = new Map<string, ObjectPatch>();
    for (const [id, o] of this.items) {
      const r = mapRect(o, this.group, next);
      patches.set(id, o.kind === 'text' ? { x: r.x, w: r.w } : { x: r.x, y: r.y, w: r.w, h: r.h });
    }
    this.core.doc.patchMany(patches);
    this.core.setOverlay({ guides });
  }

  end(): void {
    if (this.began) this.core.doc.endGesture();
    this.core.setOverlay({ guides: [] });
  }

  cancel(): void {
    if (!this.began) return;
    this.core.doc.endGesture();
    this.core.doc.undo.undo();
    this.core.setOverlay({ guides: [] });
  }
}

// ── marquee ─────────────────────────────────────────────────────────────────

export class MarqueeGesture implements Gesture {
  readonly kind = 'marquee';
  private readonly base: Set<string>;
  constructor(private readonly core: Core, private readonly from: Point, additive: boolean) {
    this.base = additive ? new Set(core.selection) : new Set();
    if (!additive) core.setSelection([]);
  }
  move(w: Point): void {
    const r = rectFromPoints(this.from, w);
    const hits = this.core.scene.inRect(r).map((o) => o.id);
    this.core.setSelection([...this.base, ...hits]);
    this.core.setOverlay({ marquee: r });
  }
  end(): void {
    this.core.setOverlay({ marquee: null });
  }
  cancel(): void {
    this.core.setOverlay({ marquee: null });
  }
}

// ── create (sticky / text / shape) ──────────────────────────────────────────

export type CreateKind = 'sticky' | 'text' | 'shape';

export class CreateGesture implements Gesture {
  readonly kind = 'create';
  private dragged = false;
  constructor(
    private readonly core: Core,
    private readonly what: CreateKind,
    private readonly from: Point,
    private readonly fromScreen: Point,
  ) {}

  private rect(w: Point, m: Mods): Rect {
    const g = m.mod ? 0 : this.core.gridSize;
    const a = g ? { x: snapTo(this.from.x, g), y: snapTo(this.from.y, g) } : this.from;
    const b = g ? { x: snapTo(w.x, g), y: snapTo(w.y, g) } : w;
    return rectFromPoints(a, b);
  }

  move(w: Point, s: Point, m: Mods): void {
    if (!this.dragged && Math.hypot(s.x - this.fromScreen.x, s.y - this.fromScreen.y) < DRAG_PX * 2) return;
    this.dragged = true;
    this.core.setOverlay({ ghost: this.rect(w, m) });
  }

  end(w: Point, _s: Point, m: Mods): void {
    this.core.setOverlay({ ghost: null });
    const doc = this.core.doc;
    doc.checkpoint();
    let id: string | null;
    if (this.dragged) {
      const r = this.rect(w, m);
      const bw = Math.max(r.w, this.what === 'text' ? DEFAULTS.minTextW : DEFAULTS.minBox);
      const bh = Math.max(r.h, DEFAULTS.minBox);
      id = this.what === 'sticky'
        ? doc.create({ kind: 'sticky', x: r.x, y: r.y, w: bw, h: bh })
        : this.what === 'text'
          ? doc.create({ kind: 'text', x: r.x, y: r.y, w: bw })
          : doc.create({ kind: 'shape', shape: this.core.shapeKind, x: r.x, y: r.y, w: bw, h: bh });
    } else {
      const c = this.core.gridSize && !m.mod ? { x: snapTo(this.from.x, this.core.gridSize), y: snapTo(this.from.y, this.core.gridSize) } : this.from;
      id = this.what === 'sticky'
        ? doc.create({ kind: 'sticky', x: c.x - DEFAULTS.stickySize / 2, y: c.y - DEFAULTS.stickySize / 2 })
        : this.what === 'text'
          ? doc.create({ kind: 'text', x: c.x - 8, y: c.y - DEFAULTS.textSize })
          : doc.create({ kind: 'shape', shape: this.core.shapeKind, x: c.x - DEFAULTS.shapeW / 2, y: c.y - DEFAULTS.shapeH / 2 });
    }
    if (id) this.core.finishCreate([id], true);
  }

  cancel(): void {
    this.core.setOverlay({ ghost: null });
  }
}

// ── wire (connector tool) and endpoint drag ─────────────────────────────────

interface GlueTarget {
  id: string;
  side: ConcreteSide | 'auto';
  rect: Rect;
  anchors: Point[];
  active: Point | null;
}

/** Object under the pointer to glue to, with the side if the pointer is on one of its anchors. */
export function glueAt(core: Core, w: Point, exclude?: string): GlueTarget | null {
  // By area, not by what selection picks: an unfilled frame is a target everywhere inside it (selection stays outline-only).
  const o = core.scene.hitArea(w, core.px(6), (x) => isBox(x) && x.id !== exclude);
  if (!o || !isBox(o)) return null;
  const shape = o.kind === 'shape' ? o.shape : undefined;
  const anchors = SIDES.map((s) => ({ side: s, p: anchorPoint(o, shape, s) }));
  let best: { side: ConcreteSide; p: Point } | null = null;
  for (const a of anchors) if (dist(a.p, w) <= core.px(12) && (!best || dist(a.p, w) < dist(best.p, w))) best = a;
  return { id: o.id, side: best?.side ?? 'auto', rect: { x: o.x, y: o.y, w: o.w, h: o.h }, anchors: anchors.map((a) => a.p), active: best?.p ?? null };
}

const endpointOf = (g: GlueTarget | null, free: Point): Endpoint => (g ? { id: g.id, side: g.side } : { x: free.x, y: free.y });

function glueOverlay(g: GlueTarget | null): Pick<OverlayState, 'glue'> {
  return { glue: g ? { rect: g.rect, anchors: g.anchors, active: g.active } : null };
}

export class WireGesture implements Gesture {
  readonly kind = 'wire';
  private readonly source: GlueTarget | null;
  private readonly startPoint: Point;
  private target: GlueTarget | null = null;
  private moved = false;

  constructor(private readonly core: Core, from: Point, private readonly fromScreen: Point) {
    this.source = glueAt(core, from);
    this.startPoint = from;
  }

  move(w: Point, s: Point): void {
    if (!this.moved && Math.hypot(s.x - this.fromScreen.x, s.y - this.fromScreen.y) < DRAG_PX) return;
    this.moved = true;
    this.target = glueAt(this.core, w, this.source?.id);
    const a = this.source?.active ?? this.startPoint;
    const b = this.target?.active ?? w;
    this.core.setOverlay({ wire: [a.x, a.y, b.x, b.y], ...glueOverlay(this.target ?? this.source) });
  }

  end(w: Point): void {
    this.core.setOverlay({ wire: null, glue: null });
    if (!this.moved) return;
    const from = endpointOf(this.source, this.startPoint);
    const to = endpointOf(this.target, w);
    this.core.doc.checkpoint();
    const id = this.core.doc.create({ kind: 'connector', from, to, arrow: 'end', route: this.core.connectorRoute });
    if (id) this.core.finishCreate([id], false);
  }

  cancel(): void {
    this.core.setOverlay({ wire: null, glue: null });
  }
}

/** Dragging one end of the selected connector: re-glues it live. */
export class EndpointGesture implements Gesture {
  readonly kind = 'endpoint';
  private began = false;
  private wrote = false;
  private readonly other: string | undefined;

  constructor(private readonly core: Core, private readonly conn: ConnectorRec, private readonly end_: 'from' | 'to') {
    const e = end_ === 'from' ? conn.to : conn.from;
    this.other = isBound(e) ? e.id : undefined;
  }

  move(w: Point): void {
    if (!this.began) {
      this.began = true;
      this.core.doc.beginGesture();
    }
    const g = glueAt(this.core, w, this.other);
    const e = endpointOf(g, w);
    this.core.doc.patch(this.conn.id, this.end_ === 'from' ? { from: e } : { to: e });
    this.wrote = true;
    this.core.setOverlay(glueOverlay(g));
  }

  end(): void {
    if (this.began) this.core.doc.endGesture();
    this.core.setOverlay({ glue: null });
  }

  cancel(): void {
    if (this.began) {
      this.core.doc.endGesture();
      if (this.wrote) this.core.doc.undo.undo();
    }
    this.core.setOverlay({ glue: null });
  }
}

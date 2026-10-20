import { pinchStep, type Camera } from '../../../lib/canvas/camera';
import { duplicate } from '../../../lib/canvas/clipboard';
import type { CanvasDoc } from '../../../lib/canvas/doc';
import {
  ROT_STEP, angleToward, boundsOf, dist, mapRect, normRot, rectCenter, rectFromPoints, rectInflate, resizeRect, resizeRotated, rotatePoint, snapAngle, snapTo,
  type HandleId, type Point, type Rect,
} from '../../../lib/canvas/geometry';
import { anchorOf, SIDES, type ConcreteSide } from '../../../lib/canvas/route';
import type { Scene } from '../../../lib/canvas/scene';
import { snapMove, snapResizePoint, type SnapOptions } from '../../../lib/canvas/snap';
import {
  DEFAULTS, aabb, isBound, isBox, isConnector,
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
  /** The ids plus every member of their groups (the unlocked ones; a group the user stepped into stays as picked). */
  expandUnits(ids: Iterable<string>): string[];
  /** Touch editing (the phone): glue targets are found from further away, a finger being what it is. */
  readonly touch?: boolean;
}

export interface Gesture {
  readonly kind: 'pan' | 'move' | 'resize' | 'rotate' | 'marquee' | 'create' | 'wire' | 'endpoint' | 'pinch' | 'tap';
  move(w: Point, s: Point, m: Mods): void;
  end(w: Point, s: Point, m: Mods): void;
  cancel(): void;
}

const DRAG_PX = 3;
/** A finger wanders: a touch counts as a tap (or a press that has not started to drag) within this many px. */
export const TOUCH_SLOP_PX = 8;
/** How far from an object (px) a finger still means it when wiring a connector, and from an anchor to snap to it. */
const GLUE_PX = 6;
const TOUCH_GLUE_PX = 16;
const ANCHOR_PX = 12;
const TOUCH_ANCHOR_PX = 24;

const snapOpts = (core: Core): SnapOptions => ({ threshold: core.px(6), grid: core.gridSize });

/** Rects of objects near `r` that can attract (boxes only), up to a cap. */
function neighbours(core: Core, r: Rect, exclude: ReadonlySet<string>): Rect[] {
  const out: Rect[] = [];
  for (const o of core.scene.query(rectInflate(r, core.px(240)))) {
    if (exclude.has(o.id) || isConnector(o)) continue;
    out.push(aabb(o));
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

// ── tap or pan (touch editing) ──────────────────────────────────────────────

/**
 * A touch on an empty place or on an object that is not selected: a tap runs `onTap`, a drag pans the view (so a scroll
 * never moves anything by accident). Past the slop the camera follows the finger from where it started; a second finger
 * cancels without undoing the pan, like a pan does.
 */
export class TapPanGesture implements Gesture {
  readonly kind = 'tap';
  private readonly start: Camera;
  private moved = false;
  private spent = false;
  constructor(private readonly core: Core, private readonly from: Point, private readonly onTap: () => void) {
    this.start = core.liveCamera;
  }
  get panned(): boolean {
    return this.moved;
  }
  /** The press became something else (a long press): lifting the finger is not a tap. */
  consume(): void {
    this.spent = true;
  }
  move(_w: Point, s: Point): void {
    if (this.spent) return;
    if (!this.moved) {
      if (Math.hypot(s.x - this.from.x, s.y - this.from.y) < TOUCH_SLOP_PX) return;
      this.moved = true;
    }
    this.core.steerCamera({ ...this.start, tx: this.start.tx + (s.x - this.from.x), ty: this.start.ty + (s.y - this.from.y) });
  }
  end(): void {
    if (this.moved) this.core.flushCamera();
    else if (!this.spent) this.onTap();
  }
  cancel(): void {
    if (this.moved) this.core.flushCamera();
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
  private boxStart = new Map<string, Point>();
  private freeStart = new Map<string, { from?: Point; to?: Point }>();
  private startRect: Rect | null = null;

  /** `onClickOnly` runs on release if the pointer never moved beyond the drag threshold. */
  constructor(
    private readonly core: Core,
    ids: Iterable<string>,
    private readonly fromWorld: Point,
    private readonly fromScreen: Point,
    private readonly onClickOnly: () => void,
    private readonly slop = DRAG_PX,
  ) {
    // Locked objects stay where they are, whatever else moves with them.
    this.ids = Array.from(ids).filter((id) => !core.scene.get(id)?.locked);
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
        this.boxStart.set(id, { x: o.x, y: o.y });
        rects.push(aabb(o));
      }
    }
    this.startRect = boundsOf(rects);
  }

  move(w: Point, s: Point, m: Mods): void {
    if (this.started && this.ids.length === 0) return;
    if (!this.started) {
      if (Math.hypot(s.x - this.fromScreen.x, s.y - this.fromScreen.y) < this.slop) return;
      this.started = true;
      if (this.ids.length === 0) return;
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
    if (this.ids.length === 0) return;
    this.core.doc.endGesture();
    this.core.setOverlay({ guides: [] });
  }

  cancel(): void {
    if (!this.started || this.ids.length === 0) return;
    this.core.doc.endGesture();
    if (this.wrote) this.core.doc.undo.undo();
    this.core.setOverlay({ guides: [] });
  }
}

// ── resize ──────────────────────────────────────────────────────────────────

/**
 * Resize by one handle. One box (rotated or not): along its own axes, the opposite side/corner stays put in the
 * world. Several boxes (unrotated, ungrouped — the frame only offers handles then): the group box is scaled
 * and every member mapped through it. A group is never resized (its frame has rotation and move only).
 */
export class ResizeGesture implements Gesture {
  readonly kind = 'resize';
  private readonly group: Rect;
  private readonly items = new Map<string, BoxRec>();
  private began = false;

  constructor(private readonly core: Core, private readonly handle: HandleId, ids: Iterable<string>) {
    const rects: Rect[] = [];
    for (const id of ids) {
      const o = core.scene.get(id);
      if (o && isBox(o) && !o.locked) {
        this.items.set(id, o);
        rects.push(aabb(o));
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
    const rot = single?.rot ?? 0;
    let p = w;
    let guides: OverlayState['guides'] = [];
    const keepAspect = m.shift && !isText;
    // Snapping works on the world axes: a rotated box is free of it.
    if (!m.mod && !keepAspect && rot === 0) {
      const sn = snapResizePoint(p, handle, neighbours(this.core, this.group, new Set(this.items.keys())), snapOpts(this.core));
      p = sn.p;
      guides = sn.guides;
    }
    const minW = isText ? DEFAULTS.minTextW : DEFAULTS.minBox;
    const minH = isText ? 1 : DEFAULTS.minBox;
    const patches = new Map<string, ObjectPatch>();
    if (single) {
      const r = resizeRotated(single, rot, handle, p, { keepAspect, minW, minH });
      patches.set(single.id, isText ? (rot === 0 ? { x: r.x, w: r.w } : { x: r.x, y: r.y, w: r.w }) : { x: r.x, y: r.y, w: r.w, h: r.h });
    } else {
      const next = resizeRect(this.group, handle, p, { keepAspect, minW, minH });
      for (const [id, o] of this.items) {
        const r = mapRect(o, this.group, next);
        patches.set(id, o.kind === 'text' ? { x: r.x, w: r.w } : { x: r.x, y: r.y, w: r.w, h: r.h });
      }
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

// ── rotate ──────────────────────────────────────────────────────────────────

/**
 * Turns the selected boxes about the center of their joint bounds (a single box: about its own center). Each
 * box gets its position turned about the pivot and its own `rot` advanced by the same angle; free connector
 * ends turn with them, glued ones follow their objects. Shift snaps to 15° (one box: the angle itself,
 * several: the turn). Locked objects are left out.
 */
export class RotateGesture implements Gesture {
  readonly kind = 'rotate';
  private readonly pivot: Point;
  private readonly startAngle: number;
  private readonly boxes: { id: string; c: Point; rot: number }[] = [];
  private readonly free = new Map<string, { from?: Point; to?: Point }>();
  private began = false;

  constructor(private readonly core: Core, ids: Iterable<string>, from: Point) {
    const rects: Rect[] = [];
    for (const id of ids) {
      const o = core.scene.get(id);
      if (!o || o.locked) continue;
      if (isConnector(o)) {
        const f: { from?: Point; to?: Point } = {};
        if (!isBound(o.from)) f.from = { x: o.from.x, y: o.from.y };
        if (!isBound(o.to)) f.to = { x: o.to.x, y: o.to.y };
        if (f.from || f.to) this.free.set(id, f);
      } else {
        this.boxes.push({ id, c: rectCenter(o), rot: o.rot ?? 0 });
        rects.push(aabb(o));
      }
    }
    const b = boundsOf(rects);
    this.pivot = b ? rectCenter(b) : from;
    this.startAngle = angleToward(this.pivot, from);
  }

  /** Signed turn since the start, degrees in (-180, 180]. */
  private turn(w: Point, shift: boolean): number {
    let d = angleToward(this.pivot, w) - this.startAngle;
    d = ((((d + 180) % 360) + 360) % 360) - 180;
    if (!shift) return d;
    const only = this.boxes.length === 1 ? this.boxes[0] : undefined;
    return only ? snapAngle(only.rot + d, ROT_STEP) - only.rot : snapAngle(d, ROT_STEP);
  }

  move(w: Point, _s: Point, m: Mods): void {
    if (this.boxes.length === 0) return;
    if (!this.began) {
      this.began = true;
      this.core.doc.beginGesture();
    }
    const d = this.turn(w, m.shift);
    const patches = new Map<string, ObjectPatch>();
    for (const b of this.boxes) {
      const o = this.core.scene.get(b.id);
      if (!o) continue;
      const c = rotatePoint(b.c, this.pivot, d);
      patches.set(b.id, { x: c.x - o.w / 2, y: c.y - o.h / 2, rot: normRot(b.rot + d) });
    }
    for (const [id, f] of this.free) {
      const p: ObjectPatch = {};
      if (f.from) p.from = rotatePoint(f.from, this.pivot, d);
      if (f.to) p.to = rotatePoint(f.to, this.pivot, d);
      patches.set(id, p);
    }
    this.core.doc.patchMany(patches);
  }

  end(): void {
    if (this.began) this.core.doc.endGesture();
  }

  cancel(): void {
    if (!this.began) return;
    this.core.doc.endGesture();
    this.core.doc.undo.undo();
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
    // Locked objects are not picked by a frame; a touched group is taken whole.
    const hits = this.core.expandUnits(this.core.scene.inRect(r).filter((o) => !o.locked).map((o) => o.id));
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
  rot: number;
  anchors: Point[];
  active: Point | null;
}

/** Object under the pointer to glue to, with the side if the pointer is on one of its anchors. */
export function glueAt(core: Core, w: Point, exclude?: string): GlueTarget | null {
  // By area, not by what selection picks: an unfilled frame is a target everywhere inside it (selection stays outline-only).
  const o = core.scene.hitArea(w, core.px(core.touch ? TOUCH_GLUE_PX : GLUE_PX), (x) => isBox(x) && x.id !== exclude) ?? (core.touch ? nearestBox(core, w, exclude) : null);
  if (!o || !isBox(o)) return null;
  const anchors = SIDES.map((s) => ({ side: s, p: anchorOf(o, s) }));
  let best: { side: ConcreteSide; p: Point } | null = null;
  const near = core.px(core.touch ? TOUCH_ANCHOR_PX : ANCHOR_PX);
  for (const a of anchors) if (dist(a.p, w) <= near && (!best || dist(a.p, w) < dist(best.p, w))) best = a;
  return { id: o.id, side: best?.side ?? 'auto', rect: { x: o.x, y: o.y, w: o.w, h: o.h }, rot: o.rot ?? 0, anchors: anchors.map((a) => a.p), active: best?.p ?? null };
}

/** A finger's release lands near, not on: the box (stickies and texts have no tolerance of their own) closest within the touch radius. */
function nearestBox(core: Core, w: Point, exclude: string | undefined): BoxRec | null {
  const tol = core.px(TOUCH_GLUE_PX);
  let best: BoxRec | null = null;
  let bestD = Infinity;
  for (const o of core.scene.query({ x: w.x - tol, y: w.y - tol, w: 2 * tol, h: 2 * tol })) {
    if (!isBox(o) || o.id === exclude) continue;
    const dx = Math.max(o.x - w.x, 0, w.x - (o.x + o.w));
    const dy = Math.max(o.y - w.y, 0, w.y - (o.y + o.h));
    const d = Math.hypot(dx, dy);
    if (d <= tol && d < bestD) {
      best = o;
      bestD = d;
    }
  }
  return best;
}

const endpointOf = (g: GlueTarget | null, free: Point): Endpoint => (g ? { id: g.id, side: g.side } : { x: free.x, y: free.y });

function glueOverlay(g: GlueTarget | null): Pick<OverlayState, 'glue'> {
  return { glue: g ? { rect: g.rect, rot: g.rot, anchors: g.anchors, active: g.active } : null };
}

export class WireGesture implements Gesture {
  readonly kind = 'wire';
  private readonly source: GlueTarget | null;
  private readonly startPoint: Point;
  private target: GlueTarget | null = null;
  private moved = false;

  constructor(private readonly core: Core, from: Point, private readonly fromScreen: Point, private readonly slop = DRAG_PX) {
    this.source = glueAt(core, from);
    this.startPoint = from;
  }

  move(w: Point, s: Point): void {
    if (!this.moved && Math.hypot(s.x - this.fromScreen.x, s.y - this.fromScreen.y) < this.slop) return;
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

import { pinchStep, type Camera } from '../../../lib/canvas/camera';
import { duplicate } from '../../../lib/canvas/clipboard';
import type { CanvasDoc } from '../../../lib/canvas/doc';
import { INK_EPS_PX, INK_MAX_ERASE, INK_RAW_MAX, inkErase, inkFromStroke, inkPoints, inkSegDistance, swathToStored, swathsCover, tailRect } from '../../../lib/canvas/ink';
import type { LiveLayer } from '../../../lib/canvas/live';
import {
  ROT_STEP, angleToward, boundsOf, dist, mapRect, normRot, rectCenter, rectFromPoints, rectInflate, resizeRect, resizeRotated, rotatePoint, snapAngle, snapTo,
  type HandleId, type Point, type Rect,
} from '../../../lib/canvas/geometry';
import { anchorOf, curveControls, flattenCubic, routeConnector, SIDE_DIR, SIDES, type ConcreteSide } from '../../../lib/canvas/route';
import type { Scene } from '../../../lib/canvas/scene';
import { snapMove, snapResizePoint, type SnapOptions } from '../../../lib/canvas/snap';
import { SHAPE_TEXT_SIZE, STICKY_TEXT_SIZE } from '../../../lib/canvas/textLayout';
import {
  DEFAULTS, aabb, isBound, isBox, isConnector,
  type BoxRec, type ConnectorRec, type Endpoint, type ObjectPatch, type ShapeRec, type StickyRec, type RouteKind, type ShapeKind,
} from '../../../lib/canvas/types';
import type { InkPreview, OverlayState } from './overlay';
import { edgeMid, QUICK_ROUTE } from './quick';

/** What the pen draws with now (remembered for the session by the engine). */
export interface InkStyle {
  readonly color: string;
  readonly width: number;
  readonly marker: boolean;
}

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
  /** Where a gesture shows its fields while it runs; the document is written once, on release (`commit`). */
  readonly live: LiveLayer;
  readonly camera: Camera;
  /** The camera including queued gesture input; continuous gestures (pan, pinch) build on it. */
  readonly liveCamera: Camera;
  readonly selection: ReadonlySet<string>;
  readonly shapeKind: ShapeKind;
  readonly stickyColor: string;
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
  /** The pen's color, width and kind. */
  readonly inkStyle: InkStyle;
  /** The size a click of the «Фрейм» tool places. */
  readonly frameSize: { readonly w: number; readonly h: number };
  /** The title a new frame gets («Фрейм 3»). */
  nextFrameTitle(): string;
  /** The eraser's radius, screen px. */
  readonly eraserPx: number;
  /** Shows the stroke in progress (null: none); `dirty` is the world rect that changed since the last call (null: all of it). */
  previewInk(ink: InkPreview | null, dirty: Rect | null): void;
  /** A create was refused by the document (the object or state limit): said to the user, not swallowed. */
  refuseCreate(): void;
  /** A «continue» line released on empty canvas: the line stays and the drop menu opens at its end. */
  openQuickDrop(src: string, side: ConcreteSide, from: Point, at: Point): void;
  /** A drag starts moving these: the renderer may paint them as one sprite until `dropMoving` (Renderer.liftObjects). */
  liftMoving?(ids: readonly string[]): void;
  dropMoving?(): void;
}

export interface Gesture {
  readonly kind: 'pan' | 'move' | 'resize' | 'rotate' | 'marquee' | 'create' | 'wire' | 'endpoint' | 'pinch' | 'tap' | 'draw' | 'erase' | 'quick';
  move(w: Point, s: Point, m: Mods): void;
  end(w: Point, s: Point, m: Mods): void;
  cancel(): void;
  /**
   * The release was lost (a new touch began while this one was still down): keep what the gesture shows, as a release
   * would, without what a release adds itself (a click, a new object). Gestures without it are cancelled.
   */
  settle?(): void;
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
  settle(): void {
    this.core.flushCamera();
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
  private boxStart = new Map<string, Point>();
  private freeStart = new Map<string, { from?: Point; to?: Point }>();
  private startRect: Rect | null = null;
  /** The selection before an Alt-drag moved it onto the copies; Esc gives it back. */
  private selectedBefore: string[] | null = null;

  /** `onClickOnly` runs on release if the pointer never moved beyond the drag threshold. */
  constructor(
    private readonly core: Core,
    ids: Iterable<string>,
    private readonly fromWorld: Point,
    private readonly fromScreen: Point,
    private readonly onClickOnly: () => void,
    private readonly slop = DRAG_PX,
    /**
     * A sticky pad's drag: makes the objects that move instead (a new sticky pulled off the pad), inside the drag's
     * gesture, so Esc or undo takes it back. Alt-drag moves the pad itself. Works on a locked pad too.
     */
    private readonly spawn?: () => string[],
  ) {
    // Locked objects stay where they are, whatever else moves with them. A frame takes what it holds along (computed
    // now: an object dragged in or out later is simply in or out).
    const free = (id: string): boolean => !core.scene.get(id)?.locked;
    this.ids = core.scene.withFrameMembers(Array.from(ids).filter(free)).filter(free);
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
      const pull = m.alt ? undefined : this.spawn;
      if (this.ids.length === 0 && !pull) return;
      this.core.doc.beginGesture();
      if (pull) {
        const made = pull();
        this.selectedBefore = [...this.core.selection];
        this.ids = made;
        if (made.length > 0) this.core.setSelection(made);
        this.capture();
        if (made.length === 0) {
          this.core.doc.cancelGesture();
          // The object limit: said, not swallowed.
          this.core.refuseCreate();
          return;
        }
      } else if (m.alt && !this.spawn) {
        const copies = duplicate(this.core.scene, this.core.doc, this.ids, 0, 0);
        if (copies.length > 0) {
          this.selectedBefore = [...this.core.selection];
          this.ids = copies;
          this.core.setSelection(copies);
          this.capture();
        }
      }
      this.core.liftMoving?.(this.ids);
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
    this.core.live.preview(patches);
    this.core.setOverlay({ guides });
  }

  end(): void {
    if (!this.started) {
      this.onClickOnly();
      return;
    }
    if (this.ids.length === 0) return;
    this.core.live.commit();
    this.core.dropMoving?.();
    this.core.doc.endGesture();
    this.core.setOverlay({ guides: [] });
  }

  cancel(): void {
    if (!this.started || this.ids.length === 0) return;
    this.core.live.drop();
    this.core.dropMoving?.();
    // Takes back the Alt-copies, if any; the move itself was never written.
    this.core.doc.cancelGesture();
    if (this.selectedBefore) this.core.setSelection(this.selectedBefore);
    this.core.setOverlay({ guides: [] });
  }

  settle(): void {
    if (this.started) this.end();
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
    // A picture never stretches: its aspect ratio is kept without Shift (and so is the whole selection's around it).
    const keepAspect = (m.shift && !isText) || [...this.items.values()].some((o) => o.kind === 'image');
    // Snapping works on the world axes: a rotated box is free of it.
    if (!m.mod && !keepAspect && rot === 0) {
      const sn = snapResizePoint(p, handle, neighbours(this.core, this.group, new Set(this.items.keys())), snapOpts(this.core));
      p = sn.p;
      guides = sn.guides;
    }
    const isFrame = single?.kind === 'frame';
    const minW = isText ? DEFAULTS.minTextW : isFrame ? DEFAULTS.minFrame : DEFAULTS.minBox;
    const minH = isText ? 1 : isFrame ? DEFAULTS.minFrame : DEFAULTS.minBox;
    const patches = new Map<string, ObjectPatch>();
    if (single) {
      const r = resizeRotated(single, rot, handle, p, { keepAspect, minW, minH });
      patches.set(single.id, isText ? (rot === 0 ? { x: r.x, w: r.w } : { x: r.x, y: r.y, w: r.w }) : { x: r.x, y: r.y, w: r.w, h: r.h });
    } else {
      const next = resizeRect(this.group, handle, p, { keepAspect, minW, minH });
      for (const [id, o] of this.items) {
        const r = mapRect(o, this.group, next);
        // A text's height follows its content, but its top moves with the group like everyone else's.
        patches.set(id, o.kind === 'text' ? { x: r.x, y: r.y, w: r.w } : { x: r.x, y: r.y, w: r.w, h: r.h });
      }
    }
    this.core.live.preview(patches);
    this.core.setOverlay({ guides });
  }

  end(): void {
    if (this.began) {
      this.core.live.commit();
      this.core.doc.endGesture();
    }
    this.core.setOverlay({ guides: [] });
  }

  cancel(): void {
    if (!this.began) return;
    this.core.live.drop();
    this.core.doc.cancelGesture();
    this.core.setOverlay({ guides: [] });
  }

  settle(): void {
    this.end();
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
      // A frame never turns.
      if (!o || o.locked || o.kind === 'frame') continue;
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
    this.core.live.preview(patches);
    const only = this.boxes.length === 1 ? this.boxes[0] : undefined;
    // One box: its absolute angle; several: the signed turn. `+ 0` folds a rounded -0 into 0.
    this.core.setOverlay({ angle: { at: w, deg: (Math.round(only ? normRot(only.rot + d) : d) % 360) + 0 } });
  }

  end(): void {
    this.core.setOverlay({ angle: null });
    if (!this.began) return;
    this.core.live.commit();
    this.core.doc.endGesture();
  }

  cancel(): void {
    this.core.setOverlay({ angle: null });
    if (!this.began) return;
    this.core.live.drop();
    this.core.doc.cancelGesture();
  }

  settle(): void {
    this.end();
  }
}

// ── marquee ─────────────────────────────────────────────────────────────────

export class MarqueeGesture implements Gesture {
  readonly kind = 'marquee';
  private readonly base: Set<string>;
  /** Esc gives back what was selected before the frame. */
  private readonly before: string[];
  constructor(private readonly core: Core, private readonly from: Point, additive: boolean) {
    this.before = [...core.selection];
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
    this.core.setSelection(this.before);
    this.core.setOverlay({ marquee: null });
  }
}

// ── create (sticky / text / shape) ──────────────────────────────────────────

export type CreateKind = 'sticky' | 'text' | 'shape' | 'frame';

/** The steps a new object's size takes with the zoom (`createScale`): tidy sizes, not one per wheel tick. */
const CREATE_STEPS: readonly number[] = [0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8];

/**
 * How much bigger (in world units) a new object is made so that it looks about as big on screen as at 100 % (owner
 * 30.10: zoomed out, a new sticky was a speck): `worldPerPx` is the world size of a screen pixel; the nearest step in
 * log scale, 0.5 (zoomed in) … 8 (zoomed far out).
 */
export function createScale(worldPerPx: number): number {
  const want = Math.log(Math.max(1e-6, worldPerPx));
  let best = 1;
  for (const s of CREATE_STEPS) if (Math.abs(Math.log(s) - want) < Math.abs(Math.log(best) - want)) best = s;
  return best;
}

/** The text size fields of a new sticky or shape made `k` times bigger (none at 1: the default token). */
export function scaledFont(kind: 'sticky' | 'shape', k: number): { fontPx?: number } {
  if (k === 1) return {};
  return { fontPx: Math.min(DEFAULTS.maxTextSize, Math.round((kind === 'sticky' ? STICKY_TEXT_SIZE : SHAPE_TEXT_SIZE) * k)) };
}

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
    if (this.what === 'frame') {
      // A drag draws it; a click places the armed size centered on the pointer. Neither opens a text editor.
      const r = this.dragged ? this.rect(w, m) : null;
      const fk = createScale(this.core.px(1));
      const fw = this.core.frameSize.w * fk;
      const fh = this.core.frameSize.h * fk;
      id = doc.create(r
        ? { kind: 'frame', x: r.x, y: r.y, w: Math.max(r.w, DEFAULTS.minFrame), h: Math.max(r.h, DEFAULTS.minFrame), title: this.core.nextFrameTitle() }
        : { kind: 'frame', x: snapTo(this.from.x - fw / 2, this.core.gridSize || 1), y: snapTo(this.from.y - fh / 2, this.core.gridSize || 1), w: fw, h: fh, title: this.core.nextFrameTitle() });
      this.core.finishCreate(id ? [id] : [], false);
      return;
    }
    // Sized for the zoom: a click zoomed out makes a sticky that looks like one at 100 %, its text too.
    const k = createScale(this.core.px(1));
    const textSize = Math.min(DEFAULTS.maxTextSize, Math.round(DEFAULTS.textSize * k));
    if (this.dragged) {
      const r = this.rect(w, m);
      const bw = Math.max(r.w, this.what === 'text' ? DEFAULTS.minTextW : DEFAULTS.minBox);
      const bh = Math.max(r.h, DEFAULTS.minBox);
      id = this.what === 'sticky'
        ? doc.create({ kind: 'sticky', color: this.core.stickyColor, x: r.x, y: r.y, w: bw, h: bh, ...scaledFont('sticky', k) })
        : this.what === 'text'
          ? doc.create({ kind: 'text', x: r.x, y: r.y, w: bw, size: textSize })
          : doc.create({ kind: 'shape', shape: this.core.shapeKind, x: r.x, y: r.y, w: bw, h: bh, ...scaledFont('shape', k) });
    } else {
      const c = this.core.gridSize && !m.mod ? { x: snapTo(this.from.x, this.core.gridSize), y: snapTo(this.from.y, this.core.gridSize) } : this.from;
      const sw = DEFAULTS.stickySize * k;
      id = this.what === 'sticky'
        ? doc.create({ kind: 'sticky', color: this.core.stickyColor, x: c.x - sw / 2, y: c.y - sw / 2, w: sw, h: sw, ...scaledFont('sticky', k) })
        : this.what === 'text'
          ? doc.create({ kind: 'text', x: c.x - 8 * k, y: c.y - textSize, w: DEFAULTS.textW * k, size: textSize })
          : doc.create({
            kind: 'shape', shape: this.core.shapeKind, x: c.x - (DEFAULTS.shapeW * k) / 2, y: c.y - (DEFAULTS.shapeH * k) / 2,
            w: DEFAULTS.shapeW * k, h: DEFAULTS.shapeH * k, ...scaledFont('shape', k),
          });
    }
    this.core.finishCreate(id ? [id] : [], true);
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
  // A freehand stroke is no target: a scribble has no sides to route to.
  const o = core.scene.hitArea(w, core.px(core.touch ? TOUCH_GLUE_PX : GLUE_PX), (x) => isBox(x) && x.kind !== 'ink' && x.id !== exclude) ?? (core.touch ? nearestBox(core, w, exclude) : null);
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
    if (!isBox(o) || o.kind === 'ink' || o.id === exclude) continue;
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
    this.core.finishCreate(id ? [id] : [], false);
  }

  cancel(): void {
    this.core.setOverlay({ wire: null, glue: null });
  }
}

// ── «continue» drag (engine/quick.ts) ───────────────────────────────────────

/**
 * Pressed on a «continue» dot. A click (no drag) is the quick copy beside the source (`click`). A drag pulls a wire
 * out of that side — a dashed line that follows the pointer, nothing else is drawn on the way: over another object it
 * glues to it and the release just connects the two; released on empty canvas, the line stays and the drop menu
 * opens at its end (the engine's `openQuickDrop`: what to put there). Esc puts the dots back.
 */
export class QuickGesture implements Gesture {
  readonly kind = 'quick';
  private dragged = false;
  private target: GlueTarget | null = null;
  private at: Point | null = null;

  constructor(
    private readonly core: Core,
    private readonly src: StickyRec | ShapeRec,
    private readonly side: ConcreteSide,
    private readonly fromScreen: Point,
    private readonly click: () => void,
    private readonly restore: () => void,
  ) {}

  move(w: Point, s: Point, m: Mods): void {
    if (!this.dragged && Math.hypot(s.x - this.fromScreen.x, s.y - this.fromScreen.y) < DRAG_PX * 2) return;
    this.dragged = true;
    const a = edgeMid(this.src, this.side);
    // A frame or zone the source sits in is the place, not a target: the line ends on empty canvas there.
    const hit = glueAt(this.core, w, this.src.id);
    const holder = hit ? this.core.scene.get(hit.id) : undefined;
    const src = this.src;
    const holds = !!holder && !isConnector(holder) && holder.x <= src.x && holder.y <= src.y && holder.x + holder.w >= src.x + src.w && holder.y + holder.h >= src.y + src.h;
    this.target = hit && holder && holder.kind !== 'frame' && !holds ? hit : null;
    if (this.target) {
      this.at = null;
      this.core.setOverlay({ quick: null, ghost: null, wire: this.glued(this.target), ...glueOverlay(this.target) });
      return;
    }
    const g = m.mod ? 0 : this.core.gridSize;
    this.at = g ? { x: snapTo(w.x, g), y: snapTo(w.y, g) } : w;
    this.core.setOverlay({ quick: null, ghost: null, wire: this.arc(a, this.at), glue: null });
  }

  /** Over a target: exactly the connector that release creates (same ends, same route), so nothing jumps on drop. */
  private glued(t: GlueTarget): number[] {
    const lookup = (id: string): BoxRec | undefined => {
      const o = this.core.scene.get(id);
      return o && isBox(o) ? o : undefined;
    };
    return routeConnector({ id: this.src.id, side: this.side }, { id: t.id, side: t.side }, QUICK_ROUTE, lookup).points;
  }

  /**
   * The free line as an arc: it leaves the source along its side's normal and arrives heading straight from the start.
   * That end direction turns continuously with the pointer (a curved connector's free end snaps to an axis, which
   * flips the arc by 90° on the diagonal).
   */
  private arc(a: Point, b: Point): number[] {
    const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const from = { p: a, dir: SIDE_DIR[this.side], target: null, side: null };
    const to = { p: b, dir: { x: (a.x - b.x) / d, y: (a.y - b.y) / d }, target: null, side: null };
    const [c1, c2] = curveControls(from, to);
    return flattenCubic(a, c1, c2, b);
  }

  end(): void {
    if (!this.dragged) {
      this.click();
      return;
    }
    if (this.target) {
      this.core.setOverlay({ wire: null, glue: null });
      this.core.doc.checkpoint();
      const from = { id: this.src.id, side: this.side };
      const id = this.core.doc.create({ kind: 'connector', from, to: { id: this.target.id, side: this.target.side }, arrow: 'end', route: QUICK_ROUTE });
      this.core.finishCreate(id ? [id] : [], false);
      return;
    }
    if (!this.at) {
      this.core.setOverlay({ wire: null, glue: null });
      this.restore();
      return;
    }
    // The line stays drawn while the menu is open.
    this.core.openQuickDrop(this.src.id, this.side, edgeMid(this.src, this.side), this.at);
  }

  cancel(): void {
    this.core.setOverlay({ ghost: null, wire: null, glue: null });
    this.restore();
  }
}

/** Dragging one end of the selected connector: re-glues it live. */
export class EndpointGesture implements Gesture {
  readonly kind = 'endpoint';
  private began = false;
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
    this.core.live.preview(new Map([[this.conn.id, this.end_ === 'from' ? { from: e } : { to: e }]]));
    this.core.setOverlay(glueOverlay(g));
  }

  end(): void {
    if (this.began) {
      this.core.live.commit();
      this.core.doc.endGesture();
    }
    this.core.setOverlay({ glue: null });
  }

  cancel(): void {
    if (this.began) {
      this.core.live.drop();
      this.core.doc.cancelGesture();
    }
    this.core.setOverlay({ glue: null });
  }

  settle(): void {
    this.end();
  }
}

// ── draw (pen / marker) ─────────────────────────────────────────────────────

/**
 * A freehand stroke (ADR-0127 addendum 2026-10-29). The points are collected in world units and shown by the overlay
 * (each move repaints only the stroke's tail); the document is written once, on release: one object, one undo step.
 * Points closer than half a screen pixel to the last one are skipped; past INK_RAW_MAX the rest of the drag is not
 * recorded.
 */
export class DrawGesture implements Gesture {
  readonly kind = 'draw';
  private readonly pts: number[] = [];
  private readonly style: InkStyle;
  private done = false;

  constructor(private readonly core: Core, from: Point) {
    this.style = core.inkStyle;
    this.pts.push(from.x, from.y);
    core.previewInk(this.preview(), null);
  }

  private preview(): InkPreview {
    return { points: this.pts, color: this.style.color, width: this.style.width, marker: this.style.marker };
  }

  /** World points collected so far (tests). */
  get points(): readonly number[] {
    return this.pts;
  }

  move(w: Point): void {
    if (this.done || this.pts.length >= 2 * INK_RAW_MAX) return;
    const lx = this.pts[this.pts.length - 2] ?? 0;
    const ly = this.pts[this.pts.length - 1] ?? 0;
    if (Math.hypot(w.x - lx, w.y - ly) < this.core.px(0.5)) return;
    this.pts.push(w.x, w.y);
    // One more point reshapes the last two spline pieces (the one before it bends toward it): the last four points' hull.
    this.core.previewInk(this.preview(), tailRect(this.pts, 4, this.style.width / 2 + this.core.px(2)));
  }

  end(w: Point): void {
    if (this.done) return;
    this.move(w);
    this.done = true;
    this.core.previewInk(null, null);
    const ink = inkFromStroke(this.pts, this.core.px(INK_EPS_PX));
    if (!ink) return;
    const doc = this.core.doc;
    doc.checkpoint();
    const id = doc.create({ kind: 'ink', ...ink, stroke: this.style.color, strokeWidth: this.style.width, ...(this.style.marker ? { marker: true } : {}) });
    doc.checkpoint();
    if (!id) this.core.refuseCreate();
  }

  cancel(): void {
    this.done = true;
    this.core.previewInk(null, null);
  }

  /** A finger's lost release: the line it drew is kept. */
  settle(): void {
    const x = this.pts[this.pts.length - 2] ?? 0;
    const y = this.pts[this.pts.length - 1] ?? 0;
    this.end({ x, y });
  }
}

// ── eraser ──────────────────────────────────────────────────────────────────

/**
 * The area eraser (ADR-0127 addendum 2026-10-29): the drag is a swath as wide as the ring the cursor shows, and each
 * stroke under it keeps the part of the swath that touches it (`erase` on the stroke, cut out when drawn): exactly the
 * covered area goes, a wide marker included, and the stroke stays one object. Shown at once through the live layer,
 * written once on release (one undo step); a stroke the swaths cover entirely is deleted instead. Locked strokes and
 * other kinds are left alone.
 */
export class EraseGesture implements Gesture {
  readonly kind = 'erase';
  private last: Point;
  private began = false;
  /** Per stroke: the swaths this drag added, in its stored frame. */
  private readonly added = new Map<string, number[]>();
  private done = false;

  constructor(private readonly core: Core, from: Point) {
    this.last = from;
    this.swath(from, from);
  }

  /** Strokes this drag has cut so far (tests). */
  get touched(): ReadonlySet<string> {
    return new Set(this.added.keys());
  }

  /** Adds the swath a → b (world) to every stroke it touches and shows the result. */
  private swath(a: Point, b: Point): void {
    const r = this.core.px(this.core.eraserPx);
    const box = { x: Math.min(a.x, b.x) - r, y: Math.min(a.y, b.y) - r, w: Math.abs(b.x - a.x) + 2 * r, h: Math.abs(b.y - a.y) + 2 * r };
    let changed = false;
    for (const o of this.core.scene.query(box)) {
      if (o.kind !== 'ink' || o.locked) continue;
      const center = rectCenter(o);
      const la = o.rot ? rotatePoint(a, center, -o.rot) : a;
      const lb = o.rot ? rotatePoint(b, center, -o.rot) : b;
      const pa = { x: la.x - o.x, y: la.y - o.y };
      const pb = { x: lb.x - o.x, y: lb.y - o.y };
      if (inkSegDistance(pa, pb, o.points) > r + o.strokeWidth / 2) continue;
      const m = this.core.doc.objects.get(o.id);
      const raw = inkPoints(m?.get('points'));
      if (!raw) continue;
      const mine = this.added.get(o.id) ?? [];
      const had = inkErase(m?.get('erase'))?.length ?? 0;
      if ((had + mine.length) / 5 >= INK_MAX_ERASE) continue;
      mine.push(...swathToStored(raw, o.w, o.h, pa.x, pa.y, pb.x, pb.y, r));
      this.added.set(o.id, mine);
      changed = true;
    }
    if (!changed) return;
    if (!this.began) {
      this.began = true;
      this.core.doc.beginGesture();
    }
    const patches = new Map<string, ObjectPatch>();
    for (const [id, mine] of this.added) {
      const had = inkErase(this.core.doc.objects.get(id)?.get('erase')) ?? [];
      patches.set(id, { erase: [...had, ...mine] });
    }
    this.core.live.preview(patches);
  }

  move(w: Point): void {
    if (this.done) return;
    // A swath is a capsule: no sampling, one piece per third of the radius moved (fewer swaths for a slow drag).
    if (dist(this.last, w) < this.core.px(this.core.eraserPx) / 3) return;
    this.swath(this.last, w);
    this.last = w;
  }

  end(w: Point): void {
    if (this.done) return;
    if (dist(this.last, w) > 0) this.swath(this.last, w);
    this.done = true;
    if (!this.began) return;
    this.core.live.commit();
    // What the swaths took whole goes away (an invisible stroke would still be picked and counted).
    const gone: string[] = [];
    for (const id of this.added.keys()) {
      const o = this.core.scene.get(id);
      if (o?.kind === 'ink' && o.erase && swathsCover(o.points, o.strokeWidth, o.erase)) gone.push(id);
    }
    // Connectors never glue to a stroke (`glueAt`); should one end point at it anyway, it stays where it was.
    if (gone.length) this.core.doc.remove(gone, (c, end) => this.core.scene.pointOf(c, end));
    this.core.doc.endGesture();
  }

  cancel(): void {
    if (this.done) return;
    this.done = true;
    if (!this.began) return;
    this.core.live.drop();
    this.core.doc.cancelGesture();
  }

  settle(): void {
    this.end(this.last);
  }
}

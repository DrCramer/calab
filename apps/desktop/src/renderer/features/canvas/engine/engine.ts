import type * as Y from 'yjs';
import {
  DEFAULT_CAMERA, clampScale, fitRect, lerpCamera, nextZoomStep, sameCamera, screenToWorld, visibleRect, zoomAt,
  type Camera,
} from '../../../lib/canvas/camera';
import { duplicate, parse, serialize, toInits } from '../../../lib/canvas/clipboard';
import { CanvasDoc } from '../../../lib/canvas/doc';
import { boundsOf, rectInflate, type Point, type Rect } from '../../../lib/canvas/geometry';
import { Scene } from '../../../lib/canvas/scene';
import { contentRect } from '../../../lib/canvas/shapes';
import { LABEL_SIZE, SHAPE_TEXT_SIZE, STICKY_TEXT_SIZE, TextLayouter, estimateMeasure, type MeasureFn } from '../../../lib/canvas/textLayout';
import { polylineMidpoint } from '../../../lib/canvas/geometry';
import {
  DEFAULTS, isConnector,
  type ObjectPatch, type ObjectRec, type RouteKind, type ShapeKind,
} from '../../../lib/canvas/types';
import { AwarenessLayer, type PeerState } from './awareness';
import type { Core, Gesture } from './gestures';
import { attachInput } from './input';
import { emptyOverlay, type OverlayState } from './overlay';
import { resolveColor, resolveSticky, type CanvasPalette } from './palette';
import { Renderer, renderSceneTo, type FrameStats } from './renderer';
import { TextEditor, type EditSpec } from './textEditor';

export type Tool = 'select' | 'sticky' | 'text' | 'shape' | 'connector';

/** Everything React is allowed to see: primitives only (ADR-0107 §4). The object identity changes only when a value does. */
export interface EngineState {
  /** The selected object when exactly one is selected. */
  readonly selectedId: string | null;
  readonly selectionCount: number;
  readonly tool: Tool;
  readonly shapeKind: ShapeKind;
  /** Rounded zoom, percent. */
  readonly zoomPct: number;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly editing: boolean;
  readonly readOnly: boolean;
}

export interface ClipboardPort {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
}

export interface LocalAwareness {
  cursor: Point | null;
  selection: string[];
}

export interface EngineOptions {
  canvas: HTMLCanvasElement;
  doc: Y.Doc;
  palette: CanvasPalette;
  readOnly?: boolean;
  /** «Слабый компьютер»: DPR 1. */
  lowPower?: boolean;
  /** Camera moves jump instead of animating. */
  reducedMotion?: boolean;
  /** World grid step for snapping; 0 disables. */
  gridSize?: number;
  clipboard?: ClipboardPort;
  /** Positioned element the text editor is appended to (default: the canvas' parent). */
  editorHost?: HTMLElement;
  /** Text measuring (tests / non-DOM). Default: a hidden 2D context. */
  measure?: MeasureFn;
  /** Clock and frame scheduler, for tests. */
  now?: () => number;
  raf?: (cb: () => void) => number;
  cancelRaf?: (id: number) => void;
}

const STATE_KEYS: readonly (keyof EngineState)[] = ['selectedId', 'selectionCount', 'tool', 'shapeKind', 'zoomPct', 'canUndo', 'canRedo', 'editing', 'readOnly'];
const LOCAL_AWARENESS_MS = 50;
const ANIM_MS = 180;

function makeCanvasMeasure(family: () => string): MeasureFn {
  if (typeof document === 'undefined') return estimateMeasure;
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return estimateMeasure;
  let last = '';
  return (text, size) => {
    const f = `${size}px ${family()}`;
    if (f !== last) {
      ctx.font = f;
      last = f;
    }
    return ctx.measureText(text).width;
  };
}

/**
 * The Canvas engine: Y.Doc → Scene → Canvas 2D renderer, with pointer/keyboard input, selection,
 * snapping, connectors, undo and a text-edit overlay (ADR-0107 §3–§4). Plain TS; the section UI (H5)
 * subscribes to `getState()` primitives and calls the command methods.
 */
export class CanvasEngine implements Core {
  readonly doc: CanvasDoc;
  readonly scene: Scene;
  readonly awareness = new AwarenessLayer();
  readonly renderer: Renderer;
  readonly editor: TextEditor;
  readonly canvas: HTMLCanvasElement;

  private palette: CanvasPalette;
  private cam: Camera = { ...DEFAULT_CAMERA };
  private sel = new Set<string>();
  private overlay: OverlayState = emptyOverlay();
  private gesture: Gesture | null = null;
  private state: EngineState;
  private readonly listeners = new Set<() => void>();
  private readonly selListeners = new Set<(objs: readonly ObjectRec[]) => void>();
  private readonly localListeners = new Set<(a: LocalAwareness) => void>();
  private readonly viewListeners = new Set<() => void>();
  private localCursor: Point | null = null;
  private localTimer: ReturnType<typeof setTimeout> | null = null;
  private localAt = 0;
  private awarenessTimer: ReturnType<typeof setTimeout> | null = null;
  /** When the armed `awarenessTimer` fires (engine clock). */
  private awarenessDue = 0;
  private active = true;
  private readOnlyFlag: boolean;
  private lowPower: boolean;
  private reducedMotion: boolean;
  private tool_: Tool = 'select';
  private shape_: ShapeKind = 'rect';
  private route_: RouteKind = 'straight';
  private pasteCount = 0;
  private animToken = 0;
  private animRaf = 0;
  private readonly clipboardPort: ClipboardPort | null;
  private readonly now: () => number;
  private readonly disposers: (() => void)[] = [];
  private destroyed = false;
  gridSize: number;

  constructor(private readonly opts: EngineOptions) {
    this.canvas = opts.canvas;
    this.palette = opts.palette;
    this.readOnlyFlag = opts.readOnly ?? false;
    this.lowPower = opts.lowPower ?? false;
    this.reducedMotion = opts.reducedMotion ?? false;
    this.gridSize = opts.gridSize ?? 8;
    this.now = opts.now ?? Date.now;
    this.clipboardPort = opts.clipboard ?? (typeof navigator !== 'undefined' && 'clipboard' in navigator ? navigator.clipboard : null);

    this.doc = new CanvasDoc(opts.doc);
    const layouter = new TextLayouter(opts.measure ?? makeCanvasMeasure(() => this.palette.fontFamily));
    this.scene = new Scene(this.doc, layouter);
    this.renderer = new Renderer({
      canvas: opts.canvas,
      scene: this.scene,
      palette: this.palette,
      getCamera: () => this.cam,
      getOverlay: () => this.overlay,
      awareness: this.awareness,
      maxDpr: this.lowPower ? 1 : 2,
      ...(opts.raf ? { raf: opts.raf } : {}),
      ...(opts.cancelRaf ? { cancelRaf: opts.cancelRaf } : {}),
      now: this.now,
    });
    const host = opts.editorHost ?? opts.canvas.parentElement;
    this.editor = new TextEditor({ host: host ?? opts.canvas, canvas: opts.canvas, getCamera: () => this.cam });
    this.renderer.onFrame = () => {
      if (this.editor.isOpen) this.editor.reposition();
    };

    this.state = this.computeState();
    this.disposers.push(this.scene.subscribe((c) => this.onSceneChange(c.ids)));

    const um = this.doc.undo;
    const onUndo = (): void => this.sync();
    um.on('stack-item-added', onUndo);
    um.on('stack-item-popped', onUndo);
    um.on('stack-cleared', onUndo);
    this.disposers.push(() => {
      um.off('stack-item-added', onUndo);
      um.off('stack-item-popped', onUndo);
      um.off('stack-cleared', onUndo);
    });
    // A newer schema arriving later makes the canvas read-only.
    const onMeta = (): void => this.sync();
    this.doc.meta.observe(onMeta);
    this.disposers.push(() => this.doc.meta.unobserve(onMeta));

    opts.canvas.style.touchAction = 'none';
    if (!opts.canvas.hasAttribute('tabindex')) opts.canvas.tabIndex = 0;
    this.disposers.push(attachInput(this, opts.canvas));
    this.observeSize();
    this.observeVisibility();
    this.sync();
  }

  // ── state store (useSyncExternalStore-compatible) ───────────────────────────

  getState = (): EngineState => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  /** Selected objects (immutable records) now and on every change to them or the selection — for the properties panel. */
  subscribeSelection(fn: (objs: readonly ObjectRec[]) => void): () => void {
    this.selListeners.add(fn);
    return () => this.selListeners.delete(fn);
  }

  /**
   * Camera moved or a gesture started/ended — for UI pinned to the content (the floating properties panel).
   * Called synchronously and rarely more than once per input event; the listener must be cheap and must
   * not set React state per call.
   */
  subscribeView(fn: () => void): () => void {
    this.viewListeners.add(fn);
    return () => this.viewListeners.delete(fn);
  }

  private emitView(): void {
    for (const fn of this.viewListeners) fn();
  }

  /** Local cursor + selection for the sync layer, throttled to 20/s (trailing edge kept). */
  onLocalAwareness(fn: (a: LocalAwareness) => void): () => void {
    this.localListeners.add(fn);
    return () => this.localListeners.delete(fn);
  }

  private computeState(): EngineState {
    const only = this.sel.size === 1 ? (this.sel.values().next().value ?? null) : null;
    return {
      selectedId: only,
      selectionCount: this.sel.size,
      tool: this.tool_,
      shapeKind: this.shape_,
      zoomPct: Math.round(this.cam.scale * 100),
      canUndo: this.doc.undo.undoStack.length > 0,
      canRedo: this.doc.undo.redoStack.length > 0,
      editing: this.editor.isOpen,
      readOnly: this.readOnly,
    };
  }

  /** Recomputes the snapshot; notifies only if a primitive changed. */
  private sync(): void {
    const next = this.computeState();
    let changed = false;
    for (const k of STATE_KEYS) if (next[k] !== this.state[k]) changed = true;
    if (!changed) return;
    this.state = next;
    for (const fn of this.listeners) fn();
  }

  get readOnly(): boolean {
    return this.readOnlyFlag || this.doc.isFuture;
  }

  get tool(): Tool {
    return this.tool_;
  }

  get shapeKind(): ShapeKind {
    return this.shape_;
  }

  get connectorRoute(): RouteKind {
    return this.route_;
  }

  // ── Core (used by gestures and input) ───────────────────────────────────────

  get camera(): Camera {
    return this.cam;
  }

  get selection(): ReadonlySet<string> {
    return this.sel;
  }

  get stats(): FrameStats {
    return this.renderer.stats;
  }

  get activeGesture(): Gesture | null {
    return this.gesture;
  }

  set activeGesture(g: Gesture | null) {
    if (g === this.gesture) return;
    this.gesture = g;
    this.emitView();
  }

  px(n: number): number {
    return n / this.cam.scale;
  }

  setCamera(c: Camera): void {
    const next = { tx: c.tx, ty: c.ty, scale: clampScale(c.scale) };
    if (sameCamera(next, this.cam)) return;
    this.cam = next;
    this.renderer.requestFrame();
    this.sync();
    this.emitView();
  }

  setOverlay(p: Partial<OverlayState>): void {
    this.overlay = { ...this.overlay, ...p };
    this.renderer.requestFrame();
  }

  setSelection(ids: Iterable<string>): void {
    const next = new Set<string>();
    for (const id of ids) if (this.scene.has(id)) next.add(id);
    if (next.size === this.sel.size && [...next].every((i) => this.sel.has(i))) return;
    this.sel = next;
    this.refreshOverlay();
    this.sync();
    this.notifySelection();
    this.emitLocal();
  }

  finishCreate(ids: readonly string[], edit: boolean): void {
    this.setSelection(ids);
    this.setTool('select');
    const id = ids[0];
    if (edit && id) this.startTextEdit(id);
  }

  /** Decoration for the current selection (outlines, group handles, connector ends). */
  private refreshOverlay(): void {
    const outlines: Rect[] = [];
    const connectors = [];
    const boxes: Rect[] = [];
    for (const id of this.sel) {
      const o = this.scene.get(id);
      if (!o) continue;
      if (isConnector(o)) connectors.push(o);
      else {
        outlines.push({ x: o.x, y: o.y, w: o.w, h: o.h });
        boxes.push(o);
      }
    }
    const group = !this.readOnly && !this.editor.isOpen ? boundsOf(boxes) : null;
    this.overlay = { ...this.overlay, outlines: this.sel.size > 1 ? outlines : [], connectors, group };
    this.renderer.requestFrame();
  }

  private onSceneChange(ids: ReadonlySet<string>): void {
    let touched = false;
    for (const id of this.sel) {
      if (!this.scene.has(id)) {
        this.setSelection([...this.sel].filter((i) => this.scene.has(i)));
        return;
      }
      if (ids.has(id)) touched = true;
    }
    if (touched) {
      this.refreshOverlay();
      this.notifySelection();
    }
    if (ids.size > 0) this.sync();
  }

  private notifySelection(): void {
    if (this.selListeners.size === 0) return;
    const objs = this.getSelected();
    for (const fn of this.selListeners) fn(objs);
  }

  getSelected(): ObjectRec[] {
    const out: ObjectRec[] = [];
    for (const id of this.sel) {
      const o = this.scene.get(id);
      if (o) out.push(o);
    }
    return out;
  }

  // ── tools & options ─────────────────────────────────────────────────────────

  setTool(t: Tool): void {
    if (t === this.tool_) return;
    this.tool_ = t;
    this.canvas.style.cursor = t === 'select' ? '' : 'crosshair';
    this.sync();
  }

  setShapeKind(k: ShapeKind): void {
    this.shape_ = k;
    this.sync();
  }

  setConnectorRoute(r: RouteKind): void {
    this.route_ = r;
  }

  setReadOnly(on: boolean): void {
    this.readOnlyFlag = on;
    if (this.readOnly) this.editor.cancel();
    this.refreshOverlay();
    this.sync();
  }

  setPalette(p: CanvasPalette): void {
    this.palette = p;
    this.scene.text.setMeasure(this.opts.measure ?? makeCanvasMeasure(() => this.palette.fontFamily));
    this.renderer.setPalette(p);
    // Text heights depend on the font: rebuild everything.
    this.scene.refresh(this.doc.objects.keys());
  }

  setLowPower(on: boolean): void {
    this.lowPower = on;
    this.renderer.setMaxDpr(on ? 1 : 2);
  }

  setReducedMotion(on: boolean): void {
    this.reducedMotion = on;
  }

  /** The window/tab is hidden: stop drawing (and sending awareness) until shown; no cursor-fade timer either. */
  setActive(on: boolean): void {
    this.active = on;
    this.renderer.setActive(on);
    if (on) this.scheduleAwarenessStep();
    else this.clearAwarenessStep();
  }

  // ── camera commands ─────────────────────────────────────────────────────────

  get viewport(): { w: number; h: number } {
    return this.renderer.viewport;
  }

  toWorld(screen: Point): Point {
    return screenToWorld(this.cam, screen);
  }

  zoomAtPoint(factor: number, at: Point): void {
    this.cancelAnimation();
    this.setCamera(zoomAt(this.cam, factor, at));
  }

  panByScreen(dx: number, dy: number): void {
    this.cancelAnimation();
    this.setCamera({ ...this.cam, tx: this.cam.tx + dx, ty: this.cam.ty + dy });
  }

  zoomStep(dir: 1 | -1): void {
    const v = this.viewport;
    const target = nextZoomStep(this.cam.scale, dir);
    this.moveCamera(zoomAt(this.cam, target / this.cam.scale, { x: v.w / 2, y: v.h / 2 }));
  }

  /** Absolute zoom, percent (clamped 10–400), around the viewport center. */
  zoomTo(pct: number): void {
    const v = this.viewport;
    this.moveCamera(zoomAt(this.cam, clampScale(pct / 100) / this.cam.scale, { x: v.w / 2, y: v.h / 2 }));
  }

  fitAll(): void {
    const b = this.scene.bounds();
    const v = this.viewport;
    this.moveCamera(b ? fitRect(b, v) : { tx: v.w / 2, ty: v.h / 2, scale: 1 });
  }

  fitSelection(): void {
    const b = this.scene.bounds(this.sel);
    if (b) this.moveCamera(fitRect(b, this.viewport, 64));
    else this.fitAll();
  }

  /** Centers the view on a world point at the current zoom. */
  centerOn(p: Point): void {
    const v = this.viewport;
    this.moveCamera({ scale: this.cam.scale, tx: v.w / 2 - p.x * this.cam.scale, ty: v.h / 2 - p.y * this.cam.scale });
  }

  visibleWorld(): Rect {
    return visibleRect(this.cam, this.viewport);
  }

  /** Animated camera move (instant under reduced motion). The only place that loops frames besides the renderer. */
  private moveCamera(target: Camera): void {
    this.cancelAnimation();
    if (this.reducedMotion || sameCamera(target, this.cam)) {
      this.setCamera(target);
      return;
    }
    const from = this.cam;
    const t0 = this.now();
    const token = ++this.animToken;
    const step = (): void => {
      if (token !== this.animToken || this.destroyed) return;
      const t = Math.min(1, (this.now() - t0) / ANIM_MS);
      const e = 1 - (1 - t) ** 3;
      this.setCamera(t >= 1 ? target : lerpCamera(from, target, e));
      this.animRaf = t >= 1 ? 0 : (this.opts.raf ?? requestAnimationFrame)(step);
    };
    this.animRaf = (this.opts.raf ?? requestAnimationFrame)(step);
  }

  cancelAnimation(): void {
    this.animToken++;
    if (this.animRaf) (this.opts.cancelRaf ?? cancelAnimationFrame)(this.animRaf);
    this.animRaf = 0;
  }

  // ── object commands ─────────────────────────────────────────────────────────

  get snapGrid(): number {
    return this.gridSize;
  }

  private canEdit(): boolean {
    return !this.readOnly;
  }

  selectAll(): void {
    this.setSelection(this.scene.orderedIds());
  }

  clearSelection(): void {
    this.setSelection([]);
  }

  /** Tab / Shift+Tab through objects in layer order. */
  cycleSelection(dir: 1 | -1): void {
    const order = this.scene.orderedIds();
    if (order.length === 0) return;
    const cur = this.state.selectedId;
    const i = cur === null ? (dir > 0 ? -1 : order.length) : order.indexOf(cur);
    const next = order[(i + dir + order.length) % order.length];
    if (next) {
      this.setSelection([next]);
      const o = this.scene.get(next);
      if (o && !rectInView(o, this.visibleWorld())) this.centerOn({ x: o.x + o.w / 2, y: o.y + o.h / 2 });
    }
  }

  deleteSelection(): void {
    if (!this.canEdit() || this.sel.size === 0) return;
    const ids = [...this.sel];
    this.doc.checkpoint();
    this.doc.remove(ids, (c, end) => this.scene.pointOf(c, end));
  }

  duplicateSelection(): string[] {
    if (!this.canEdit() || this.sel.size === 0) return [];
    this.doc.checkpoint();
    const ids = duplicate(this.scene, this.doc, this.sel, 24, 24);
    if (ids.length > 0) this.setSelection(ids);
    return ids;
  }

  /** Writes the selection to the clipboard. Returns the text (also for callers with their own clipboard). */
  async copy(): Promise<string | null> {
    const text = serialize(this.scene, this.doc, this.sel);
    if (text && this.clipboardPort) {
      try {
        await this.clipboardPort.writeText(text);
      } catch {
        // Clipboard access can be denied; the text is still returned.
      }
    }
    this.pasteCount = 0;
    return text;
  }

  async cut(): Promise<void> {
    if (!this.canEdit()) return;
    await this.copy();
    this.deleteSelection();
  }

  async paste(): Promise<string[]> {
    if (!this.canEdit() || !this.clipboardPort) return [];
    try {
      return this.pasteText(await this.clipboardPort.readText());
    } catch {
      return [];
    }
  }

  /** Pastes our JSON (placed visibly, offset on repeats) or plain text as a text object at the view center. */
  pasteText(text: string): string[] {
    if (!this.canEdit()) return [];
    const payload = parse(text);
    const view = this.visibleWorld();
    if (!payload) {
      const t = text.trim();
      if (!t || text.startsWith('calaba-canvas:')) return [];
      const c = { x: view.x + view.w / 2, y: view.y + view.h / 2 };
      this.doc.checkpoint();
      const id = this.doc.create({ kind: 'text', x: c.x - DEFAULTS.textW / 2, y: c.y - DEFAULTS.textSize, text: t });
      if (id) this.setSelection([id]);
      return id ? [id] : [];
    }
    const boxes = payload.objects.filter((o) => o.kind !== 'connector');
    const bb = boundsOf(boxes.map((o) => ({ x: Number(o.x) || 0, y: Number(o.y) || 0, w: Number(o.w) || 0, h: Number(o.h) || 0 })));
    let dx = 24 * (this.pasteCount + 1);
    let dy = dx;
    if (bb && !rectInView(bb, view)) {
      dx = view.x + view.w / 2 - (bb.x + bb.w / 2);
      dy = view.y + view.h / 2 - (bb.y + bb.h / 2);
    }
    this.pasteCount++;
    this.doc.checkpoint();
    const ids = this.doc.createMany(toInits(payload, dx, dy));
    if (ids.length > 0) this.setSelection(ids);
    return ids;
  }

  undo(): void {
    if (!this.canEdit()) return;
    this.doc.undo.undo();
  }

  redo(): void {
    if (!this.canEdit()) return;
    this.doc.undo.redo();
  }

  /** `step`: one layer; `edge`: to the very front/back. */
  reorder(dir: 1 | -1, edge: boolean): void {
    if (!this.canEdit() || this.sel.size === 0) return;
    const ids = [...this.sel];
    this.doc.checkpoint();
    if (edge) {
      if (dir > 0) this.doc.bringToFront(ids);
      else this.doc.sendToBack(ids);
    } else this.doc.step(ids, dir);
  }

  /** Moves the selection by a world delta (arrow keys). */
  nudge(dx: number, dy: number): void {
    if (!this.canEdit() || this.sel.size === 0) return;
    const patches = new Map<string, ObjectPatch>();
    for (const id of this.sel) {
      const o = this.scene.get(id);
      if (!o) continue;
      if (isConnector(o)) {
        const p: ObjectPatch = {};
        if (!('id' in o.from)) p.from = { x: o.from.x + dx, y: o.from.y + dy };
        if (!('id' in o.to)) p.to = { x: o.to.x + dx, y: o.to.y + dy };
        patches.set(id, p);
      } else patches.set(id, { x: o.x + dx, y: o.y + dy });
    }
    this.doc.patchMany(patches);
  }

  /** Applies plain-field changes (color, size, fill, arrow, …) to every selected object they apply to. */
  updateSelected(patch: ObjectPatch): void {
    if (!this.canEdit() || this.sel.size === 0) return;
    const patches = new Map<string, ObjectPatch>();
    for (const id of this.sel) patches.set(id, patch);
    this.doc.patchMany(patches);
  }

  // ── text editing ────────────────────────────────────────────────────────────

  private editSpec(o: ObjectRec): EditSpec | null {
    const p = this.palette;
    if (isConnector(o)) {
      const m = polylineMidpoint(o.points);
      return { box: { x: m.x - 80, y: m.y - 12, w: 160, h: 24 }, text: o.label, size: LABEL_SIZE, color: p.ink, align: 'center', vcenter: true, autoHeight: false, fontFamily: p.fontFamily };
    }
    const box = contentRect(o);
    switch (o.kind) {
      case 'sticky': return { box, text: o.text, size: STICKY_TEXT_SIZE, color: resolveSticky(p, o.color).fg, align: 'left', vcenter: false, autoHeight: false, fontFamily: p.fontFamily };
      case 'text': return { box, text: o.text, size: o.size, color: resolveColor(p, o.color) ?? p.ink, align: 'left', vcenter: false, autoHeight: true, fontFamily: p.fontFamily };
      case 'shape': return { box, text: o.text, size: SHAPE_TEXT_SIZE, color: p.ink, align: 'center', vcenter: true, autoHeight: false, fontFamily: p.fontFamily };
    }
  }

  /** Opens the textarea over an object (default: the single selected one). */
  startTextEdit(id?: string): boolean {
    if (!this.canEdit()) return false;
    const target = id ?? this.state.selectedId;
    const o = target ? this.scene.get(target) : undefined;
    if (!o) return false;
    const spec = this.editSpec(o);
    if (!spec) return false;
    const oid = o.id;
    this.renderer.setHiddenText(oid);
    this.overlay = { ...this.overlay, group: null };
    this.editor.open(spec, (text) => {
      this.renderer.setHiddenText(null);
      const cur = this.scene.get(oid);
      if (cur) {
        this.doc.checkpoint();
        if (cur.kind === 'text' && text.trim() === '') this.doc.remove([oid]);
        else this.doc.setText(oid, text);
      }
      this.refreshOverlay();
      this.sync();
      this.canvas.focus({ preventScroll: true });
    });
    this.sync();
    return true;
  }

  /** Double-click on empty canvas: a new text object, in edit mode. */
  createTextAt(world: Point): string | null {
    if (!this.canEdit()) return null;
    this.doc.checkpoint();
    const id = this.doc.create({ kind: 'text', x: world.x - 8, y: world.y - DEFAULTS.textSize });
    if (id) this.finishCreate([id], true);
    return id;
  }

  /** Hit-test a world point with a screen-pixel radius. */
  hitAt(world: Point, px = 6): ObjectRec | null {
    return this.scene.hit(world, this.px(px));
  }

  // ── awareness ───────────────────────────────────────────────────────────────

  /** Remote participants from the sync layer; schedules at most one timer for the next cursor fade step. */
  setPeers(peers: readonly PeerState[]): void {
    const changed = this.awareness.setPeers(peers, this.now());
    if (changed) this.renderer.requestFrame();
    this.scheduleAwarenessStep();
  }

  private clearAwarenessStep(): void {
    if (this.awarenessTimer) clearTimeout(this.awarenessTimer);
    this.awarenessTimer = null;
  }

  /**
   * One timer to the next cursor visibility step; none while hidden (nothing is drawn, `setActive(true)` re-arms).
   * An armed timer that fires no later than needed stays: a cursor that keeps moving would otherwise re-arm it on
   * every awareness frame. Firing early costs one overlay frame and a re-arm.
   */
  private scheduleAwarenessStep(): void {
    if (!this.active) return;
    const t = this.now();
    const d = this.awareness.nextStepIn(t);
    if (d === null) {
      this.clearAwarenessStep();
      return;
    }
    const due = t + d;
    if (this.awarenessTimer && this.awarenessDue <= due) return;
    this.clearAwarenessStep();
    this.awarenessDue = due;
    this.awarenessTimer = setTimeout(() => {
      this.awarenessTimer = null;
      this.renderer.requestFrame();
      this.scheduleAwarenessStep();
    }, d);
  }

  setLocalCursor(w: Point | null): void {
    this.localCursor = w;
    this.emitLocal();
  }

  private emitLocal(): void {
    if (this.localListeners.size === 0) return;
    const t = this.now();
    const wait = this.localAt + LOCAL_AWARENESS_MS - t;
    const fire = (): void => {
      this.localTimer = null;
      this.localAt = this.now();
      const a: LocalAwareness = { cursor: this.localCursor, selection: [...this.sel] };
      for (const fn of this.localListeners) fn(a);
    };
    if (wait <= 0) {
      if (this.localTimer) clearTimeout(this.localTimer);
      fire();
    } else if (!this.localTimer) this.localTimer = setTimeout(fire, wait);
  }

  // ── export ──────────────────────────────────────────────────────────────────

  /**
   * Paints the whole canvas, just the selection or an explicit world `rect` (the visible area) into a new
   * canvas element; null if there is nothing to paint. `pad` is the world margin around the content.
   */
  exportToCanvas(opts: { selectionOnly?: boolean; pxPerUnit?: number; rect?: Rect; pad?: number } = {}): HTMLCanvasElement | null {
    const b = opts.rect ?? (opts.selectionOnly && this.sel.size > 0 ? this.scene.bounds(this.sel) : this.scene.bounds());
    if (!b) return null;
    const c = document.createElement('canvas');
    renderSceneTo(c, this.scene, this.palette, b, opts.pxPerUnit ?? 1, opts.pad);
    return c;
  }

  // ── lifecycle ───────────────────────────────────────────────────────────────

  private observeSize(): void {
    const apply = (): void => {
      const r = this.canvas.getBoundingClientRect();
      const dpr = this.canvas.ownerDocument.defaultView?.devicePixelRatio ?? 1;
      this.renderer.resize(r.width, r.height, dpr);
    };
    apply();
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(apply);
      ro.observe(this.canvas);
      this.disposers.push(() => ro.disconnect());
    }
  }

  private observeVisibility(): void {
    const doc = this.canvas.ownerDocument;
    const onVis = (): void => this.setActive(doc.visibilityState !== 'hidden');
    doc.addEventListener('visibilitychange', onVis);
    this.disposers.push(() => doc.removeEventListener('visibilitychange', onVis));
    onVis();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancelAnimation();
    this.editor.cancel();
    if (this.localTimer) clearTimeout(this.localTimer);
    if (this.awarenessTimer) clearTimeout(this.awarenessTimer);
    for (const d of this.disposers.splice(0)) d();
    this.renderer.destroy();
    this.scene.destroy();
    this.doc.destroy();
    this.listeners.clear();
    this.selListeners.clear();
    this.localListeners.clear();
    this.viewListeners.clear();
  }
}

function rectInView(r: Rect, view: Rect): boolean {
  const i = rectInflate(view, 0);
  return r.x >= i.x && r.y >= i.y && r.x + r.w <= i.x + i.w && r.y + r.h <= i.y + i.h;
}


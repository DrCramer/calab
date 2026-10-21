import type * as Y from 'yjs';
import {
  DEFAULT_CAMERA, clampScale, edgePanVelocity, fitRect, lerpCamera, nextZoomStep, panBy, sameCamera, screenToWorld, visibleRect, zoomAt,
  type Camera,
} from '../../../lib/canvas/camera';
import { duplicate, parse, serialize, toInits } from '../../../lib/canvas/clipboard';
import { arrangeDeltas, arrangeUnits, type ArrangeOp } from '../../../lib/canvas/arrange';
import { CanvasDoc, newId } from '../../../lib/canvas/doc';
import { boundsOf, rectCenter, rectInflate, type Point, type Rect } from '../../../lib/canvas/geometry';
import { Scene, visualBounds } from '../../../lib/canvas/scene';
import { contentRect } from '../../../lib/canvas/shapes';
import { buildTemplate, type TemplateId, type TemplateText } from '../../../lib/canvas/templates';
import { LABEL_SIZE, TextLayouter, boxFontSize, estimateMeasure, fontOf, type MeasureFn } from '../../../lib/canvas/textLayout';
import { polylineMidpoint } from '../../../lib/canvas/geometry';
import { LiveLayer } from '../../../lib/canvas/live';
import {
  DEFAULTS, MAX_OBJECTS, aabb, isConnector,
  type ObjectKind, type ObjectPatch, type ObjectRec, type RouteKind, type ShapeKind,
} from '../../../lib/canvas/types';
import { VOTE_DEFAULT, VoteBook, type VotePhase, type VoteSession } from '../../../lib/canvas/votes';
import { AwarenessLayer, sameView, type PeerState, type PeerView } from './awareness';
import type { Core, Gesture, Mods } from './gestures';
import { attachInput } from './input';
import { emptyOverlay, type Outline, type OverlayState, type SelFrame } from './overlay';
import { readableInk, resolveColor, resolveSticky, type CanvasPalette } from './palette';
import { Renderer, renderSceneTo, type FrameStats } from './renderer';
import { selectionFrame } from './selection';
import { TextEditor, type EditSpec } from './textEditor';
import { BADGE_MARGIN_PX, hitBadge } from './voteDraw';

export type Tool = 'select' | 'sticky' | 'text' | 'shape' | 'connector' | 'comment';

/** A click (tap) of the «Комментарий» tool (ADR-0115 wave 4): where, and the object under it (null = the field). */
export interface CommentClick {
  readonly screen: Point;
  readonly world: Point;
  readonly objectId: string | null;
}

/** Everything React is allowed to see: primitives only (ADR-0114 §4). The object identity changes only when a value does. */
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
  /** The person whose view the camera follows (`followKeyOf`), or null. */
  readonly followKey: string | null;
  /** Their name (empty while not following). */
  readonly followName: string;
  /** No vote on the canvas, one counting, or one finished (totals shown). */
  readonly votePhase: VotePhase;
  /** Votes per person of the current session (0 without one). */
  readonly votesPer: number;
  /** Votes I may still give (0 unless I can vote now). */
  readonly votesLeft: number;
  /** A vote is open and I may take part (write access, signed in). */
  readonly canVote: boolean;
  /** Phone edit mode: taps add to / remove from the selection (the stand-in for Shift). */
  readonly multiSelect: boolean;
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
  /** Transparent canvas over `canvas` for other people's cursors and selections (see `RendererOptions.remoteCanvas`). */
  remoteCanvas?: HTMLCanvasElement;
  doc: Y.Doc;
  palette: CanvasPalette;
  /** The signed-in person: the owner of the vote cells (no id, no voting). */
  userId?: string;
  readOnly?: boolean;
  /** «Слабый компьютер»: DPR 1. */
  lowPower?: boolean;
  /** Camera moves jump instead of animating. */
  reducedMotion?: boolean;
  /** The phone (ADR-0115 wave 5b): touch editing semantics (tap selects, drag moves the selected, bigger handles). */
  touch?: boolean;
  /** World grid step for snapping; 0 disables. */
  gridSize?: number;
  clipboard?: ClipboardPort;
  /** A paste or ⌘D was refused whole: the object limit (`objects`) or the document's state limit (`size`). */
  onRefused?: (why: 'objects' | 'size') => void;
  /** Positioned element the text editor is appended to (default: the canvas' parent). */
  editorHost?: HTMLElement;
  /** The text editor's accessible name, in the UI language (read at every open). */
  editorLabel?: () => string;
  /** Text measuring (tests / non-DOM). Default: a hidden 2D context. */
  measure?: MeasureFn;
  /** Clock and frame scheduler, for tests. */
  now?: () => number;
  raf?: (cb: () => void) => number;
  cancelRaf?: (id: number) => void;
}

const STATE_KEYS: readonly (keyof EngineState)[] = ['selectedId', 'selectionCount', 'tool', 'shapeKind', 'zoomPct', 'canUndo', 'canRedo', 'editing', 'readOnly', 'followKey', 'followName', 'votePhase', 'votesPer', 'votesLeft', 'canVote', 'multiSelect'];
const LOCAL_AWARENESS_MS = 50;
/** Gestures that follow their pointer when the camera moves under it, and pan the view at its edge. */
const FOLLOW_KINDS: ReadonlySet<Gesture['kind']> = new Set(['marquee', 'move', 'resize']);
/** The edge pan arms once the pointer has moved this far (px) from where it went down. */
const EDGE_SLOP_PX = 3;
/** One step of the edge pan covers at most this long (s): a stalled frame does not make the view jump. */
const EDGE_PAN_MAX_DT = 0.05;
/** Our camera goes out at most this often (5/s), and only when it moved. */
const LOCAL_VIEW_MS = 200;
const ANIM_MS = 180;
/** Phone: the format bar above the keyboard (44 px targets + padding) and the zoom bar / count of others at the top. */
const PHONE_FORMAT_BAR_PX = 56;
const PHONE_TOP_BARS_PX = 64;

function makeCanvasMeasure(family: () => string): MeasureFn {
  if (typeof document === 'undefined') return estimateMeasure;
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return estimateMeasure;
  let last = '';
  return (text, size, flags = 0) => {
    const f = fontOf(size, family(), flags);
    if (f !== last) {
      ctx.font = f;
      last = f;
    }
    return ctx.measureText(text).width;
  };
}

/**
 * The Canvas engine: Y.Doc → Scene → Canvas 2D renderer, with pointer/keyboard input, selection,
 * snapping, connectors, undo and a text-edit overlay (ADR-0114 §3–§4). Plain TS; the section UI (H5)
 * subscribes to `getState()` primitives and calls the command methods.
 */
export class CanvasEngine implements Core {
  readonly doc: CanvasDoc;
  readonly scene: Scene;
  readonly live: LiveLayer;
  /** Voting on stickies and shapes (ADR-0115): the numbers behind the badges. */
  readonly votes: VoteBook;
  readonly awareness = new AwarenessLayer();
  readonly renderer: Renderer;
  readonly editor: TextEditor;
  readonly canvas: HTMLCanvasElement;
  /** Touch editing on the phone: set once at construction (the viewer's `phone` mode). */
  readonly touch: boolean;

  private palette: CanvasPalette;
  private cam: Camera = { ...DEFAULT_CAMERA };
  private sel = new Set<string>();
  /** The group the user stepped into (double-click): its members select one by one until the selection leaves it. */
  private entered: string | null = null;
  private overlay: OverlayState = emptyOverlay();
  private gesture: Gesture | null = null;
  /** False while the socket is down: the peer list is empty for the gap, not because people left. */
  private peersSettled = true;
  private state: EngineState;
  private readonly listeners = new Set<() => void>();
  private readonly selListeners = new Set<(objs: readonly ObjectRec[]) => void>();
  private readonly localListeners = new Set<(a: LocalAwareness) => void>();
  private readonly viewListeners = new Set<() => void>();
  private readonly localViewListeners = new Set<(v: PeerView) => void>();
  private viewTimer: ReturnType<typeof setTimeout> | null = null;
  private viewAt = -Infinity;
  /** The camera changed since the last view was sent (kept across hidden periods). */
  private viewDirty = false;
  private followKey_: string | null = null;
  /** The view of the followed person that the camera was last set to, so an unchanged view moves nothing. */
  private followApplied: PeerView | null = null;
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
  private readonly pressListeners = new Set<(screen: Point, world: Point) => void>();
  private readonly commentListeners = new Set<(c: CommentClick) => void>();
  private tool_: Tool = 'select';
  private multi_ = false;
  private shape_: ShapeKind = 'rect';
  private route_: RouteKind = 'straight';
  private pasteCount = 0;
  /** The object whose text the editor is open on. */
  private editingId: string | null = null;
  /** The view before the on-screen keyboard made it move for a text edit, and where it was moved to (phone). */
  private editCam: { before: Camera; after: Camera } | null = null;
  private animToken = 0;
  private animRaf = 0;
  private pending: Camera | null = null;
  /**
   * The drag that follows its pointer (a frame, a move, a resize): where the pointer went down and is now, its modifiers,
   * the camera of its last `move`, and the edge pan (`armed`; `base`, `left`: how it may arm; `at`: the last step).
   */
  private drag: { g: Gesture; from: Point; s: Point; m: Mods; cam: Camera; base: number; left: boolean; armed: boolean; at: number } | null = null;
  private readonly userId: string;
  private readonly clipboardPort: ClipboardPort | null;
  private readonly now: () => number;
  private readonly disposers: (() => void)[] = [];
  private destroyed = false;
  gridSize: number;

  constructor(private readonly opts: EngineOptions) {
    this.canvas = opts.canvas;
    this.touch = opts.touch ?? false;
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
    this.live = new LiveLayer(this.doc, this.scene, { now: this.now });
    this.userId = opts.userId ?? '';
    this.votes = new VoteBook(opts.doc, this.userId, (id) => {
      const o = this.scene.get(id);
      return o?.kind === 'sticky' || o?.kind === 'shape';
    }, () => !this.readOnly);
    this.renderer = new Renderer({
      canvas: opts.canvas,
      ...(opts.remoteCanvas ? { remoteCanvas: opts.remoteCanvas } : {}),
      scene: this.scene,
      palette: this.palette,
      getCamera: () => this.cam,
      getOverlay: () => this.overlay,
      beforeFrame: () => this.frameStart(),
      awareness: this.awareness,
      getVotes: () => (this.votes.active ? this.votes : undefined),
      maxDpr: this.lowPower ? 1 : 2,
      ...(opts.raf ? { raf: opts.raf } : {}),
      ...(opts.cancelRaf ? { cancelRaf: opts.cancelRaf } : {}),
      now: this.now,
    });
    const host = opts.editorHost ?? opts.canvas.parentElement;
    this.editor = new TextEditor({
      host: host ?? opts.canvas,
      canvas: opts.canvas,
      getCamera: () => this.cam,
      ...(opts.editorLabel ? { label: opts.editorLabel } : {}),
      ...(this.touch ? { phone: { keepVisible: (dy: number) => this.keepEditVisible(dy), reserve: PHONE_FORMAT_BAR_PX, top: PHONE_TOP_BARS_PX } } : {}),
    });
    this.renderer.onFrame = () => {
      if (this.editor.isOpen) this.editor.reposition();
    };

    this.state = this.computeState();
    this.disposers.push(this.scene.subscribe((c) => this.onSceneChange(c.ids, c.order)));
    this.disposers.push(this.votes.subscribe((ids) => this.onVotes(ids)));
    this.disposers.push(() => this.votes.destroy());

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
      followKey: this.followKey_,
      followName: this.followKey_ === null ? '' : (this.awareness.followTarget(this.followKey_)?.name ?? ''),
      votePhase: this.votes.phase,
      votesPer: this.votes.session?.votesPerPerson ?? 0,
      votesLeft: this.canVote ? this.votes.left() : 0,
      canVote: this.canVote,
      multiSelect: this.multi_,
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
    if (this.drag && this.drag.g !== g) this.drag = null;
    // An edit under a moving camera would drag the object along with the leader's view: editing ends the follow.
    if (g && g.kind !== 'pan' && g.kind !== 'pinch' && g.kind !== 'tap') this.stopFollow();
    this.emitView();
  }

  px(n: number): number {
    return n / this.cam.scale;
  }

  /**
   * The camera including gesture input that has not reached a frame yet. Wheel, pinch and pan events
   * arrive faster than frames (120+/s on a trackpad): they build on this and are applied once per frame.
   */
  get liveCamera(): Camera {
    return this.pending ?? this.cam;
  }

  /** Queues the next camera of a continuous gesture; the frame applies it (one `setCamera` per frame). */
  steerCamera(c: Camera): void {
    this.stopFollow();
    this.queueCamera(c);
  }

  /** Queues a camera for the next frame without touching «follow» (the follow itself uses this). */
  private queueCamera(c: Camera): void {
    this.cancelAnimation();
    const next = { tx: c.tx, ty: c.ty, scale: clampScale(c.scale) };
    if (sameCamera(next, this.liveCamera)) return;
    this.pending = next;
    this.renderer.requestFrame();
  }

  /**
   * Input: the pointer of the active gesture moved to `s` (`from`: where it went down). A frame, a move or a resize then
   * follows the pointer when the camera moves under it (the wheel) and, with `edge` (mouse and pen; a finger keeps the
   * system's edge swipes), pans the view toward the edge of the viewport the pointer is at.
   */
  dragPointer(from: Point, s: Point, m: Mods, edge: boolean): void {
    const g = this.gesture;
    if (!g || !FOLLOW_KINDS.has(g.kind)) {
      this.drag = null;
      return;
    }
    const speed = (p: Point): number => {
      const v = edgePanVelocity(p, this.viewport);
      return Math.hypot(v.x, v.y);
    };
    let d = this.drag;
    if (!d || d.g !== g) d = this.drag = { g, from, s, m, cam: this.liveCamera, base: speed(from), left: false, armed: false, at: 0 };
    d.s = s;
    d.m = m;
    d.cam = this.liveCamera;
    if (!edge) return;
    const v = speed(s);
    if (!d.armed) {
      // It pans once the pointer has really moved; one that went down in a zone only after leaving it or going deeper:
      // a click near the edge, or a drag away from it, never scrolls.
      if (v === 0) d.left = true;
      d.armed = Math.hypot(s.x - from.x, s.y - from.y) >= EDGE_SLOP_PX && (d.base === 0 || d.left || v > d.base);
    }
    if (d.armed && v > 0) this.renderer.requestFrame();
  }

  /**
   * Frame start: the edge pan's step (the first frame in a zone only starts its clock), the queued camera, then the drag
   * re-run where its pointer now is in the world. `true` while the pan goes on: the renderer runs the next frame.
   */
  private frameStart(): boolean {
    const d = this.drag && this.drag.g === this.gesture ? this.drag : null;
    let more = false;
    if (d?.armed) {
      const v = edgePanVelocity(d.s, this.viewport);
      if (v.x !== 0 || v.y !== 0) {
        const now = this.now();
        const dt = d.at ? Math.min(EDGE_PAN_MAX_DT, (now - d.at) / 1000) : 0;
        d.at = now;
        more = true;
        if (dt > 0) this.steerCamera(panBy(this.liveCamera, -v.x * dt, -v.y * dt));
      } else d.at = 0;
    }
    this.flushCamera();
    if (d && !sameCamera(d.cam, this.cam)) {
      d.cam = this.cam;
      d.g.move(screenToWorld(this.cam, d.s), d.s, d.m);
    }
    return more;
  }

  /** Applies queued gesture input now (gesture end, explicit commands, the frame start). */
  flushCamera(): void {
    const c = this.pending;
    if (!c) return;
    this.pending = null;
    this.setCamera(c);
  }

  setCamera(c: Camera): void {
    this.pending = null;
    const next = { tx: c.tx, ty: c.ty, scale: clampScale(c.scale) };
    if (sameCamera(next, this.cam)) return;
    this.cam = next;
    this.renderer.requestFrame();
    this.sync();
    this.emitView();
    this.emitLocalView();
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
    if (this.entered !== null && ![...next].some((i) => this.scene.get(i)?.group === this.entered)) this.entered = null;
    this.refreshOverlay();
    this.sync();
    this.notifySelection();
    this.emitLocal();
  }

  finishCreate(ids: readonly string[], edit: boolean): void {
    this.setSelection(ids);
    this.setTool('select');
    const id = ids[0];
    if (edit && id) this.startTextEdit(id, true);
  }

  /** Decoration for the current selection (outlines, the frame with its handles, connector ends). */
  private refreshOverlay(): void {
    const outlines: Outline[] = [];
    const connectors = [];
    const recs = this.getSelected();
    for (const o of recs) {
      if (isConnector(o)) connectors.push(o);
      else outlines.push({ rect: { x: o.x, y: o.y, w: o.w, h: o.h }, rot: o.rot ?? 0 });
    }
    const group = !this.readOnly && !this.editor.isOpen ? selectionFrame(recs) : null;
    this.overlay = { ...this.overlay, outlines: this.sel.size > 1 ? outlines : [], connectors, group, ...(this.touch ? { touch: true } : {}) };
    this.renderer.requestFrame();
  }

  /** The selection frame the input hit-tests its handles against (null when read-only or editing): the one the overlay draws, kept current by `refreshOverlay`. */
  selectionFrame(): SelFrame | null {
    return this.overlay.group;
  }

  private onSceneChange(ids: ReadonlySet<string>, order = false): void {
    // Objects came or went: votes for gone ones stop counting, the leaders and my remaining votes may differ.
    if (order && this.votes.active) this.votes.invalidate();
    if (this.editingId !== null && (ids.has(this.editingId) || !this.scene.has(this.editingId))) this.followEditedObject(this.editingId);
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

  /** A co-author deleted, locked or moved the object being edited: the editor closes (nothing to write into) or follows it. */
  private followEditedObject(id: string): void {
    const o = this.scene.get(id);
    if (!o || o.locked) {
      this.editor.cancel();
      this.renderer.setHiddenText(null);
      this.editingId = null;
      this.endEditCamera();
      this.refreshOverlay();
      this.sync();
      return;
    }
    const spec = this.editSpec(o);
    if (spec) this.editor.moveTo(spec);
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

  /**
   * Leaving the phone's edit mode (the screen's «Готово»): what was typed is kept, a gesture in progress is dropped, and no
   * selection, tool or «several» mode stays armed. The caller flushes the socket before it turns the canvas read-only.
   */
  leaveTouchEdit(): void {
    if (this.editor.isOpen) this.editor.commit();
    const g = this.gesture;
    this.activeGesture = null;
    g?.cancel();
    this.clearSelection();
    this.setTool('select');
    this.setMultiSelect(false);
  }

  /** A long press on empty canvas (touch editing): the phone shows its menu. */
  onLongPress(fn: (screen: Point, world: Point) => void): () => void {
    this.pressListeners.add(fn);
    return () => this.pressListeners.delete(fn);
  }

  emitLongPress(screen: Point, world: Point): void {
    for (const fn of [...this.pressListeners]) fn(screen, world);
  }

  /**
   * A click of the «Комментарий» tool: the view places a pin there and opens the input. The document is not
   * touched — comments are a server entity (ADR-0115 wave 4).
   */
  onCommentAt(fn: (c: CommentClick) => void): () => void {
    this.commentListeners.add(fn);
    return () => this.commentListeners.delete(fn);
  }

  emitCommentAt(screen: Point, world: Point): void {
    const hit = this.hitAt(world);
    const c: CommentClick = { screen, world, objectId: hit ? hit.id : null };
    for (const fn of [...this.commentListeners]) fn(c);
  }

  /** «Выбрать несколько» (touch): while on, a tap adds the object to the selection or takes it out. */
  setMultiSelect(on: boolean): void {
    if (this.multi_ === on) return;
    this.multi_ = on;
    this.sync();
  }

  get multiSelect(): boolean {
    return this.multi_;
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
    if (this.readOnly) {
      // Commit, not drop: typed text must survive a role flip to read-only.
      this.editor.commit();
      this.renderer.setHiddenText(null);
      this.editingId = null;
      this.endEditCamera();
      // An edit drag in progress is dropped (its release would write into a doc that no longer syncs); a pan goes on.
      const g = this.gesture;
      if (g && g.kind !== 'pan' && g.kind !== 'pinch' && g.kind !== 'tap') {
        this.activeGesture = null;
        g.cancel();
      }
    }
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
    const changed = this.active !== on;
    this.active = on;
    this.renderer.setActive(on);
    if (on) {
      this.scheduleAwarenessStep();
      this.emitLocalView();
    } else {
      this.clearAwarenessStep();
      this.clearViewTimer();
    }
    // Pieces of UI that pause while hidden (the mini-map) pick up again on this.
    if (changed) this.emitView();
  }

  /** The window and the canvas are on screen (what `setActive` last said). */
  get isActive(): boolean {
    return this.active;
  }

  // ── camera commands ─────────────────────────────────────────────────────────

  get viewport(): { w: number; h: number } {
    return this.renderer.viewport;
  }

  toWorld(screen: Point): Point {
    return screenToWorld(this.liveCamera, screen);
  }

  zoomAtPoint(factor: number, at: Point): void {
    this.stopFollow();
    this.cancelAnimation();
    this.setCamera(zoomAt(this.liveCamera, factor, at));
  }

  panByScreen(dx: number, dy: number): void {
    this.stopFollow();
    this.cancelAnimation();
    const c = this.liveCamera;
    this.setCamera({ ...c, tx: c.tx + dx, ty: c.ty + dy });
  }

  /** `zoomAtPoint` for a stream of wheel/gesture events: queued, applied with the next frame. */
  steerZoom(factor: number, at: Point): void {
    this.steerCamera(zoomAt(this.liveCamera, factor, at));
  }

  /** `panByScreen` for a stream of wheel events: queued, applied with the next frame. */
  steerPan(dx: number, dy: number): void {
    const c = this.liveCamera;
    this.steerCamera({ ...c, tx: c.tx + dx, ty: c.ty + dy });
  }

  zoomStep(dir: 1 | -1): void {
    const v = this.viewport;
    const c = this.liveCamera;
    const target = nextZoomStep(c.scale, dir);
    this.moveCamera(zoomAt(c, target / c.scale, { x: v.w / 2, y: v.h / 2 }));
  }

  /** Absolute zoom, percent (clamped 10–400), around the viewport center. */
  zoomTo(pct: number): void {
    const v = this.viewport;
    const c = this.liveCamera;
    this.moveCamera(zoomAt(c, clampScale(pct / 100) / c.scale, { x: v.w / 2, y: v.h / 2 }));
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
    const { scale } = this.liveCamera;
    this.moveCamera({ scale, tx: v.w / 2 - p.x * scale, ty: v.h / 2 - p.y * scale });
  }

  /**
   * Moves the camera (animated, zoom unchanged) so the selection lies between `inset.top` and `inset.bottom` px of the view,
   * the strips the screen's own panels cover (phone: the zoom bar above, the properties sheet and tool bar below). A selection
   * taller than that is aligned to the top. False: nothing needed, or a gesture is in progress.
   */
  revealSelection(inset: { top: number; bottom: number }): boolean {
    const b = this.scene.bounds(this.sel);
    if (!b || this.gesture) return false;
    const c = this.liveCamera;
    const v = this.viewport;
    const top = inset.top + 8;
    const bottom = v.h - inset.bottom - 8;
    const y0 = c.ty + b.y * c.scale;
    const y1 = c.ty + (b.y + b.h) * c.scale;
    let dy = 0;
    if (y1 - y0 > bottom - top) dy = top - y0;
    else if (y1 > bottom) dy = bottom - y1;
    else if (y0 < top) dy = top - y0;
    if (Math.abs(dy) < 1) return false;
    this.moveCamera({ ...c, ty: c.ty + dy });
    return true;
  }

  visibleWorld(): Rect {
    return visibleRect(this.cam, this.viewport);
  }

  /** Animated camera move (instant under reduced motion). The only place that loops frames besides the renderer. */
  private moveCamera(target: Camera): void {
    this.stopFollow();
    this.cancelAnimation();
    this.flushCamera();
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

  /** Everything but the locked objects (those are picked by a click only). */
  selectAll(): void {
    this.setSelection(this.scene.orderedIds().filter((id) => !this.scene.get(id)?.locked));
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
      // Tab walks the objects one by one: a group's member is stepped into.
      this.entered = this.scene.get(next)?.group ?? null;
      this.setSelection([next]);
      const o = this.scene.get(next);
      if (o && !rectInView(aabb(o), this.visibleWorld())) this.centerOn(rectCenter(aabb(o)));
    }
  }

  /**
   * Deletes the selected objects except the locked ones: a lock protects from deletion by every path (keys, cut, menu,
   * panels), and a member locked on its own stays when its group is deleted. Nothing to delete: no undo step.
   */
  deleteSelection(): void {
    if (!this.canEdit() || this.sel.size === 0) return;
    const ids = [...this.sel].filter((id) => !this.scene.get(id)?.locked);
    if (ids.length === 0) return;
    this.doc.checkpoint();
    this.doc.remove(ids, (c, end) => this.scene.pointOf(c, end));
  }

  duplicateSelection(): string[] {
    if (!this.canEdit() || this.sel.size === 0) return [];
    this.doc.checkpoint();
    // The copy lands to the right of the selection (a gap of 24), on the same line; a lone connector has no box to go beside and keeps the small diagonal step.
    const bb = boundsOf([...this.sel].flatMap((id) => { const o = this.scene.get(id); return o && !isConnector(o) ? [aabb(o)] : []; }));
    const ids = duplicate(this.scene, this.doc, this.sel, bb ? bb.w + 24 : 24, bb ? 0 : 24);
    if (ids.length > 0) this.setSelection(ids);
    else this.refused(this.sel.size);
    return ids;
  }

  /** CanvasDoc.createMany refused `n` new objects: over the count limit, else over the state limit. */
  private refused(n: number): void {
    this.opts.onRefused?.(this.doc.count + n > MAX_OBJECTS ? 'objects' : 'size');
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

  /** Copies the selection and deletes what may be deleted: on locked objects ⌘X is a plain copy. */
  async cut(): Promise<void> {
    if (!this.canEdit()) return;
    // What was copied is what goes: the selection may change while the clipboard write is awaited.
    const ids = [...this.sel].filter((id) => !this.scene.get(id)?.locked);
    await this.copy();
    const alive = ids.filter((id) => this.scene.get(id));
    if (!this.canEdit() || alive.length === 0) return;
    this.doc.checkpoint();
    this.doc.remove(alive, (c, end) => this.scene.pointOf(c, end));
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
    const inits = toInits(payload, dx, dy);
    const ids = this.doc.createMany(inits);
    if (ids.length > 0) this.setSelection(ids);
    else if (inits.length > 0) this.refused(inits.length);
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

  /** A patch that shifts an object by a world delta (boxes by their frame, connectors by their free ends). */
  private shiftPatch(o: ObjectRec, dx: number, dy: number): ObjectPatch {
    if (!isConnector(o)) return { x: o.x + dx, y: o.y + dy };
    const p: ObjectPatch = {};
    if (!('id' in o.from)) p.from = { x: o.from.x + dx, y: o.from.y + dy };
    if (!('id' in o.to)) p.to = { x: o.to.x + dx, y: o.to.y + dy };
    return p;
  }

  /** Moves the selection by a world delta (arrow keys); locked objects stay. */
  nudge(dx: number, dy: number): void {
    if (!this.canEdit() || this.sel.size === 0) return;
    const patches = new Map<string, ObjectPatch>();
    for (const id of this.sel) {
      const o = this.scene.get(id);
      if (o && !o.locked) patches.set(id, this.shiftPatch(o, dx, dy));
    }
    this.doc.patchMany(patches);
  }

  /** Applies plain-field changes (color, size, fill, arrow, …) to every selected object they apply to (not the locked ones); `kinds` limits it to those object kinds. */
  updateSelected(patch: ObjectPatch, kinds?: readonly ObjectKind[]): void {
    if (!this.canEdit() || this.sel.size === 0) return;
    const patches = new Map<string, ObjectPatch>();
    for (const id of this.sel) {
      const o = this.scene.get(id);
      if (o?.locked) continue;
      if (kinds && (!o || !kinds.includes(o.kind))) continue;
      patches.set(id, patch);
    }
    this.doc.patchMany(patches);
  }

  // ── lock, groups, arrangement (ADR-0115) ────────────────────────────────────

  /** Locks the selection; when every selected object is already locked, unlocks it. */
  toggleLock(): void {
    if (!this.canEdit() || this.sel.size === 0) return;
    const recs = this.getSelected();
    const lock = !recs.every((o) => o.locked);
    const patches = new Map<string, ObjectPatch>();
    for (const o of recs) patches.set(o.id, { locked: lock });
    this.doc.checkpoint();
    this.doc.patchMany(patches);
  }

  /** Groups the selection (two or more objects) into one flat group; it replaces any group they were in. */
  groupSelection(): string | null {
    if (!this.canEdit() || this.sel.size < 2) return null;
    const recs = this.getSelected();
    const first = recs[0]?.group;
    if (first !== undefined && recs.every((o) => o.group === first) && this.scene.groupMembers(first).size === recs.length) return first;
    const gid = newId();
    const patches = new Map<string, ObjectPatch>();
    for (const o of recs) patches.set(o.id, { group: gid });
    this.doc.checkpoint();
    this.doc.patchMany(patches);
    this.entered = null;
    return gid;
  }

  /** Dissolves every group the selection touches (all their members, selected or not) and selects them. */
  ungroupSelection(): void {
    if (!this.canEdit()) return;
    const members = new Set<string>();
    for (const o of this.getSelected()) for (const id of this.scene.groupMembers(o.group)) members.add(id);
    if (members.size === 0) return;
    const patches = new Map<string, ObjectPatch>();
    for (const id of members) patches.set(id, { group: null });
    this.doc.checkpoint();
    this.doc.patchMany(patches);
    this.entered = null;
    this.setSelection(members);
  }

  /** The ids plus the unlocked members of their groups; inside the group the user stepped into, ids stay as they are. */
  expandUnits(ids: Iterable<string>): string[] {
    const out = new Set<string>();
    for (const id of ids) {
      const g = this.scene.get(id)?.group;
      if (g === undefined || g === this.entered) out.add(id);
      else for (const m of this.scene.groupMembers(g)) if (!this.scene.get(m)?.locked) out.add(m);
    }
    return [...out];
  }

  /** What a click on `id` selects: the object's whole group (just itself inside the group stepped into). */
  unitAt(id: string): string[] {
    const g = this.scene.get(id)?.group;
    return g === undefined || g === this.entered ? [id] : this.scene.unitOf(id);
  }

  /** Double-click on a group member from outside: step into the group and select that member. Returns false when there is nothing to step into. */
  enterGroupAt(id: string): boolean {
    const g = this.scene.get(id)?.group;
    if (g === undefined || g === this.entered) return false;
    this.entered = g;
    this.setSelection([id]);
    return true;
  }

  /** Esc: leave the group stepped into, keeping it selected as a whole. Returns false when none was entered. */
  exitGroup(): boolean {
    const g = this.entered;
    if (g === null) return false;
    this.entered = null;
    this.setSelection(this.scene.groupMembers(g));
    return true;
  }

  get enteredGroup(): string | null {
    return this.entered;
  }

  /** Aligns / distributes the selection by circumscribed rects, groups as units; locked ones do not move. One undo step. */
  arrange(op: ArrangeOp): void {
    if (!this.canEdit()) return;
    const units = arrangeUnits(this.getSelected(), (g) => this.scene.groupMembers(g).size);
    const deltas = arrangeDeltas(units, op);
    if (!deltas) return;
    const patches = new Map<string, ObjectPatch>();
    units.forEach((u, i) => {
      const d = deltas[i];
      if (!d || (d.dx === 0 && d.dy === 0)) return;
      for (const id of u.ids) {
        const o = this.scene.get(id);
        if (o) patches.set(id, this.shiftPatch(o, d.dx, d.dy));
      }
    });
    if (patches.size === 0) return;
    this.doc.checkpoint();
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
    const turn = o.rot ? { rot: o.rot, center: rectCenter(o) } : {};
    switch (o.kind) {
      case 'sticky': return { box, text: o.text, size: boxFontSize(o), color: resolveSticky(p, o.color).fg, align: 'left', vcenter: false, autoHeight: false, fontFamily: p.fontFamily, rich: true, sized: true, ...(o.fmt ? { fmt: o.fmt } : {}), ...turn };
      case 'text': return { box, text: o.text, size: o.size, color: resolveColor(p, o.color) ?? p.ink, align: 'left', vcenter: false, autoHeight: true, fontFamily: p.fontFamily, rich: true, sized: true, ...(o.fmt ? { fmt: o.fmt } : {}), ...turn };
      case 'shape': return { box, text: o.text, size: boxFontSize(o), color: shapeInk(p, o.fill), align: 'center', vcenter: true, autoHeight: false, fontFamily: p.fontFamily, rich: true, sized: true, ...(o.fmt ? { fmt: o.fmt } : {}), ...turn };
    }
  }

  /** The text editor asks for the view to move by `dy` px so the text stays clear of the keyboard (phone). Remembers where it came from. */
  private keepEditVisible(dy: number): void {
    const c = this.liveCamera;
    const target = { ...c, ty: c.ty + dy };
    if (!this.editCam) this.editCam = { before: c, after: target };
    else this.editCam.after = target;
    this.moveCamera(target);
  }

  /** The edit is over: the view goes back to where it was before the keyboard moved it — unless the person has moved it since. */
  private endEditCamera(): void {
    const e = this.editCam;
    this.editCam = null;
    if (!e) return;
    if (sameCamera(this.liveCamera, e.after) || sameCamera(this.cam, e.after)) this.moveCamera(e.before);
  }

  /** Opens the textarea over an object (default: the single selected one). */
  startTextEdit(id?: string, fresh = false): boolean {
    if (!this.canEdit()) return false;
    // A previous edit still open (a size list held the focus) ends first, so its close does not reset this one.
    if (this.editor.isOpen) this.editor.commit();
    const target = id ?? this.state.selectedId;
    const o = target ? this.scene.get(target) : undefined;
    if (!o || o.locked) return false;
    const spec = this.editSpec(o);
    if (!spec) return false;
    const oid = o.id;
    this.renderer.setHiddenText(oid);
    this.overlay = { ...this.overlay, group: null };
    this.editingId = oid;
    const original = this.doc.rawTextOf(oid);
    // An object created for this edit: left empty, it goes with its creation step instead of two silent undo steps.
    const created = fresh ? this.doc.topStep() : null;
    this.editor.open(spec, (text, changed, fmt, fmtChanged) => {
      this.renderer.setHiddenText(null);
      this.editingId = null;
      this.endEditCamera();
      const cur = this.scene.get(oid);
      if (cur) {
        this.doc.checkpoint();
        // Emptied, unless a co-author typed into it meanwhile (then the edit merges like any other).
        if (cur.kind === 'text' && text.trim() === '' && this.doc.rawTextOf(oid) === original) {
          if (!this.doc.undoStep(created)) this.doc.remove([oid]);
        }
        else if (cur.kind === 'connector') this.doc.setText(oid, text);
        else if (changed || fmtChanged) this.doc.setRich(oid, text, fmt, original);
      }
      this.refreshOverlay();
      this.sync();
      this.canvas.focus({ preventScroll: true });
    });
    this.sync();
    return true;
  }

  /**
   * Inserts a built-in template centered on the visible area, in one transaction (one undo step), and selects it.
   * Returns the new ids; [] when the canvas has no room (the 5000-object limit) or cannot be edited.
   */
  insertTemplate(id: TemplateId, tr: TemplateText): string[] {
    if (!this.canEdit()) return [];
    const view = this.visibleWorld();
    const items = buildTemplate(id, { x: view.x + view.w / 2, y: view.y + view.h / 2 }, tr, newId);
    this.doc.checkpoint();
    const ids = this.doc.createMany(items);
    if (ids.length > 0) {
      this.setSelection(ids);
      this.setTool('select');
    }
    return ids;
  }

  /** The text size in px of the object under edit (the format bar's size field): the object changes, the textarea follows. */
  setEditFontSize(px: number): void {
    const id = this.editingId;
    const o = id ? this.scene.get(id) : undefined;
    if (!id || !o || isConnector(o) || o.locked || !this.canEdit() || !this.editor.isOpen) return;
    this.doc.patch(id, { fontPx: px });
    const now = this.scene.get(id);
    if (now && !isConnector(now)) this.editor.setSize(boxFontSize(now));
  }

  /** Double-click on empty canvas: a new text object, in edit mode. */
  createTextAt(world: Point): string | null {
    if (!this.canEdit()) return null;
    this.doc.checkpoint();
    const id = this.doc.create({ kind: 'text', x: world.x - 8, y: world.y - DEFAULTS.textSize });
    if (id) this.finishCreate([id], true);
    return id;
  }

  /** Hit-test a world point with a screen-pixel radius; `boxPx` (a finger) also picks a box that close when nothing is hit exactly. */
  hitAt(world: Point, px = 6, boxPx = 0): ObjectRec | null {
    const hit = this.scene.hit(world, this.px(px));
    return hit || boxPx === 0 ? hit : this.scene.hit(world, this.px(px), undefined, this.px(boxPx));
  }

  // ── awareness ───────────────────────────────────────────────────────────────

  /** Remote participants from the sync layer; schedules at most one timer for the next cursor fade step. */
  setPeers(peers: readonly PeerState[], settled = true): void {
    this.peersSettled = settled;
    this.live.setPresent(peers.map((p) => p.id));
    const changed = this.awareness.setPeers(peers, this.now());
    if (changed) this.renderer.requestRemoteFrame();
    this.scheduleAwarenessStep();
    if (this.followKey_ !== null) {
      this.applyFollow();
      this.sync();
    }
  }

  // ── voting ──────────────────────────────────────────────────────────────────

  /** A vote is open and I may take part in it. */
  get canVote(): boolean {
    return this.votes.phase === 'open' && this.canEdit() && this.userId !== '';
  }

  /** Starts a new vote (all earlier votes are dropped); null without write access. */
  startVote(votesPerPerson = VOTE_DEFAULT): VoteSession | null {
    if (!this.canEdit() || this.userId === '') return null;
    const s = this.votes.start(votesPerPerson);
    this.sync();
    return s;
  }

  finishVote(): boolean {
    return this.canEdit() && this.votes.finish();
  }

  resetVote(): boolean {
    return this.canEdit() && this.votes.reset();
  }

  /** +1 / −1 of my vote on a sticky or shape. */
  castVote(id: string, delta: 1 | -1): boolean {
    return this.canVote && this.votes.add(id, delta);
  }

  /** Whether a click on this object is a vote right now (the hover cursor and the double-click ask). */
  votableAt(id: string): boolean {
    if (!this.canVote) return false;
    const k = this.scene.get(id)?.kind;
    return k === 'sticky' || k === 'shape';
  }

  /** A click on an object while voting: +1, or −1 with Alt or on its own badge. Returns whether a vote changed. */
  voteClick(id: string, at: Point, alt: boolean): boolean {
    if (!this.votableAt(id)) return false;
    const o = this.scene.get(id);
    const own = this.votes.own(id);
    const onBadge = !!o && o.kind !== 'connector' && own > 0 && hitBadge(o, own, this.cam.scale, at);
    return this.castVote(id, alt || onBadge ? -1 : 1);
  }

  /** Repaints just the objects whose badge may differ (everything for a new session, a finish or a reset). */
  private onVotes(ids: ReadonlySet<string> | null): void {
    if (ids === null || ids.size > 256) this.renderer.invalidateAll();
    else {
      const margin = BADGE_MARGIN_PX / this.cam.scale;
      for (const id of ids) {
        const o = this.scene.get(id);
        if (o) this.renderer.invalidate(rectInflate(visualBounds(o), margin));
      }
    }
    this.sync();
  }

  // ── follow a participant ────────────────────────────────────────────────────

  /** The camera follows the center and zoom of that person (`PeerState.userId ?? id`); null stops. Their own screen size does not matter. */
  follow(key: string | null): void {
    if (key === null) {
      this.stopFollow();
      return;
    }
    if (key === this.followKey_ || !this.awareness.followTarget(key)) return;
    this.followKey_ = key;
    this.followApplied = null;
    this.applyFollow();
    this.sync();
  }

  get followKey(): string | null {
    return this.followKey_;
  }

  private stopFollow(): void {
    if (this.followKey_ === null) return;
    this.followKey_ = null;
    this.followApplied = null;
    this.sync();
  }

  /** Brings the camera to the followed person's view; ends the follow when they left the canvas. Queued like gesture input (one `setCamera` per frame). */
  private applyFollow(): void {
    const key = this.followKey_;
    if (key === null) return;
    const peer = this.awareness.followTarget(key);
    if (!peer) {
      // Without a socket everyone is gone for a moment: the follow waits for the list after the reconnect.
      if (this.peersSettled) this.stopFollow();
      return;
    }
    const v = peer.view;
    const vp = this.viewport;
    if (!v || vp.w <= 0 || vp.h <= 0 || sameView(v, this.followApplied)) return;
    this.followApplied = v;
    const scale = clampScale(v.zoom);
    this.queueCamera({ scale, tx: vp.w / 2 - v.x * scale, ty: vp.h / 2 - v.y * scale });
  }

  /** The center and zoom of what we see, for the others to follow (5/s at most, only after a change, nothing while hidden). */
  onLocalView(fn: (v: PeerView) => void): () => void {
    this.localViewListeners.add(fn);
    // A camera that moved before anyone listened still goes out once.
    if (this.viewDirty) this.emitLocalView();
    return () => this.localViewListeners.delete(fn);
  }

  private clearViewTimer(): void {
    if (this.viewTimer) clearTimeout(this.viewTimer);
    this.viewTimer = null;
  }

  private emitLocalView(): void {
    this.viewDirty = true;
    if (this.localViewListeners.size === 0 || !this.active || this.viewTimer) return;
    const wait = this.viewAt + LOCAL_VIEW_MS - this.now();
    if (wait <= 0) this.fireLocalView();
    else this.viewTimer = setTimeout(() => this.fireLocalView(), wait);
  }

  private fireLocalView(): void {
    this.viewTimer = null;
    if (!this.viewDirty || !this.active || this.destroyed) return;
    const vp = this.viewport;
    if (vp.w <= 0 || vp.h <= 0) return;
    this.viewDirty = false;
    this.viewAt = this.now();
    const r = visibleRect(this.cam, vp);
    const v: PeerView = { x: r.x + r.w / 2, y: r.y + r.h / 2, zoom: this.cam.scale };
    for (const fn of this.localViewListeners) fn(v);
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
      this.renderer.requestRemoteFrame();
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
      // The center of our view moved with the window: tell the others, and keep the followed center in the middle.
      this.emitLocalView();
      if (this.followKey_ !== null) {
        this.followApplied = null;
        this.applyFollow();
      }
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
    this.clearViewTimer();
    for (const d of this.disposers.splice(0)) d();
    this.renderer.destroy();
    this.live.destroy();
    this.scene.destroy();
    this.doc.destroy();
    this.listeners.clear();
    this.selListeners.clear();
    this.localListeners.clear();
    this.viewListeners.clear();
    this.localViewListeners.clear();
  }
}

function rectInView(r: Rect, view: Rect): boolean {
  const i = rectInflate(view, 0);
  return r.x >= i.x && r.y >= i.y && r.x + r.w <= i.x + i.w && r.y + r.h <= i.y + i.h;
}


/** The text color the renderer uses on a shape (readable on its fill), so the editor matches it. */
function shapeInk(p: CanvasPalette, fillToken: string | undefined): string {
  const fill = resolveColor(p, fillToken);
  const ink = resolveColor(p, 'text') ?? p.ink;
  return fill ? readableInk(fill, ink) : ink;
}

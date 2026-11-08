import { snapCamera, visibleRect, type Camera } from '../../../lib/canvas/camera';
import { rectUnion, rectsIntersect, type Rect } from '../../../lib/canvas/geometry';
import type { Scene, SceneChange } from '../../../lib/canvas/scene';
import { visualBounds } from '../../../lib/canvas/scene';
import { AwarenessLayer } from './awareness';
import { drawBackground, drawObjects, releaseScratch, type Ctx2D, type DrawEnv } from './draw';
import { drawOverlay, overlayBounds, type OverlayState } from './overlay';
import type { ImageSource } from './images';
import type { CanvasPalette } from './palette';

export interface RendererOptions {
  canvas: HTMLCanvasElement;
  /**
   * A second, transparent canvas stacked over `canvas` (same CSS box, `pointer-events: none`) that holds only
   * other people's cursors and selections (ADR-0126 §4). A stream of awareness frames repaints a few hundred
   * pixels there and never touches `canvas` or its content layer. Absent: they are composited onto `canvas`.
   */
  remoteCanvas?: HTMLCanvasElement;
  scene: Scene;
  palette: CanvasPalette;
  getCamera: () => Camera;
  getOverlay: () => OverlayState;
  awareness: AwarenessLayer;
  /** Vote badges: the book while a vote exists (open or finished), null otherwise (ADR-0127). */
  getVotes?: () => DrawEnv['votes'];
  /** A sticky pad's hover lift (0…1), see DrawEnv.padLift. */
  getPadLift?: (id: string) => number;
  /** Decoded pictures (absent: pictures are plaques). */
  images?: ImageSource;
  /** Max device-pixel ratio; 1 in the low-power mode. */
  maxDpr?: number;
  /** Injected for tests / non-DOM hosts. */
  raf?: (cb: () => void) => number;
  cancelRaf?: (id: number) => void;
  now?: () => number;
  /**
   * Runs at the start of a frame, before the camera is read (the engine applies queued gesture input). `true` asks for
   * the next frame as well (the edge pan of a drag moves the camera every frame while it lasts).
   */
  beforeFrame?: () => boolean;
  makeLayer?: (w: number, h: number) => LayerCanvas;
}

export interface LayerCanvas {
  width: number;
  height: number;
  getContext(kind: '2d'): Ctx2D | null;
}

export interface FrameStats {
  /** Frames that repainted the main canvas. */
  frames: number;
  /** Frames that repainted only the remote layer (cursors / peer selections). */
  remote: number;
  full: number;
  scrolled: number;
  regions: number;
  /** Objects drawn in the last frame's content passes. */
  drawn: number;
  /** Frames that composited only a piece of the overlay (the pen's stroke). */
  partial: number;
  /** Frames that placed a lifted drag sprite (`liftObjects`). */
  sprite: number;
}

const MAX_REGIONS = 8;
/** Damage over more than this share of the canvas is composited whole (cheaper than clipping that much). */
const PARTIAL_MAX_SHARE = 0.6;
/** A drag sprite no larger than this per side, device px, and than this share of the canvas (else the drag paints as before). */
const SPRITE_MAX_SIDE = 4096;
const SPRITE_MAX_SHARE = 1.5;

/** Objects lifted out of the content layer while a drag moves them (`liftObjects`). */
interface Lift {
  ids: ReadonlySet<string>;
  /** One lifted box and where it was at the lift: its position now gives the sprite's offset. */
  ref: string;
  start: { x: number; y: number };
  /** World rect the sprite covers at the lift, and the camera scale it was painted at. */
  box: Rect;
  scale: number;
  canvas: LayerCanvas;
  /** Last known visual bounds of the connectors glued to lifted objects (they re-route each frame: old + new are dirty). */
  known: Map<string, Rect>;
}

/**
 * Canvas 2D renderer, on demand (ADR-0126 §4): a frame is scheduled only when something is dirty or a
 * gesture changed the camera, and nothing is scheduled while idle. The content (background + objects) is
 * kept in an offscreen layer: panning blits it shifted and paints just the exposed strips; object changes
 * repaint only their dirty rects; the overlay (selection, guides, remote cursors) is composited on top each
 * frame. No shadows or blur. Remote cursors and selections live on their own canvas (`remoteCanvas`) and
 * repaint on `requestRemoteFrame` without touching the content layer or the main canvas.
 */
export class Renderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: Ctx2D;
  private readonly remote: HTMLCanvasElement | null;
  private rctx: Ctx2D | null = null;
  /** The main canvas needs a frame (content, camera, overlay); false = only the remote layer does. */
  private mainDirty = true;
  /**
   * Only this world rect of the overlay changed since the last frame (the pen's stroke growing): the frame composites
   * just that part of the screen.
   */
  private overlayDirty: Rect | null = null;
  /** A frame request (not only the pen's tail) since the last frame: the tail-only composite would miss its overlay change. */
  private frameRequested = false;
  /** Composite everything on the next frame: the first one, and any frame request without a remote layer. */
  private compositeAll = true;
  /** The overlay's world box at the last frame (`overlayBounds`): where its old pixels are, to repaint on the next one. */
  private lastOverlay: Rect | null = null;
  private lift: Lift | null = null;
  /** The drag sprite's world box at the last frame (where to repaint once it moved on or was dropped). */
  private lastSprite: Rect | null = null;
  private remoteDirty = true;
  /** Device-pixel box the remote layer painted last (what to clear next), and the camera it was painted for. */
  private remoteBox: Rect | null = null;
  private remoteCam: Camera | null = null;
  private layer: LayerCanvas;
  private lctx: Ctx2D;
  private layerCam: Camera | null = null;
  private layerValid = false;
  private cssW = 0;
  private cssH = 0;
  private dpr = 1;
  private maxDpr: number;
  private fullDirty = true;
  private dirty: Rect[] = [];
  private raf = 0;
  private active = true;
  private hiddenText: string | null = null;
  private palette: CanvasPalette;
  private readonly off: () => void;
  readonly stats: FrameStats = { frames: 0, remote: 0, full: 0, scrolled: 0, regions: 0, drawn: 0, partial: 0, sprite: 0 };
  /** Frame callback for the owner (e.g. to keep the text editor aligned). */
  onFrame: (() => void) | null = null;

  constructor(private readonly o: RendererOptions) {
    this.canvas = o.canvas;
    const ctx = o.canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('canvas 2d context unavailable');
    this.ctx = ctx;
    this.remote = o.remoteCanvas ?? null;
    if (this.remote) {
      this.rctx = this.remote.getContext('2d');
      if (!this.rctx) throw new Error('canvas 2d context unavailable');
    }
    this.maxDpr = o.maxDpr ?? 2;
    this.palette = o.palette;
    this.layer = this.makeLayer(1, 1);
    const l = this.layer.getContext('2d');
    if (!l) throw new Error('canvas 2d context unavailable');
    this.lctx = l;
    this.off = o.scene.subscribe((c) => this.onSceneChange(c));
  }

  destroy(): void {
    this.off();
    if (this.raf) (this.o.cancelRaf ?? cancelAnimationFrame)(this.raf);
    this.raf = 0;
    releaseScratch();
  }

  private makeLayer(w: number, h: number): LayerCanvas {
    if (this.o.makeLayer) return this.o.makeLayer(w, h);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  get frameScheduled(): boolean {
    return this.raf !== 0;
  }

  get pendingDirty(): boolean {
    return this.fullDirty || this.dirty.length > 0;
  }

  get devicePixelRatio(): number {
    return this.dpr;
  }

  setPalette(p: CanvasPalette): void {
    this.palette = p;
    this.remoteDirty = true;
    this.invalidateAll();
  }

  setMaxDpr(v: number): void {
    if (v === this.maxDpr) return;
    this.maxDpr = v;
    this.resize(this.cssW, this.cssH, this.o.canvas.ownerDocument.defaultView?.devicePixelRatio ?? 1);
  }

  /** The tab/window is hidden: no frames until shown again. */
  setActive(on: boolean): void {
    if (this.active === on) return;
    this.active = on;
    if (on) {
      this.remoteDirty = true;
      this.invalidateAll();
    } else if (this.raf) {
      (this.o.cancelRaf ?? cancelAnimationFrame)(this.raf);
      this.raf = 0;
    }
    if (!on) releaseScratch();
  }

  setHiddenText(id: string | null): void {
    if (this.hiddenText === id) return;
    const prev = this.hiddenText;
    this.hiddenText = id;
    for (const k of [prev, id]) {
      const r = k ? this.o.scene.get(k) : undefined;
      if (r) this.invalidate(visualBounds(r));
    }
  }

  /** Canvas backing-store size from the element's CSS size. */
  resize(cssW: number, cssH: number, deviceDpr: number): void {
    const dpr = Math.max(1, Math.min(this.maxDpr, deviceDpr || 1));
    const w = Math.max(1, Math.round(cssW));
    const h = Math.max(1, Math.round(cssH));
    if (w === this.cssW && h === this.cssH && dpr === this.dpr) return;
    this.cssW = w;
    this.cssH = h;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    if (this.remote) {
      this.remote.width = this.canvas.width;
      this.remote.height = this.canvas.height;
      this.remoteBox = null;
      this.remoteCam = null;
      this.remoteDirty = true;
    }
    this.layer = this.makeLayer(this.canvas.width, this.canvas.height);
    const l = this.layer.getContext('2d');
    if (l) this.lctx = l;
    this.layer.width = this.canvas.width;
    this.layer.height = this.canvas.height;
    this.layerValid = false;
    this.fullDirty = true;
    this.requestFrame();
  }

  get viewport(): { w: number; h: number } {
    return { w: this.cssW, h: this.cssH };
  }

  // ── invalidation ───────────────────────────────────────────────────────────

  private onSceneChange(c: SceneChange): void {
    if (this.lift && this.liftedChange(c, this.lift)) {
      this.requestFrame();
      return;
    }
    if (c.full) this.fullDirty = true;
    else for (const r of c.dirty) this.dirty.push(r);
    this.requestFrame();
  }

  /**
   * A change during a lifted drag: the lifted objects only move the sprite (nothing to repaint), their glued connectors
   * repaint where they were and are. True when handled; false (anything else changed) falls back to the change's rects.
   */
  private liftedChange(c: SceneChange, lift: Lift): boolean {
    const rects: Rect[] = [];
    for (const id of c.ids) {
      if (lift.ids.has(id)) continue;
      const was = lift.known.get(id);
      if (!was) return false;
      rects.push(was);
      const o = this.o.scene.get(id);
      if (o) {
        const now = visualBounds(o);
        rects.push(now);
        lift.known.set(id, now);
      }
    }
    for (const r of rects) this.dirty.push(r);
    return true;
  }

  /**
   * Lifts `ids` out of the content layer for a drag: painted once into a sprite, the layer repainted once without them;
   * each frame then only places the sprite where they are now, instead of repainting all they cover (a frame and its
   * contents) twice. Connectors stay in the layer (glued ones re-route). False — the drag paints as before — when there
   * is nothing to lift or the sprite would be too large.
   */
  liftObjects(ids: Iterable<string>): boolean {
    this.dropLift();
    if (this.cssW === 0) return false;
    const scene = this.o.scene;
    const want = new Set<string>();
    const known = new Map<string, Rect>();
    for (const id of ids) {
      const o = scene.get(id);
      // A moving connector stays in the layer and repaints where it was and is, like a glued one.
      if (o?.kind === 'connector') known.set(id, visualBounds(o));
      else if (o) want.add(id);
    }
    if (want.size === 0) return false;
    const recs = scene.orderedIds().filter((id) => want.has(id)).map((id) => scene.get(id)).filter((o): o is NonNullable<typeof o> => !!o);
    let box: Rect | null = null;
    for (const o of recs) box = box ? rectUnion(box, visualBounds(o)) : visualBounds(o);
    const first = recs[0];
    if (!box || !first || first.kind === 'connector') return false;
    const cam = snapCamera(this.o.getCamera(), this.dpr);
    const s = this.dpr * cam.scale;
    const w = Math.ceil(box.w * s) + 2;
    const h = Math.ceil(box.h * s) + 2;
    if (w > SPRITE_MAX_SIDE || h > SPRITE_MAX_SIDE || w * h > SPRITE_MAX_SHARE * this.canvas.width * this.canvas.height) return false;
    const canvas = this.makeLayer(w, h);
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    ctx.setTransform(s, 0, 0, s, 1 - box.x * s, 1 - box.y * s);
    drawObjects(ctx, recs, box, { ...this.env(cam.scale), skip: undefined });
    for (const id of want) for (const cid of scene.connectorsOf(id)) {
      const c = scene.get(cid);
      if (c) known.set(cid, visualBounds(c));
    }
    this.lift = { ids: want, ref: first.id, start: { x: first.x, y: first.y }, box, scale: cam.scale, canvas, known };
    // The layer without them.
    this.invalidate(box);
    return true;
  }

  /** Ends a lift: the objects go back into the layer where they are now. */
  dropLift(): void {
    const lift = this.lift;
    if (!lift) return;
    this.lift = null;
    for (const id of lift.ids) {
      const o = this.o.scene.get(id);
      if (o) this.dirty.push(visualBounds(o));
    }
    this.dirty.push(lift.box);
    lift.canvas.width = 0;
    lift.canvas.height = 0;
    this.requestFrame();
  }

  /** Where the lifted sprite is now (its box moved by the reference object's travel), or null. */
  private spriteBox(lift: Lift): Rect | null {
    const ref = this.o.scene.get(lift.ref);
    if (!ref || ref.kind === 'connector') return null;
    return { x: lift.box.x + ref.x - lift.start.x, y: lift.box.y + ref.y - lift.start.y, w: lift.box.w, h: lift.box.h };
  }

  /** World rect to repaint. */
  invalidate(r: Rect): void {
    this.dirty.push(r);
    this.requestFrame();
  }

  invalidateAll(): void {
    this.fullDirty = true;
    this.requestFrame();
  }

  /**
   * Only the overlay/camera changed (selection, guides, pan): a frame, no content repaint beyond the scroll. What it
   * composites is worked out by the frame (the changed content and the overlay's old and new box, or everything after
   * a scroll or zoom).
   */
  requestFrame(): void {
    this.mainDirty = true;
    this.frameRequested = true;
    // Without a remote layer the peers are painted on this canvas too, and nothing tracks where: composite it all.
    if (!this.remote) this.compositeAll = true;
    this.schedule();
  }

  /** Only `r` (world) of the overlay changed: the next frame repaints just that part of the screen, unless more comes up. */
  requestOverlayRect(r: Rect): void {
    this.mainDirty = true;
    this.overlayDirty = this.overlayDirty ? rectUnion(this.overlayDirty, r) : r;
    this.schedule();
  }

  /** Other people's cursors / selections changed: repaints the remote layer only (the main canvas when there is none). */
  requestRemoteFrame(): void {
    if (this.remote) this.remoteDirty = true;
    else this.mainDirty = true;
    this.schedule();
  }

  private schedule(): void {
    if (this.raf || !this.active) return;
    this.raf = (this.o.raf ?? requestAnimationFrame)(() => {
      // `raf` is still set here: a camera change made by the hook asks for this very frame, not another.
      const more = this.o.beforeFrame?.() ?? false;
      this.raf = 0;
      this.frame();
      if (more) this.schedule();
    });
  }

  // ── frame ──────────────────────────────────────────────────────────────────

  private env(scale: number): DrawEnv {
    return { palette: this.palette, layouter: this.o.scene.text, scale, hiddenText: this.hiddenText, votes: this.o.getVotes?.(), images: this.o.images, skip: this.lift?.ids, padLift: this.o.getPadLift };
  }

  frame(): void {
    if (!this.active || this.cssW === 0) return;
    if (!this.mainDirty) {
      if (this.remoteDirty) this.remoteFrame(snapCamera(this.o.getCamera(), this.dpr));
      return;
    }
    this.mainDirty = false;
    const dpr = this.dpr;
    const cam = snapCamera(this.o.getCamera(), dpr);
    const W = this.canvas.width;
    const H = this.canvas.height;
    // A zoom during a lifted drag: the sprite's pixels no longer fit; the objects go back into the layer.
    if (this.lift && this.lift.scale !== cam.scale) this.dropLift();
    this.stats.frames++;
    this.stats.drawn = 0;

    let full = this.fullDirty || !this.layerValid || !this.layerCam || this.layerCam.scale !== cam.scale;
    let dx = 0;
    let dy = 0;
    if (!full && this.layerCam) {
      dx = Math.round((cam.tx - this.layerCam.tx) * dpr);
      dy = Math.round((cam.ty - this.layerCam.ty) * dpr);
      if (Math.abs(dx) >= W || Math.abs(dy) >= H) full = true;
    }
    const dirty = this.dirty;
    this.dirty = [];
    this.fullDirty = false;
    const ov = this.o.getOverlay();
    const ovBox = overlayBounds(ov, cam.scale);
    const lastOv = this.lastOverlay;
    this.lastOverlay = ovBox;
    const lift = this.lift;
    const sprite = lift ? this.spriteBox(lift) : null;
    const lastSprite = this.lastSprite;
    this.lastSprite = sprite;
    // What changed on screen: the changed content, and the overlay where it was and where it is now (a dragged sticky,
    // its frame and handles). Only that is composited; a scroll, a zoom, peers drawn on this canvas (no remote layer)
    // or a change over most of the screen composite everything. The pen's stroke growing: just its tail.
    let partial: Rect[] | null = null;
    if (!this.compositeAll && !full && dx === 0 && dy === 0) {
      if (dirty.length === 0 && this.overlayDirty && !this.frameRequested) partial = [this.overlayDirty];
      else if (this.remote) {
        const boxes = [...dirty];
        if (lastOv) boxes.push(lastOv);
        if (ovBox) boxes.push(ovBox);
        if (lastSprite) boxes.push(lastSprite);
        if (sprite) boxes.push(sprite);
        if (this.overlayDirty) boxes.push(this.overlayDirty);
        partial = boxes;
      }
    }
    this.compositeAll = false;
    this.frameRequested = false;
    this.overlayDirty = null;

    if (full) {
      this.paintDevice(cam, { x: 0, y: 0, w: W, h: H });
      this.stats.full++;
    } else {
      if (dx !== 0 || dy !== 0) {
        this.stats.scrolled++;
        const l = this.lctx;
        l.save();
        l.setTransform(1, 0, 0, 1, 0, 0);
        l.drawImage(this.layer as unknown as CanvasImageSource, dx, dy);
        l.restore();
        if (dx !== 0) this.paintDevice(cam, dx > 0 ? { x: 0, y: 0, w: dx, h: H } : { x: W + dx, y: 0, w: -dx, h: H });
        if (dy !== 0) this.paintDevice(cam, dy > 0 ? { x: 0, y: 0, w: W, h: dy } : { x: 0, y: H + dy, w: W, h: -dy });
      }
      // Dirty rects: object changes since the last frame, in the (possibly scrolled) layer.
      const regions = this.toDeviceRegions(dirty, cam, W, H);
      for (const r of regions) this.paintDevice(cam, r);
    }
    const contentChanged = full || dirty.length > 0;
    this.layerCam = cam;
    this.layerValid = true;

    // Composite: content, then overlay + remote layer (world transform).
    const c = this.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    let parts = partial ? this.toDeviceRegions(partial, cam, W, H) : null;
    // One rect around all of it: a rectangular clip is a plain scissor on the GPU, several rects need a mask.
    if (parts && parts.length > 1) parts = [parts.reduce((u, r) => rectUnion(u, r))];
    // Most of the screen anyway: one plain composite is cheaper than clipping.
    if (parts && parts.reduce((a, r) => a + r.w * r.h, 0) > PARTIAL_MAX_SHARE * W * H) parts = null;
    if (parts) {
      // Nothing on screen changed (e.g. the change is off screen); peers' cursors may have.
      if (parts.length === 0) {
        if (this.remoteDirty) this.remoteFrame(cam);
        this.onFrame?.();
        return;
      }
      this.stats.partial++;
      c.save();
      c.beginPath();
      for (const r of parts) c.rect(r.x, r.y, r.w, r.h);
      c.clip();
      for (const r of parts) c.drawImage(this.layer as unknown as CanvasImageSource, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
    } else c.drawImage(this.layer as unknown as CanvasImageSource, 0, 0);
    if (lift && sprite) {
      // The lifted objects above the layer, at whole device pixels (the sprite's 1 px margin included).
      const s = dpr * cam.scale;
      this.stats.sprite++;
      c.drawImage(lift.canvas as unknown as CanvasImageSource, Math.round(sprite.x * s + cam.tx * dpr) - 1, Math.round(sprite.y * s + cam.ty * dpr) - 1);
    }
    c.setTransform(dpr * cam.scale, 0, 0, dpr * cam.scale, dpr * cam.tx, dpr * cam.ty);
    drawOverlay(c, ov, this.palette, cam.scale);
    if (!this.remote) this.o.awareness.draw(c, cam, this.o.scene, this.palette, (this.o.now ?? Date.now)());
    c.setTransform(1, 0, 0, 1, 0, 0);
    if (parts) c.restore();
    // Peers' selections follow the objects (the remote layer is redrawn below when content changed).
    if (parts && !(contentChanged && this.o.awareness.hasSelections)) {
      // Peers' cursors moved meanwhile (a drag, the pen, a hover): their layer too, or it freezes until the end.
      if (this.remoteDirty) this.remoteFrame(cam);
      this.onFrame?.();
      return;
    }
    if (this.remote) {
      const rc = this.remoteCam;
      // The remote layer is in screen space: it follows the camera, and peers' selections follow the objects.
      if (!rc || rc.tx !== cam.tx || rc.ty !== cam.ty || rc.scale !== cam.scale || (contentChanged && this.o.awareness.hasSelections)) this.remoteDirty = true;
      if (this.remoteDirty) this.remoteFrame(cam);
    }
    this.onFrame?.();
  }

  /** Repaints the remote layer: clears the box painted last time (all of it after a camera move), draws, remembers the new box. */
  private remoteFrame(cam: Camera): void {
    const c = this.rctx;
    if (!c || !this.remote || this.cssW === 0) return;
    this.remoteDirty = false;
    this.stats.remote++;
    const dpr = this.dpr;
    c.setTransform(1, 0, 0, 1, 0, 0);
    const rc = this.remoteCam;
    const sameCam = !!rc && rc.tx === cam.tx && rc.ty === cam.ty && rc.scale === cam.scale;
    const prev = this.remoteBox;
    if (!sameCam || !prev) c.clearRect(0, 0, this.remote.width, this.remote.height);
    else c.clearRect(prev.x, prev.y, prev.w, prev.h);
    c.setTransform(dpr * cam.scale, 0, 0, dpr * cam.scale, dpr * cam.tx, dpr * cam.ty);
    const box = this.o.awareness.draw(c, cam, this.o.scene, this.palette, (this.o.now ?? Date.now)());
    c.setTransform(1, 0, 0, 1, 0, 0);
    this.remoteCam = cam;
    if (!box) {
      this.remoteBox = null;
      return;
    }
    const s = dpr * cam.scale;
    const x0 = Math.max(0, Math.floor(box.x * s + cam.tx * dpr) - 3);
    const y0 = Math.max(0, Math.floor(box.y * s + cam.ty * dpr) - 3);
    const x1 = Math.min(this.remote.width, Math.ceil((box.x + box.w) * s + cam.tx * dpr) + 3);
    const y1 = Math.min(this.remote.height, Math.ceil((box.y + box.h) * s + cam.ty * dpr) + 3);
    this.remoteBox = x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
  }

  /** World dirty rects → merged device-pixel regions. */
  private toDeviceRegions(dirty: readonly Rect[], cam: Camera, W: number, H: number): Rect[] {
    const s = this.dpr * cam.scale;
    const dev: Rect[] = [];
    for (const r of dirty) {
      const x0 = Math.floor(r.x * s + cam.tx * this.dpr) - 2;
      const y0 = Math.floor(r.y * s + cam.ty * this.dpr) - 2;
      const x1 = Math.ceil((r.x + r.w) * s + cam.tx * this.dpr) + 2;
      const y1 = Math.ceil((r.y + r.h) * s + cam.ty * this.dpr) + 2;
      const cx0 = Math.max(0, x0);
      const cy0 = Math.max(0, y0);
      const cx1 = Math.min(W, x1);
      const cy1 = Math.min(H, y1);
      if (cx1 > cx0 && cy1 > cy0) dev.push({ x: cx0, y: cy0, w: cx1 - cx0, h: cy1 - cy0 });
    }
    // Overlapping rects (an object's old and new bounds) become one region.
    const merged: Rect[] = [];
    for (const r of dev) {
      let cur = r;
      for (let i = merged.length - 1; i >= 0; i--) {
        const m = merged[i];
        if (m && rectsIntersect(m, cur)) {
          cur = rectUnion(m, cur);
          merged.splice(i, 1);
        }
      }
      merged.push(cur);
    }
    if (merged.length <= MAX_REGIONS) return merged;
    // Too many small rects: one covering rect beats many clips.
    let u = merged[0] as Rect;
    for (const r of merged) u = rectUnion(u, r);
    return [u];
  }

  /** Repaints a device-pixel region of the content layer for the given camera. */
  private paintDevice(cam: Camera, region: Rect): void {
    const l = this.lctx;
    const dpr = this.dpr;
    this.stats.regions++;
    l.save();
    l.setTransform(1, 0, 0, 1, 0, 0);
    l.beginPath();
    l.rect(region.x, region.y, region.w, region.h);
    l.clip();
    l.setTransform(dpr * cam.scale, 0, 0, dpr * cam.scale, dpr * cam.tx, dpr * cam.ty);
    // Region in world units.
    const world: Rect = {
      x: (region.x / dpr - cam.tx) / cam.scale,
      y: (region.y / dpr - cam.ty) / cam.scale,
      w: region.w / dpr / cam.scale,
      h: region.h / dpr / cam.scale,
    };
    drawBackground(l, this.palette, world, cam.scale, dpr);
    const objs = this.o.scene.query(world);
    this.stats.drawn += objs.length;
    drawObjects(l, objs, world, this.env(cam.scale));
    l.restore();
  }

  /** Visible world rect for the current camera. */
  visibleWorld(): Rect {
    return visibleRect(this.o.getCamera(), this.viewport);
  }
}

/**
 * Renders the whole scene (or `bounds`) into a fresh canvas at `pxPerUnit`, for PNG export. Same drawing
 * code as the live view; no overlay.
 */
export function renderSceneTo(
  target: { width: number; height: number; getContext(kind: '2d'): Ctx2D | null },
  scene: Scene,
  palette: CanvasPalette,
  bounds: Rect,
  pxPerUnit: number,
  pad = 24,
  images?: ImageSource,
): void {
  const ctx = target.getContext('2d');
  if (!ctx) return;
  const w = Math.ceil((bounds.w + 2 * pad) * pxPerUnit);
  const h = Math.ceil((bounds.h + 2 * pad) * pxPerUnit);
  target.width = w;
  target.height = h;
  ctx.setTransform(pxPerUnit, 0, 0, pxPerUnit, (pad - bounds.x) * pxPerUnit, (pad - bounds.y) * pxPerUnit);
  const world: Rect = { x: bounds.x - pad, y: bounds.y - pad, w: bounds.w + 2 * pad, h: bounds.h + 2 * pad };
  ctx.fillStyle = palette.background;
  ctx.fillRect(world.x, world.y, world.w, world.h);
  // Pictures already decoded are painted; one still loading is its plaque (the export does not wait).
  drawObjects(ctx, scene.query(world), world, { palette, layouter: scene.text, scale: pxPerUnit, hiddenText: null, images });
}

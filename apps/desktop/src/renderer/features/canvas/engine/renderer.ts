import { snapCamera, visibleRect, type Camera } from '../../../lib/canvas/camera';
import { rectUnion, rectsIntersect, type Rect } from '../../../lib/canvas/geometry';
import type { Scene, SceneChange } from '../../../lib/canvas/scene';
import { visualBounds } from '../../../lib/canvas/scene';
import { AwarenessLayer } from './awareness';
import { drawBackground, drawObjects, type Ctx2D, type DrawEnv } from './draw';
import { drawOverlay, type OverlayState } from './overlay';
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
}

const MAX_REGIONS = 8;

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
  readonly stats: FrameStats = { frames: 0, remote: 0, full: 0, scrolled: 0, regions: 0, drawn: 0 };
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
    if (c.full) this.fullDirty = true;
    else for (const r of c.dirty) this.dirty.push(r);
    this.requestFrame();
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

  /** Only the overlay/camera changed (selection, guides, pan): a frame, no content repaint beyond the scroll. */
  requestFrame(): void {
    this.mainDirty = true;
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
    return { palette: this.palette, layouter: this.o.scene.text, scale, hiddenText: this.hiddenText, votes: this.o.getVotes?.() };
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
    c.drawImage(this.layer as unknown as CanvasImageSource, 0, 0);
    c.setTransform(dpr * cam.scale, 0, 0, dpr * cam.scale, dpr * cam.tx, dpr * cam.ty);
    const ov = this.o.getOverlay();
    drawOverlay(c, ov, this.palette, cam.scale);
    if (!this.remote) this.o.awareness.draw(c, cam, this.o.scene, this.palette, (this.o.now ?? Date.now)());
    c.setTransform(1, 0, 0, 1, 0, 0);
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
  drawObjects(ctx, scene.query(world), world, { palette, layouter: scene.text, scale: pxPerUnit, hiddenText: null });
}

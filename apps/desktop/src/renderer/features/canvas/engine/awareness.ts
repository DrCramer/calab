import type { Camera } from '../../../lib/canvas/camera';
import { rectInflate, rectUnion, type Point, type Rect } from '../../../lib/canvas/geometry';
import type { Scene } from '../../../lib/canvas/scene';
import type { Ctx2D } from './draw';
import type { CanvasPalette } from './palette';

/** One remote participant, as the sync layer (H4) reports it. Coordinates are world units. */
export interface PeerState {
  id: string;
  name: string;
  /** CSS color. */
  color: string;
  cursor?: Point | null;
  selection?: readonly string[];
}

/** Cursor stays fully visible this long after its last move, then dims, then disappears (no animation loop). */
export const CURSOR_FULL_MS = 2500;
export const CURSOR_DIM_MS = 6000;

interface Tracked {
  state: PeerState;
  movedAt: number;
}

/**
 * Remote cursors and selections: a light layer drawn over the content. State arrives from outside
 * (`setPeers`); cursor visibility steps down by time, so the engine only needs a one-shot timer to the
 * next step — never a frame loop.
 */
export class AwarenessLayer {
  private peers = new Map<string, Tracked>();

  /** Replaces the peer set. Returns true if anything visible changed (cursor moved, selection or peers differ). */
  setPeers(next: readonly PeerState[], now: number): boolean {
    let changed = next.length !== this.peers.size;
    const out = new Map<string, Tracked>();
    for (const s of next) {
      const prev = this.peers.get(s.id);
      const moved = !prev || !sameCursor(prev.state.cursor, s.cursor);
      if (!prev || moved || prev.state.color !== s.color || prev.state.name !== s.name || !sameSel(prev.state.selection, s.selection)) changed = true;
      out.set(s.id, { state: s, movedAt: moved && s.cursor ? now : (prev?.movedAt ?? now - CURSOR_DIM_MS) });
    }
    this.peers = out;
    return changed;
  }

  get size(): number {
    return this.peers.size;
  }

  /** Cursor alpha at `now`: 1 → 0.45 → 0. */
  alpha(id: string, now: number): number {
    const t = this.peers.get(id);
    if (!t?.state.cursor) return 0;
    const age = now - t.movedAt;
    return age < CURSOR_FULL_MS ? 1 : age < CURSOR_DIM_MS ? 0.45 : 0;
  }

  /** Ms until the next visibility step of any cursor; null if none will change. */
  nextStepIn(now: number): number | null {
    let best: number | null = null;
    for (const t of this.peers.values()) {
      if (!t.state.cursor) continue;
      const age = now - t.movedAt;
      const d = age < CURSOR_FULL_MS ? CURSOR_FULL_MS - age : age < CURSOR_DIM_MS ? CURSOR_DIM_MS - age : null;
      if (d !== null && (best === null || d < best)) best = d;
    }
    return best === null ? null : Math.max(16, best);
  }

  has(id: string): boolean {
    return this.peers.has(id);
  }

  /** Some peer has a selection: its outline follows the objects, so content changes redraw this layer. */
  get hasSelections(): boolean {
    for (const t of this.peers.values()) if (t.state.selection && t.state.selection.length > 0) return true;
    return false;
  }

  /**
   * Paints selections and cursors (world transform on ctx) for the camera. Returns the world rect that holds
   * everything painted (null if nothing was), so the owner clears just that next time.
   */
  draw(ctx: Ctx2D, cam: Camera, scene: Scene, p: CanvasPalette, now: number): Rect | null {
    const px = 1 / cam.scale;
    let box: Rect | null = null;
    for (const t of this.peers.values()) {
      const sel = t.state.selection;
      if (!sel) continue;
      ctx.strokeStyle = t.state.color;
      ctx.lineWidth = 2 * px;
      for (const id of sel) {
        const o = scene.get(id);
        if (!o) continue;
        const r = rectInflate(o, 2 * px);
        ctx.strokeRect(r.x, r.y, r.w, r.h);
        box = box ? rectUnion(box, rectInflate(r, px)) : rectInflate(r, px);
      }
    }
    for (const t of this.peers.values()) {
      const a = this.alpha(t.state.id, now);
      const c = t.state.cursor;
      if (a === 0 || !c) continue;
      const r = this.drawCursor(ctx, c.x, c.y, t.state, a, p, px);
      box = box ? rectUnion(box, r) : r;
    }
    return box;
  }

  private drawCursor(ctx: Ctx2D, x: number, y: number, s: PeerState, alpha: number, p: CanvasPalette, px: number): Rect {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = s.color;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 3 * px, y + 16 * px);
    ctx.lineTo(x + 7 * px, y + 12 * px);
    ctx.lineTo(x + 13 * px, y + 12 * px);
    ctx.closePath();
    ctx.fill();
    const size = 11 * px;
    ctx.font = `${11 * px}px ${p.fontFamily}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const w = ctx.measureText(s.name).width + 10 * px;
    const h = 16 * px;
    ctx.fillStyle = s.color;
    ctx.beginPath();
    ctx.rect(x + 12 * px, y + 14 * px, w, h);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillText(s.name, x + 17 * px, y + 14 * px + h / 2, Math.max(size, w));
    ctx.globalAlpha = 1;
    return { x, y, w: Math.max(13 * px, 12 * px + w), h: 30 * px };
  }
}

const sameCursor = (a: Point | null | undefined, b: Point | null | undefined): boolean =>
  (!a && !b) || (!!a && !!b && a.x === b.x && a.y === b.y);

const sameSel = (a: readonly string[] | undefined, b: readonly string[] | undefined): boolean => {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

import { rotatePoint, rectCenter, type Point, type Rect } from '../../../lib/canvas/geometry';
import { STICKY_RADIUS, traceRounded, traceShape } from '../../../lib/canvas/shapes';
import type { VoteBadge } from '../../../lib/canvas/votes';
import type { BoxRec } from '../../../lib/canvas/types';
import type { Ctx2D, DrawEnv } from './draw';

/** Vote badge on a sticky or shape (ADR-0115): a pill in the top right corner, the same size on screen at any zoom. */
const MIN_SIDE_PX = 28;
const INSET_PX = 5;
/** The extra the badge can reach beyond the object's own bounds (repaint margin, screen px). */
export const BADGE_MARGIN_PX = 12;

export interface BadgeBox {
  /** In the object's own frame (before its rotation). */
  rect: Rect;
  fontPx: number;
}

/** Where the badge for `n` votes sits on `o` at `scale`, or null when the object is too small on screen to carry one. */
export function badgeBox(o: Rect, n: number, scale: number): BadgeBox | null {
  const side = Math.min(o.w, o.h) * scale;
  if (side < MIN_SIDE_PX) return null;
  const hPx = Math.min(22, Math.max(14, side * 0.3));
  const wPx = Math.max(hPx, hPx * 0.8 + String(n).length * hPx * 0.42);
  if (wPx + 2 * INSET_PX > o.w * scale) return null;
  const h = hPx / scale;
  const w = wPx / scale;
  const inset = INSET_PX / scale;
  return { rect: { x: o.x + o.w - inset - w, y: o.y + inset, w, h }, fontPx: hPx * 0.62 };
}

/** Whether a world point lies on the badge of `o` (the pointer is turned back by the object's rotation). */
export function hitBadge(o: BoxRec, n: number, scale: number, p: Point): boolean {
  const b = badgeBox(o, n, scale);
  if (!b) return false;
  const q = o.rot ? rotatePoint(p, rectCenter(o), -o.rot) : p;
  const r = b.rect;
  return q.x >= r.x && q.x <= r.x + r.w && q.y >= r.y && q.y <= r.y + r.h;
}

/**
 * Paints the vote mark of one object, in the object's own frame (the caller has turned the context for a rotated
 * one): the winners of a finished vote get an outline along their shape, every counted object a badge.
 */
export function drawVoteMark(ctx: Ctx2D, o: BoxRec, badge: VoteBadge, env: DrawEnv): void {
  const p = env.palette;
  const s = env.scale;
  if (badge.leader) {
    ctx.beginPath();
    if (o.kind === 'shape') traceShape(ctx, o.shape, o);
    else traceRounded(ctx, o, STICKY_RADIUS);
    ctx.strokeStyle = p.accent;
    ctx.lineWidth = 3 / s;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }
  const b = badgeBox(o, badge.n, s);
  if (!b) return;
  const r = b.rect;
  ctx.beginPath();
  traceRounded(ctx, r, r.h / 2);
  ctx.fillStyle = badge.leader ? p.accent : p.handleFill;
  ctx.fill();
  if (!badge.leader) {
    ctx.strokeStyle = p.accent;
    ctx.lineWidth = 1.5 / s;
    ctx.stroke();
  }
  ctx.fillStyle = badge.leader ? '#ffffff' : p.ink;
  ctx.font = `600 ${b.fontPx / s}px ${p.fontFamily}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(badge.n), r.x + r.w / 2, r.y + r.h / 2 + (0.5 / s));
}

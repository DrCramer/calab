import { DEG, HANDLE_IDS, handlePoint, rectCenter, type Point, type Rect } from '../../../lib/canvas/geometry';
import type { Guide } from '../../../lib/canvas/snap';
import { traceRounded } from '../../../lib/canvas/shapes';
import type { ConnectorRec } from '../../../lib/canvas/types';
import type { Ctx2D } from './draw';
import type { CanvasPalette } from './palette';

export const HANDLE_PX = 8;
/** The phone's handles: drawn a little larger, hit from a 44 px zone (radius `TOUCH_HIT_PX`), the rotation handle hung further out. */
export const TOUCH_HANDLE_PX = 14;
export const TOUCH_ROTATE_OFFSET_PX = 40;
export const TOUCH_HIT_PX = 22;
/** The rotation handle hangs this many screen px above the top side of the frame. */
export const ROTATE_OFFSET_PX = 26;

/** An outline of a (possibly rotated) box: its unrotated frame and the angle. */
export interface Outline {
  rect: Rect;
  rot: number;
}

/**
 * The selection frame: the single box's own (rotated) frame, or the circumscribed rect of several. `resize` shows
 * the eight handles, `rotate` the rotation handle; both off (locked objects, a group's resize) leaves just the frame.
 */
export interface SelFrame {
  rect: Rect;
  rot: number;
  resize: boolean;
  rotate: boolean;
  /** A lone text sizes by width only: no top / bottom handles. */
  widthOnly?: boolean;
}

/** Transient, per-gesture decoration drawn over the content layer (never part of the document). */
export interface OverlayState {
  /** Outlines of selected boxes. */
  outlines: readonly Outline[];
  /** Selected connectors: highlighted path + end handles. */
  connectors: readonly ConnectorRec[];
  /** Selection frame with its handles; null when no box is selected. */
  group: SelFrame | null;
  marquee: Rect | null;
  guides: readonly Guide[];
  /** Angle badge hung by the cursor while turning: world point + whole degrees (one box: its angle, several: the turn). */
  angle: { at: Point; deg: number } | null;
  /** Rubber band while placing a new object. */
  ghost: Rect | null;
  /** Connector being drawn / retargeted: polyline in world units. */
  wire: readonly number[] | null;
  /** Glue target under the cursor while wiring: rect + its four anchors. */
  /** Touch editing: larger handles. */
  touch?: boolean;
  glue: { rect: Rect; /** Rotation of the glue target. */ rot?: number; anchors: readonly Point[]; active: Point | null } | null;
}

export const emptyOverlay = (): OverlayState => ({ outlines: [], connectors: [], group: null, marquee: null, guides: [], angle: null, ghost: null, wire: null, glue: null });

export const overlayIsEmpty = (o: OverlayState): boolean =>
  o.outlines.length === 0 && o.connectors.length === 0 && !o.group && !o.marquee && o.guides.length === 0 && !o.angle && !o.ghost && !o.wire && !o.glue;

/** Paints the overlay. The context carries the camera transform (world units); `scale` is the camera scale. */
export function drawOverlay(ctx: Ctx2D, o: OverlayState, p: CanvasPalette, scale: number): void {
  const px = 1 / scale;
  const hp = o.touch ? TOUCH_HANDLE_PX : HANDLE_PX;
  ctx.lineJoin = 'miter';
  ctx.lineWidth = px * 1.5;
  ctx.strokeStyle = p.accent;
  for (const r of o.outlines) strokeTurned(ctx, r.rect, r.rot);

  for (const c of o.connectors) {
    const pts = c.points;
    if (pts.length < 4) continue;
    ctx.lineWidth = Math.max(c.strokeWidth, 1) * px + 3 * px;
    ctx.strokeStyle = p.accentFill;
    ctx.beginPath();
    ctx.moveTo(pts[0] ?? 0, pts[1] ?? 0);
    for (let i = 2; i + 1 < pts.length; i += 2) ctx.lineTo(pts[i] ?? 0, pts[i + 1] ?? 0);
    ctx.stroke();
    drawHandle(ctx, { x: pts[0] ?? 0, y: pts[1] ?? 0 }, p, px, true, hp);
    drawHandle(ctx, { x: pts[pts.length - 2] ?? 0, y: pts[pts.length - 1] ?? 0 }, p, px, true, hp);
  }

  if (o.group) {
    const g = o.group;
    const c = rectCenter(g.rect);
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(g.rot * DEG);
    ctx.translate(-c.x, -c.y);
    ctx.lineWidth = px * 1.5;
    ctx.strokeStyle = p.accent;
    ctx.strokeRect(g.rect.x, g.rect.y, g.rect.w, g.rect.h);
    if (g.rotate) {
      const top = { x: g.rect.x + g.rect.w / 2, y: g.rect.y };
      const knob = { x: top.x, y: top.y - (o.touch ? TOUCH_ROTATE_OFFSET_PX : ROTATE_OFFSET_PX) * px };
      ctx.beginPath();
      ctx.moveTo(top.x, top.y);
      ctx.lineTo(knob.x, knob.y + (hp / 2 + 1) * px);
      ctx.stroke();
      drawHandle(ctx, knob, p, px, true, hp);
    }
    if (g.resize) for (const h of HANDLE_IDS) if (!(g.widthOnly && (h === 'n' || h === 's'))) drawHandle(ctx, handlePoint(g.rect, h), p, px, false, hp);
    ctx.restore();
  }

  if (o.marquee) {
    ctx.fillStyle = p.accentFill;
    ctx.fillRect(o.marquee.x, o.marquee.y, o.marquee.w, o.marquee.h);
    ctx.lineWidth = px;
    ctx.strokeStyle = p.accent;
    ctx.strokeRect(o.marquee.x, o.marquee.y, o.marquee.w, o.marquee.h);
  }

  if (o.ghost) {
    ctx.lineWidth = px * 1.5;
    ctx.strokeStyle = p.accent;
    ctx.setLineDash([6 * px, 4 * px]);
    ctx.strokeRect(o.ghost.x, o.ghost.y, o.ghost.w, o.ghost.h);
    ctx.setLineDash([]);
  }

  if (o.glue) {
    ctx.lineWidth = px * 2;
    ctx.strokeStyle = p.accent;
    strokeTurned(ctx, o.glue.rect, o.glue.rot ?? 0);
    for (const a of o.glue.anchors) {
      const active = o.glue.active !== null && a.x === o.glue.active.x && a.y === o.glue.active.y;
      ctx.beginPath();
      ctx.arc(a.x, a.y, (active ? 5 : 3.5) * px, 0, Math.PI * 2);
      ctx.fillStyle = active ? p.accent : p.handleFill;
      ctx.fill();
      ctx.stroke();
    }
  }

  if (o.wire && o.wire.length >= 4) {
    ctx.lineWidth = px * 2;
    ctx.strokeStyle = p.accent;
    ctx.setLineDash([6 * px, 4 * px]);
    ctx.beginPath();
    ctx.moveTo(o.wire[0] ?? 0, o.wire[1] ?? 0);
    for (let i = 2; i + 1 < o.wire.length; i += 2) ctx.lineTo(o.wire[i] ?? 0, o.wire[i + 1] ?? 0);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (o.guides.length > 0) {
    ctx.lineWidth = px;
    ctx.strokeStyle = p.guide;
    ctx.beginPath();
    for (const g of o.guides) {
      if (g.axis === 'x') {
        ctx.moveTo(g.at, g.from);
        ctx.lineTo(g.at, g.to);
      } else {
        ctx.moveTo(g.from, g.at);
        ctx.lineTo(g.to, g.at);
      }
    }
    ctx.stroke();
  }

  if (o.angle) drawAngle(ctx, o.angle, p, px);
}

/** The «45°» pill: screen-sized, hung down-right of the cursor so the pointer and the handle stay visible. */
function drawAngle(ctx: Ctx2D, a: { at: Point; deg: number }, p: CanvasPalette, px: number): void {
  const text = `${a.deg}°`;
  ctx.save();
  ctx.font = `600 ${12 * px}px ${p.fontFamily}`;
  const w = ctx.measureText(text).width + 14 * px;
  const h = 20 * px;
  ctx.beginPath();
  traceRounded(ctx, { x: a.at.x + 14 * px, y: a.at.y + 14 * px, w, h }, h / 2);
  ctx.fillStyle = p.accent;
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, a.at.x + 14 * px + w / 2, a.at.y + 14 * px + h / 2 + 0.5 * px);
  ctx.restore();
}

function strokeTurned(ctx: Ctx2D, r: Rect, rot: number): void {
  if (!rot) {
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    return;
  }
  const c = rectCenter(r);
  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.rotate(rot * DEG);
  ctx.strokeRect(-r.w / 2, -r.h / 2, r.w, r.h);
  ctx.restore();
}

function drawHandle(ctx: Ctx2D, at: Point, p: CanvasPalette, px: number, round: boolean, size = HANDLE_PX): void {
  const s = size * px;
  ctx.fillStyle = p.handleFill;
  ctx.strokeStyle = p.accent;
  ctx.lineWidth = px * 1.5;
  ctx.beginPath();
  if (round) ctx.arc(at.x, at.y, s / 2 + px, 0, Math.PI * 2);
  else ctx.rect(at.x - s / 2, at.y - s / 2, s, s);
  ctx.fill();
  ctx.stroke();
}

import { HANDLE_IDS, handlePoint, type Point, type Rect } from '../../../lib/canvas/geometry';
import type { Guide } from '../../../lib/canvas/snap';
import type { ConnectorRec } from '../../../lib/canvas/types';
import type { Ctx2D } from './draw';
import type { CanvasPalette } from './palette';

export const HANDLE_PX = 8;

/** Transient, per-gesture decoration drawn over the content layer (never part of the document). */
export interface OverlayState {
  /** Outlines of selected boxes. */
  outlines: readonly Rect[];
  /** Selected connectors: highlighted path + end handles. */
  connectors: readonly ConnectorRec[];
  /** Box with the 8 resize handles (selection bounds); null when nothing resizable is selected. */
  group: Rect | null;
  marquee: Rect | null;
  guides: readonly Guide[];
  /** Rubber band while placing a new object. */
  ghost: Rect | null;
  /** Connector being drawn / retargeted: polyline in world units. */
  wire: readonly number[] | null;
  /** Glue target under the cursor while wiring: rect + its four anchors. */
  glue: { rect: Rect; anchors: readonly Point[]; active: Point | null } | null;
}

export const emptyOverlay = (): OverlayState => ({ outlines: [], connectors: [], group: null, marquee: null, guides: [], ghost: null, wire: null, glue: null });

export const overlayIsEmpty = (o: OverlayState): boolean =>
  o.outlines.length === 0 && o.connectors.length === 0 && !o.group && !o.marquee && o.guides.length === 0 && !o.ghost && !o.wire && !o.glue;

/** Paints the overlay. The context carries the camera transform (world units); `scale` is the camera scale. */
export function drawOverlay(ctx: Ctx2D, o: OverlayState, p: CanvasPalette, scale: number): void {
  const px = 1 / scale;
  ctx.lineJoin = 'miter';
  ctx.lineWidth = px * 1.5;
  ctx.strokeStyle = p.accent;
  for (const r of o.outlines) ctx.strokeRect(r.x, r.y, r.w, r.h);

  for (const c of o.connectors) {
    const pts = c.points;
    if (pts.length < 4) continue;
    ctx.lineWidth = Math.max(c.strokeWidth, 1) * px + 3 * px;
    ctx.strokeStyle = p.accentFill;
    ctx.beginPath();
    ctx.moveTo(pts[0] ?? 0, pts[1] ?? 0);
    for (let i = 2; i + 1 < pts.length; i += 2) ctx.lineTo(pts[i] ?? 0, pts[i + 1] ?? 0);
    ctx.stroke();
    drawHandle(ctx, { x: pts[0] ?? 0, y: pts[1] ?? 0 }, p, px, true);
    drawHandle(ctx, { x: pts[pts.length - 2] ?? 0, y: pts[pts.length - 1] ?? 0 }, p, px, true);
  }

  if (o.group) {
    ctx.lineWidth = px * 1.5;
    ctx.strokeStyle = p.accent;
    ctx.strokeRect(o.group.x, o.group.y, o.group.w, o.group.h);
    for (const h of HANDLE_IDS) drawHandle(ctx, handlePoint(o.group, h), p, px, false);
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
    ctx.strokeRect(o.glue.rect.x, o.glue.rect.y, o.glue.rect.w, o.glue.rect.h);
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
}

function drawHandle(ctx: Ctx2D, at: Point, p: CanvasPalette, px: number, round: boolean): void {
  const s = HANDLE_PX * px;
  ctx.fillStyle = p.handleFill;
  ctx.strokeStyle = p.accent;
  ctx.lineWidth = px * 1.5;
  ctx.beginPath();
  if (round) ctx.arc(at.x, at.y, s / 2 + px, 0, Math.PI * 2);
  else ctx.rect(at.x - s / 2, at.y - s / 2, s, s);
  ctx.fill();
  ctx.stroke();
}

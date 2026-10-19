import { polylineMidpoint, rectsIntersect, type Rect } from '../../../lib/canvas/geometry';
import { endDirection } from '../../../lib/canvas/route';
import { contentRect, STICKY_RADIUS, traceRounded, traceShape } from '../../../lib/canvas/shapes';
import { LABEL_SIZE, SHAPE_TEXT_SIZE, STICKY_TEXT_SIZE, type TextLayouter } from '../../../lib/canvas/textLayout';
import type { BoxRec, ConnectorRec, ObjectRec } from '../../../lib/canvas/types';
import { resolveColor, resolveSticky, type CanvasPalette } from './palette';

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Below this zoom, glyphs become plaques and strokes lose their details (ADR-0107 §4). */
export const TEXT_PLAQUE_SCALE = 0.25;

export interface DrawEnv {
  palette: CanvasPalette;
  layouter: TextLayouter;
  /** Camera scale (world → CSS px). */
  scale: number;
  /** Object whose text is being edited in the overlay textarea: its glyphs are not painted. */
  hiddenText: string | null;
}

const font = (env: DrawEnv, size: number): string => `${size}px ${env.palette.fontFamily}`;

/** Fills the region with the background and, when zoomed in enough, the dot grid. `r` is in world units. */
export function drawBackground(ctx: Ctx2D, p: CanvasPalette, r: Rect, scale: number): void {
  ctx.fillStyle = p.background;
  ctx.fillRect(r.x, r.y, r.w, r.h);
  if (scale < 0.3) return;
  const step = scale >= 0.8 ? 24 : 96;
  const dot = Math.max(1 / scale, 0.9 / scale) * 1.4;
  const x0 = Math.floor(r.x / step) * step;
  const y0 = Math.floor(r.y / step) * step;
  ctx.fillStyle = p.grid;
  ctx.beginPath();
  for (let x = x0; x <= r.x + r.w; x += step) for (let y = y0; y <= r.y + r.h; y += step) ctx.rect(x - dot / 2, y - dot / 2, dot, dot);
  ctx.fill();
}

export function drawObject(ctx: Ctx2D, o: ObjectRec, env: DrawEnv): void {
  // Sub-pixel objects are not worth a draw call.
  if (o.kind !== 'connector' && o.w * env.scale < 0.6 && o.h * env.scale < 0.6) return;
  switch (o.kind) {
    case 'sticky':
      drawSticky(ctx, o, env);
      break;
    case 'text':
      drawText(ctx, o, env);
      break;
    case 'shape':
      drawShape(ctx, o, env);
      break;
    case 'connector':
      drawConnector(ctx, o, env);
      break;
  }
}

/** Paints glyphs, or plaques when the zoom is too small to read them. */
function drawLines(ctx: Ctx2D, env: DrawEnv, text: string, size: number, box: Rect, fg: string, align: 'left' | 'center', vcenter: boolean): void {
  if (text === '' || box.w <= 0) return;
  const lay = env.layouter.layout(text, size, box.w);
  const top = vcenter ? box.y + Math.max(0, (box.h - lay.height) / 2) : box.y;
  const bottom = box.y + box.h + lay.lineHeight * 0.5;
  if (env.scale < TEXT_PLAQUE_SCALE || size * env.scale < 4) {
    ctx.fillStyle = env.palette.plaque;
    const bar = lay.lineHeight * 0.45;
    for (let i = 0; i < lay.lines.length; i++) {
      const y = top + i * lay.lineHeight + (lay.lineHeight - bar) / 2;
      if (y > bottom) break;
      const w = lay.widths[i] ?? 0;
      if (w <= 0) continue;
      ctx.fillRect(align === 'center' ? box.x + (box.w - w) / 2 : box.x, y, w, bar);
    }
    return;
  }
  ctx.font = font(env, size);
  ctx.fillStyle = fg;
  ctx.textBaseline = 'top';
  ctx.textAlign = align;
  const x = align === 'center' ? box.x + box.w / 2 : box.x;
  for (let i = 0; i < lay.lines.length; i++) {
    const y = top + i * lay.lineHeight;
    if (y + lay.lineHeight > bottom) break;
    const line = lay.lines[i];
    if (line) ctx.fillText(line, x, y + (lay.lineHeight - size) / 2);
  }
}

function drawSticky(ctx: Ctx2D, o: BoxRec & { kind: 'sticky' }, env: DrawEnv): void {
  const c = resolveSticky(env.palette, o.color);
  ctx.fillStyle = c.bg;
  ctx.beginPath();
  traceRounded(ctx, o, STICKY_RADIUS);
  ctx.fill();
  if (env.hiddenText !== o.id) drawLines(ctx, env, o.text, STICKY_TEXT_SIZE, contentRect(o), c.fg, 'left', false);
}

function drawText(ctx: Ctx2D, o: BoxRec & { kind: 'text' }, env: DrawEnv): void {
  if (env.hiddenText === o.id) return;
  drawLines(ctx, env, o.text, o.size, contentRect(o), resolveColor(env.palette, o.color) ?? env.palette.ink, 'left', false);
}

function drawShape(ctx: Ctx2D, o: BoxRec & { kind: 'shape' }, env: DrawEnv): void {
  const fill = resolveColor(env.palette, o.fill);
  const stroke = resolveColor(env.palette, o.stroke);
  ctx.beginPath();
  traceShape(ctx, o.shape, o);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke && o.strokeWidth > 0) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = Math.max(o.strokeWidth, 1 / env.scale);
    ctx.lineJoin = 'round';
    ctx.stroke();
  }
  if (env.hiddenText !== o.id) drawLines(ctx, env, o.text, SHAPE_TEXT_SIZE, contentRect(o), resolveColor(env.palette, 'text') ?? env.palette.ink, 'center', true);
}

function drawConnector(ctx: Ctx2D, o: ConnectorRec, env: DrawEnv): void {
  const pts = o.points;
  if (pts.length < 4) return;
  const stroke = resolveColor(env.palette, o.stroke) ?? env.palette.ink;
  const lw = Math.max(o.strokeWidth, 1 / env.scale);
  const detail = env.scale >= TEXT_PLAQUE_SCALE;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = lw;
  ctx.lineJoin = detail ? 'round' : 'miter';
  ctx.lineCap = 'butt';
  ctx.beginPath();
  ctx.moveTo(pts[0] ?? 0, pts[1] ?? 0);
  for (let i = 2; i + 1 < pts.length; i += 2) ctx.lineTo(pts[i] ?? 0, pts[i + 1] ?? 0);
  ctx.stroke();
  if (!detail) return;
  const head = 8 + o.strokeWidth * 2;
  if (o.arrow !== 'none') drawArrowHead(ctx, pts[pts.length - 2] ?? 0, pts[pts.length - 1] ?? 0, endDirection(pts, true), head, stroke);
  if (o.arrow === 'both') drawArrowHead(ctx, pts[0] ?? 0, pts[1] ?? 0, endDirection(pts, false), head, stroke);
  if (o.label) {
    const m = polylineMidpoint(pts);
    const lay = env.layouter.layout(o.label, LABEL_SIZE, 160);
    const w = Math.max(...lay.widths, 0) + 12;
    const h = lay.height + 6;
    ctx.fillStyle = env.palette.labelBg;
    ctx.beginPath();
    traceRounded(ctx, { x: m.x - w / 2, y: m.y - h / 2, w, h }, 6);
    ctx.fill();
    drawLines(ctx, env, o.label, LABEL_SIZE, { x: m.x - w / 2 + 6, y: m.y - h / 2 + 3, w: w - 12, h: h - 6 }, env.palette.ink, 'center', false);
  }
}

function drawArrowHead(ctx: Ctx2D, x: number, y: number, d: { x: number; y: number }, size: number, color: string): void {
  const nx = -d.y;
  const ny = d.x;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - d.x * size + nx * size * 0.45, y - d.y * size + ny * size * 0.45);
  ctx.lineTo(x - d.x * size - nx * size * 0.45, y - d.y * size - ny * size * 0.45);
  ctx.closePath();
  ctx.fill();
}

/** Draws `objects` (already z-sorted) that touch `region`. */
export function drawObjects(ctx: Ctx2D, objects: readonly ObjectRec[], region: Rect, env: DrawEnv): void {
  for (const o of objects) if (rectsIntersect(o, region) || o.kind === 'connector') drawObject(ctx, o, env);
}

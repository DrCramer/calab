import { polylineMidpoint, rectCenter, rectsIntersect, DEG, type Rect } from '../../../lib/canvas/geometry';
import { endDirection } from '../../../lib/canvas/route';
import { contentRect, STICKY_RADIUS, traceRounded, traceShape } from '../../../lib/canvas/shapes';
import { F_STRIKE, type Fmt } from '../../../lib/canvas/richText';
import { LABEL_SIZE, boxFontSize, fontOf, type TextLayout, type TextLayouter } from '../../../lib/canvas/textLayout';
import { aabb, type BoxRec, type ConnectorRec, type ObjectRec } from '../../../lib/canvas/types';
import { readableInk, resolveColor, resolveSticky, type CanvasPalette } from './palette';
import type { VoteBadge } from '../../../lib/canvas/votes';
import { drawVoteMark } from './voteDraw';

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Below this zoom, glyphs become plaques and strokes lose their details (ADR-0113 §4). */
export const TEXT_PLAQUE_SCALE = 0.25;
/** Glyphs smaller than this on screen (CSS px) become plaques; plain text keeps them down to 25 % anyway. */
const MIN_GLYPH_PX = 4;
/**
 * The same for a rotated box (ADR-0114). Every distinct angle × zoom rasterizes its own glyphs (no shared glyph
 * cache), so a zoom over hundreds of turned notes repainted them at 4–8 px — barely legible — for a 3–4× costlier
 * frame (docs/14-energy.md «Холст, вторая итерация»).
 */
const MIN_ROTATED_GLYPH_PX = 8;

export interface DrawEnv {
  palette: CanvasPalette;
  layouter: TextLayouter;
  /** Camera scale (world → CSS px). */
  scale: number;
  /** Object whose text is being edited in the overlay textarea: its glyphs are not painted. */
  hiddenText: string | null;
  /** Vote badges of the open or finished vote (ADR-0114); absent while there is no vote, so a plain canvas pays nothing. */
  votes?: { badge(id: string): VoteBadge | null } | undefined;
}

const font = (env: DrawEnv, size: number): string => `${size}px ${env.palette.fontFamily}`;

interface DotTile {
  key: string;
  pattern: CanvasPattern | null;
}
let dotTile: DotTile | null = null;

function makeTileCanvas(px: number): (HTMLCanvasElement | OffscreenCanvas) | null {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(px, px);
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = px;
    c.height = px;
    return c;
  }
  return null;
}

/**
 * The dot grid as a repeating pattern: a handful of dots in a tiny tile, filled with one fillRect. Thousands of
 * per-dot rects cost two orders of magnitude more on a software rasterizer.
 */
function dotPattern(ctx: Ctx2D, color: string, step: number, scale: number, dpr: number): CanvasPattern | null {
  const tile = Math.max(2, Math.round(step * scale * dpr));
  const key = `${color}|${step}|${tile}`;
  if (dotTile?.key === key) return dotTile.pattern;
  let pattern: CanvasPattern | null = null;
  const c = makeTileCanvas(tile);
  const g = c?.getContext('2d');
  if (c && g) {
    g.fillStyle = color;
    const d = Math.max(1, Math.round(1.4 * dpr));
    g.fillRect(0, 0, d, d);
    pattern = ctx.createPattern(c, 'repeat');
    // One tile spans exactly `step` world units, whatever the rounding of its pixel size.
    pattern?.setTransform(new DOMMatrix().scale(step / tile));
  }
  dotTile = { key, pattern };
  return pattern;
}

/** Fills the region with the background and, when zoomed in enough, the dot grid. `r` is in world units. */
export function drawBackground(ctx: Ctx2D, p: CanvasPalette, r: Rect, scale: number, dpr = 1): void {
  ctx.fillStyle = p.background;
  ctx.fillRect(r.x, r.y, r.w, r.h);
  if (scale < 0.3) return;
  const pattern = dotPattern(ctx, p.grid, scale >= 0.8 ? 24 : 96, scale, dpr);
  if (!pattern) return;
  ctx.fillStyle = pattern;
  ctx.fillRect(r.x, r.y, r.w, r.h);
}

export function drawObject(ctx: Ctx2D, o: ObjectRec, env: DrawEnv): void {
  // Sub-pixel objects are not worth a draw call.
  if (o.kind !== 'connector' && o.w * env.scale < 0.6 && o.h * env.scale < 0.6) return;
  if (o.kind !== 'connector' && o.rot) {
    // A rotated box is drawn in its own frame: the context turns about the center, nothing else knows.
    const c = rectCenter(o);
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(o.rot * DEG);
    ctx.translate(-c.x, -c.y);
    drawBody(ctx, o, env);
    ctx.restore();
    return;
  }
  drawBody(ctx, o, env);
}

function drawBody(ctx: Ctx2D, o: ObjectRec, env: DrawEnv): void {
  switch (o.kind) {
    case 'sticky':
      drawSticky(ctx, o, env);
      if (env.votes) markVotes(ctx, o, env);
      break;
    case 'text':
      drawText(ctx, o, env);
      break;
    case 'shape':
      drawShape(ctx, o, env);
      if (env.votes) markVotes(ctx, o, env);
      break;
    case 'connector':
      drawConnector(ctx, o, env);
      break;
  }
}

function markVotes(ctx: Ctx2D, o: BoxRec, env: DrawEnv): void {
  const b = env.votes?.badge(o.id);
  if (b) drawVoteMark(ctx, o, b, env);
}

interface Laid {
  text: string;
  fmt: Fmt | undefined;
  size: number;
  w: number;
  lay: TextLayout;
}
/** Layout per record: records are immutable, so a repaint of unchanged text skips even the cache's key building. */
const laidOut = new WeakMap<object, Laid>();

function layoutFor(owner: object, env: DrawEnv, text: string, fmt: Fmt | undefined, size: number, w: number): TextLayout {
  const hit = laidOut.get(owner);
  if (hit && hit.text === text && hit.fmt === fmt && hit.size === size && hit.w === w) return hit.lay;
  const lay = fmt ? env.layouter.layoutRich(text, fmt, size, w) : env.layouter.layout(text, size, w);
  laidOut.set(owner, { text, fmt, size, w, lay });
  return lay;
}

/** Paints glyphs, or plaques when the zoom is too small to read them. */
function drawLines(ctx: Ctx2D, env: DrawEnv, owner: object, text: string, fmt: Fmt | undefined, size: number, box: Rect, fg: string, align: 'left' | 'center', vcenter: boolean): void {
  if (text === '' || box.w <= 0) return;
  const lay = layoutFor(owner, env, text, fmt, size, box.w);
  const top = vcenter ? box.y + Math.max(0, (box.h - lay.height) / 2) : box.y;
  const bottom = box.y + box.h + lay.lineHeight * 0.5;
  const minPx = (owner as { rot?: number }).rot ? MIN_ROTATED_GLYPH_PX : MIN_GLYPH_PX;
  if (env.scale < TEXT_PLAQUE_SCALE || size * env.scale < minPx) {
    ctx.fillStyle = env.palette.plaque;
    if (env.scale < 0.15) {
      // Lines are ~2 px tall here: one block per text.
      const w = Math.max(...lay.widths);
      if (w > 0) ctx.fillRect(align === 'center' ? box.x + (box.w - w) / 2 : box.x, top, w, Math.min(lay.height, box.h) * 0.6);
      return;
    }
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
  if (lay.segs) {
    drawRich(ctx, env, lay, size, box, align, top, bottom);
    return;
  }
  ctx.textAlign = align;
  const x = align === 'center' ? box.x + box.w / 2 : box.x;
  for (let i = 0; i < lay.lines.length; i++) {
    const y = top + i * lay.lineHeight;
    if (y + lay.lineHeight > bottom) break;
    const line = lay.lines[i];
    if (line) ctx.fillText(line, x, y + (lay.lineHeight - size) / 2);
  }
}

/** Formatted lines: each piece in its own font, strike-through as a bar, list markers in the regular font. */
function drawRich(ctx: Ctx2D, env: DrawEnv, lay: TextLayout, size: number, box: Rect, align: 'left' | 'center', top: number, bottom: number): void {
  ctx.textAlign = 'left';
  let current = -1;
  const setFont = (f: number): void => {
    if (f === current) return;
    current = f;
    ctx.font = fontOf(size, env.palette.fontFamily, f);
  };
  const bar = Math.max(size / 16, 1 / env.scale);
  for (let i = 0; i < lay.lines.length; i++) {
    const y = top + i * lay.lineHeight;
    if (y + lay.lineHeight > bottom) break;
    const ty = y + (lay.lineHeight - size) / 2;
    const left = align === 'center' ? box.x + Math.max(0, (box.w - (lay.widths[i] ?? 0)) / 2) : box.x;
    const mark = lay.marks?.[i];
    if (mark) {
      setFont(0);
      ctx.fillText(mark, left, ty);
    }
    for (const seg of lay.segs?.[i] ?? []) {
      setFont(seg.f);
      ctx.fillText(seg.text, left + seg.x, ty);
      if (seg.f & F_STRIKE) ctx.fillRect(left + seg.x, ty + size * 0.56, seg.w, bar);
    }
  }
}

function drawSticky(ctx: Ctx2D, o: BoxRec & { kind: 'sticky' }, env: DrawEnv): void {
  const c = resolveSticky(env.palette, o.color);
  ctx.fillStyle = c.bg;
  if (env.scale < TEXT_PLAQUE_SCALE) {
    ctx.fillRect(o.x, o.y, o.w, o.h);
  } else {
    ctx.beginPath();
    traceRounded(ctx, o, STICKY_RADIUS);
    ctx.fill();
  }
  if (env.hiddenText !== o.id) drawLines(ctx, env, o, o.text, o.fmt, boxFontSize(o), contentRect(o), c.fg, 'left', false);
}

function drawText(ctx: Ctx2D, o: BoxRec & { kind: 'text' }, env: DrawEnv): void {
  if (env.hiddenText === o.id) return;
  drawLines(ctx, env, o, o.text, o.fmt, o.size, contentRect(o), resolveColor(env.palette, o.color) ?? env.palette.ink, 'left', false);
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
  if (env.hiddenText !== o.id) {
    const ink = resolveColor(env.palette, 'text') ?? env.palette.ink;
    drawLines(ctx, env, o, o.text, o.fmt, boxFontSize(o), contentRect(o), fill && o.text ? readableInk(fill, ink) : ink, 'center', true);
  }
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
    drawLines(ctx, env, o, o.label, undefined, LABEL_SIZE, { x: m.x - w / 2 + 6, y: m.y - h / 2 + 3, w: w - 12, h: h - 6 }, env.palette.ink, 'center', false);
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
  for (const o of objects) if (o.kind === 'connector' || rectsIntersect(aabb(o), region)) drawObject(ctx, o, env);
}

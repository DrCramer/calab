import type { Rect } from './geometry';
import { SHAPE_PAD, STICKY_PAD, TEXT_PAD } from './textLayout';
import type { BoxRec, ShapeKind } from './types';

/** The subset of path methods shared by CanvasRenderingContext2D, OffscreenCanvasRenderingContext2D and Path2D. */
export interface PathTarget {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arcTo(x1: number, y1: number, x2: number, y2: number, r: number): void;
  closePath(): void;
  ellipse(x: number, y: number, rx: number, ry: number, rot: number, a0: number, a1: number): void;
}

export const STICKY_RADIUS = 6;

/** Adds the outline of a shape to the current path (caller does beginPath/fill/stroke). */
export function traceShape(p: PathTarget, kind: ShapeKind, r: Rect): void {
  const { x, y, w, h } = r;
  switch (kind) {
    case 'rect':
      p.moveTo(x, y);
      p.lineTo(x + w, y);
      p.lineTo(x + w, y + h);
      p.lineTo(x, y + h);
      p.closePath();
      break;
    case 'rounded':
      traceRounded(p, r, Math.min(16, w / 4, h / 4));
      break;
    case 'ellipse':
      p.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      break;
    case 'diamond':
      p.moveTo(x + w / 2, y);
      p.lineTo(x + w, y + h / 2);
      p.lineTo(x + w / 2, y + h);
      p.lineTo(x, y + h / 2);
      p.closePath();
      break;
    case 'triangle':
      p.moveTo(x + w / 2, y);
      p.lineTo(x + w, y + h);
      p.lineTo(x, y + h);
      p.closePath();
      break;
  }
}

export function traceRounded(p: PathTarget, r: Rect, radius: number): void {
  const { x, y, w, h } = r;
  const k = Math.max(0, Math.min(radius, w / 2, h / 2));
  p.moveTo(x + k, y);
  p.arcTo(x + w, y, x + w, y + h, k);
  p.arcTo(x + w, y + h, x, y + h, k);
  p.arcTo(x, y + h, x, y, k);
  p.arcTo(x, y, x + w, y, k);
  p.closePath();
}

/** Where an object's text lives (inside the outline, clear of the corners that the shape cuts away). */
export function contentRect(o: BoxRec): Rect {
  const inset = (r: Rect, d: number): Rect => ({ x: r.x + d, y: r.y + d, w: Math.max(1, r.w - 2 * d), h: Math.max(1, r.h - 2 * d) });
  if (o.kind === 'sticky') return inset(o, STICKY_PAD);
  if (o.kind === 'text') return inset(o, TEXT_PAD);
  switch (o.shape) {
    case 'ellipse': {
      const dx = o.w * 0.146;
      const dy = o.h * 0.146;
      return inset({ x: o.x + dx, y: o.y + dy, w: o.w - 2 * dx, h: o.h - 2 * dy }, SHAPE_PAD / 2);
    }
    case 'diamond':
      return inset({ x: o.x + o.w * 0.25, y: o.y + o.h * 0.25, w: o.w * 0.5, h: o.h * 0.5 }, SHAPE_PAD / 2);
    case 'triangle':
      return inset({ x: o.x + o.w * 0.25, y: o.y + o.h * 0.45, w: o.w * 0.5, h: o.h * 0.5 }, SHAPE_PAD / 2);
    default:
      return inset(o, SHAPE_PAD);
  }
}

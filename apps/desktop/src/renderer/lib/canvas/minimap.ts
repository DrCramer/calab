import type { Camera, Viewport } from './camera';
import { rectUnion, type Point, type Rect } from './geometry';

/** The mini-map's box in CSS px and the margin kept around the drawing (ADR-0116). */
export const MAP_W = 180;
export const MAP_H = 120;
export const MAP_PAD = 8;

/** world → map: `x * scale + ox`, `y * scale + oy` (one scale for both axes, so the picture is not distorted). */
export interface MapFrame {
  readonly scale: number;
  readonly ox: number;
  readonly oy: number;
}

/**
 * The frame that shows the content and the visible area together, centered in the box. With no content it shows
 * the visible area alone. Pure: the caller keeps the frame it dragged in, so the map does not slide under the pointer.
 */
export function mapFrame(content: Rect | null, view: Rect, w = MAP_W, h = MAP_H, pad = MAP_PAD): MapFrame {
  const world = content ? rectUnion(content, view) : view;
  const ww = Math.max(world.w, 1);
  const wh = Math.max(world.h, 1);
  const scale = Math.max(1e-6, Math.min((w - 2 * pad) / ww, (h - 2 * pad) / wh));
  return { scale, ox: (w - ww * scale) / 2 - world.x * scale, oy: (h - wh * scale) / 2 - world.y * scale };
}

export const worldToMap = (f: MapFrame, p: Point): Point => ({ x: p.x * f.scale + f.ox, y: p.y * f.scale + f.oy });
export const mapToWorld = (f: MapFrame, q: Point): Point => ({ x: (q.x - f.ox) / f.scale, y: (q.y - f.oy) / f.scale });

export const rectToMap = (f: MapFrame, r: Rect): Rect => ({ x: r.x * f.scale + f.ox, y: r.y * f.scale + f.oy, w: r.w * f.scale, h: r.h * f.scale });

/** The camera (same zoom) that has the world point `p` in the middle of the screen. */
export function cameraCenteredOn(cam: Camera, v: Viewport, p: Point): Camera {
  return { scale: cam.scale, tx: v.w / 2 - p.x * cam.scale, ty: v.h / 2 - p.y * cam.scale };
}

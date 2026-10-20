import { clamp, type Point, type Rect } from './geometry';

/** screen = world * scale + (tx, ty), in CSS pixels. Zoom range 10–400 % (ADR-0114 §4). */
export interface Camera {
  tx: number;
  ty: number;
  scale: number;
}

export interface Viewport {
  w: number;
  h: number;
}

export const MIN_SCALE = 0.1;
export const MAX_SCALE = 4;
export const DEFAULT_CAMERA: Camera = { tx: 0, ty: 0, scale: 1 };

export const clampScale = (s: number): number => clamp(Number.isFinite(s) ? s : 1, MIN_SCALE, MAX_SCALE);

export const worldToScreen = (c: Camera, p: Point): Point => ({ x: p.x * c.scale + c.tx, y: p.y * c.scale + c.ty });
export const screenToWorld = (c: Camera, p: Point): Point => ({ x: (p.x - c.tx) / c.scale, y: (p.y - c.ty) / c.scale });

export function visibleRect(c: Camera, v: Viewport): Rect {
  return { x: (0 - c.tx) / c.scale, y: (0 - c.ty) / c.scale, w: v.w / c.scale, h: v.h / c.scale };
}

export const panBy = (c: Camera, dx: number, dy: number): Camera => ({ tx: c.tx + dx, ty: c.ty + dy, scale: c.scale });

/** Zoom by `factor` keeping the world point under screen point `at` fixed. */
export function zoomAt(c: Camera, factor: number, at: Point): Camera {
  const scale = clampScale(c.scale * factor);
  const k = scale / c.scale;
  return { scale, tx: at.x - (at.x - c.tx) * k, ty: at.y - (at.y - c.ty) * k };
}

/**
 * One step of a two-finger gesture: the camera that keeps the world point that was under the previous
 * midpoint under the new one, scaled by the change of the finger distance. Incremental (from the previous
 * finger positions, not from the gesture start) so a scale held at a limit cannot "stick" — pinching back
 * responds at once — and re-pairing fingers only needs new previous positions.
 */
export function pinchStep(c: Camera, prevA: Point, prevB: Point, a: Point, b: Point): Camera {
  const d0 = Math.hypot(prevB.x - prevA.x, prevB.y - prevA.y);
  const d1 = Math.hypot(b.x - a.x, b.y - a.y);
  // Fingers closer than a few pixels give a meaningless ratio (and a jump): treat as a pure pan.
  const ratio = d0 < 8 || d1 < 8 ? 1 : d1 / d0;
  const m0 = { x: (prevA.x + prevB.x) / 2, y: (prevA.y + prevB.y) / 2 };
  const m1 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const z = zoomAt(c, ratio, m0);
  return { scale: z.scale, tx: z.tx + (m1.x - m0.x), ty: z.ty + (m1.y - m0.y) };
}

/** Set an absolute scale around a screen point. */
export const zoomTo = (c: Camera, scale: number, at: Point): Camera => zoomAt(c, clampScale(scale) / c.scale, at);

/**
 * Camera that shows `r` centered with `padding` px around it; never zooms past 100 % in when fitting
 * (a lone small object does not blow up to 400 %) unless `allowUpscale`.
 */
export function fitRect(r: Rect, v: Viewport, padding = 48, allowUpscale = false): Camera {
  const aw = Math.max(1, v.w - 2 * padding);
  const ah = Math.max(1, v.h - 2 * padding);
  let scale = Math.min(aw / Math.max(r.w, 1), ah / Math.max(r.h, 1));
  if (!allowUpscale) scale = Math.min(scale, 1);
  scale = clampScale(scale);
  return { scale, tx: v.w / 2 - (r.x + r.w / 2) * scale, ty: v.h / 2 - (r.y + r.h / 2) * scale };
}

/** Rounds the translation to device pixels so scrolled blits stay pixel-exact (renderer). */
export function snapCamera(c: Camera, dpr: number): Camera {
  return { scale: c.scale, tx: Math.round(c.tx * dpr) / dpr, ty: Math.round(c.ty * dpr) / dpr };
}

export const sameCamera = (a: Camera, b: Camera): boolean => a.tx === b.tx && a.ty === b.ty && a.scale === b.scale;

/** Zoom steps for +/− (percent). */
export const ZOOM_STEPS = [0.1, 0.15, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const;

export function nextZoomStep(scale: number, dir: 1 | -1): number {
  const eps = 1e-6;
  if (dir > 0) return ZOOM_STEPS.find((s) => s > scale + eps) ?? MAX_SCALE;
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) {
    const s = ZOOM_STEPS[i];
    if (s !== undefined && s < scale - eps) return s;
  }
  return MIN_SCALE;
}

/** Interpolation for animated camera moves (zoom in log space so it feels even). */
export function lerpCamera(a: Camera, b: Camera, t: number): Camera {
  const scale = Math.exp(Math.log(a.scale) + (Math.log(b.scale) - Math.log(a.scale)) * t);
  // Interpolate the world point at the viewport center is overkill; blending the translation keeps it simple and smooth.
  return { scale, tx: a.tx + (b.tx - a.tx) * t, ty: a.ty + (b.ty - a.ty) * t };
}

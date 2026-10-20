import { aabb, isConnector } from '../../../lib/canvas/types';
import { MAP_H, MAP_W, rectToMap, worldToMap, type MapFrame } from '../../../lib/canvas/minimap';
import type { Rect } from '../../../lib/canvas/geometry';
import type { Scene } from '../../../lib/canvas/scene';
import { resolveColor, resolveSticky, type CanvasPalette } from '../engine';
import type { Ctx2D } from '../engine/draw';

const KEY = 'calaba.canvas.minimap';

let memory = false;
const listeners = new Set<() => void>();

/**
 * Whether the mini-map is on: a per-person preference kept in `localStorage` (off by default). Storage may be
 * missing or throw (private window, blocked data): then it lives for the session in memory.
 */
export const minimapPref = {
  get: (): boolean => {
    try {
      return window.localStorage.getItem(KEY) === '1';
    } catch {
      return memory;
    }
  },
  set: (on: boolean): void => {
    memory = on;
    try {
      window.localStorage.setItem(KEY, on ? '1' : '0');
    } catch {
      // Not persisted: the session still follows the in-memory value.
    }
    for (const fn of [...listeners]) fn();
  },
  subscribe: (fn: () => void): (() => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

/**
 * Paints the whole scene as plain rectangles in the map's frame, and the visible area on top. Objects take a simple
 * color (a sticky its note, a shape its fill or outline, text a faint bar), connectors one thin line each. Cheap by
 * design: one fillRect per object, no text, no shadows.
 */
export function drawMinimap(ctx: Ctx2D, scene: Scene, palette: CanvasPalette, frame: MapFrame, view: Rect, dpr = 1): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, MAP_W, MAP_H);
  const px = (v: number): number => Math.max(v, 1.5);
  const lines: [number, number, number, number][] = [];
  for (const o of scene.all()) {
    if (isConnector(o)) {
      const p = o.points;
      if (p.length >= 4) {
        const a = worldToMap(frame, { x: p[0] ?? 0, y: p[1] ?? 0 });
        const b = worldToMap(frame, { x: p[p.length - 2] ?? 0, y: p[p.length - 1] ?? 0 });
        lines.push([a.x, a.y, b.x, b.y]);
      }
      continue;
    }
    const r = rectToMap(frame, aabb(o));
    if (o.kind === 'sticky') {
      ctx.globalAlpha = 1;
      ctx.fillStyle = resolveSticky(palette, o.color).bg;
      ctx.fillRect(r.x, r.y, px(r.w), px(r.h));
    } else if (o.kind === 'shape') {
      const fill = resolveColor(palette, o.fill);
      if (fill) {
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = fill;
        ctx.fillRect(r.x, r.y, px(r.w), px(r.h));
      } else {
        // An empty frame: its outline only, so a big board does not blot out what sits on it.
        ctx.globalAlpha = 0.6;
        ctx.strokeStyle = resolveColor(palette, o.stroke) ?? palette.ink;
        ctx.lineWidth = 1;
        ctx.strokeRect(r.x + 0.5, r.y + 0.5, Math.max(r.w - 1, 1), Math.max(r.h - 1, 1));
      }
    } else {
      ctx.globalAlpha = 0.4;
      ctx.fillStyle = resolveColor(palette, o.color) ?? palette.ink;
      ctx.fillRect(r.x, r.y, px(r.w), px(r.h));
    }
  }
  if (lines.length > 0) {
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = palette.ink;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const [x0, y0, x1, y1] of lines) {
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  const v = rectToMap(frame, view);
  ctx.fillStyle = palette.accentFill;
  ctx.fillRect(v.x, v.y, v.w, v.h);
  ctx.strokeStyle = palette.accent;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(v.x, v.y, v.w, v.h);
}

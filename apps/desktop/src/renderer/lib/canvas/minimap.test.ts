import { describe, expect, it } from 'vitest';
import { MAP_H, MAP_PAD, MAP_W, cameraCenteredOn, mapFrame, mapToWorld, rectToMap, worldToMap } from './minimap';

const view = { x: 0, y: 0, w: 1000, h: 800 };

describe('mini-map coordinates', () => {
  it('fits the content and the view together inside the padded box, centered, undistorted', () => {
    const content = { x: -2000, y: -500, w: 5000, h: 1000 };
    const f = mapFrame(content, view);
    const a = worldToMap(f, { x: -2000, y: -500 });
    const b = worldToMap(f, { x: 3000, y: 1000 });
    expect(a.x).toBeGreaterThanOrEqual(MAP_PAD - 1e-9);
    expect(b.x).toBeLessThanOrEqual(MAP_W - MAP_PAD + 1e-9);
    expect(b.y).toBeLessThanOrEqual(MAP_H - MAP_PAD + 1e-9);
    // The wide content spans the whole padded width.
    expect(b.x - a.x).toBeCloseTo(MAP_W - 2 * MAP_PAD);
    const r = rectToMap(f, view);
    expect(r.w / r.h).toBeCloseTo(1000 / 800);
  });
  it('with no content it shows the visible area alone', () => {
    const f = mapFrame(null, view);
    const r = rectToMap(f, view);
    expect(r.x).toBeGreaterThanOrEqual(MAP_PAD - 1e-9);
    expect(r.x + r.w).toBeLessThanOrEqual(MAP_W - MAP_PAD + 1e-9);
    expect(r.y + r.h / 2).toBeCloseTo(MAP_H / 2);
  });
  it('a degenerate (empty-sized) world does not divide by zero', () => {
    const f = mapFrame({ x: 5, y: 5, w: 0, h: 0 }, { x: 5, y: 5, w: 0, h: 0 });
    expect(Number.isFinite(f.scale)).toBe(true);
    expect(Number.isFinite(worldToMap(f, { x: 5, y: 5 }).x)).toBe(true);
  });
  it('map ↔ world round-trips', () => {
    const f = mapFrame({ x: -300, y: 40, w: 900, h: 1500 }, view);
    for (const p of [{ x: 0, y: 0 }, { x: -300, y: 1540 }, { x: 123.5, y: -77 }]) {
      const q = mapToWorld(f, worldToMap(f, p));
      expect(q.x).toBeCloseTo(p.x);
      expect(q.y).toBeCloseTo(p.y);
    }
  });
  it('the camera that centers a world point keeps the zoom and puts the point mid-screen', () => {
    const cam = cameraCenteredOn({ tx: 10, ty: 20, scale: 2 }, { w: 1000, h: 800 }, { x: 300, y: -100 });
    expect(cam.scale).toBe(2);
    expect(300 * cam.scale + cam.tx).toBeCloseTo(500);
    expect(-100 * cam.scale + cam.ty).toBeCloseTo(400);
  });
});

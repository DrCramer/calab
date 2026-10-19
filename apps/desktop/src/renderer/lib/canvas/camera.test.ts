import { describe, expect, it } from 'vitest';
import {
  MAX_SCALE, MIN_SCALE, clampScale, fitRect, lerpCamera, nextZoomStep, panBy, pinchStep, screenToWorld, snapCamera, visibleRect, worldToScreen, zoomAt, zoomTo,
} from './camera';

const cam = { tx: 100, ty: -50, scale: 2 };

describe('camera', () => {
  it('converts both ways', () => {
    const w = { x: 12, y: 34 };
    expect(screenToWorld(cam, worldToScreen(cam, w))).toEqual(w);
    expect(worldToScreen(cam, { x: 0, y: 0 })).toEqual({ x: 100, y: -50 });
  });
  it('clamps zoom to 10–400 %', () => {
    expect(clampScale(0.01)).toBe(MIN_SCALE);
    expect(clampScale(99)).toBe(MAX_SCALE);
    expect(clampScale(NaN)).toBe(1);
  });
  it('zooms around a point, keeping the world point under it fixed', () => {
    const at = { x: 300, y: 200 };
    const before = screenToWorld(cam, at);
    const next = zoomAt(cam, 1.5, at);
    expect(next.scale).toBeCloseTo(3);
    const after = screenToWorld(next, at);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });
  it('stops at the limits and keeps the anchor', () => {
    const at = { x: 50, y: 60 };
    const next = zoomAt({ tx: 0, ty: 0, scale: 3.9 }, 10, at);
    expect(next.scale).toBe(MAX_SCALE);
    expect(screenToWorld(next, at).x).toBeCloseTo(50 / 3.9);
    expect(zoomTo(cam, 1, at).scale).toBe(1);
  });
  it('pans by screen deltas', () => {
    expect(panBy(cam, 5, -5)).toEqual({ tx: 105, ty: -55, scale: 2 });
  });
  it('computes the visible world rect', () => {
    expect(visibleRect({ tx: 0, ty: 0, scale: 0.5 }, { w: 400, h: 200 })).toEqual({ x: 0, y: 0, w: 800, h: 400 });
    expect(visibleRect({ tx: 100, ty: 50, scale: 1 }, { w: 400, h: 200 })).toEqual({ x: -100, y: -50, w: 400, h: 200 });
  });
  it('fits a rect centered, never upscaling past 100 % by default', () => {
    const v = { w: 800, h: 600 };
    const big = fitRect({ x: 0, y: 0, w: 4000, h: 1000 }, v, 0);
    expect(big.scale).toBeCloseTo(0.2);
    const c = worldToScreen(big, { x: 2000, y: 500 });
    expect(c.x).toBeCloseTo(400);
    expect(c.y).toBeCloseTo(300);
    expect(fitRect({ x: 0, y: 0, w: 10, h: 10 }, v).scale).toBe(1);
    expect(fitRect({ x: 0, y: 0, w: 10, h: 10 }, v, 48, true).scale).toBe(MAX_SCALE);
  });
  it('snaps translation to device pixels', () => {
    expect(snapCamera({ tx: 10.37, ty: 4.9, scale: 1 }, 2)).toEqual({ tx: 10.5, ty: 5, scale: 1 });
    expect(snapCamera({ tx: 10.37, ty: 4.9, scale: 1 }, 1)).toEqual({ tx: 10, ty: 5, scale: 1 });
  });
  it('steps through zoom presets', () => {
    expect(nextZoomStep(1, 1)).toBe(1.25);
    expect(nextZoomStep(1, -1)).toBe(0.75);
    expect(nextZoomStep(4, 1)).toBe(MAX_SCALE);
    expect(nextZoomStep(0.1, -1)).toBe(MIN_SCALE);
    expect(nextZoomStep(0.8, 1)).toBe(1);
  });
  it('interpolates scale geometrically', () => {
    const mid = lerpCamera({ tx: 0, ty: 0, scale: 0.25 }, { tx: 100, ty: 0, scale: 4 }, 0.5);
    expect(mid.scale).toBeCloseTo(1);
    expect(mid.tx).toBe(50);
  });
});

describe('pinchStep', () => {
  // Deterministic pseudo-random gestures (a property check without a dependency).
  const rnd = ((seed: number) => () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296))(7);

  it('keeps the world point under the midpoint under the midpoint as it moves, at any scale', () => {
    for (let i = 0; i < 200; i++) {
      const c = { tx: rnd() * 400 - 200, ty: rnd() * 400 - 200, scale: 0.15 + rnd() * 3.5 };
      const a0 = { x: rnd() * 400, y: rnd() * 800 };
      const b0 = { x: rnd() * 400, y: rnd() * 800 };
      const a1 = { x: a0.x + rnd() * 80 - 40, y: a0.y + rnd() * 80 - 40 };
      const b1 = { x: b0.x + rnd() * 80 - 40, y: b0.y + rnd() * 80 - 40 };
      const m0 = { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2 };
      const m1 = { x: (a1.x + b1.x) / 2, y: (a1.y + b1.y) / 2 };
      const next = pinchStep(c, a0, b0, a1, b1);
      const was = screenToWorld(c, m0);
      const now = screenToWorld(next, m1);
      expect(now.x).toBeCloseTo(was.x, 6);
      expect(now.y).toBeCloseTo(was.y, 6);
    }
  });
  it('scales by the change of the finger distance', () => {
    const next = pinchStep({ tx: 0, ty: 0, scale: 1 }, { x: 100, y: 0 }, { x: 200, y: 0 }, { x: 50, y: 0 }, { x: 250, y: 0 });
    expect(next.scale).toBeCloseTo(2);
  });
  it('does not stick at a limit: pinching back responds at once', () => {
    let c = { tx: 0, ty: 0, scale: 3.9 };
    c = pinchStep(c, { x: 100, y: 0 }, { x: 200, y: 0 }, { x: 0, y: 0 }, { x: 400, y: 0 });
    expect(c.scale).toBe(MAX_SCALE);
    c = pinchStep(c, { x: 0, y: 0 }, { x: 400, y: 0 }, { x: 100, y: 0 }, { x: 300, y: 0 });
    expect(c.scale).toBeCloseTo(MAX_SCALE / 2);
  });
  it('treats fingers touching each other as a pure pan (no ratio blow-up)', () => {
    const next = pinchStep({ tx: 0, ty: 0, scale: 1 }, { x: 100, y: 100 }, { x: 102, y: 100 }, { x: 110, y: 120 }, { x: 160, y: 120 });
    expect(next.scale).toBe(1);
    expect(next.tx).toBeCloseTo(10 + 25 - 1);
    expect(next.ty).toBeCloseTo(20);
  });
});

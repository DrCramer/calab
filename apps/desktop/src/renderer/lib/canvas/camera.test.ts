import { describe, expect, it } from 'vitest';
import {
  MAX_SCALE, MIN_SCALE, clampScale, fitRect, lerpCamera, nextZoomStep, panBy, screenToWorld, snapCamera, visibleRect, worldToScreen, zoomAt, zoomTo,
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

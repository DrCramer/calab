import { describe, expect, it } from 'vitest';
import { rotateHandlePoint } from '../../../lib/canvas/geometry';
import { KNOB_RADIUS, PANEL_GAP, PANEL_MARGIN, placePanel, safeArea, type Insets } from './layout';

const cam = { tx: 0, ty: 0, scale: 1 };
const vp = { w: 1000, h: 800 };
const size = { w: 300, h: 40 };
/** The real chrome: a ~52px toolbar column on the left, a ~52px band at the top and the bottom. */
const chrome: Insets = { left: 52, top: 52, right: 0, bottom: 52 };
const safe = safeArea(vp, chrome);
const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });

/** The panel never overlaps the chrome and stays inside the viewport. */
function expectClear(p: { x: number; y: number }): void {
  expect(p.x).toBeGreaterThanOrEqual(safe.x);
  expect(p.x + size.w).toBeLessThanOrEqual(safe.x + safe.w);
  expect(p.y).toBeGreaterThanOrEqual(safe.y);
  expect(p.y + size.h).toBeLessThanOrEqual(safe.y + safe.h);
}

describe('safeArea', () => {
  it('shrinks the viewport by the chrome plus a margin', () => {
    expect(safeArea(vp, chrome)).toEqual({ x: 60, y: 60, w: 932, h: 680 });
    expect(safeArea(vp)).toEqual({ x: PANEL_MARGIN, y: PANEL_MARGIN, w: 984, h: 784 });
  });

  it('never goes empty in a tiny window', () => {
    const s = safeArea({ w: 40, h: 40 }, { left: 52, top: 52, right: 52, bottom: 52 });
    expect(s.w).toBeGreaterThan(0);
    expect(s.h).toBeGreaterThan(0);
  });
});

describe('placePanel with floating chrome', () => {
  it('keeps a selection at the left edge clear of the toolbar column', () => {
    const p = placePanel(box(0, 300, 40, 40), cam, vp, size, chrome);
    expect(p.x).toBe(safe.x);
    expect(p.y).toBe(300 - size.h - PANEL_GAP);
    expectClear(p);
    expect(placePanel(box(0, 300, 40, 40), cam, vp, size).x).toBe(PANEL_MARGIN);
  });

  it('keeps a selection at the right edge inside the safe area', () => {
    const p = placePanel(box(960, 300, 40, 40), cam, vp, size, { ...chrome, right: 60 });
    expectClear(p);
    expect(p.x + size.w).toBe(vp.w - 60 - PANEL_MARGIN);
  });

  it('goes below a selection hugging the top, and never into the top band', () => {
    const p = placePanel(box(400, 20, 100, 60), cam, vp, size, chrome);
    expect(p.y).toBe(20 + 60 + PANEL_GAP);
    expectClear(p);
  });

  it('stays above a selection at the bottom, clear of the undo/zoom bars', () => {
    const p = placePanel(box(400, 760, 100, 30), cam, vp, size, chrome);
    // 760 - 40 - 12 = 708 would reach into the bottom band, so it is clamped to the safe area's lower edge
    expect(p.y).toBe(safe.y + safe.h - size.h);
    expectClear(p);
    expect(p.y + size.h).toBeLessThanOrEqual(vp.h - chrome.bottom);
  });

  it('puts a selection whose top is in the top band below it, and still above the bottom band', () => {
    const p = placePanel(box(400, 40, 100, 600), cam, vp, size, chrome);
    expect(p.y).toBe(40 + 600 + PANEL_GAP);
    expectClear(p);
  });

  it('centers on the visible part of a huge selection, inside it', () => {
    // Spans the whole window and beyond: the panel sits at the top of what is visible, over the middle of it.
    const p = placePanel(box(-500, -500, 3000, 3000), cam, vp, size, chrome);
    expectClear(p);
    expect(p.y).toBe(safe.y + PANEL_GAP);
    expect(p.x).toBe(Math.round((safe.x + safe.x + safe.w) / 2 - size.w / 2));
  });

  it('centers on the visible part of a selection partly off the left edge', () => {
    const p = placePanel(box(-400, 300, 800, 200), cam, vp, size, chrome);
    expectClear(p);
    // the visible part is 60..400: center 230 → the panel's left edge is 80
    expect(p.x).toBe(80);
  });

  it('has nowhere clean to go in a short window: it stays clamped in the safe area', () => {
    const tiny = { w: 1000, h: 200 };
    const s = safeArea(tiny, chrome);
    const p = placePanel(box(400, 80, 100, 60), cam, tiny, size, chrome);
    expect(p.y).toBeGreaterThanOrEqual(s.y);
    expect(p.y + size.h).toBeLessThanOrEqual(s.y + s.h);
    expect(p.visible).toBe(true);
  });

  it('follows the camera continuously (no jump while panning)', () => {
    let prev: number | null = null;
    for (let tx = 0; tx <= 800; tx += 20) {
      const p = placePanel(box(100, 300, 120, 80), { tx, ty: 0, scale: 1 }, vp, size, chrome);
      expectClear(p);
      if (prev !== null) expect(Math.abs(p.x - prev)).toBeLessThanOrEqual(20);
      prev = p.x;
    }
  });

  it('hides when the selection is off screen', () => {
    expect(placePanel(box(5000, 100, 10, 10), cam, vp, size, chrome).visible).toBe(false);
    expect(placePanel(box(100, 100, 10, 10), cam, vp, size, chrome).visible).toBe(true);
  });
});

describe('placePanel with a rotation handle', () => {
  const offset = 26;
  /** The handle of an upright box: above the middle of its top side. */
  const knobOf = (b: { x: number; y: number; w: number; h: number }) => rotateHandlePoint(b, 0, offset);
  const free = (p: { x: number; y: number }, b: { y: number; h: number }, k: { y: number }): boolean =>
    p.y + size.h <= k.y - KNOB_RADIUS || p.y >= b.y + b.h;

  it('sits above the handle, clear of it', () => {
    const b = box(400, 300, 160, 160);
    const k = knobOf(b);
    const p = placePanel(b, cam, vp, size, chrome, k);
    expect(p.y + size.h).toBeLessThanOrEqual(k.y - KNOB_RADIUS - PANEL_GAP + 1);
    expect(placePanel(b, cam, vp, size, chrome).y).toBeGreaterThan(p.y); // without the handle it hangs lower
    expectClear(p);
  });

  it('goes below the object, clear of the bottom handles, when the handle leaves no room above', () => {
    const b = box(400, 70, 160, 160);
    const k = knobOf(b);
    const p = placePanel(b, cam, vp, size, chrome, k);
    expect(p.y).toBeGreaterThanOrEqual(b.y + b.h + PANEL_GAP - 1);
    expect(free(p, b, k)).toBe(true);
    expectClear(p);
  });

  it('flips for an object that would have fit the panel above it, if not for the handle', () => {
    const b = box(400, 130, 160, 160); // 70 px above the box fit the 40 px panel + gap; the handle takes 34 of them
    expect(placePanel(b, cam, vp, size, chrome).y + size.h).toBeLessThanOrEqual(b.y);
    const withKnob = placePanel(b, cam, vp, size, chrome, knobOf(b));
    expect(withKnob.y).toBeGreaterThanOrEqual(b.y + b.h);
  });

  it('a rotated object: the panel clears the handle wherever the turn put it', () => {
    for (const rot of [0, 45, 90, 180, 270]) {
      const b = box(400, 300, 160, 100);
      const k = rotateHandlePoint(b, rot, offset);
      // The selection's circumscribed rect, as the engine reports it.
      const a = (rot * Math.PI) / 180;
      const w = 160 * Math.abs(Math.cos(a)) + 100 * Math.abs(Math.sin(a));
      const h = 160 * Math.abs(Math.sin(a)) + 100 * Math.abs(Math.cos(a));
      const bb = box(480 - w / 2, 350 - h / 2, w, h);
      const p = placePanel(bb, cam, vp, size, chrome, k);
      expect(p.y + size.h <= k.y - KNOB_RADIUS || p.y >= Math.max(bb.y + bb.h, k.y + KNOB_RADIUS) || p.x + size.w <= k.x - KNOB_RADIUS || p.x >= k.x + KNOB_RADIUS).toBe(true);
      expectClear(p);
    }
  });

  it('a very tall object: neither side fits, the panel stays inside the viewport', () => {
    const b = box(300, -400, 300, 1600);
    const p = placePanel(b, cam, vp, size, chrome, knobOf(b));
    expectClear(p);
    expect(p.visible).toBe(true);
  });

  it('follows the camera with the handle (zoomed, panned) and never changes without a handle', () => {
    const c = { tx: 40, ty: 30, scale: 2 };
    const b = box(100, 100, 100, 80);
    const k = knobOf(b);
    const p = placePanel(b, c, vp, size, chrome, k);
    expect(p.y + size.h).toBeLessThanOrEqual(c.ty + k.y * 2 - KNOB_RADIUS);
    expect(placePanel(b, c, vp, size, chrome, null)).toEqual(placePanel(b, c, vp, size, chrome));
  });
});

import { describe, expect, it } from 'vitest';
import { IDENTITY, anchorAt, chatGallery, clampPan, clampScale, dimsOf, doubleTapTarget, fitFrame, isDoubleTap, isTap, lightboxLayers, lockAxis, placeAnchor, stepImage, swipeAction } from './lightbox';

describe('chatGallery', () => {
  const f = (id: string): { id: string } => ({ id });
  it('flattens the chat in message order and finds the opened photo', () => {
    const g = chatGallery([[f('a')], [f('b'), f('c')], [f('d')]], 'c', [f('c')]);
    expect(g.files.map((x) => x.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(g.index).toBe(2);
  });
  it('falls back to the message pictures when the photo is not in the list', () => {
    const g = chatGallery([[f('a')]], 'z', [f('y'), f('z')]);
    expect(g.files.map((x) => x.id)).toEqual(['y', 'z']);
    expect(g.index).toBe(1);
  });
});

describe('zoom math', () => {
  const frame = { w: 300, h: 200 };
  const view = { w: 400, h: 600 };
  it('clamps the scale', () => {
    expect(clampScale(0.3)).toBe(1);
    expect(clampScale(9)).toBe(5);
  });
  it('keeps a pinch anchor under the fingers', () => {
    const p = { x: 40, y: -20 };
    const t = placeAnchor(anchorAt(IDENTITY, p), 3, p);
    expect(anchorAt(t, p)).toEqual(anchorAt(IDENTITY, p));
  });
  it('clamps the pan to the picture edges and centres a fitted one', () => {
    expect(clampPan({ s: 1, x: 50, y: 50 }, frame, view)).toEqual(IDENTITY);
    // 300*3 = 900 wide in a 400 view: 250 px of travel each way; 200*3 = 600 = view height: none.
    const t = clampPan({ s: 3, x: 999, y: -999 }, frame, view);
    expect(t.x).toBe(250);
    expect(Math.abs(t.y)).toBe(0);
  });
  it('double tap zooms in about the point and out again', () => {
    const t = doubleTapTarget(IDENTITY, { x: 100, y: 0 }, frame, view);
    expect(t.s).toBe(2.5);
    expect(t.x).toBeLessThan(0);
    expect(doubleTapTarget(t, { x: 0, y: 0 }, frame, view)).toEqual(IDENTITY);
  });
  it('recognises a double tap by time and place', () => {
    const a = { t: 1000, x: 10, y: 10 };
    expect(isDoubleTap(a, { t: 1200, x: 15, y: 12 })).toBe(true);
    expect(isDoubleTap(a, { t: 1400, x: 15, y: 12 })).toBe(false);
    expect(isDoubleTap(a, { t: 1100, x: 90, y: 12 })).toBe(false);
    expect(isDoubleTap(null, a)).toBe(false);
  });
});

describe('swipe', () => {
  it('locks the dominant axis past the slop', () => {
    expect(lockAxis(3, 3)).toBeNull();
    expect(lockAxis(30, 5)).toBe('x');
    expect(lockAxis(5, 30)).toBe('y');
  });
  it('right = previous, left = next, no wrap at the ends', () => {
    expect(swipeAction('x', 100, 0, 400, true, true)).toBe('prev');
    expect(swipeAction('x', -100, 0, 400, true, true)).toBe('next');
    expect(swipeAction('x', 100, 0, 400, false, true)).toBe('none');
    expect(swipeAction('x', -100, 0, 400, true, false)).toBe('none');
    expect(swipeAction('x', 30, 0, 400, true, true)).toBe('none');
  });
  it('closes on a long swipe down only', () => {
    expect(swipeAction('y', 0, 150, 400, true, true)).toBe('close');
    expect(swipeAction('y', 0, -150, 400, true, true)).toBe('none');
    expect(swipeAction('y', 0, 50, 400, true, true)).toBe('none');
  });
});

describe('lightboxLayers', () => {
  it('shows the thumbnail with a spinner while the full image loads', () => {
    expect(lightboxLayers('loaded', 'loading')).toEqual({ thumb: true, full: false, spinner: true, error: false });
  });
  it('shows only a spinner before the thumbnail is there', () => {
    expect(lightboxLayers('loading', 'loading')).toEqual({ thumb: false, full: false, spinner: true, error: false });
  });
  it('replaces the thumbnail by the loaded full image', () => {
    expect(lightboxLayers('loaded', 'loaded')).toEqual({ thumb: false, full: true, spinner: false, error: false });
  });
  it('keeps the thumbnail and reports a failed full image', () => {
    expect(lightboxLayers('loaded', 'error')).toEqual({ thumb: true, full: false, spinner: false, error: true });
  });
});

describe('fitFrame', () => {
  it('fits a known size both ways and never upscales it', () => {
    expect(fitFrame({ w: 720, h: 1280 }, true)).toEqual({ width: 'min(100cqw, 720px, calc(100cqh * 720 / 1280))', aspectRatio: '720 / 1280' });
  });
  it('fills the box when only the aspect is known', () => {
    expect(fitFrame({ w: 16, h: 9 }, false)).toEqual({ width: 'min(100cqw, calc(100cqh * 16 / 9))', aspectRatio: '16 / 9' });
  });
  it('has no frame for an unknown image', () => {
    expect(fitFrame(null, true)).toBeNull();
    expect(dimsOf(0, 400)).toBeNull();
    expect(dimsOf(640, 400)).toEqual({ w: 640, h: 400 });
  });
});

describe('stepImage', () => {
  it('moves within the gallery without wrapping', () => {
    expect(stepImage(0, 1, 3)).toBe(1);
    expect(stepImage(2, 1, 3)).toBeNull();
    expect(stepImage(0, -1, 3)).toBeNull();
    expect(stepImage(0, 1, 1)).toBeNull();
  });
});

describe('isTap', () => {
  it('counts a press released in place or within the slop as a click', () => {
    expect(isTap({ x: 10, y: 10 }, { x: 10, y: 10 })).toBe(true);
    expect(isTap({ x: 10, y: 10 }, { x: 14, y: 13 })).toBe(true);
  });
  it('treats a press that moved further as a drag (the viewer stays open)', () => {
    expect(isTap({ x: 10, y: 10 }, { x: 40, y: 10 })).toBe(false);
    expect(isTap({ x: 10, y: 10 }, { x: 15, y: 15 })).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { NOTCH_ZOOM, WheelClassifier, type WheelLike } from './wheel';

const ev = (o: Partial<WheelLike>): WheelLike => ({
  deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false, timeStamp: 1000, ...o,
});

describe('wheel events', () => {
  it('a Chrome/Electron trackpad pinch (ctrl + small pixel deltas) zooms exponentially, and the pieces add up', () => {
    const w = new WheelClassifier();
    const f = (dy: number): number => {
      const a = w.classify(ev({ ctrlKey: true, deltaY: dy }), 800);
      return a.kind === 'zoom' ? a.factor : NaN;
    };
    expect(f(-5)).toBeCloseTo(Math.exp(0.05));
    expect(f(5)).toBeCloseTo(Math.exp(-0.05));
    expect(f(-0.4)).toBeCloseTo(Math.exp(0.004));
    // One long pinch is the same zoom however its events are cut.
    expect(f(-6) * f(-4)).toBeCloseTo(f(-10));
    // A burst can't jump the view: a single event is capped.
    expect(f(-49)).toBeLessThan(Math.exp(0.5) + 1e-9);
    expect(w.classify(ev({ ctrlKey: true, deltaY: -49.5 }), 800)).toMatchObject({ kind: 'zoom' });
  });

  it('ctrl + a mouse notch is a step, in either unit; ⌘ works like ctrl', () => {
    const w = new WheelClassifier();
    expect(w.classify(ev({ ctrlKey: true, deltaY: -100 }), 800)).toEqual({ kind: 'zoom', factor: NOTCH_ZOOM });
    expect(w.classify(ev({ metaKey: true, deltaY: 100 }), 800)).toEqual({ kind: 'zoom', factor: 1 / NOTCH_ZOOM });
    const line = w.classify(ev({ ctrlKey: true, deltaMode: 1, deltaY: -3 }), 800);
    expect(line.kind === 'zoom' && line.factor).toBeCloseTo(NOTCH_ZOOM);
  });

  it('a mouse wheel (big whole pixel delta, or lines) zooms in steps; several notches in one event are capped', () => {
    const w = new WheelClassifier();
    expect(w.classify(ev({ deltaY: -100 }), 800)).toEqual({ kind: 'zoom', factor: NOTCH_ZOOM });
    expect(w.classify(ev({ deltaMode: 1, deltaY: 3 }), 800)).toMatchObject({ kind: 'zoom' });
    const big = w.classify(ev({ deltaY: -2000 }), 800);
    expect(big.kind === 'zoom' && big.factor).toBeCloseTo(NOTCH_ZOOM ** 3);
    expect(w.classify(ev({ deltaMode: 2, deltaY: 1 }), 800)).toMatchObject({ kind: 'zoom' });
  });

  it('a shifted mouse wheel pans sideways instead of zooming', () => {
    const w = new WheelClassifier();
    expect(w.classify(ev({ deltaY: 100, shiftKey: true }), 800)).toEqual({ kind: 'pan', dx: -100, dy: 0 });
    expect(w.classify(ev({ deltaMode: 1, deltaY: 3, shiftKey: true }), 800)).toEqual({ kind: 'pan', dx: -48, dy: 0 });
  });

  it('a two-finger scroll (small, fractional or two-axis pixel deltas) pans the content with the fingers', () => {
    const w = new WheelClassifier();
    expect(w.classify(ev({ deltaX: 4, deltaY: -12 }), 800)).toEqual({ kind: 'pan', dx: -4, dy: 12 });
    expect(w.classify(ev({ deltaY: 7.25 }), 800)).toEqual({ kind: 'pan', dx: -0, dy: -7.25 });
    expect(w.classify(ev({ deltaY: 30 }), 800)).toMatchObject({ kind: 'pan' });
  });

  it('big whole deltas right after trackpad events are still the trackpad (a fast flick), later they are a wheel again', () => {
    const w = new WheelClassifier();
    w.classify(ev({ deltaY: 12.5, timeStamp: 1000 }), 800);
    expect(w.classify(ev({ deltaY: 120, timeStamp: 1100 }), 800)).toMatchObject({ kind: 'pan' });
    expect(w.classify(ev({ deltaY: 120, timeStamp: 1450 }), 800)).toMatchObject({ kind: 'pan' });
    expect(w.classify(ev({ deltaY: 120, timeStamp: 2300 }), 800)).toMatchObject({ kind: 'zoom' });
  });

  it('a pinch counts as trackpad input too', () => {
    const w = new WheelClassifier();
    w.classify(ev({ ctrlKey: true, deltaY: -3, timeStamp: 1000 }), 800);
    expect(w.classify(ev({ deltaY: 100, timeStamp: 1100 }), 800)).toMatchObject({ kind: 'pan' });
  });
});

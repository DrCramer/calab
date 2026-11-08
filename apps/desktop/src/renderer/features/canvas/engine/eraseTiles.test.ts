import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InkRec, ObjectRec } from '../../../lib/canvas/types';
import { TextLayouter } from '../../../lib/canvas/textLayout';
import { drawObjects, releaseScratch, SCRATCH_TILE, type DrawEnv } from './draw';
import { defaultPalette } from './palette';
import { fakeCtx } from './testing';

/** Offscreen canvases that remember the biggest size ever given to one. */
const made: FakeOffscreen[] = [];
class FakeOffscreen {
  width: number;
  height: number;
  constructor(w: number, h: number) {
    this.width = w;
    this.height = h;
    made.push(this);
  }
  getContext(): unknown {
    return fakeCtx().ctx;
  }
}

const env = (): DrawEnv => ({ palette: defaultPalette('light'), layouter: new TextLayouter((t) => t.length * 6), scale: 1, hiddenText: null });

function ink(over: Partial<InkRec>): ObjectRec {
  return {
    id: 'i', kind: 'ink', x: 0, y: 0, w: 100, h: 100, points: [0, 0, 100, 100], stroke: 'ink', strokeWidth: 4, erase: [50, 50, 50, 50, 8],
    ...over,
  } as unknown as ObjectRec;
}

function paint(o: ObjectRec, cw: number, ch: number): ReturnType<typeof fakeCtx> {
  const f = fakeCtx();
  f.state.canvas = { width: cw, height: ch };
  f.state.getTransform = () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
  drawObjects(f.ctx, [o], { x: -10, y: -10, w: cw + 20, h: ch + 20 }, env());
  return f;
}

describe('the eraser scratch canvas', () => {
  beforeEach(() => {
    made.length = 0;
    releaseScratch();
    vi.stubGlobal('OffscreenCanvas', FakeOffscreen);
  });
  afterEach(() => {
    releaseScratch();
    vi.unstubAllGlobals();
  });

  it('paints a box wider than a tile as several drawImage calls covering it exactly', () => {
    const W = SCRATCH_TILE * 2 + 300;
    const H = SCRATCH_TILE + 50;
    const f = paint(ink({ w: W, h: H, points: [0, 0, W, H], erase: [10, 10, 10, 10, 8] }), 5000, 5000);
    const rects = f.calls.filter((c) => c.name === 'drawImage').map((c) => c.args.slice(5) as number[]);
    expect(rects).toHaveLength(6);
    let area = 0;
    for (const [, , w, h] of rects) {
      expect(w).toBeLessThanOrEqual(SCRATCH_TILE);
      expect(h).toBeLessThanOrEqual(SCRATCH_TILE);
      area += (w ?? 0) * (h ?? 0);
    }
    // No overlaps and no gaps: the tiles' area is the box's (stroke width 4 → 3 px pad, the leading pad is off-canvas).
    expect(area).toBe((W + 3) * (H + 3));
  });

  it('never makes a scratch canvas bigger than one tile', () => {
    paint(ink({ w: 4000, h: 3000, points: [0, 0, 4000, 3000] }), 5000, 5000);
    expect(made.length).toBeGreaterThan(0);
    for (const c of made) {
      expect(c.width).toBeLessThanOrEqual(SCRATCH_TILE);
      expect(c.height).toBeLessThanOrEqual(SCRATCH_TILE);
    }
  });

  it('a small stroke is one drawImage, and releaseScratch drops the canvas', () => {
    const f = paint(ink({}), 800, 600);
    expect(f.count('drawImage')).toBe(1);
    const c = made[made.length - 1];
    if (!c) throw new Error('no scratch canvas');
    releaseScratch();
    expect(c.width).toBe(0);
    paint(ink({}), 800, 600);
    expect(made).toHaveLength(2);
  });
});

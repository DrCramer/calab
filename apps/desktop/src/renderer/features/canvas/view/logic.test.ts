import { describe, expect, it, vi } from 'vitest';
import type { ObjectRec } from '../../../lib/canvas/types';
import { placePanel } from './layout';
import { exportScale, pngFileName, MAX_EXPORT_PIXELS, MAX_EXPORT_SIDE } from './exportPng';
import { nearestTextSize } from './model';
import { PresenceStore } from './presenceStore';
import { createSelectionModel, panelModelOf } from './selectionModel';

const base = { id: 'a', z: 'a0', x: 0, y: 0, w: 100, h: 80 } as const;
const sticky = (id: string, color: string): ObjectRec => ({ ...base, id, kind: 'sticky', color, text: '' });
const shape = (id: string, over: Partial<{ fill: string; stroke: string; strokeWidth: number }> = {}): ObjectRec => ({
  ...base, id, kind: 'shape', shape: 'rect', fill: 'none', stroke: 'stroke', strokeWidth: 2, text: '', ...over,
});

describe('placePanel', () => {
  const cam = { tx: 0, ty: 0, scale: 1 };
  const vp = { w: 1000, h: 800 };
  const size = { w: 200, h: 40 };

  it('centers above the selection', () => {
    expect(placePanel({ x: 400, y: 300, w: 100, h: 80 }, cam, vp, size)).toEqual({ x: 350, y: 248, visible: true });
  });

  it('flips below when there is no room above, and stays inside the viewport', () => {
    expect(placePanel({ x: 400, y: 10, w: 100, h: 80 }, cam, vp, size).y).toBe(102);
    expect(placePanel({ x: 0, y: 300, w: 20, h: 20 }, cam, vp, size).x).toBe(8);
    expect(placePanel({ x: 980, y: 300, w: 20, h: 20 }, cam, vp, size).x).toBe(792);
  });

  it('follows the camera and hides when the selection is off screen', () => {
    const p = placePanel({ x: 100, y: 100, w: 100, h: 100 }, { tx: 50, ty: 20, scale: 2 }, vp, size);
    expect(p).toEqual({ x: 250, y: 168, visible: true });
    expect(placePanel({ x: 5000, y: 100, w: 10, h: 10 }, cam, vp, size).visible).toBe(false);
    expect(placePanel({ x: -500, y: 100, w: 100, h: 10 }, cam, vp, size).visible).toBe(false);
  });
});

describe('export sizing', () => {
  it('keeps the wanted scale for small content', () => {
    expect(exportScale(800, 600, 2)).toBe(2);
  });

  it('lowers the scale so the long side stays within 8192 px', () => {
    const s = exportScale(20_000, 1000, 2);
    expect(20_000 * s).toBeLessThanOrEqual(MAX_EXPORT_SIDE + 1e-6);
  });

  it('lowers the scale so the pixel count stays within the cap', () => {
    const s = exportScale(8000, 8000, 2);
    expect(8000 * s * 8000 * s).toBeLessThanOrEqual(MAX_EXPORT_PIXELS * 1.0001);
    expect(exportScale(1e7, 1e7, 1)).toBeGreaterThan(0);
  });

  it('makes a safe file name', () => {
    expect(pngFileName('Plan: Q4/2026?', 'canvas')).toBe('Plan Q4 2026.png');
    expect(pngFileName('   ', 'холст')).toBe('холст.png');
    expect(pngFileName('a'.repeat(300), 'x').length).toBeLessThanOrEqual(104);
  });
});

describe('properties panel model', () => {
  it('is null without a selection and summarizes uniform values', () => {
    expect(panelModelOf([])).toBeNull();
    const m = panelModelOf([sticky('a', 'green'), sticky('b', 'green')]);
    expect(m).toMatchObject({ count: 2, hasSticky: true, hasShape: false, stickyColor: 'green' });
    expect(panelModelOf([sticky('a', 'green'), sticky('b', 'pink')])?.stickyColor).toBeUndefined();
  });

  it('mixes shape and connector strokes', () => {
    const conn = { ...base, id: 'c', kind: 'connector', from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, arrow: 'end', route: 'elbow', stroke: 'stroke', strokeWidth: 2, label: '', points: [] } as ObjectRec;
    const m = panelModelOf([shape('s'), conn]);
    expect(m).toMatchObject({ hasShape: true, hasConnector: true, stroke: 'stroke', strokeWidth: 2, arrow: 'end', route: 'elbow' });
    expect(panelModelOf([shape('s', { strokeWidth: 4 }), conn])?.strokeWidth).toBeUndefined();
  });

  it('the store keeps the same snapshot while only geometry changes', () => {
    let objs: ObjectRec[] = [sticky('a', 'yellow')];
    const hook: { fire: ((o: readonly ObjectRec[]) => void) | null } = { fire: null };
    const store = createSelectionModel({
      getSelected: () => objs,
      subscribeSelection: (fn) => {
        hook.fire = fn;
        return () => undefined;
      },
    });
    const cb = vi.fn();
    store.subscribe(cb);
    const first = store.getSnapshot();
    objs = [{ ...sticky('a', 'yellow'), x: 50, y: 70 }];
    hook.fire?.(objs);
    expect(cb).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toBe(first);
    objs = [sticky('a', 'blue')];
    hook.fire?.(objs);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()?.stickyColor).toBe('blue');
  });

  it('maps text sizes to the nearest preset', () => {
    expect(nearestTextSize(20)).toBe(20);
    expect(nearestTextSize(25)).toBe(20);
    expect(nearestTextSize(28)).toBe(32);
    expect(nearestTextSize(200)).toBe(48);
  });
});

describe('PresenceStore', () => {
  it('lists people once, and stays quiet while only cursors move', () => {
    const s = new PresenceStore();
    const cb = vi.fn();
    s.subscribe(cb);
    s.set([
      { id: '1', name: 'Ann', color: '#111', cursor: { x: 1, y: 1 } },
      { id: '2', name: 'Ann', color: '#111' },
      { id: '3', name: 'Bob', color: '#222' },
    ]);
    expect(s.getSnapshot().map((u) => u.name)).toEqual(['Ann', 'Bob']);
    const snap = s.getSnapshot();
    s.set([
      { id: '1', name: 'Ann', color: '#111', cursor: { x: 50, y: 9 } },
      { id: '3', name: 'Bob', color: '#222', cursor: { x: 5, y: 5 } },
    ]);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(s.getSnapshot()).toBe(snap);
    s.set([]);
    expect(cb).toHaveBeenCalledTimes(2);
    expect(s.getSnapshot()).toEqual([]);
  });
});

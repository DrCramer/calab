import { describe, expect, it, vi } from 'vitest';
import { Scene } from '../../../lib/canvas/scene';
import { makeDoc } from '../../../lib/canvas/testing';
import { TextLayouter } from '../../../lib/canvas/textLayout';
import { isConnector, type ShapeRec, type StickyRec } from '../../../lib/canvas/types';
import { QuickGesture, type Core } from './gestures';
import { QUICK_GAP, QUICK_OFFSET_PX, WIDE_STICKY_W, choiceInit, choiceSize, dropRect, quickInit, quickSideAt, quickTarget } from './quick';

const src = { x: 0, y: 0, w: 160, h: 160 };

describe('«continue» handles', () => {
  it('a dot is hit within its radius, at its screen distance at any zoom; there is none on top', () => {
    expect(quickSideAt(src, { x: 160 + QUICK_OFFSET_PX, y: 80 }, 1)).toBe('right');
    expect(quickSideAt(src, { x: 160 + QUICK_OFFSET_PX * 2, y: 80 }, 2)).toBe('right');
    expect(quickSideAt(src, { x: 80, y: 160 + QUICK_OFFSET_PX }, 1)).toBe('bottom');
    expect(quickSideAt(src, { x: 80, y: -QUICK_OFFSET_PX }, 1)).toBeNull();
    expect(quickSideAt(src, { x: 200, y: 200 }, 1)).toBeNull();
  });
  it('the new object goes one gap beyond the side, stepping past what is already there', () => {
    expect(quickTarget(src, 'right', [])).toEqual({ x: 160 + QUICK_GAP, y: 0, w: 160, h: 160 });
    expect(quickTarget(src, 'left', [])).toEqual({ x: -QUICK_GAP - 160, y: 0, w: 160, h: 160 });
    const taken = [{ x: 240, y: 0, w: 160, h: 160 }];
    const r = quickTarget(src, 'right', taken);
    expect(r.x).toBe(240);
    expect(r.y).toBeGreaterThanOrEqual(160);
    const b = quickTarget(src, 'bottom', [{ x: 0, y: 240, w: 160, h: 160 }]);
    expect(b.y).toBe(240);
    expect(b.x).toBeGreaterThanOrEqual(160);
  });
  it('copies the kind, size and look but not the text; a soft fill stays soft', () => {
    const sticky = { id: 's', kind: 'sticky', x: 0, y: 0, w: 200, h: 120, color: 'pink', text: 'hello', fontPx: 22 } as StickyRec;
    expect(quickInit(sticky, { x: 5, y: 6, w: 200, h: 120 })).toEqual({ kind: 'sticky', x: 5, y: 6, w: 200, h: 120, color: 'pink', fontPx: 22 });
    const shape = { id: 'h', kind: 'shape', x: 0, y: 0, w: 160, h: 100, shape: 'ellipse', fill: 'green', soft: true, stroke: 'green', strokeWidth: 2, text: 'x' } as ShapeRec;
    expect(quickInit(shape, { x: 0, y: 0, w: 160, h: 100 })).toMatchObject({ kind: 'shape', shape: 'ellipse', fill: 'soft:green', stroke: 'green', strokeWidth: 2 });
    expect('text' in quickInit(shape, src)).toBe(false);
  });
});

describe('QuickGesture (press on a dot)', () => {
  const setup = () => {
    const doc = makeDoc();
    const scene = new Scene(doc, new TextLayouter((t, sz) => t.length * sz * 0.5));
    const [a, b] = doc.createMany([
      { init: { kind: 'sticky', x: 0, y: 0, color: 'pink' } },
      { init: { kind: 'sticky', x: 600, y: 0 } },
    ]);
    doc.checkpoint();
    const finished = vi.fn();
    const click = vi.fn();
    const restore = vi.fn();
    const dropped = vi.fn();
    const core = { doc, scene, px: (n: number) => n, gridSize: 0, connectorRoute: 'straight', setOverlay: () => {}, finishCreate: finished, openQuickDrop: dropped } as unknown as Core;
    const src = scene.get(a ?? '') as StickyRec;
    const g = new QuickGesture(core, src, 'right', { x: 182, y: 80 }, click, restore);
    return { doc, scene, a: a ?? '', b: b ?? '', g, finished, click, restore, dropped };
  };
  const mods = { shift: false, alt: false, mod: false };

  it('a click without a drag is the quick copy', () => {
    const t = setup();
    t.g.end();
    expect(t.click).toHaveBeenCalledTimes(1);
  });
  it('released over another object: only an arrow to it', () => {
    const t = setup();
    const before = t.doc.count;
    t.g.move({ x: 680, y: 80 }, { x: 680, y: 80 }, mods);
    t.g.end();
    expect(t.doc.count).toBe(before + 1);
    const wire = [...t.scene.all()].find(isConnector);
    expect(wire?.from).toMatchObject({ id: t.a, side: 'right' });
    expect(wire?.to).toMatchObject({ id: t.b });
    expect(t.finished).toHaveBeenCalledWith([wire?.id], false);
  });
  it('the arrow it makes is the curve the drag previewed, whatever the connector setting', () => {
    const t = setup();
    let wire: number[] | null | undefined;
    (t.g as unknown as { core: { setOverlay: (o: { wire?: number[] | null }) => void } }).core.setOverlay = (o) => {
      if (o.wire) wire = o.wire;
    };
    t.g.move({ x: 680, y: 130 }, { x: 680, y: 130 }, mods);
    t.g.end();
    const made = [...t.scene.all()].find(isConnector);
    expect(made?.route).toBe('curve');
    expect(made?.points).toEqual(wire);
  });
  it('released on empty canvas: the line stays, the drop menu opens at its end, nothing is written yet', () => {
    const t = setup();
    const before = t.doc.count;
    t.g.move({ x: 300, y: 500 }, { x: 300, y: 500 }, mods);
    t.g.end();
    expect(t.doc.count).toBe(before);
    expect(t.dropped).toHaveBeenCalledWith(t.a, 'right', { x: 160, y: 80 }, { x: 300, y: 500 });
  });
  it('Esc during a drag puts the dots back and writes nothing', () => {
    const t = setup();
    const before = t.doc.count;
    t.g.move({ x: 300, y: 500 }, { x: 300, y: 500 }, mods);
    t.g.cancel();
    expect(t.restore).toHaveBeenCalled();
    expect(t.doc.count).toBe(before);
  });
});

describe('the drop menu\'s object', () => {
  it('sits with its side facing the line on the line\'s end', () => {
    expect(dropRect({ x: 0, y: 0 }, { x: 300, y: 10 }, 100, 60)).toEqual({ rect: { x: 300, y: -20, w: 100, h: 60 }, side: 'left' });
    expect(dropRect({ x: 0, y: 0 }, { x: -300, y: 0 }, 100, 60)).toEqual({ rect: { x: -400, y: -30, w: 100, h: 60 }, side: 'right' });
    expect(dropRect({ x: 0, y: 0 }, { x: 10, y: 300 }, 100, 60)).toEqual({ rect: { x: -40, y: 300, w: 100, h: 60 }, side: 'top' });
    expect(dropRect({ x: 0, y: 0 }, { x: 0, y: -300 }, 100, 60).side).toBe('bottom');
  });
  it('the copy keeps the source; a sticky takes the tool\'s color; typed text goes in', () => {
    const src = { id: 's', kind: 'sticky', x: 0, y: 0, w: 200, h: 120, color: 'pink', text: '' } as StickyRec;
    expect(choiceSize({ kind: 'same' }, src)).toEqual({ w: 200, h: 120 });
    expect(choiceSize({ kind: 'sticky', wide: true }, src).w).toBe(WIDE_STICKY_W);
    const r = { x: 0, y: 0, w: 160, h: 160 };
    expect(choiceInit({ kind: 'same' }, src, r, 'yellow', 'Hi')).toMatchObject({ kind: 'sticky', color: 'pink', text: 'Hi' });
    expect(choiceInit({ kind: 'sticky' }, src, r, 'yellow', '')).toMatchObject({ kind: 'sticky', color: 'yellow' });
    expect(choiceInit({ kind: 'shape', shape: 'diamond' }, src, r, 'yellow', '')).toMatchObject({ kind: 'shape', shape: 'diamond' });
  });
});

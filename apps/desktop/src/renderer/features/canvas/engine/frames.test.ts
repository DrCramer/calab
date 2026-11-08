// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Scene } from '../../../lib/canvas/scene';
import { TextLayouter } from '../../../lib/canvas/textLayout';
import { drawObject, type DrawEnv } from './draw';
import { defaultPalette } from './palette';
import { fakeCtx } from './testing';
import { destroyRigs, rig, type Rig } from './testRig';

const frameAt = (x: number, y: number, w = 600, h = 400, title = 'Board') => ({ init: { kind: 'frame' as const, x, y, w, h, title } });
const sticky = (x: number, y: number) => ({ init: { kind: 'sticky' as const, x, y } });
const at = (r: Rig, id: string) => r.engine.doc.snapshot(id);

afterEach(() => {
  destroyRigs();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('the «Фрейм» tool', () => {
  it('F arms it; a click places the armed size centered, titled «Frame N», selected, without a text editor', () => {
    const r = rig({ frameTitle: (n) => `Frame ${n}` });
    r.key('f');
    expect(r.engine.getState().tool).toBe('frame');
    r.engine.setFrameSize('1:1');
    r.click(500, 400);
    const s = r.engine.getState();
    expect(s.tool).toBe('select');
    expect(s.editing).toBe(false);
    expect(at(r, s.selectedId ?? '')).toMatchObject({ kind: 'frame', x: 140, y: 40, w: 720, h: 720, title: 'Frame 1' });
    r.engine.setTool('frame');
    r.click(100, 100);
    expect(at(r, r.engine.getState().selectedId ?? '')).toMatchObject({ title: 'Frame 2', w: 720 });
  });

  it('a drag draws a frame of its own size (never smaller than the minimum)', () => {
    const r = rig();
    r.engine.setTool('frame');
    r.drag([100, 100], [500, 350]);
    expect(at(r, r.engine.getState().selectedId ?? '')).toMatchObject({ kind: 'frame', x: 100, y: 100, w: 400, h: 250 });
    r.engine.setTool('frame');
    r.drag([100, 100], [120, 112]);
    expect(at(r, r.engine.getState().selectedId ?? '')).toMatchObject({ w: 80, h: 80 });
  });
});

describe('a frame and what it holds', () => {
  it('a click picks the object under the pointer, the frame by its empty area; a frame has no rotation handle', () => {
    const r = rig();
    const [f, a] = r.make(frameAt(0, 0), sticky(100, 100));
    r.click(150, 150);
    expect(r.engine.getState().selectedId).toBe(a);
    r.click(500, 300);
    expect(r.engine.getState().selectedId).toBe(f);
    expect(r.engine.selectionFrame()).toMatchObject({ resize: true, rotate: false });
  });

  it('dragging the frame moves its members in the same gesture: one undo step takes all of it back', () => {
    const r = rig();
    const [f, a, out] = r.make(frameAt(0, 0), sticky(100, 100), sticky(700, 100));
    r.engine.doc.undo.stopCapturing();
    const steps = r.engine.doc.undo.undoStack.length;
    r.drag([500, 300], [560, 340]);
    expect(at(r, f ?? '')).toMatchObject({ x: 60, y: 40 });
    expect(at(r, a ?? '')).toMatchObject({ x: 160, y: 140 });
    expect(at(r, out ?? '')).toMatchObject({ x: 700, y: 100 });
    expect(r.engine.doc.undo.undoStack.length).toBe(steps + 1);
    r.key('z', { metaKey: true });
    expect(at(r, f ?? '')).toMatchObject({ x: 0, y: 0 });
    expect(at(r, a ?? '')).toMatchObject({ x: 100, y: 100 });
  });

  it('an object dragged out is no longer taken along; arrow keys move a frame with its members', () => {
    const r = rig();
    const [f, a] = r.make(frameAt(0, 0), sticky(100, 100));
    r.drag([150, 150], [850, 150]);
    expect(at(r, a ?? '')).toMatchObject({ x: 800 });
    r.click(500, 300);
    expect(r.engine.getState().selectedId).toBe(f);
    r.drag([500, 300], [500, 350]);
    expect(at(r, a ?? '')).toMatchObject({ x: 800, y: 100 });
    r.drag([850, 150], [150, 150]);
    r.click(500, 300);
    r.key('ArrowRight', { shiftKey: true });
    expect(at(r, f ?? '')).toMatchObject({ x: 10 });
    expect(at(r, a ?? '')).toMatchObject({ x: 110 });
  });

  it('resizing a frame leaves its members as they are; deleting it keeps them', () => {
    const r = rig();
    const [f, a] = r.make(frameAt(0, 0), sticky(100, 100));
    r.click(500, 300);
    r.drag([600, 400], [800, 500]); // se handle
    expect(at(r, f ?? '')).toMatchObject({ w: 800, h: 500 });
    expect(at(r, a ?? '')).toMatchObject({ x: 100, y: 100, w: 160, h: 160 });
    r.key('Delete');
    expect(r.engine.scene.has(f ?? '')).toBe(false);
    expect(r.engine.scene.has(a ?? '')).toBe(true);
  });

  it('duplicating a frame copies what it holds', () => {
    const r = rig();
    r.make(frameAt(0, 0), sticky(100, 100));
    r.click(500, 300);
    const copies = r.engine.duplicateSelection();
    expect(copies).toHaveLength(2);
    expect(copies.map((id) => at(r, id)?.kind).sort()).toEqual(['frame', 'sticky']);
  });

  it('the frames panel commands: zoom to a frame selects it and fits it; rename is one undo step', () => {
    const r = rig();
    const [f] = r.make(frameAt(2000, 1000, 400, 300));
    r.engine.zoomToFrame(f ?? '');
    expect(r.engine.getState().selectedId).toBe(f);
    const v = r.engine.visibleWorld();
    expect(v.x).toBeLessThanOrEqual(2000);
    expect(v.x + v.w).toBeGreaterThanOrEqual(2400);
    expect(v.y + v.h).toBeGreaterThanOrEqual(1300);
    r.engine.doc.undo.stopCapturing();
    r.engine.renameFrame(f ?? '', 'Anna');
    expect(at(r, f ?? '')).toMatchObject({ title: 'Anna' });
    r.engine.undo();
    expect(at(r, f ?? '')).toMatchObject({ title: 'Board' });
  });
});

describe('drawing a frame', () => {
  it('paints its board and the title; the title goes below a readable size', () => {
    const r = rig();
    const [f] = r.make(frameAt(0, 0, 600, 400, 'Sprint'));
    const scene = new Scene(r.engine.doc, new TextLayouter((t, s) => t.length * s * 0.5));
    const rec = scene.get(f ?? '');
    if (!rec) throw new Error('no frame');
    const fake = fakeCtx();
    const env: DrawEnv = { palette: defaultPalette('light'), layouter: scene.text, scale: 1, hiddenText: null };
    drawObject(fake.ctx, rec, env);
    expect(fake.count('fill')).toBe(1);
    expect(fake.calls.filter((c) => c.name === 'fillText').map((c) => c.args[0])).toEqual(['Sprint']);
    fake.clear();
    drawObject(fake.ctx, rec, { ...env, scale: 0.1 });
    expect(fake.count('fillText')).toBe(0);
    scene.destroy();
  });
});

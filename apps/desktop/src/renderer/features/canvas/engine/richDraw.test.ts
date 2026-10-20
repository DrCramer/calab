import { describe, expect, it } from 'vitest';
import { F_BOLD, F_ITALIC, F_STRIKE, toggleFlag, toggleList } from '../../../lib/canvas/richText';
import { Scene } from '../../../lib/canvas/scene';
import { makeDoc } from '../../../lib/canvas/testing';
import { TextLayouter } from '../../../lib/canvas/textLayout';
import { AwarenessLayer } from './awareness';
import { emptyOverlay } from './overlay';
import { defaultPalette } from './palette';
import { Renderer, renderSceneTo } from './renderer';
import { fakeCtx, fakeCanvas, manualRaf } from './testing';

const FAM = defaultPalette('light').fontFamily;
const measure = (t: string, s: number, f = 0): number => t.length * s * 0.5 * (f & F_BOLD ? 1.1 : 1);

function paint(setup: (d: ReturnType<typeof makeDoc>) => void, scale = 1): ReturnType<typeof fakeCtx> {
  const d = makeDoc();
  setup(d);
  const scene = new Scene(d, new TextLayouter(measure));
  const f = fakeCtx();
  const target = { width: 0, height: 0, getContext: () => f.ctx };
  const b = scene.bounds();
  if (!b) throw new Error('empty');
  renderSceneTo(target, scene, defaultPalette('light'), b, scale, 10);
  return f;
}

describe('drawing formatted text (recorded calls)', () => {
  const text = 'plain bold italic gone';
  const fmt = (() => {
    let f = toggleFlag(undefined, text, 6, 10, F_BOLD);
    f = toggleFlag(f, text, 11, 17, F_ITALIC);
    return toggleFlag(f, text, 18, 22, F_STRIKE);
  })();
  it('draws each piece in its own font, and strike-through as a bar', () => {
    const f = paint((d) => d.create({ kind: 'sticky', x: 0, y: 0, w: 400, text, fmt }));
    const drawn = f.calls.filter((c) => c.name === 'fillText').map((c) => [c.args[0], c.font]);
    expect(drawn).toEqual([
      ['plain ', `18px ${FAM}`],
      ['bold', `600 18px ${FAM}`],
      [' ', `18px ${FAM}`],
      ['italic', `italic 18px ${FAM}`],
      [' ', `18px ${FAM}`],
      ['gone', `18px ${FAM}`],
    ]);
    // The strike-through is a thin bar over the last piece ('gone' = 4 chars × 9 px = 36 wide).
    const bar = f.calls.filter((c) => c.name === 'fillRect').find((c) => (c.args[3] as number) < 3);
    expect(bar?.args[2]).toBeCloseTo(36);
  });
  it('plain objects are drawn as before: one fillText per line, regular font', () => {
    const f = paint((d) => d.create({ kind: 'sticky', x: 0, y: 0, w: 400, text: 'just text' }));
    const t = f.calls.filter((c) => c.name === 'fillText');
    expect(t).toHaveLength(1);
    expect(t[0]?.font).toBe(`18px ${FAM}`);
  });
  it('draws list markers and a number per item', () => {
    const t = 'one\ntwo';
    const f = paint((d) => d.create({ kind: 'text', x: 0, y: 0, w: 300, size: 20, text: t, fmt: toggleList(undefined, t, 0, 7, 'number') }));
    expect(f.calls.filter((c) => c.name === 'fillText').map((c) => c.args[0])).toEqual(['1.', 'one', '2.', 'two']);
    const g = paint((d) => d.create({ kind: 'text', x: 0, y: 0, w: 300, size: 20, text: t, fmt: toggleList(undefined, t, 0, 7, 'bullet') }));
    expect(g.calls.filter((c) => c.name === 'fillText').map((c) => c.args[0])).toEqual(['•', 'one', '•', 'two']);
  });
  it('the export draws the formatting too (same path)', () => {
    const f = paint((d) => d.create({ kind: 'shape', x: 0, y: 0, w: 300, h: 120, text: 'ab', fmt: toggleFlag(undefined, 'ab', 0, 2, F_BOLD) }), 2);
    expect(f.calls.find((c) => c.name === 'fillText')?.font).toBe(`600 16px ${FAM}`);
  });
  it('sticky and shape text follows the size token', () => {
    const f = paint((d) => d.create({ kind: 'sticky', x: 0, y: 0, text: 'big', fontSize: 'xl' }));
    expect(f.calls.find((c) => c.name === 'fillText')?.font).toBe(`38px ${FAM}`);
    const g = paint((d) => d.create({ kind: 'shape', x: 0, y: 0, text: 'small', fontSize: 's' }));
    expect(g.calls.find((c) => c.name === 'fillText')?.font).toBe(`12px ${FAM}`);
  });
  it('below 25 % a formatted text degenerates to a plaque like a plain one: no glyphs', () => {
    const d = makeDoc();
    d.create({ kind: 'sticky', x: 0, y: 0, w: 400, h: 400, text, fmt });
    const scene = new Scene(d, new TextLayouter(measure));
    const canvas = fakeCanvas();
    const raf = manualRaf();
    const layer = fakeCtx();
    const r = new Renderer({
      canvas: canvas as unknown as HTMLCanvasElement, scene, palette: defaultPalette('light'),
      getCamera: () => ({ tx: 0, ty: 0, scale: 0.2 }), getOverlay: emptyOverlay,
      awareness: new AwarenessLayer(),
      raf: raf.raf, cancelRaf: raf.cancel, now: () => 0, makeLayer: () => ({ width: 0, height: 0, getContext: () => layer.ctx }),
    });
    r.resize(800, 600, 1);
    raf.flush();
    expect(layer.count('fillText') + canvas.fake.count('fillText')).toBe(0);
  });
  it('an old record with no attributes does not allocate a rich layout', () => {
    const d = makeDoc();
    d.create({ kind: 'sticky', x: 0, y: 0, text: 'aaa' });
    const scene = new Scene(d, new TextLayouter(measure));
    expect(scene.get('o1')).not.toHaveProperty('fmt');
    expect(scene.text.size).toBe(0);
  });
});

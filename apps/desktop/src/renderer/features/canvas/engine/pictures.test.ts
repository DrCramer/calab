// @vitest-environment jsdom
import * as Y from 'yjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serialize, parse, toInits } from '../../../lib/canvas/clipboard';
import { CanvasDoc } from '../../../lib/canvas/doc';
import { canvasPlainText } from '../../../lib/canvas/plainText';
import { Scene } from '../../../lib/canvas/scene';
import { TextLayouter } from '../../../lib/canvas/textLayout';
import { CURVE_STEPS } from '../../../lib/canvas/route';
import { isConnector, type ConnectorRec, type ImageRec } from '../../../lib/canvas/types';
import { describeObject } from '../view/SelectionAnnouncer';
import { ImageCache, KEEP_MS } from './images';
import { destroyRigs, rig, type Rig } from './testRig';

afterEach(() => {
  destroyRigs();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const SRC = '/api/files/0b7c6a52-3f7a-4a7e-9d8e-2f6c1f0e9a11';
const SRC2 = '/api/files/1c8d7b63-4a8b-4b8f-ae9f-3a7d2a1fab22';
const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

/** A decoder that resolves when told (a fake bitmap per URL). */
function decoder(): { decode: (url: string) => Promise<CanvasImageSource>; urls: string[]; resolveAll: () => void } {
  const waiting: (() => void)[] = [];
  const urls: string[] = [];
  return {
    urls,
    decode: (url) =>
      new Promise((resolve) => {
        urls.push(url);
        waiting.push(() => resolve({ url } as unknown as CanvasImageSource));
      }),
    resolveAll: () => {
      for (const w of waiting.splice(0)) w();
    },
  };
}

function pictureRig(): { r: Rig; dec: ReturnType<typeof decoder>; resolved: string[] } {
  const dec = decoder();
  const resolved: string[] = [];
  const r = rig({
    imageUrl: (src) => {
      resolved.push(src);
      return `blob:${src}`;
    },
    decodeImage: dec.decode,
  });
  return { r, dec, resolved };
}

const conn = (r: Rig, id: string | undefined): ConnectorRec => {
  const o = r.engine.scene.get(id ?? '');
  if (!o || !isConnector(o)) throw new Error('no connector');
  return o;
};
const pic = (r: Rig, id: string | undefined): ImageRec => {
  const o = r.engine.scene.get(id ?? '');
  if (o?.kind !== 'image') throw new Error('no picture');
  return o;
};

describe('smooth connectors', () => {
  const setup = (r: Rig): string | undefined => {
    const [a, b] = r.make(
      { init: { kind: 'sticky', x: 0, y: 0, w: 100, h: 100 } },
      { init: { kind: 'sticky', x: 400, y: 300, w: 100, h: 100 } },
    );
    const [c] = r.make({ init: { kind: 'connector', from: { id: a ?? '', side: 'right' }, to: { id: b ?? '', side: 'left' }, route: 'curve', label: 'flow' } });
    return c;
  };
  it('are read with their control points, a flattened path and a label at the curve middle', () => {
    const r = rig();
    const c = conn(r, setup(r));
    expect(c.route).toBe('curve');
    expect(c.curve).toHaveLength(4);
    expect(c.points.length).toBe(2 * (CURVE_STEPS + 1));
    // Right side (100, 50) → left side (400, 350): symmetric, so the middle is the chord's middle.
    expect(c.points.slice(0, 2)).toEqual([100, 50]);
    expect(c.points.slice(-2)).toEqual([400, 350]);
  });
  it('are hit along the curve, not along the chord', () => {
    const r = rig();
    const id = setup(r);
    const c = conn(r, id);
    // A sample a quarter of the way: on the curve (it leaves horizontally, so it is above the chord there).
    const q = { x: c.points[2 * 8] ?? 0, y: c.points[2 * 8 + 1] ?? 0 };
    expect(r.engine.hitAt(q)?.id).toBe(id);
    // The chord's quarter point lies well off the curve.
    expect(r.engine.hitAt({ x: 175, y: 125 })).toBeNull();
  });
  it('are drawn as one cubic with tangent arrowheads; a route switch re-routes', () => {
    const r = rig();
    const id = setup(r);
    r.raf.flush();
    expect(r.fake.count('bezierCurveTo')).toBeGreaterThan(0);
    r.fake.clear();
    r.engine.setSelection([id ?? '']);
    r.engine.updateSelected({ route: 'elbow' });
    expect(conn(r, id).curve).toBeUndefined();
    r.raf.flush();
    expect(r.fake.count('bezierCurveTo')).toBe(0);
  });
  it('a route a build does not know reads as straight (and so does `curve` for builds before it)', () => {
    const y = new Y.Doc();
    const d = new CanvasDoc(y);
    y.transact(() => {
      const m = new Y.Map<unknown>();
      d.objects.set('c', m);
      m.set('kind', 'connector');
      m.set('from', { x: 0, y: 0 });
      m.set('to', { x: 100, y: 0 });
      m.set('route', 'spiral');
    });
    const s = new Scene(d, new TextLayouter((t, n) => t.length * n * 0.5));
    expect(s.get('c')).toMatchObject({ route: 'straight', points: [0, 0, 100, 0] });
  });
});

describe('stickers on the board (pictures)', () => {
  it('a sticker is placed at the view center with its aspect ratio, selected, and the tool goes back to select', () => {
    const { r } = pictureRig();
    const id = r.engine.insertImage(SRC, 512, 256, 'st1');
    const o = pic(r, id ?? undefined);
    expect(o).toMatchObject({ src: SRC, stickerId: 'st1', w: 200, h: 100 });
    // The rig's view is 1000 × 800 at scale 1 from (0, 0).
    expect(o.x + o.w / 2).toBe(500);
    expect(o.y + o.h / 2).toBe(400);
    expect(r.engine.getState().selectedId).toBe(id);
    expect(r.engine.getState().tool).toBe('select');
  });
  it('anything but the app\'s own media is refused (the loader sends the token)', () => {
    const { r } = pictureRig();
    expect(r.engine.insertImage('https://evil.example/x.webp', 10, 10)).toBeNull();
    expect(r.engine.insertImage('/api/files/../me', 10, 10)).toBeNull();
    // A foreign client writing one directly: the record is not read.
    r.ydoc.transact(() => {
      const m = new Y.Map<unknown>();
      r.engine.doc.objects.set('x', m);
      m.set('kind', 'image');
      m.set('src', 'https://evil.example/x.webp');
    }, 'remote');
    expect(r.engine.scene.has('x')).toBe(false);
    expect(r.engine.scene.size).toBe(0);
  });
  it('draws a plaque until the picture loads, then repaints once with the image; one load per picture', async () => {
    const { r, dec, resolved } = pictureRig();
    r.engine.insertImage(SRC, 512, 512);
    r.engine.insertImage(SRC, 512, 512);
    r.engine.clearSelection();
    r.raf.flush();
    expect(r.fake.count('drawImage')).toBe(1); // the layer blit only
    await flush();
    expect(resolved).toEqual([SRC]);
    expect(dec.urls).toEqual([`blob:${SRC}`]);
    const frames = r.engine.stats.frames;
    r.fake.clear();
    dec.resolveAll();
    await flush();
    expect(r.raf.pending).toBe(1);
    r.raf.flush();
    expect(r.engine.stats.frames).toBe(frames + 1);
    // Two pictures + the layer blit.
    expect(r.fake.calls.filter((c) => c.name === 'drawImage' && (c.args[0] as { url?: string }).url === `blob:${SRC}`)).toHaveLength(2);
    expect(r.raf.pending).toBe(0);
  });
  it('a failed load stays a plaque and is not retried', async () => {
    const calls = vi.fn(() => Promise.reject(new Error('403')));
    const r2 = rig({ imageUrl: calls });
    r2.engine.insertImage(SRC, 1, 1);
    r2.raf.flush();
    await flush();
    r2.engine.setCamera({ tx: 10, ty: 10, scale: 1 });
    r2.raf.flush();
    r2.engine.setCamera({ tx: 0, ty: 0, scale: 2 });
    r2.raf.flush();
    await flush();
    expect(calls).toHaveBeenCalledTimes(1);
    expect(r2.raf.pending).toBe(0);
  });
  it('resizes from the corners only and keeps the aspect ratio without Shift', () => {
    const { r } = pictureRig();
    const id = r.engine.insertImage(SRC, 512, 256);
    const o = pic(r, id ?? undefined);
    expect(r.engine.selectionFrame()).toMatchObject({ cornersOnly: true, resize: true, rotate: true });
    // Drag the south-east corner far to the right only: the height follows.
    r.drag([o.x + o.w, o.y + o.h], [o.x + o.w + 200, o.y + o.h]);
    const n = pic(r, id ?? undefined);
    expect(n.w / n.h).toBeCloseTo(2);
    expect(n.w).toBeGreaterThan(o.w);
    // An edge handle is not one: the drag from the east edge's middle moves the picture instead.
    const before = pic(r, id ?? undefined);
    r.drag([before.x + before.w, before.y + before.h / 2], [before.x + before.w + 50, before.y + before.h / 2]);
    const after = pic(r, id ?? undefined);
    expect(after.w).toBe(before.w);
  });
  it('has no text: Enter and a double-click do not open an editor', () => {
    const { r } = pictureRig();
    const id = r.engine.insertImage(SRC, 100, 100);
    expect(r.engine.startTextEdit(id ?? '')).toBe(false);
    r.key('Enter');
    expect(r.engine.getState().editing).toBe(false);
  });
  it('duplicates, copies, rotates, locks and groups like any box', async () => {
    const { r } = pictureRig();
    const id = r.engine.insertImage(SRC, 100, 100, 'st1') ?? '';
    r.engine.updateSelected({ rot: 30 });
    const [copy] = r.engine.duplicateSelection();
    expect(pic(r, copy)).toMatchObject({ src: SRC, stickerId: 'st1', rot: 30 });
    r.engine.setSelection([id, copy ?? '']);
    expect(r.engine.groupSelection()).not.toBeNull();
    await r.engine.copy();
    const pasted = r.engine.pasteText(r.clip.text);
    expect(pasted).toHaveLength(2);
    expect(pasted.map((p) => pic(r, p).src)).toEqual([SRC, SRC]);
    r.engine.setSelection([id]);
    r.engine.toggleLock();
    expect(pic(r, id).locked).toBe(true);
  });
  it('a connector glues to a picture\'s sides', () => {
    const { r } = pictureRig();
    const a = r.engine.insertImage(SRC, 100, 100) ?? '';
    const [c] = r.make({ init: { kind: 'connector', from: { id: a, side: 'right' }, to: { x: 900, y: 400 } } });
    const o = pic(r, a);
    expect(conn(r, c).points.slice(0, 2)).toEqual([o.x + o.w, o.y + o.h / 2]);
  });
  it('is announced as «Стикер-картинка» and adds no text for search', () => {
    const { r } = pictureRig();
    const id = r.engine.insertImage(SRC, 100, 100);
    expect(describeObject(pic(r, id ?? undefined))).toBe('Стикер-картинка');
    expect(canvasPlainText(r.ydoc)).toBe('');
  });
  it('200 stickers at rest: after they load, no frame and no timer', async () => {
    vi.useFakeTimers();
    const { r, dec } = pictureRig();
    const inits = Array.from({ length: 200 }, (_, i) => ({ init: { kind: 'image' as const, src: i % 2 ? SRC : SRC2, x: (i % 20) * 50, y: Math.floor(i / 20) * 50, w: 40, h: 40 } }));
    r.make(...inits);
    r.raf.flush();
    await flush();
    dec.resolveAll();
    await flush();
    r.raf.flush();
    expect(dec.urls).toHaveLength(2);
    expect(r.raf.pending).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    const frames = r.engine.stats.frames;
    r.clock.t += 60_000;
    vi.advanceTimersByTime(60_000);
    await flush();
    expect(r.raf.pending).toBe(0);
    expect(r.engine.stats.frames).toBe(frames);
  });
});

describe('the picture cache', () => {
  it('keeps at most `cap` pictures, dropping the least recently drawn ones not drawn lately', async () => {
    const clock = { t: 0 };
    const loaded: string[] = [];
    const c = new ImageCache((s) => s, (s) => loaded.push(s), { cap: 2, now: () => clock.t, decode: (u) => Promise.resolve({ u } as unknown as CanvasImageSource) });
    c.get('a');
    c.get('b');
    await flush();
    expect(loaded).toEqual(['a', 'b']);
    // A third one drawn in the same moment: nothing is old enough to go, the cache holds all three.
    c.get('c');
    expect(c.size).toBe(3);
    clock.t += KEEP_MS + 1;
    c.get('b');
    c.get('d');
    // 'a' was the least recently drawn and is old: dropped; 'c' (same age) too, to get back to the cap.
    expect(c.size).toBe(2);
    expect(c.get('b')).not.toBeNull();
  });
  it('ready pictures are returned synchronously; a destroyed cache loads nothing', async () => {
    const c = new ImageCache((s) => s, () => undefined, { decode: () => Promise.resolve({} as CanvasImageSource) });
    expect(c.get('a')).toBeNull();
    await flush();
    expect(c.get('a')).not.toBeNull();
    c.destroy();
    expect(c.get('b')).toBeNull();
    expect(c.size).toBe(0);
  });
});

describe('older documents and clients', () => {
  it('a kind this build does not know (as `image` is for builds before it) is skipped everywhere, nothing breaks', () => {
    const y = new Y.Doc();
    const d = new CanvasDoc(y);
    y.transact(() => {
      const m = new Y.Map<unknown>();
      d.objects.set('v', m);
      m.set('kind', 'video');
      m.set('z', 'a0');
      m.set('src', SRC);
      m.set('x', 0);
      m.set('y', 0);
      m.set('w', 100);
      m.set('h', 100);
    });
    d.create({ kind: 'sticky', x: 0, y: 0, text: 'kept' });
    const s = new Scene(d, new TextLayouter((t, n) => t.length * n * 0.5));
    expect(s.size).toBe(1);
    expect(s.has('v')).toBe(false);
    const text = serialize(s, d, ['v', ...s.orderedIds()]);
    const payload = parse(text ?? '');
    expect(payload?.objects.map((o) => o.kind)).toEqual(['sticky']);
    expect(toInits(payload ?? { v: 1, objects: [] }, 0, 0)).toHaveLength(1);
    expect(canvasPlainText(y)).toBe('kept');
    // Its own fields survive edits around it: nothing rewrites an object it cannot read.
    d.remove(s.orderedIds());
    expect(d.objects.get('v')?.get('src')).toBe(SRC);
  });
});

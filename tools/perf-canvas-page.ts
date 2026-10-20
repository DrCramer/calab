/**
 * Browser side of tools/perf-canvas.ts: builds a canvas with N objects and times the engine's scene
 * assembly, first paint, pan / zoom / edit frames and the idle state in a real Chromium. Bundled by
 * esbuild and exposed as `window.__bench`.
 */
import * as Y from 'yjs';
import { CanvasDoc } from '../apps/desktop/src/renderer/lib/canvas/doc';
import { Scene } from '../apps/desktop/src/renderer/lib/canvas/scene';
import { fmtFromDelta, type DeltaOp, type Fmt } from '../apps/desktop/src/renderer/lib/canvas/richText';
import { TEMPLATE_IDS } from '../apps/desktop/src/renderer/lib/canvas/templates';
import { TextLayouter } from '../apps/desktop/src/renderer/lib/canvas/textLayout';
import { SHAPE_KINDS, type ObjectInit } from '../apps/desktop/src/renderer/lib/canvas/types';
import { CanvasEngine } from '../apps/desktop/src/renderer/features/canvas/engine/engine';
import { RotateGesture } from '../apps/desktop/src/renderer/features/canvas/engine/gestures';
import { defaultPalette } from '../apps/desktop/src/renderer/features/canvas/engine/palette';

export interface Stat {
  mean: number;
  p50: number;
  p95: number;
  max: number;
  n: number;
}

const stat = (xs: number[]): Stat => {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number): number => s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
  return { mean: xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length), p50: at(0.5), p95: at(0.95), max: s[s.length - 1] ?? 0, n: xs.length };
};
const round = (n: number): number => Math.round(n * 100) / 100;
const fmt = (s: Stat): Stat => ({ mean: round(s.mean), p50: round(s.p50), p95: round(s.p95), max: round(s.max), n: s.n });

function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

const WORDS = ['план', 'релиз', 'идея', 'бэклог', 'встреча', 'дизайн', 'тест', 'сервер', 'клиент', 'звонок', 'холст', 'задача'];

/** N objects on a 200-unit lattice (100 columns): 60 % stickies with text, 20 % text, 15 % shapes, 5 % glued connectors. */
export function populate(doc: CanvasDoc, n: number): void {
  const r = rng(42);
  const cols = 100;
  const pos = (i: number): { x: number; y: number } => ({ x: (i % cols) * 200, y: Math.floor(i / cols) * 200 });
  const words = (k: number): string => Array.from({ length: k }, () => WORDS[Math.floor(r() * WORDS.length)] ?? '').join(' ');
  const nConn = Math.floor(n * 0.05);
  const nBox = n - nConn;
  const inits: { id: string; init: ObjectInit }[] = [];
  for (let i = 0; i < nBox; i++) {
    const { x, y } = pos(i);
    const t = r();
    const id = `b${i}`;
    if (t < 0.6) inits.push({ id, init: { kind: 'sticky', x, y, w: 160, h: 160, color: ['yellow', 'green', 'blue', 'pink'][i % 4] ?? 'yellow', text: words(4 + Math.floor(r() * 8)) } });
    else if (t < 0.8) inits.push({ id, init: { kind: 'text', x, y, w: 180, size: 20, text: words(2 + Math.floor(r() * 4)) } });
    else inits.push({ id, init: { kind: 'shape', shape: (['rect', 'ellipse', 'diamond', 'rounded', 'triangle'] as const)[i % 5] ?? 'rect', x, y, w: 160, h: 100, fill: i % 2 ? 'none' : 'blue', stroke: 'stroke', text: words(2) } });
  }
  for (let i = 0; i < nConn; i++) {
    const a = Math.floor(r() * nBox);
    const b = Math.min(nBox - 1, a + 1 + Math.floor(r() * 3));
    inits.push({ id: `c${i}`, init: { kind: 'connector', from: { id: `b${a}`, side: 'auto' }, to: { id: `b${b}`, side: 'auto' }, route: i % 2 ? 'elbow' : 'straight', arrow: 'end' } });
  }
  for (let i = 0; i < inits.length; i += 500) doc.createMany(inits.slice(i, i + 500));
}

/** Bold / italic / strike spans and a bullet list over `text` (ADR-0114 wave 2): what a formatted note stores. */
function richOf(text: string, k: number): { text: string; fmt: Fmt | undefined } {
  const words = text.split(' ');
  const ops: DeltaOp[] = [];
  words.forEach((w, i) => {
    const f = (i + k) % 4;
    ops.push({ insert: i < words.length - 1 ? `${w} ` : w, ...(f === 1 ? { attributes: { bold: true } } : f === 2 ? { attributes: { italic: true } } : f === 3 && i % 3 === 0 ? { attributes: { strike: true } } : {}) });
    if (i === 1 && k % 2 === 0) ops.push({ insert: '\n', attributes: { list: 'bullet' } });
  });
  if (k % 2 === 0) ops.push({ insert: '\n', attributes: { list: 'bullet' } });
  return fmtFromDelta(ops);
}

/**
 * The second iteration's mix (ADR-0114) on the same lattice and the same kinds as `populate`: half of the boxes
 * rotated, a third of them in groups of 5, 40 % of the texts formatted (runs and lists), shapes over all 11
 * kinds, a quarter of the stickies with a non-default font size. `rot: false` / `fmt: false` (mixes `v2-norot`,
 * `v2-nofmt`) leave one of them out, the same objects otherwise — to tell what costs what; `v2-rot10` turns 10 % of the
 * boxes instead of half.
 */
export function populateV2(doc: CanvasDoc, n: number, opts: { rot?: boolean; fmt?: boolean; rotEvery?: number } = {}): void {
  const withRot = opts.rot ?? true;
  const rotEvery = opts.rotEvery ?? 2;
  const withFmt = opts.fmt ?? true;
  const r = rng(42);
  const cols = 100;
  const pos = (i: number): { x: number; y: number } => ({ x: (i % cols) * 200, y: Math.floor(i / cols) * 200 });
  const words = (k: number): string => Array.from({ length: k }, () => WORDS[Math.floor(r() * WORDS.length)] ?? '').join(' ');
  const nConn = Math.floor(n * 0.05);
  const nBox = n - nConn;
  const inits: { id: string; init: ObjectInit }[] = [];
  const sizes = ['s', 'l', 'xl'] as const;
  for (let i = 0; i < nBox; i++) {
    const { x, y } = pos(i);
    const t = r();
    const id = `b${i}`;
    const extra: { rot?: number; group?: string; fontSize?: 's' | 'l' | 'xl' } = {};
    const angle = 5 + Math.floor(r() * 350);
    if (i % rotEvery === 0 && withRot) extra.rot = angle;
    if (i % 30 < 10) extra.group = `g${Math.floor(i / 5)}`;
    const rich = (s: string): { text: string; fmt?: Fmt } => {
      if (i % 5 >= 2 || !withFmt) return { text: s };
      const v = richOf(s, i);
      return v.fmt ? { text: v.text, fmt: v.fmt } : { text: v.text };
    };
    if (t < 0.6) inits.push({ id, init: { kind: 'sticky', x, y, w: 160, h: 160, color: ['yellow', 'green', 'blue', 'pink'][i % 4] ?? 'yellow', ...rich(words(4 + Math.floor(r() * 8))), ...extra, ...(i % 4 === 1 ? { fontSize: sizes[i % 3] } : {}) } });
    else if (t < 0.8) inits.push({ id, init: { kind: 'text', x, y, w: 180, size: 20, ...rich(words(2 + Math.floor(r() * 4))), ...extra } });
    else inits.push({ id, init: { kind: 'shape', shape: SHAPE_KINDS[i % SHAPE_KINDS.length] ?? 'rect', x, y, w: 160, h: 100, fill: i % 2 ? 'none' : 'blue', stroke: 'stroke', ...rich(words(2)), ...extra } });
  }
  for (let i = 0; i < nConn; i++) {
    const a = Math.floor(r() * nBox);
    const b = Math.min(nBox - 1, a + 1 + Math.floor(r() * 3));
    inits.push({ id: `c${i}`, init: { kind: 'connector', from: { id: `b${a}`, side: 'auto' }, to: { id: `b${b}`, side: 'auto' }, route: i % 2 ? 'elbow' : 'straight', arrow: 'end' } });
  }
  for (let i = 0; i < inits.length; i += 500) doc.createMany(inits.slice(i, i + 500));
}

const sync = (c: HTMLCanvasElement): void => {
  // Forces the pending GPU/raster work to finish, so the time includes rasterization.
  c.getContext('2d')?.getImageData(0, 0, 1, 1);
};


declare global {
  interface Window {
    __mark?(name: string): Promise<void>;
  }
}
const mark = (name: string): Promise<void> => window.__mark?.(name) ?? Promise.resolve();

export interface BenchResult {
  objects: number;
  dpr: number;
  stateBytes: number;
  /** Text layout cache over the whole run: hits, misses, entries. */
  textCache: { hits: number; misses: number; entries: number };
  canvasLayersMB: number;
  buildDocMs: number;
  loadFromUpdateMs: number;
  sceneBuildMs: number;
  engineCreateMs: number;
  firstFrameMs: number;
  fullFrame: Record<string, { ms: Stat; drawn: number }>;
  pan: Record<string, { record: Stat; withRaster: Stat; fps: number; scrolledFrames: number; drawnPerFrame: number }>;
  zoomFrames: { record: Stat; withRaster: Stat };
  editFrame: { record: Stat; withRaster: Stat };
  dragWithSnap: Stat;
  idle: { seconds: number; rafCalls: number; timeoutCalls: number; intervalCalls: number; frames: number };
  /** `--mix v2` only. */
  ops?: { templates: Record<string, OpCost>; alignLeft500: OpCost; distribute500: OpCost; group500: OpCost; rotate500: { perMoveMs: Stat; bytesPerMove: number } };
}

/** One command: the Yjs transaction(s), the frame after it, the updates it produced (`over64k`: above one socket frame). */
export interface OpCost {
  txMs: number;
  frameMs: number;
  updates: number;
  bytes: number;
  maxUpdate: number;
  over64k: number;
}

export async function run(n: number, dprLabel: number, mix: 'h9' | 'v2' | 'v2-norot' | 'v2-nofmt' | 'v2-rot10' = 'h9'): Promise<BenchResult> {
  await mark('gc:start');
  const canvas = document.getElementById('c') as HTMLCanvasElement;
  const W = canvas.clientWidth;
  const H = canvas.clientHeight;

  // Document build.
  let t = performance.now();
  const ydoc = new Y.Doc();
  const cdoc = new CanvasDoc(ydoc, { rng: rng(7) });
  if (mix === 'h9') populate(cdoc, n);
  else populateV2(cdoc, n, { rot: mix !== 'v2-norot', fmt: mix !== 'v2-nofmt', rotEvery: mix === 'v2-rot10' ? 10 : 2 });
  const buildDocMs = performance.now() - t;
  const state = Y.encodeStateAsUpdate(ydoc);

  // What a client pays when the synced state arrives: apply the update and assemble the scene.
  t = performance.now();
  const loaded = new Y.Doc();
  Y.applyUpdate(loaded, state);
  const loadFromUpdateMs = performance.now() - t;
  t = performance.now();
  const scene = new Scene(new CanvasDoc(loaded), new TextLayouter((s, size) => s.length * size * 0.5));
  const sceneBuildMs = performance.now() - t;
  scene.destroy();

  await mark('gc:engine-before');
  t = performance.now();
  const engine = new CanvasEngine({ canvas, doc: ydoc, palette: defaultPalette('dark'), reducedMotion: true });
  const engineCreateMs = performance.now() - t;
  const frame = (): void => engine.renderer.frame();
  const withRaster = (): number => {
    const s = performance.now();
    frame();
    sync(canvas);
    return performance.now() - s;
  };
  const recordOnly = (): number => {
    const s = performance.now();
    frame();
    return performance.now() - s;
  };

  engine.setCamera({ tx: 40, ty: 40, scale: 1 });
  t = performance.now();
  frame();
  sync(canvas);
  const firstFrameMs = performance.now() - t;

  await mark('gc:engine-after');
  const bounds = engine.scene.bounds() ?? { x: 0, y: 0, w: 1, h: 1 };
  const cx = bounds.x + bounds.w / 2;
  const cy = bounds.y + bounds.h / 2;
  /** Camera whose view center is the world point (wx, wy). */
  const camAt = (wx: number, wy: number, scale: number) => ({ scale, tx: W / 2 - wx * scale, ty: H / 2 - wy * scale });
  const fullFrame: BenchResult['fullFrame'] = {};
  for (const pct of [100, 50, 26, 24, 10]) {
    const xs: number[] = [];
    let drawn = 0;
    for (let k = 0; k < 8; k++) {
      engine.setCamera(camAt(cx + k * 7, cy, pct / 100));
      const s = performance.now();
      engine.renderer.invalidateAll();
      frame();
      sync(canvas);
      xs.push(performance.now() - s);
      drawn = engine.stats.drawn;
    }
    fullFrame[`${pct}%`] = { ms: fmt(stat(xs)), drawn };
  }

  // Pan: the frame time of a drag across the board at a few zoom levels (content scrolled, strips repainted).
  const pan: BenchResult['pan'] = {};
  for (const pct of [100, 50, 26, 10]) {
    const scale = pct / 100;
    const rec: number[] = [];
    const ras: number[] = [];
    const startScroll = engine.stats.scrolled;
    let drawn = 0;
    const startDrawn: number[] = [];
    engine.setCamera(camAt(cx - 1500, cy, scale));
    engine.renderer.invalidateAll();
    frame();
    sync(canvas);
    for (let k = 0; k < 200; k++) {
      engine.setCamera({ ...engine.camera, tx: engine.camera.tx - 14, ty: engine.camera.ty - 5 });
      rec.push(recordOnly());
      sync(canvas);
      startDrawn.push(engine.stats.drawn);
      engine.setCamera({ ...engine.camera, tx: engine.camera.tx - 14, ty: engine.camera.ty - 5 });
      ras.push(withRaster());
    }
    drawn = startDrawn.reduce((a, b) => a + b, 0) / startDrawn.length;
    const wr = stat(ras);
    pan[`${pct}%`] = { record: fmt(stat(rec)), withRaster: fmt(wr), fps: round(1000 / wr.mean), scrolledFrames: engine.stats.scrolled - startScroll, drawnPerFrame: Math.round(drawn) };
  }

  // Zoom gesture: continuous wheel zoom (every frame is a full repaint).
  const zrec: number[] = [];
  const zras: number[] = [];
  engine.setCamera(camAt(cx, cy, 1));
  await mark('zoom-start');
  for (let k = 0; k < 40; k++) {
    engine.zoomAtPoint(0.96, { x: W / 2, y: H / 2 });
    zrec.push(recordOnly());
    sync(canvas);
    engine.zoomAtPoint(0.96, { x: W / 2, y: H / 2 });
    zras.push(withRaster());
  }
  await mark('zoom-end');

  // Editing one object while the view is static (dirty-rect repaint) and a snapped drag through the engine's own gesture.
  engine.setCamera(camAt(cx, cy, 1));
  engine.renderer.invalidateAll();
  frame();
  sync(canvas);
  const erec: number[] = [];
  const eras: number[] = [];
  const centerHit = engine.hitAt({ x: cx, y: cy }, 400);
  const target = centerHit?.id ?? 'b0';
  const baseX = centerHit?.x ?? 0;
  for (let k = 0; k < 60; k++) {
    cdoc.patch(target, { x: baseX + k * 2 });
    erec.push(recordOnly());
    sync(canvas);
    cdoc.patch(target, { x: baseX + k * 2 + 1 });
    eras.push(withRaster());
  }
  const drag: number[] = [];
  const rect = canvas.getBoundingClientRect();
  const fire = (type: string, x: number, y: number): void => {
    const e = new MouseEvent(type, { bubbles: true, clientX: rect.left + x, clientY: rect.top + y, button: 0 });
    Object.defineProperty(e, 'pointerId', { value: 1 });
    canvas.dispatchEvent(e);
  };
  const w0 = engine.hitAt({ x: cx, y: cy }, 400);
  const sx = w0 ? engine.camera.scale * (w0.x + 20) + engine.camera.tx : 0;
  const sy = w0 ? engine.camera.scale * (w0.y + 20) + engine.camera.ty : 0;
  if (w0) {
    fire('pointerdown', sx, sy);
    for (let k = 1; k <= 60; k++) {
      const s = performance.now();
      fire('pointermove', sx + k * 3, sy + k * 2);
      frame();
      sync(canvas);
      drag.push(performance.now() - s);
    }
    fire('pointerup', sx + 180, sy + 120);
  }

  // Second-iteration commands over many objects (ADR-0114): templates, align / distribute, group, group rotation.
  let ops: BenchResult['ops'];
  if (mix !== 'h9') {
    const sizes: number[] = [];
    const onUpdate = (u: Uint8Array): void => void sizes.push(u.length);
    ydoc.on('update', onUpdate);
    const measure = (body: () => void): OpCost => {
      sizes.length = 0;
      const s = performance.now();
      body();
      const txMs = performance.now() - s;
      const f = performance.now();
      frame();
      sync(canvas);
      return { txMs: round(txMs), frameMs: round(performance.now() - f), updates: sizes.length, bytes: sizes.reduce((a, b) => a + b, 0), maxUpdate: Math.max(0, ...sizes), over64k: sizes.filter((b) => b > 65536).length };
    };
    const templates: Record<string, OpCost> = {};
    for (const id of TEMPLATE_IDS) {
      engine.setCamera(camAt(cx + 3000, cy + 3000, 1));
      templates[id] = measure(() => void engine.insertTemplate(id, (key) => `Заметка ${key}`));
    }
    const five = Array.from({ length: 500 }, (_, i) => `b${i}`);
    engine.setCamera(camAt(cx, cy, 0.25));
    engine.setSelection(five);
    const alignLeft = measure(() => engine.arrange('left'));
    const distribute = measure(() => engine.arrange('hspace'));
    engine.setSelection(Array.from({ length: 500 }, (_, i) => `b${1000 + i}`));
    const group = measure(() => void engine.groupSelection());
    engine.setSelection(five);
    const b = engine.scene.bounds(engine.selection) ?? { x: 0, y: 0, w: 1, h: 1 };
    const pivot = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    const g = new RotateGesture(engine, engine.expandUnits(five), { x: pivot.x + 500, y: pivot.y });
    const moves: number[] = [];
    const moveBytes: number[] = [];
    for (let k = 1; k <= 30; k++) {
      const a = (k * 3 * Math.PI) / 180;
      const c = measure(() => g.move({ x: pivot.x + 500 * Math.cos(a), y: pivot.y + 500 * Math.sin(a) }, { x: 0, y: 0 }, { shift: false, alt: false, mod: false }));
      moves.push(c.txMs + c.frameMs);
      moveBytes.push(c.bytes);
    }
    g.end();
    ydoc.off('update', onUpdate);
    ops = { templates, alignLeft500: alignLeft, distribute500: distribute, group500: group, rotate500: { perMoveMs: fmt(stat(moves)), bytesPerMove: Math.round(moveBytes.reduce((a, x) => a + x, 0) / moveBytes.length) } };
  }

  // Idle: nothing should schedule frames or timers while the canvas just sits there.
  const counts = { raf: 0, to: 0, iv: 0 };
  const raf0 = window.requestAnimationFrame.bind(window);
  const to0 = window.setTimeout.bind(window);
  const iv0 = window.setInterval.bind(window);
  window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    counts.raf++;
    return raf0(cb);
  }) as typeof window.requestAnimationFrame;
  window.setTimeout = ((...a: Parameters<typeof setTimeout>) => {
    counts.to++;
    return to0(...a);
  }) as typeof window.setTimeout;
  window.setInterval = ((...a: Parameters<typeof setInterval>) => {
    counts.iv++;
    return iv0(...a);
  }) as typeof window.setInterval;
  await new Promise((r) => to0(r, 100)); // let the last scheduled frame (if any) land
  counts.raf = counts.to = counts.iv = 0;
  const framesBefore = engine.stats.frames;
  await new Promise((r) => to0(r, 3000));
  const idle = { seconds: 3, rafCalls: counts.raf, timeoutCalls: counts.to, intervalCalls: counts.iv, frames: engine.stats.frames - framesBefore };
  window.requestAnimationFrame = raf0;
  window.setTimeout = to0;
  window.setInterval = iv0;

  const dpr = engine.renderer.devicePixelRatio;
  const result: BenchResult = {
    objects: n, dpr: dprLabel, stateBytes: state.length,
    textCache: { hits: engine.scene.text.hits, misses: engine.scene.text.misses, entries: engine.scene.text.size },
    canvasLayersMB: round((2 * W * H * dpr * dpr * 4) / 1048576),
    buildDocMs: round(buildDocMs), loadFromUpdateMs: round(loadFromUpdateMs), sceneBuildMs: round(sceneBuildMs),
    engineCreateMs: round(engineCreateMs), firstFrameMs: round(firstFrameMs),
    fullFrame, pan,
    zoomFrames: { record: fmt(stat(zrec)), withRaster: fmt(stat(zras)) },
    editFrame: { record: fmt(stat(erec)), withRaster: fmt(stat(eras)) },
    dragWithSnap: fmt(stat(drag)),
    idle,
    ...(ops ? { ops } : {}),
  };
  engine.destroy();
  return result;
}

(window as unknown as { __bench: { run: typeof run } }).__bench = { run };

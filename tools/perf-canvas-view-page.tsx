/**
 * Browser side of tools/perf-canvas-view.ts: mounts the real `CanvasView` (React + engine + panels + sync
 * provider) against the in-memory relay with N objects and measures what a user's machine pays for the
 * screen around the engine. Phases (each one is bracketed by `__mark`, the driver adds CPU / heap):
 *   idle          10 s of nothing: rAF, live and fired timers, React commits, frames sent
 *   hidden        the window is hidden (`document.hidden`): nothing drawn, no awareness, no timers — also
 *                 while a peer moves its cursor and edits (hiddenBusy)
 *   cursors       a peer streams 50 awareness frames/s for 5 s (visible, one of our objects selected)
 *   peerEdits     a peer edits visible objects 30×/s for 5 s over a real UPDATE frame
 *   panZoom       wheel pan / zoom clicks / drag: React commits
 *   drag          a selected object dragged for 3 s at ~60 pointer moves/s: frames and bytes we send
 *   paste         500 and 1500 objects pasted into a small canvas: frames and bytes we send
 * Exposed as `window.__viewBench`.
 */
import { createElement, Profiler } from 'react';
import { createRoot } from 'react-dom/client';
import { Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { CanvasView } from '../apps/desktop/src/renderer/features/canvas/view';
import { CanvasDoc } from '../apps/desktop/src/renderer/lib/canvas/doc';
import { CLIPBOARD_PREFIX } from '../apps/desktop/src/renderer/lib/canvas/clipboard';
import type { ObjectInit } from '../apps/desktop/src/renderer/lib/canvas/types';
import { quietAwareness } from '../apps/desktop/src/renderer/lib/ySync';
import { MockRelay, type MockSocket } from '../apps/desktop/src/renderer/lib/ySyncMock';
import { encodeAwareness, encodeUpdate, FRAME_AWARENESS, FRAME_SNAPSHOT_POST, FRAME_UPDATE } from '../apps/desktop/src/renderer/lib/wiki/frames';

declare global {
  interface Window {
    __mark(name: string): Promise<void>;
  }
}

export interface Phase {
  seconds: number;
  rafCalls: number;
  timersScheduled: number;
  timerFires: number;
  reactCommits: number;
  /** Frames this client sent in the phase. */
  /** With `--sites`: the busiest timer call sites of the phase. */
  timerSites?: string[];
  sent: { update: number; updateBytes: number; awareness: number; snapshotPost: number; snapshotPostBytes: number; maxFrame: number };
}

export interface ViewBenchResult {
  objects: number;
  mountToFirstPaintMs: number;
  /** Timers alive at the end of idle (set but not yet fired / cleared), by call site. */
  liveTimers: { timeouts: number; intervals: number; sites: string[] };
  /** The same, while the window is hidden (after `hiddenIdle`). */
  liveTimersHidden: { timeouts: number; intervals: number; sites: string[] };
  phases: Record<string, Phase>;
  /** Sanity of the controls: the clicked sticky got selected (panel shown), the zoom label changed. */
  checks: { panelShownAfterClick: boolean; zoomBefore: string; zoomAfter: string; objectMoved: boolean; peerSeen: boolean; resumedAfterHidden: boolean };
  /** React commits caused by each burst. Expected: 0 for pan and foreign edits; the drag's 1 is the undo button enabling; zoom updates the percentage leaf. */
  commits: { peerJoin: number; wheelPan: number; dragSelected: number; remoteEditOther: number; remoteEditSelected: number; zoomClicks: number };
  paste: { objects: number; updateFrames: number; updateBytes: number; snapshotPosts: number; snapshotPostBytes: number; maxFrame: number; settledObjects: number }[];
  teardown: { socketsOpen: number; liveTimersAfterUnmount: number };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const BITS = (1n << 41n) | (1n << 42n); // CANVAS_BITS.VIEW | WRITE

function populate(relay: MockRelay, n: number): void {
  const cdoc = new CanvasDoc(relay.doc);
  const items: { id: string; init: ObjectInit }[] = [];
  for (let i = 0; i < n; i++) items.push({ id: `o${i}`, init: { kind: 'sticky', x: (i % 100) * 200, y: Math.floor(i / 100) * 200, text: `note ${i}` } });
  for (let i = 0; i < items.length; i += 500) cdoc.createMany(items.slice(i, i + 500));
  cdoc.ensureSchema(); // as a stored document has it: opening writes nothing
}

function pointer(canvas: HTMLElement, type: string, x: number, y: number): void {
  const e = new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: 'mouse' });
  canvas.dispatchEvent(e);
}

// ---- instrumentation: installed before anything mounts

const counters = { raf: 0, scheduled: 0, fires: 0 };
/** `--sites`: also name the call site of every timeout (costs a stack per timer — diagnosis only). */
const siteCounts = new Map<string, number>();
const trackSites = (): boolean => (window as unknown as { __sites?: boolean }).__sites === true;
const live = new Map<number, { kind: 'timeout' | 'interval'; site: string }>();
let hidden = false;

const siteOf = (): string =>
  (new Error().stack ?? '')
    .split('\n')
    .slice(3, 6)
    .map((l) => l.trim().replace(/^at /, '').replace(/\(.*\/(\w+\.\w+:\d+):\d+\)$/, '($1)').replace(/^.*\/(\w+\.\w+:\d+):\d+$/, '$1'))
    .join(' < ');

function instrument(): void {
  const raf0 = window.requestAnimationFrame.bind(window);
  const to0 = window.setTimeout.bind(window);
  const clearTo0 = window.clearTimeout.bind(window);
  const iv0 = window.setInterval.bind(window);
  const clearIv0 = window.clearInterval.bind(window);
  window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    counters.raf++;
    return raf0(cb);
  }) as typeof window.requestAnimationFrame;
  window.setTimeout = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
    counters.scheduled++;
    const site = trackSites() ? siteOf() : '';
    if (site) siteCounts.set(site, (siteCounts.get(site) ?? 0) + 1);
    const id: number = to0(() => {
      live.delete(id);
      counters.fires++;
      if (typeof fn === 'function') (fn as (...a: unknown[]) => void)(...args);
    }, ms);
    live.set(id, { kind: 'timeout', site });
    return id;
  }) as unknown as typeof window.setTimeout;
  window.clearTimeout = ((id?: number) => {
    if (id !== undefined) live.delete(id);
    clearTo0(id);
  }) as typeof window.clearTimeout;
  window.setInterval = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
    counters.scheduled++;
    const site = siteOf();
    const id: number = iv0(() => {
      counters.fires++;
      if (typeof fn === 'function') (fn as (...a: unknown[]) => void)(...args);
    }, ms);
    live.set(id, { kind: 'interval', site });
    return id;
  }) as unknown as typeof window.setInterval;
  window.clearInterval = ((id?: number) => {
    if (id !== undefined) live.delete(id);
    clearIv0(id);
  }) as typeof window.clearInterval;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
}

function setHidden(on: boolean): void {
  hidden = on;
  document.dispatchEvent(new Event('visibilitychange'));
}

const liveSummary = (): ViewBenchResult['liveTimers'] => {
  const sites = new Map<string, number>();
  let timeouts = 0;
  let intervals = 0;
  for (const t of live.values()) {
    if (t.kind === 'timeout') timeouts++;
    else intervals++;
    sites.set(`${t.kind} ${t.site}`, (sites.get(`${t.kind} ${t.site}`) ?? 0) + 1);
  }
  return { timeouts, intervals, sites: [...sites].map(([s, c]) => `${c}× ${s}`) };
};

// ---- what a client sent

interface Sent {
  update: number;
  updateBytes: number;
  awareness: number;
  snapshotPost: number;
  snapshotPostBytes: number;
  maxFrame: number;
}
function tally(sockets: MockSocket[]): Sent {
  const t: Sent = { update: 0, updateBytes: 0, awareness: 0, snapshotPost: 0, snapshotPostBytes: 0, maxFrame: 0 };
  for (const s of sockets)
    for (const d of s.sent) {
      if (typeof d === 'string') continue;
      t.maxFrame = Math.max(t.maxFrame, d.length);
      if (d[0] === FRAME_UPDATE) {
        t.update++;
        t.updateBytes += d.length;
      } else if (d[0] === FRAME_AWARENESS) t.awareness++;
      else if (d[0] === FRAME_SNAPSHOT_POST) {
        t.snapshotPost++;
        t.snapshotPostBytes += d.length;
      }
    }
  return t;
}
const diff = (a: Sent, b: Sent): Sent => ({
  update: b.update - a.update,
  updateBytes: b.updateBytes - a.updateBytes,
  awareness: b.awareness - a.awareness,
  snapshotPost: b.snapshotPost - a.snapshotPost,
  snapshotPostBytes: b.snapshotPostBytes - a.snapshotPostBytes,
  maxFrame: b.maxFrame,
});

interface Mounted {
  host: HTMLElement;
  canvas: HTMLCanvasElement;
  relay: MockRelay;
  mine: MockSocket[];
  commits: { n: number };
  unmount(): void;
}

async function mountView(relay: MockRelay, clipboardText?: () => string): Promise<Mounted> {
  const host = document.getElementById('app') as HTMLElement;
  const root = createRoot(host);
  const commits = { n: 0 };
  const mine: MockSocket[] = [];
  const factory = relay.socketFactory({ canWrite: true });
  root.render(
    createElement(
      Profiler,
      { id: 'v', onRender: () => void commits.n++ },
      createElement(CanvasView, {
        canvasId: 'bench',
        workspaceId: 'w',
        bits: BITS,
        onOpenHistory: () => undefined,
        onShare: () => undefined,
        deps: {
          serverUrl: () => 'https://bench.test',
          getToken: () => Promise.resolve('t'),
          createSocket: (url: string) => {
            const s = factory(url);
            mine.push(s);
            return s;
          },
          user: () => ({ id: 'me', name: 'Me' }),
          ...(clipboardText ? { clipboard: { readText: () => Promise.resolve(clipboardText()), writeText: () => Promise.resolve() } } : {}),
        },
      }),
    ),
  );
  await sleep(1500); // sync settles, the first snapshot is applied
  const canvas = host.querySelector('canvas') as HTMLCanvasElement;
  return { host, canvas, relay, mine, commits, unmount: () => root.unmount() };
}

/** A second participant: a socket on the relay with its own doc and awareness (no engine). */
function makePeer(relay: MockRelay): { doc: CanvasDoc; ydoc: Y.Doc; cursor(x: number, y: number, sel?: string[]): void; socket: MockSocket } {
  const socket = relay.socketFactory({ canWrite: true })('wss://peer.test');
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(relay.doc));
  const aw = quietAwareness(new Awareness(ydoc));
  aw.setLocalState({ user: { id: 'peer', name: 'Peer', color: '#c0392b' }, canvas: { cursor: { x: 0, y: 0 }, selection: [] } });
  void Promise.resolve().then(() => {
    socket.send('t'); // the relay wants the token first
  });
  ydoc.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin !== 'remote') socket.send(encodeUpdate(u));
  });
  return {
    doc: new CanvasDoc(ydoc),
    ydoc,
    socket,
    cursor(x, y, sel = []) {
      aw.setLocalState({ user: { id: 'peer', name: 'Peer', color: '#c0392b' }, canvas: { cursor: { x, y }, selection: sel } });
      socket.send(encodeAwareness(encodeAwarenessUpdate(aw, [aw.clientID])));
    },
  };
}

export async function run(n: number): Promise<ViewBenchResult> {
  instrument();
  const mark = window.__mark;
  const relay = new MockRelay();
  populate(relay, n);
  await mark('gc:doc-only');
  const t0 = performance.now();
  const m = await mountView(relay);
  const { host, canvas, mine, commits } = m;
  await mark('gc:mounted');
  const mountToFirstPaintMs = performance.now() - t0 - 1500;

  const phases: Record<string, Phase> = {};
  const phase = async (name: string, body: () => Promise<void>): Promise<void> => {
    const c0 = { ...counters };
    const k0 = commits.n;
    const s0 = tally(mine);
    const sites0 = new Map(siteCounts);
    const t = performance.now();
    await mark(`${name}-start`);
    await body();
    await mark(`${name}-end`);
    phases[name] = {
      seconds: Math.round((performance.now() - t) / 100) / 10,
      rafCalls: counters.raf - c0.raf,
      timersScheduled: counters.scheduled - c0.scheduled,
      timerFires: counters.fires - c0.fires,
      reactCommits: commits.n - k0,
      ...(trackSites()
        ? { timerSites: [...siteCounts].map(([k, v]) => [k, v - (sites0.get(k) ?? 0)] as const).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${v}× ${k}`) }
        : {}),
      sent: diff(s0, tally(mine)),
    };
  };

  // ---- idle: an open canvas nobody touches
  await phase('idle', () => sleep(10_000));
  const liveTimers = liveSummary();

  // ---- select one object (click on the first sticky at the default camera)
  const rect = canvas.getBoundingClientRect();
  const cx = rect.left + 600;
  const cy = rect.top + 400;
  canvas.focus();
  pointer(canvas, 'pointerdown', cx - 560, cy - 360);
  pointer(canvas, 'pointerup', cx - 560, cy - 360);
  await sleep(200);
  const panelShownAfterClick = host.querySelector('[data-testid="canvas-props"]') !== null;

  // ---- hidden window
  setHidden(true);
  await sleep(300);
  await phase('hiddenIdle', () => sleep(5000));
  const liveTimersHidden = liveSummary();
  const peer = makePeer(relay);
  await sleep(300);
  await phase('hiddenBusy', async () => {
    for (let i = 0; i < 150; i++) {
      peer.cursor(100 + i * 3, 100 + i, ['o3']);
      if (i % 5 === 0) peer.doc.patchMany(new Map([['o1', { x: 200 + i }]]));
      pointer(canvas, 'pointermove', cx - 300 + i, cy - 200); // our own cursor
      await sleep(20);
    }
  });
  const awBefore = tally(mine).awareness;
  setHidden(false);
  await sleep(500);
  const resumedAfterHidden = tally(mine).awareness > awBefore;

  // ---- a peer's cursor stream, visible, with one of our objects selected
  const commitsBeforeJoin = commits.n;
  peer.cursor(10, 10);
  await sleep(500);
  const peerJoin = commits.n - commitsBeforeJoin;
  await phase('cursors', async () => {
    for (let i = 0; i < 250; i++) {
      peer.cursor(100 + (i * 7) % 900, 100 + (i * 5) % 500, i % 10 === 0 ? ['o2'] : []);
      await sleep(20);
    }
  });

  // ---- a peer edits visible objects (a real UPDATE frame through the relay)
  await phase('peerEdits', async () => {
    for (let i = 0; i < 150; i++) {
      peer.doc.patchMany(new Map([[`o${1 + (i % 3)}`, { x: 200 * (1 + (i % 3)) + (i % 7), y: (i % 5) }]]));
      await sleep(33);
    }
  });

  // ---- continuous drag (3 s, ~60 moves/s) with a peer present, then the quiet after it (idle snapshot)
  // The camera sits at fit-all (a few %): select the first sticky and zoom to it, so the drag grabs it at the centre.
  canvas.focus();
  canvas.dispatchEvent(new KeyboardEvent('keydown', { key: '@', code: 'Digit2', shiftKey: true, bubbles: true, cancelable: true }));
  await sleep(700);
  await phase('drag', async () => {
    const x0 = rect.left + rect.width / 2;
    const y0 = rect.top + rect.height / 2;
    pointer(canvas, 'pointerdown', x0, y0);
    for (let i = 1; i <= 180; i++) {
      pointer(canvas, 'pointermove', x0 + Math.sin(i / 20) * 120, y0 + i * 0.5);
      await sleep(16);
    }
    pointer(canvas, 'pointerup', x0, y0 + 90);
    await sleep(4000); // 200 ms batch, 3 s idle snapshot
  });
  const burst = async (fn: () => void | Promise<void>): Promise<number> => {
    const before = commits.n;
    await fn();
    await sleep(400);
    return commits.n - before;
  };
  const startX = relay.doc.getMap<Y.Map<unknown>>('objects').get('o0')?.get('x');
  const dragSelected = await burst(() => {
    pointer(canvas, 'pointerdown', cx - 540, cy - 340);
    for (let i = 1; i <= 40; i++) pointer(canvas, 'pointermove', cx - 540 + i * 3, cy - 340 + i * 2);
    pointer(canvas, 'pointerup', cx - 420, cy - 260);
  });
  const remote = new Y.Doc();
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(relay.doc));
  const rdoc = new CanvasDoc(remote);
  remote.on('update', (u: Uint8Array) => peer.socket.send(encodeUpdate(u)));
  const remoteEditOther = await burst(() => {
    for (let i = 0; i < 30; i++) rdoc.patchMany(new Map([[`o${n - 1 - i}`, { x: 100000 + i }]]));
  });
  const remoteEditSelected = await burst(() => {
    for (let i = 0; i < 30; i++) rdoc.patchMany(new Map([['o0', { x: 50 + i, y: 40 }]]));
  });
  const wheelPan = await burst(() => {
    for (let i = 0; i < 60; i++) canvas.dispatchEvent(new WheelEvent('wheel', { deltaX: 8, deltaY: 5, bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
  });
  const zoomLabel = (): string => host.querySelector('[data-testid="canvas-zoom-pct"]')?.textContent ?? '';
  const zoomBefore = zoomLabel();
  const zoomClicks = await burst(() => {
    (host.querySelector('[data-testid="canvas-zoom-in"]') as HTMLElement | null)?.click();
  });

  const checks = {
    panelShownAfterClick,
    zoomBefore,
    zoomAfter: zoomLabel(),
    objectMoved: relay.doc.getMap<Y.Map<unknown>>('objects').get('o0')?.get('x') !== startX,
    peerSeen: host.querySelector('[data-testid="canvas-presence-user"]') !== null,
    resumedAfterHidden,
  };
  m.unmount();
  await sleep(300);
  const teardown = { socketsOpen: relay.size, liveTimersAfterUnmount: live.size };
  peer.socket.close();
  peer.ydoc.destroy();

  // ---- pastes into a small canvas (independent of N)
  const paste: ViewBenchResult['paste'] = [];
  for (const count of [500, 1500]) {
    const r2 = new MockRelay();
    populate(r2, 50);
    const objs = Array.from({ length: count }, (_, i) => ({
      id: `p${i}`, kind: 'sticky', z: '', x: 20 + (i % 50) * 190, y: 20 + Math.floor(i / 50) * 190, w: 160, h: 160, color: 'yellow', text: `pasted note number ${i} with some words`,
    }));
    const text = CLIPBOARD_PREFIX + JSON.stringify({ v: 1, objects: objs });
    const m2 = await mountView(r2, () => text);
    m2.canvas.focus();
    const s0 = tally(m2.mine);
    m2.canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, metaKey: true, bubbles: true, cancelable: true }));
    await sleep(1500);
    const d = diff(s0, tally(m2.mine));
    paste.push({
      objects: count, updateFrames: d.update, updateBytes: d.updateBytes, snapshotPosts: d.snapshotPost, snapshotPostBytes: d.snapshotPostBytes,
      maxFrame: d.maxFrame, settledObjects: r2.doc.getMap('objects').size - 50,
    });
    m2.unmount();
    await sleep(200);
  }

  return {
    objects: n,
    mountToFirstPaintMs: Math.round(mountToFirstPaintMs * 10) / 10,
    liveTimers,
    liveTimersHidden,
    phases,
    checks,
    commits: { peerJoin, wheelPan, dragSelected, remoteEditOther, remoteEditSelected, zoomClicks },
    paste,
    teardown,
  };
}

(window as unknown as { __viewBench: { run: typeof run } }).__viewBench = { run };

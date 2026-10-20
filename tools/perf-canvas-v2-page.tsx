/**
 * Browser side of `tools/perf-canvas-view.ts --page v2` (V6, docs/14-energy.md «Холст, вторая итерация»): the real
 * `CanvasView` against the in-memory relay with the second iteration's objects (rotated, grouped, formatted, new
 * shapes — `populateV2`) and its features switched on one by one. Every phase is bracketed by `__mark` (the driver
 * adds CPU); counts are rAF calls, timers scheduled / fired by the app (the bench's own waits are not counted),
 * React commits and the components that rendered (`perf-react-who`), frames we sent, mini-map redraws.
 *
 * Idle (10 s each): plain · mini-map open · timer running / paused / hidden · vote open · 200 comment pins with the
 * panel open · following a still participant · everything at once in a hidden window.
 * Bursts (React, traffic): a peer's edit, vote, comment, reply, followed camera; the timer's tick; our rotation
 * gesture, formatted typing, pan with a peer (awareness `view`), vote and timer commands, a template; the public
 * link's anonymous viewer. Exposed as `window.__v2Bench`.
 */
import { who, type Who } from './perf-react-who';
import { create } from '@bufbuild/protobuf';
import * as Y from 'yjs';
// From the app's own dependency (tools/ has no link to the workspace package).
import { CanvasCommentSchema, type CanvasComment } from '../apps/desktop/node_modules/@calaba/protocol';
import { populateV2 } from './perf-canvas-page';
import { counters, instrument, liveSummary, makePeer, mountView, pointer, setHidden, tally, diff, type Mounted, type Sent } from './perf-canvas-view-page';
import type { CanvasSession } from '../apps/desktop/src/renderer/features/canvas/view/session';
import { drawMinimap, minimapPref } from '../apps/desktop/src/renderer/features/canvas/view/minimapDraw';
import { RotateGesture } from '../apps/desktop/src/renderer/features/canvas/engine/gestures';
import { ROTATE_OFFSET_PX } from '../apps/desktop/src/renderer/features/canvas/engine/overlay';
import { defaultPalette } from '../apps/desktop/src/renderer/features/canvas/engine/palette';
import { CanvasDoc } from '../apps/desktop/src/renderer/lib/canvas/doc';
import { rotateHandlePoint } from '../apps/desktop/src/renderer/lib/canvas/geometry';
import { MAP_H, MAP_W, mapFrame } from '../apps/desktop/src/renderer/lib/canvas/minimap';
import { pauseTimer, resetTimer, resumeTimer, startTimer } from '../apps/desktop/src/renderer/lib/canvas/timer';
import { VoteBook } from '../apps/desktop/src/renderer/lib/canvas/votes';
import { MockRelay } from '../apps/desktop/src/renderer/lib/ySyncMock';
import { useCanvasComments } from '../apps/desktop/src/renderer/stores/canvasComments';

declare global {
  interface Window {
    __mark(name: string): Promise<void>;
  }
}

// The bench's own waits use the clock from before `instrument()`: they are not counted as the app's timers.
const to0 = window.setTimeout.bind(window);
const nap = (ms: number): Promise<void> => new Promise((r) => to0(r, ms));

// Mini-map redraws: each starts with one clearRect on the mini-map's canvas (minimapDraw.ts).
const mm = { draws: 0 };
const clear0 = CanvasRenderingContext2D.prototype.clearRect;
CanvasRenderingContext2D.prototype.clearRect = function clearRect(this: CanvasRenderingContext2D, ...a: [number, number, number, number]) {
  if ((this.canvas as HTMLCanvasElement).dataset?.['testid'] === 'canvas-minimap') mm.draws++;
  return clear0.apply(this, a);
};

export interface V2Phase {
  seconds: number;
  rafCalls: number;
  timersScheduled: number;
  timerFires: number;
  reactCommits: number;
  /** Components that rendered in the phase, by count (top 8). */
  renders: string[];
  minimapDraws: number;
  /** Running CSS / Web animations at the end of the phase (an endless one repaints every frame without any JS). */
  animations: string[];
  /** What had the keyboard focus (a focused field blinks its caret: a repaint twice a second). */
  focus: string;
  sent: Sent;
}

export interface V2Result {
  objects: number;
  stateBytes: number;
  mountToFirstPaintMs: number;
  liveTimers: ReturnType<typeof liveSummary>;
  liveTimersHiddenAll: ReturnType<typeof liveSummary>;
  phases: Record<string, V2Phase>;
  /** One mini-map redraw of the whole scene (ms, 20 draws). */
  minimapDrawMs: { p50: number; max: number };
  /** Our template insert: frames, bytes. */
  checks: Record<string, unknown>;
  publicViewer: { framesSent: number; bytesSent: number; socketsOpen: number; liveTimers: ReturnType<typeof liveSummary> };
}

const top = (w: Who): string[] =>
  Object.entries(w.renders)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([k, v]) => `${v}× ${k}`);

/** The open view's session (engine, sync, timer), read from the React tree: the bench has no other handle on it. */
function sessionOf(host: HTMLElement): CanvasSession {
  const el = host.querySelector('[data-testid="canvas-view"]') as unknown as Record<string, unknown> | null;
  const key = el && Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
  type Fib = { memoizedProps?: { session?: CanvasSession } | null; child: Fib | null; sibling: Fib | null };
  const stack: Fib[] = key ? [el[key] as Fib] : [];
  while (stack.length) {
    const f = stack.pop() as Fib;
    const s = f.memoizedProps?.session;
    if (s?.engine) return s;
    if (f.sibling) stack.push(f.sibling);
    if (f.child) stack.push(f.child);
  }
  throw new Error('no session in the view');
}

function comment(i: number, root: string | null, objectId: string): CanvasComment {
  return create(CanvasCommentSchema, {
    id: `cm${i}`,
    canvasId: 'bench',
    objectId: root ? '' : objectId,
    x: objectId ? 20 : (i % 40) * 500,
    y: objectId ? 10 : Math.floor(i / 40) * 500,
    authorId: i % 2 ? 'peer' : 'me',
    parentId: root ?? '',
    body: `comment ${i} about this note`,
  });
}

export async function run(n: number): Promise<V2Result> {
  instrument();
  const mark = window.__mark;
  const relay = new MockRelay();
  const cdoc = new CanvasDoc(relay.doc);
  if ((window as unknown as { __v2Plain?: boolean }).__v2Plain) {
    // `--plain`: the H9 screen bench's content (short stickies) on this page, to tell the content from the page.
    const items = Array.from({ length: n }, (_, i) => ({ id: `b${i}`, init: { kind: 'sticky' as const, x: (i % 100) * 200, y: Math.floor(i / 100) * 200, text: `note ${i}` } }));
    for (let i = 0; i < items.length; i += 500) cdoc.createMany(items.slice(i, i + 500));
  } else populateV2(cdoc, n);
  cdoc.ensureSchema();
  const stateBytes = Y.encodeStateAsUpdate(relay.doc).length;
  await mark('gc:doc-only');
  const t0 = performance.now();
  const m: Mounted = await mountView(relay);
  const { host, canvas, mine, commits } = m;
  await mark('gc:mounted');
  const mountToFirstPaintMs = performance.now() - t0 - 1500;
  const s = sessionOf(host);
  const { engine } = s;
  const rect = canvas.getBoundingClientRect();
  const peer = makePeer(relay);
  peer.cursor(10, 10);
  await nap(600);

  const phases: Record<string, V2Phase> = {};
  const phase = async (name: string, body: () => Promise<void>): Promise<void> => {
    const c0 = { ...counters };
    const k0 = commits.n;
    const s0 = tally(mine);
    const d0 = mm.draws;
    const t = performance.now();
    await mark(`${name}-start`);
    who.start();
    await body();
    const w = who.stop();
    await mark(`${name}-end`);
    phases[name] = {
      seconds: Math.round((performance.now() - t) / 100) / 10,
      rafCalls: counters.raf - c0.raf,
      timersScheduled: counters.scheduled - c0.scheduled,
      timerFires: counters.fires - c0.fires,
      reactCommits: commits.n - k0,
      renders: top(w),
      minimapDraws: mm.draws - d0,
      animations: document.getAnimations().map((a) => `${(a as CSSAnimation).animationName ?? a.constructor.name} on ${((a.effect as KeyframeEffect | null)?.target as HTMLElement | null)?.dataset?.['testid'] ?? ((a.effect as KeyframeEffect | null)?.target as HTMLElement | null)?.className?.toString().slice(0, 60) ?? '?'}`),
      focus: (() => {
        const el = document.activeElement as HTMLElement | null;
        return el ? `${el.tagName.toLowerCase()}${el.dataset['testid'] ? `[${el.dataset['testid']}]` : ''}` : '';
      })(),
      sent: diff(s0, tally(mine)),
    };
  };
  const wheelPan = async (events: number, every: number): Promise<void> => {
    for (let i = 0; i < events; i++) {
      canvas.dispatchEvent(new WheelEvent('wheel', { deltaX: 8, deltaY: 5, bubbles: true, cancelable: true, clientX: rect.left + 600, clientY: rect.top + 400 }));
      await nap(every);
    }
  };
  /** Objects on screen now (peer edits and votes go there, so they would be drawn). */
  const onScreen = (k: number): string[] => {
    const v = engine.visibleWorld();
    return engine.scene.query(v).filter((o) => (o.kind === 'sticky' || o.kind === 'shape') && o.x > v.x && o.y > v.y && o.x + o.w < v.x + v.w && o.y + o.h < v.y + v.h).slice(0, k).map((o) => o.id);
  };
  const peerEdits = async (seconds: number, ids: string[]): Promise<void> => {
    for (let i = 0; i < seconds * 30; i++) {
      const id = ids[i % ids.length] ?? 'b1';
      const o = engine.scene.get(id);
      peer.doc.patchMany(new Map([[id, { x: (o?.x ?? 0) + (i % 2 ? 2 : -2) }]]));
      await nap(33);
    }
  };

  // A readable camera: 100 % on the middle of the content (set directly: zoomTo / centerOn animate and cancel each other).
  const at100 = (x: number, y: number): void => engine.setCamera({ scale: 1, tx: engine.viewport.w / 2 - x, ty: engine.viewport.h / 2 - y });
  at100(5000, 1000);
  await nap(500);
  const onScreenAt100 = onScreen(100).length;

  // ---- idle with each feature
  await phase('idle', () => nap(10_000));
  await mark('gc:idle'); // memory once the opening (first paint, caches) has settled
  if ((window as unknown as { __v2Diag?: string }).__v2Diag === 'timer') {
    // Diagnosis: a running timer's cost alone (a peer started it), then paused.
    const meta = peer.ydoc.getMap<unknown>('meta');
    startTimer(meta, 10, 'peer', Date.now());
    await nap(1500);
    for (const k of [1, 2, 3]) await phase(`diagTimer${k}`, () => nap(10_000));
    pauseTimer(meta, 'peer', Date.now());
    await nap(500);
    await phase('diagPaused', () => nap(10_000));
    const liveTimers = liveSummary();
    return { objects: n, stateBytes, mountToFirstPaintMs: 0, liveTimers, liveTimersHiddenAll: liveTimers, phases, minimapDrawMs: { p50: 0, max: 0 }, checks: {}, publicViewer: { framesSent: 0, bytesSent: 0, socketsOpen: 0, liveTimers } };
  }
  if ((window as unknown as { __v2Diag?: string }).__v2Diag === 'minimap') {
    // Diagnosis: the mini-map opened on a canvas that did nothing else before, idle windows one after another.
    minimapPref.set(true);
    for (const k of [1, 2, 3]) await phase(`diagMinimap${k}`, () => nap(10_000));
    minimapPref.set(false);
    await phase('diagClosed', () => nap(10_000));
    const liveTimers = liveSummary();
    return { objects: n, stateBytes, mountToFirstPaintMs: 0, liveTimers, liveTimersHiddenAll: liveTimers, phases, minimapDrawMs: { p50: 0, max: 0 }, checks: {}, publicViewer: { framesSent: 0, bytesSent: 0, socketsOpen: 0, liveTimers } };
  }
  // Controls for the feature phases below: the same pan and peer edits with nothing extra open.
  await phase('pan', () => wheelPan(180, 16));
  await phase('peerEdits', () => peerEdits(3, onScreen(5)));
  const liveTimers = liveSummary();

  minimapPref.set(true);
  await nap(1000);
  await phase('idleMinimap', () => nap(10_000));
  // The second 10 s: what is left once the work around opening it (first paint, GC) is surely over.
  await phase('idleMinimap2', () => nap(10_000));
  await phase('minimapPan', () => wheelPan(180, 16));
  await phase('minimapPeerEdits', () => peerEdits(3, onScreen(5)));
  const scratch = document.createElement('canvas');
  scratch.width = MAP_W;
  scratch.height = MAP_H;
  const sctx = scratch.getContext('2d') as CanvasRenderingContext2D;
  const mmTimes: number[] = [];
  for (let k = 0; k < 20; k++) {
    const t = performance.now();
    drawMinimap(sctx, engine.scene, defaultPalette('dark'), mapFrame(engine.scene.bounds(), engine.visibleWorld()), engine.visibleWorld(), 1);
    sctx.getImageData(0, 0, 1, 1);
    mmTimes.push(performance.now() - t);
  }
  mmTimes.sort((a, b) => a - b);
  minimapPref.set(false);
  await nap(500);

  const pmeta = peer.ydoc.getMap<unknown>('meta');
  startTimer(pmeta, 5, 'peer', Date.now());
  await nap(1500);
  await phase('timerRunning', () => nap(10_000));
  await phase('timerRunning2', () => nap(10_000));
  pauseTimer(pmeta, 'peer', Date.now());
  await nap(500);
  await phase('timerPaused', () => nap(5000));
  resumeTimer(pmeta, 'peer', Date.now());
  await nap(500);
  setHidden(true);
  await nap(300);
  await phase('timerHidden', () => nap(5000));
  setHidden(false);
  await nap(1500);
  await phase('timerTicks', () => nap(3000));
  resetTimer(pmeta);
  await nap(500);

  const pvotes = new VoteBook(peer.ydoc, 'peer', () => true);
  pvotes.start(5);
  await nap(500);
  const voteSeen = { phase: engine.getState().votePhase, canVote: engine.getState().canVote, cast: [] as boolean[] };
  await phase('voteOpen', () => nap(10_000));
  await phase('peerVotes', async () => {
    for (const id of onScreen(5)) {
      pvotes.add(id, 1);
      await nap(100);
    }
    await nap(400);
  });
  await phase('myVotes', async () => {
    for (const id of onScreen(3)) {
      voteSeen.cast.push(engine.castVote(id, 1));
      await nap(100);
    }
    await nap(400);
  });
  pvotes.finish();
  await nap(500);
  await phase('voteClosedIdle', () => nap(3000));
  pvotes.reset();
  await nap(500);

  // 200 threads: 150 pinned to objects (on screen and off), 50 on the field; the panel open.
  const pinned = engine.scene.all().filter((o) => o.kind !== 'connector').map((o) => o.id);
  const shown = onScreen(40);
  const list: CanvasComment[] = [];
  for (let i = 0; i < 200; i++) list.push(comment(i, null, i < 150 ? (i < 40 ? (shown[i] ?? 'b1') : (pinned[(i * 13) % pinned.length] ?? 'b1')) : ''));
  for (let i = 0; i < 100; i++) list.push(comment(1000 + i, `cm${i}`, ''));
  useCanvasComments.getState().setCanvas('bench', list);
  useCanvasComments.getState().setPanel(true);
  await nap(1000);
  await phase('idleComments', () => nap(10_000));
  await phase('idleComments2', () => nap(10_000));
  await phase('peerComment', async () => {
    useCanvasComments.getState().upsert(comment(500, null, shown[0] ?? 'b1'));
    await nap(400);
  });
  await phase('peerReply', async () => {
    useCanvasComments.getState().upsert(comment(501, 'cm5', ''));
    await nap(400);
  });
  await phase('pinsPeerEdits', () => peerEdits(3, shown.slice(0, 5)));
  await phase('pinsPan', () => wheelPan(180, 16));
  // Which of the two costs: the pins without the panel, then the panel (all threads resolved: no pins) alone.
  useCanvasComments.getState().setPanel(false);
  await nap(500);
  await phase('pinsOnlyPeerEdits', () => peerEdits(3, shown.slice(0, 5)));
  await phase('pinsOnlyPan', () => wheelPan(180, 16));
  useCanvasComments.getState().setCanvas('bench', list.map((x) => ({ ...x, resolved: true })));
  useCanvasComments.getState().setPanel(true);
  await nap(500);
  const pinsLeft = host.querySelectorAll('[data-testid="canvas-comment-pin"]').length;
  await phase('panelOnlyPeerEdits', () => peerEdits(3, shown.slice(0, 5)));
  await phase('panelOnlyPan', () => wheelPan(180, 16));

  // Following a peer: still, then moving its view 5/s (as its client sends it).
  const c = engine.visibleWorld();
  const view = { x: c.x + c.w / 2, y: c.y + c.h / 2, zoom: 1 };
  peer.cursor(view.x, view.y, [], view);
  await nap(300);
  engine.follow('peer');
  await nap(800);
  const following = engine.followKey === 'peer';
  await phase('followIdle', () => nap(10_000));
  await phase('followMoving', async () => {
    for (let i = 1; i <= 25; i++) {
      peer.cursor(view.x + i * 40, view.y, [], { ...view, x: view.x + i * 40 });
      await nap(200);
    }
  });

  // Everything at once, then the window hidden: the mini-map, a running timer, an open vote, pins + panel, following.
  minimapPref.set(true);
  startTimer(pmeta, 5, 'peer', Date.now());
  pvotes.start(5);
  await nap(1500);
  setHidden(true);
  await nap(300);
  await phase('hiddenAll', async () => {
    for (let i = 0; i < 10; i++) {
      peer.cursor(view.x - i * 40, view.y, [], { ...view, x: view.x - i * 40 });
      await nap(1000);
    }
  });
  const liveTimersHiddenAll = liveSummary();
  setHidden(false);
  await nap(1500);
  engine.follow(null);
  minimapPref.set(false);
  resetTimer(pmeta);
  pvotes.reset();
  useCanvasComments.getState().setPanel(false);
  useCanvasComments.getState().setCanvas('bench', []);
  await nap(800);

  // ---- our traffic
  const target = 'b10';
  const tobj = engine.scene.get(target);
  if (tobj) at100(tobj.x + tobj.w / 2, tobj.y + tobj.h / 2);
  engine.setSelection([target]);
  await nap(600);
  const toScreen = (p: { x: number; y: number }): { x: number; y: number } => ({ x: rect.left + p.x * engine.camera.scale + engine.camera.tx, y: rect.top + p.y * engine.camera.scale + engine.camera.ty });
  let rotated = false;
  await phase('rotateGesture', async () => {
    const f = engine.selectionFrame();
    if (!f) return;
    const h = toScreen(rotateHandlePoint(f.rect, f.rot, engine.px(ROTATE_OFFSET_PX)));
    const pv = toScreen({ x: f.rect.x + f.rect.w / 2, y: f.rect.y + f.rect.h / 2 });
    const r0 = Math.hypot(h.x - pv.x, h.y - pv.y);
    const a0 = Math.atan2(h.y - pv.y, h.x - pv.x);
    const before = engine.scene.get(target)?.rot ?? 0;
    pointer(canvas, 'pointerdown', h.x, h.y);
    for (let i = 1; i <= 180; i++) {
      const a = a0 + (i * Math.PI) / 180;
      pointer(canvas, 'pointermove', pv.x + r0 * Math.cos(a), pv.y + r0 * Math.sin(a));
      await nap(16);
    }
    pointer(canvas, 'pointerup', pv.x + r0 * Math.cos(a0 + Math.PI), pv.y + r0 * Math.sin(a0 + Math.PI));
    rotated = (engine.scene.get(target)?.rot ?? 0) !== before;
    await nap(1000);
  });
  // A big selection turned by the same gesture (the engine's own, 60 moves/s for 2 s): what the sync sends per second.
  await phase('rotate200', async () => {
    const ids = engine.expandUnits(engine.scene.all().filter((o) => o.kind !== 'connector').slice(0, 200).map((o) => o.id));
    const b = engine.scene.bounds(new Set(ids));
    if (!b) return;
    const pv0 = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    const g = new RotateGesture(engine, ids, { x: pv0.x + 300, y: pv0.y });
    for (let i = 1; i <= 120; i++) {
      const a = (i * Math.PI) / 360;
      g.move({ x: pv0.x + 300 * Math.cos(a), y: pv0.y + 300 * Math.sin(a) }, { x: 0, y: 0 }, { shift: false, alt: false, mod: false });
      await nap(16);
    }
    g.end();
    await nap(1000);
  });
  let typed = false;
  await phase('richTyping', async () => {
    if (!engine.startTextEdit(target)) return;
    await nap(100);
    const ta = host.querySelector('textarea');
    if (!ta) return;
    ta.focus();
    const key = (k: string): void => void ta.dispatchEvent(new KeyboardEvent('keydown', { key: k, metaKey: true, ctrlKey: true, bubbles: true, cancelable: true }));
    ta.setSelectionRange(ta.value.length, ta.value.length);
    key('b');
    const words = ' и ещё немного текста жирным';
    for (let i = 0; i < 60; i++) {
      if (i === 30) key('i');
      const ch = words[i % words.length] ?? ' ';
      const at = ta.selectionStart;
      ta.value = ta.value.slice(0, at) + ch + ta.value.slice(ta.selectionEnd);
      ta.setSelectionRange(at + 1, at + 1);
      ta.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
      await nap(50);
    }
    typed = true;
    await nap(500);
  });
  await phase('richCommit', async () => {
    engine.editor.commit();
    await nap(1000);
  });
  await phase('panAwareness', () => wheelPan(60, 50));
  await phase('afterPanIdle', () => nap(3000));
  await phase('voteCommands', async () => {
    engine.startVote(5);
    for (const id of onScreen(5)) {
      engine.castVote(id, 1);
      await nap(100);
    }
    engine.finishVote();
    await nap(300);
    engine.resetVote();
    await nap(800);
  });
  await phase('timerCommands', async () => {
    await s.timer.start(5);
    await nap(1000);
    s.timer.pause();
    await nap(300);
    s.timer.reset();
    await nap(800);
  });
  let templateObjects = 0;
  await phase('template', async () => {
    templateObjects = engine.insertTemplate('kanban', (k) => `Заметка ${k}`).length;
    await nap(1000);
  });

  const checks = {
    following,
    voteSeen,
    onScreenAt100,
    pinsLeft,
    rotated,
    typed,
    templateObjects,
    commitsTotal: commits.n,
    minimapDrawsTotal: mm.draws,
  };
  m.unmount();
  peer.socket.close();
  peer.ydoc.destroy();
  await nap(300);

  // ---- the public link's viewer: an anonymous receive-only socket; it must send nothing at all
  const r3 = new MockRelay();
  populateV2(new CanvasDoc(r3.doc), 300);
  const pv = await mountView(r3, undefined, { publicCode: 'bench-code' }, { viewer: true });
  const pc = pv.canvas.getBoundingClientRect();
  for (let i = 0; i < 60; i++) {
    pointer(pv.canvas, 'pointermove', pc.left + 300 + i * 5, pc.top + 300);
    pv.canvas.dispatchEvent(new WheelEvent('wheel', { deltaX: 8, deltaY: 5, bubbles: true, cancelable: true, clientX: pc.left + 600, clientY: pc.top + 400 }));
    await nap(50);
  }
  await nap(2000);
  const sentAll = pv.mine.reduce((a, sk) => a + sk.sent.length, 0);
  const bytesAll = pv.mine.reduce((a, sk) => a + sk.sent.reduce((b, d) => b + (typeof d === 'string' ? d.length : d.length), 0), 0);
  const pubTimers = liveSummary();
  const publicViewer = { framesSent: sentAll, bytesSent: bytesAll, socketsOpen: r3.size, liveTimers: pubTimers };
  pv.unmount();

  return {
    objects: n,
    stateBytes,
    mountToFirstPaintMs: Math.round(mountToFirstPaintMs * 10) / 10,
    liveTimers,
    liveTimersHiddenAll,
    phases,
    minimapDrawMs: { p50: Math.round((mmTimes[10] ?? 0) * 100) / 100, max: Math.round((mmTimes[19] ?? 0) * 100) / 100 },
    checks,
    publicViewer,
  };
}

(window as unknown as { __v2Bench: { run: typeof run } }).__v2Bench = { run };

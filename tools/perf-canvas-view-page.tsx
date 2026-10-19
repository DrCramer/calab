/**
 * Browser side of tools/perf-canvas-view.ts: mounts the real `CanvasView` (React + engine + panels) against
 * the in-memory relay with N objects and measures what a user's machine pays for the screen around the
 * engine — idle (no frames, no timers), React commits during pan / zoom / drag / remote edits, and teardown.
 * Exposed as `window.__viewBench`.
 */
import { createElement, Profiler } from 'react';
import { createRoot } from 'react-dom/client';
import * as Y from 'yjs';
import { CanvasView } from '../apps/desktop/src/renderer/features/canvas/view';
import { CanvasDoc } from '../apps/desktop/src/renderer/lib/canvas/doc';
import type { ObjectInit } from '../apps/desktop/src/renderer/lib/canvas/types';
import { MockRelay } from '../apps/desktop/src/renderer/lib/ySyncMock';

export interface ViewBenchResult {
  objects: number;
  mountToFirstPaintMs: number;
  idle: { seconds: number; rafCalls: number; timeoutCalls: number; intervalCalls: number; reactCommits: number; timeoutSites: string[] };
  /** Sanity of the controls: the clicked sticky got selected (panel shown), the zoom label changed. */
  checks: { panelShownAfterClick: boolean; zoomBefore: string; zoomAfter: string; objectMoved: boolean };
  /** React commits caused by each burst. Expected: 0 for pan and foreign edits; the drag's 1 is the undo button enabling; zoom updates the percentage leaf. */
  commits: { wheelPan: number; dragSelected: number; remoteEditOther: number; remoteEditSelected: number; zoomClicks: number };
  teardown: { socketsOpen: number };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function populate(relay: MockRelay, n: number): void {
  const cdoc = new CanvasDoc(relay.doc);
  const items: { id: string; init: ObjectInit }[] = [];
  for (let i = 0; i < n; i++) items.push({ id: `o${i}`, init: { kind: 'sticky', x: (i % 100) * 200, y: Math.floor(i / 100) * 200, text: `note ${i}` } });
  cdoc.createMany(items);
}

function pointer(canvas: HTMLElement, type: string, x: number, y: number): void {
  const e = new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: 'mouse' });
  canvas.dispatchEvent(e);
}

export async function run(n: number): Promise<ViewBenchResult> {
  const relay = new MockRelay();
  populate(relay, n);
  const host = document.getElementById('app') as HTMLElement;
  const root = createRoot(host);
  const commits = { n: 0 };
  const t0 = performance.now();
  root.render(
    createElement(Profiler, { id: 'v', onRender: () => void commits.n++ },
      createElement(CanvasView, {
        canvasId: 'bench', workspaceId: 'w', bits: (1n << 41n) | (1n << 42n), // CANVAS_BITS.VIEW | WRITE onOpenHistory: () => undefined, onShare: () => undefined,
        deps: { serverUrl: () => 'https://bench.test', getToken: () => Promise.resolve('t'), createSocket: relay.socketFactory({ canWrite: true }), user: () => ({ id: 'me', name: 'Me' }) },
      })),
  );
  await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  const mountToFirstPaintMs = performance.now() - t0;
  await sleep(1500); // sync settles, the first snapshot is applied
  const canvas = host.querySelector('canvas') as HTMLCanvasElement;

  // Idle: no frames, no timers, no React commits.
  const counts = { raf: 0, to: 0, iv: 0 };
  const sites: string[] = [];
  const raf0 = window.requestAnimationFrame.bind(window);
  const to0 = window.setTimeout.bind(window);
  const iv0 = window.setInterval.bind(window);
  window.requestAnimationFrame = ((cb: FrameRequestCallback) => { counts.raf++; return raf0(cb); }) as typeof window.requestAnimationFrame;
  window.setTimeout = ((...a: Parameters<typeof setTimeout>) => { counts.to++; sites.push((new Error().stack ?? '').split('\n').slice(2, 5).join(' | ')); return to0(...a); }) as typeof window.setTimeout;
  window.setInterval = ((...a: Parameters<typeof setInterval>) => { counts.iv++; return iv0(...a); }) as typeof window.setInterval;
  const idleStart = commits.n;
  await sleep(3000);
  const idle = { seconds: 3, rafCalls: counts.raf, timeoutCalls: counts.to, intervalCalls: counts.iv, reactCommits: commits.n - idleStart, timeoutSites: sites };
  window.requestAnimationFrame = raf0;
  window.setTimeout = to0;
  window.setInterval = iv0;

  const burst = async (fn: () => void | Promise<void>): Promise<number> => {
    const before = commits.n;
    await fn();
    await sleep(400);
    return commits.n - before;
  };
  const rect = canvas.getBoundingClientRect();
  const cx = rect.left + 600;
  const cy = rect.top + 400;

  // Select one object (click on the first sticky at the default camera), then measure.
  canvas.focus();
  pointer(canvas, 'pointerdown', cx - 560, cy - 360);
  pointer(canvas, 'pointerup', cx - 560, cy - 360);
  await sleep(200);
  const panelShownAfterClick = host.querySelector('[data-testid="canvas-props"]') !== null;
  const startX = relay.doc.getMap<Y.Map<unknown>>('objects').get('o0')?.get('x');

  const dragSelected = await burst(() => {
    pointer(canvas, 'pointerdown', cx - 540, cy - 340);
    for (let i = 1; i <= 40; i++) pointer(canvas, 'pointermove', cx - 540 + i * 3, cy - 340 + i * 2);
    pointer(canvas, 'pointerup', cx - 420, cy - 260);
  });
  const remote = new Y.Doc();
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(relay.doc));
  const rdoc = new CanvasDoc(remote);
  const applyRemote = (): void => Y.applyUpdate(relay.doc, Y.encodeStateAsUpdate(remote));
  const remoteEditOther = await burst(() => {
    for (let i = 0; i < 30; i++) rdoc.patchMany(new Map([[`o${n - 1 - i}`, { x: 100000 + i }]]));
    applyRemote();
  });
  const remoteEditSelected = await burst(() => {
    for (let i = 0; i < 30; i++) rdoc.patchMany(new Map([['o0', { x: 50 + i, y: 40 }]]));
    applyRemote();
  });
  const wheelPan = await burst(() => {
    for (let i = 0; i < 60; i++) canvas.dispatchEvent(new WheelEvent('wheel', { deltaX: 8, deltaY: 5, bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
  });
  const zoomLabel = (): string => host.querySelector('[data-testid="canvas-zoom-pct"]')?.textContent ?? '';
  const zoomBefore = zoomLabel();
  const zoomClicks = await burst(() => {
    (host.querySelector('[data-testid="canvas-zoom-in"]') as HTMLElement | null)?.click();
  });

  const checks = { panelShownAfterClick, zoomBefore, zoomAfter: zoomLabel(), objectMoved: relay.doc.getMap<Y.Map<unknown>>('objects').get('o0')?.get('x') !== startX };
  root.unmount();
  await sleep(100);
  return {
    objects: n,
    mountToFirstPaintMs: Math.round(mountToFirstPaintMs * 10) / 10,
    idle,
    checks,
    commits: { wheelPan, dragSelected, remoteEditOther, remoteEditSelected, zoomClicks },
    teardown: { socketsOpen: relay.size },
  };
}

(window as unknown as { __viewBench: { run: typeof run } }).__viewBench = { run };

// @vitest-environment jsdom
import { Profiler, act, createElement, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { pauseTimer, startTimer } from '../../../lib/canvas/timer';
import type { CanvasEngine } from '../engine';
import { TimerChip } from './Timer';
import { TimerStore } from './timerStore';

/** Renders of the plaque's buttons (the only IconButtons inside it). */
const buttonRenders = vi.hoisted(() => ({ n: 0 }));
vi.mock('../../../components/ui', async (orig) => {
  const m = await orig<typeof import('../../../components/ui')>();
  return {
    ...m,
    IconButton: (p: ComponentProps<typeof m.IconButton>) => {
      buttonRenders.n++;
      return createElement(m.IconButton, p);
    },
  };
});

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let store: TimerStore | null = null;
beforeEach(() => {
  vi.useFakeTimers();
  buttonRenders.n = 0;
});
afterEach(() => {
  act(() => root?.unmount());
  store?.destroy();
  root = store = null;
  vi.useRealTimers();
  document.body.innerHTML = '';
});

const engine = { subscribe: () => () => undefined, getState: () => ({ readOnly: false }) } as unknown as CanvasEngine;

describe('the timer plaque re-renders only its time once a second', () => {
  it('a running second changes the time and nothing else; the buttons follow the phase', async () => {
    const doc = new Y.Doc();
    const meta = doc.getMap<unknown>('meta');
    store = new TimerStore({ meta, userId: 'u1', canWrite: () => true, visible: () => true, onVisible: () => () => undefined, playEnd: () => undefined });
    const host = document.createElement('div');
    document.body.append(host);
    const r = createRoot(host);
    root = r;
    const commits = { n: 0 };
    const s = store;
    act(() => {
      r.render(createElement(Profiler, { id: 't', onRender: () => {
        commits.n++;
      } }, createElement(TimerChip, { store: s, engine })));
    });
    act(() => void startTimer(meta, 3, 'u1', Date.now()));
    const time = (): string | null | undefined => host.querySelector('[data-testid="canvas-timer-time"]')?.textContent;
    expect(time()).toBe('3:00');
    expect(host.querySelector('[data-testid="canvas-timer-pause"]')).not.toBeNull();
    const buttons = buttonRenders.n;
    const before = commits.n;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5010); // each tick fires 4 ms after the second turns
    });
    expect(time()).toBe('2:55');
    expect(commits.n - before).toBe(5);
    expect(buttonRenders.n).toBe(buttons);

    act(() => void pauseTimer(meta, 'u1', Date.now()));
    expect(host.querySelector('[data-testid="canvas-timer-resume"]')).not.toBeNull();
    expect(buttonRenders.n).toBeGreaterThan(buttons);
  });
});

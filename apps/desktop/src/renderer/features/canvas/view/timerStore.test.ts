import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { parseTimer, startTimer } from '../../../lib/canvas/timer';
import { TimerStore, type TimerStoreOptions } from './timerStore';

interface Rig {
  doc: Y.Doc;
  meta: Y.Map<unknown>;
  store: TimerStore;
  played: number;
  vis: { on: boolean; fire: () => void };
  write: { on: boolean };
}

/** Every test starts at its own hour, so the module's "already chimed" memory of one test never meets the next. */
let T0 = 0;
let hour = 0;
let rigs: TimerStore[] = [];

function rig(over: Partial<TimerStoreOptions> & { doc?: Y.Doc; user?: string } = {}): Rig {
  const doc = over.doc ?? new Y.Doc();
  const meta = doc.getMap('meta');
  const vis = { on: true, fire: (): void => undefined };
  const subs = new Set<() => void>();
  vis.fire = () => subs.forEach((f) => f());
  const write = { on: true };
  const r: Rig = { doc, meta, vis, write, played: 0, store: undefined as unknown as TimerStore };
  r.store = new TimerStore({
    meta,
    userId: over.user ?? 'ann',
    canWrite: () => write.on,
    visible: () => vis.on,
    onVisible: (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    playEnd: () => {
      r.played++;
    },
    ...over,
  });
  rigs.push(r.store);
  return r;
}

const setVisible = (r: Rig, on: boolean): void => {
  r.vis.on = on;
  r.vis.fire();
};

beforeEach(() => {
  vi.useFakeTimers();
  T0 = 1_700_000_000_000 + ++hour * 3_600_000;
  vi.setSystemTime(T0);
});
afterEach(() => {
  for (const s of rigs) s.destroy();
  rigs = [];
  vi.useRealTimers();
});

describe('countdown', () => {
  it('counts down from endsAt on its own clock, one second at a time', async () => {
    const r = rig();
    expect(r.store.getSnapshot().phase).toBe('none');
    await r.store.start(1);
    expect(r.store.getSnapshot()).toMatchObject({ phase: 'running', secs: 60, durationMs: 60_000, by: 'ann' });
    const seen: number[] = [];
    r.store.subscribe(() => seen.push(r.store.getSnapshot().secs));
    vi.advanceTimersByTime(3010);
    expect(r.store.getSnapshot().secs).toBe(57);
    expect(seen).toEqual([59, 58, 57]);
  });

  it('corrects the local clock by the server offset', async () => {
    // the local clock is 20 s behind the server: the starter writes server time, the other client counts in it
    const a = rig({ fetchOffset: () => Promise.resolve(20_000) });
    await a.store.start(1);
    const endsAt = parseTimer(a.meta.get('timer'))?.endsAt ?? 0;
    expect(endsAt).toBe(T0 + 20_000 + 60_000);
    // a client with a correct clock joins the same document: no offset header (null) → its own clock is the server's
    const b = rig({ doc: new Y.Doc() });
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
    expect(b.store.getSnapshot().secs).toBe(80); // 20 s too long: that is the error of an uncorrected clock
    const c = rig({ doc: new Y.Doc(), fetchOffset: () => Promise.resolve(20_000) });
    Y.applyUpdate(c.doc, Y.encodeStateAsUpdate(a.doc));
    await vi.advanceTimersByTimeAsync(0);
    expect(c.store.getSnapshot().secs).toBe(60);
    expect(c.store.now()).toBe(T0 + 20_000);
  });

  it('asks for the offset once, and only when a timer is seen or started', async () => {
    const fetchOffset = vi.fn(() => Promise.resolve(0));
    const a = rig({ fetchOffset });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchOffset).not.toHaveBeenCalled(); // no timer, no request
    await a.store.start(1);
    await a.store.start(2);
    a.store.pause();
    a.store.resume();
    expect(fetchOffset).toHaveBeenCalledTimes(1);
    const failing = vi.fn(() => Promise.reject(new Error('offline')));
    const b = rig({ doc: new Y.Doc(), fetchOffset: failing });
    startTimer(b.meta, 1, 'x', T0);
    await vi.advanceTimersByTimeAsync(0);
    expect(failing).toHaveBeenCalledTimes(1);
    expect(b.store.getSnapshot().phase).toBe('running'); // the local clock is used
  });

  it('pause keeps what is left, resume continues, reset removes it', async () => {
    const r = rig();
    await r.store.start(1);
    vi.advanceTimersByTime(10_000);
    expect(r.store.pause()).toBe(true);
    expect(r.store.getSnapshot()).toMatchObject({ phase: 'paused', secs: 50 });
    expect(r.store.ticking).toBe(false);
    vi.advanceTimersByTime(30_000);
    expect(r.store.getSnapshot().secs).toBe(50);
    expect(r.store.resume()).toBe(true);
    vi.advanceTimersByTime(5010);
    expect(r.store.getSnapshot()).toMatchObject({ phase: 'running', secs: 45 });
    expect(r.store.reset()).toBe(true);
    expect(r.store.getSnapshot().phase).toBe('none');
    expect(r.meta.get('timer')).toBeUndefined();
    expect(r.store.ticking).toBe(false);
  });

  it('two clients on one document show the same time and follow each other’s pause', async () => {
    const a = rig();
    const bDoc = new Y.Doc();
    const b = rig({ doc: bDoc, user: 'bob' });
    a.doc.on('update', (u: Uint8Array) => Y.applyUpdate(bDoc, u));
    bDoc.on('update', (u: Uint8Array, origin: unknown) => {
      if (origin !== undefined) Y.applyUpdate(a.doc, u);
    });
    await a.store.start(3);
    expect(b.store.getSnapshot()).toMatchObject({ phase: 'running', secs: 180 });
    vi.advanceTimersByTime(20_000);
    b.store.pause();
    expect(a.store.getSnapshot()).toMatchObject({ phase: 'paused', secs: 160, by: 'bob' });
  });
});

describe('ticking only when needed', () => {
  it('idle, paused, ended and hidden mean no timers; a running visible timer holds exactly one', async () => {
    const r = rig();
    expect(vi.getTimerCount()).toBe(0);
    await r.store.start(1);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(7000);
    expect(vi.getTimerCount()).toBe(1);
    setVisible(r, false);
    expect(vi.getTimerCount()).toBe(0);
    const before = r.store.getSnapshot().secs;
    vi.advanceTimersByTime(20_000);
    expect(r.store.getSnapshot().secs).toBe(before); // nothing computed while hidden
    setVisible(r, true);
    expect(r.store.getSnapshot().secs).toBe(60 - 27); // recomputed at once when shown
    expect(vi.getTimerCount()).toBe(1);
    r.store.pause();
    expect(vi.getTimerCount()).toBe(0);
    r.store.resume();
    vi.advanceTimersByTime(40_000);
    expect(r.store.getSnapshot().phase).toBe('ended');
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('camera moves, which also tell the store about visibility, re-arm nothing', async () => {
    const r = rig();
    await r.store.start(1);
    const set = vi.spyOn(globalThis, 'setTimeout');
    for (let i = 0; i < 50; i++) r.vis.fire();
    expect(set).not.toHaveBeenCalled();
    set.mockRestore();
  });

  it('destroy leaves no timer and no listener', async () => {
    const r = rig();
    await r.store.start(1);
    r.store.destroy();
    expect(vi.getTimerCount()).toBe(0);
    r.meta.set('timer', { state: 'running', endsAt: T0 + 5000, remainingMs: 5000, durationMs: 5000, by: 'x' });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('the end', () => {
  it('chimes once, the plaque is ended, and the starter writes done', async () => {
    const r = rig();
    await r.store.start(1);
    vi.advanceTimersByTime(59_000);
    expect(r.played).toBe(0);
    vi.advanceTimersByTime(1100);
    expect(r.store.getSnapshot()).toMatchObject({ phase: 'ended', secs: 0 });
    expect(r.played).toBe(1);
    expect(parseTimer(r.meta.get('timer'))?.state).toBe('done');
    // more refreshes (visibility flips, the done write) never chime again
    setVisible(r, false);
    setVisible(r, true);
    vi.advanceTimersByTime(10_000);
    expect(r.played).toBe(1);
  });

  it('another client chimes once as well, and does not write done', async () => {
    const a = rig({ signalled: new Set() });
    const bDoc = new Y.Doc();
    const b = rig({ doc: bDoc, user: 'bob', signalled: new Set() });
    a.doc.on('update', (u: Uint8Array) => Y.applyUpdate(bDoc, u));
    await a.store.start(1);
    vi.advanceTimersByTime(61_000);
    expect(a.played).toBe(1);
    expect(b.played).toBe(1);
    expect(b.store.getSnapshot().phase).toBe('ended');
  });

  it('a window that was hidden at the end chimes when shown shortly after, not when the news is old', async () => {
    const r = rig();
    await r.store.start(1);
    setVisible(r, false);
    vi.advanceTimersByTime(70_000); // ended 10 s ago
    expect(r.played).toBe(0);
    setVisible(r, true);
    expect(r.played).toBe(1);

    const late = rig({ doc: new Y.Doc() });
    startTimer(late.meta, 1, 'x', T0 - 5 * 60_000); // ended 4 minutes ago
    expect(late.store.getSnapshot().phase).toBe('ended');
    expect(late.played).toBe(0);
  });

  it('a reopened canvas does not chime again for a timer already signalled in this session', async () => {
    const r = rig();
    await r.store.start(1);
    vi.advanceTimersByTime(61_000);
    expect(r.played).toBe(1);
    const again = rig({ doc: new Y.Doc() });
    Y.applyUpdate(again.doc, Y.encodeStateAsUpdate(r.doc));
    expect(again.played).toBe(0);
  });
});

describe('who may control it', () => {
  it('viewers see the countdown but their commands do nothing', async () => {
    const a = rig();
    await a.store.start(2);
    const vDoc = new Y.Doc();
    const v = rig({ doc: vDoc, user: 'vera' });
    v.write.on = false;
    Y.applyUpdate(vDoc, Y.encodeStateAsUpdate(a.doc));
    expect(v.store.getSnapshot()).toMatchObject({ phase: 'running', secs: 120 });
    expect(v.store.canControl).toBe(false);
    expect(await v.store.start(5)).toBe(false);
    expect(v.store.pause()).toBe(false);
    expect(v.store.resume()).toBe(false);
    expect(v.store.reset()).toBe(false);
    expect(parseTimer(vDoc.getMap('meta').get('timer'))).toMatchObject({ state: 'running', durationMs: 120_000 });
    // and a viewer never writes `done`, even as the "starter"
    v.write.on = true;
    const own = rig({ doc: new Y.Doc(), user: 'vera' });
    own.write.on = false;
    startTimer(own.meta, 1, 'vera', T0);
    vi.advanceTimersByTime(61_000);
    expect(parseTimer(own.meta.get('timer'))?.state).toBe('running');
    expect(own.store.getSnapshot().phase).toBe('ended');
  });
});

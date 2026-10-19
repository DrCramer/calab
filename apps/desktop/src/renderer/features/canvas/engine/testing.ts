import type { Ctx2D } from './draw';

export interface Call {
  name: string;
  args: unknown[];
}

export interface FakeCtx {
  ctx: Ctx2D;
  calls: Call[];
  count(name: string): number;
  clear(): void;
  state: Record<string, unknown>;
}

/** A 2D context that records calls instead of drawing (no DOM/canvas needed). */
export function fakeCtx(): FakeCtx {
  const calls: Call[] = [];
  const state: Record<string, unknown> = {};
  const ctx = new Proxy(
    {},
    {
      get(_t, p) {
        if (typeof p !== 'string') return undefined;
        if (p === 'measureText') return (t: string) => ({ width: t.length * 6 });
        if (p in state) return state[p];
        return (...args: unknown[]) => {
          calls.push({ name: p, args });
        };
      },
      set(_t, p, v) {
        if (typeof p === 'string') state[p] = v;
        return true;
      },
    },
  ) as unknown as Ctx2D;
  return {
    ctx,
    calls,
    state,
    count: (name) => calls.filter((c) => c.name === name).length,
    clear: () => {
      calls.length = 0;
    },
  };
}

export interface FakeCanvas {
  width: number;
  height: number;
  style: Record<string, string>;
  ownerDocument: { defaultView: { devicePixelRatio: number } | null };
  getContext(kind: '2d'): Ctx2D;
  fake: FakeCtx;
}

export function fakeCanvas(): FakeCanvas {
  const fake = fakeCtx();
  return {
    width: 0,
    height: 0,
    style: {},
    ownerDocument: { defaultView: { devicePixelRatio: 1 } },
    getContext: () => fake.ctx,
    fake,
  };
}

/** Manual requestAnimationFrame: nothing runs until `flush`. */
export function manualRaf(): {
  raf: (cb: () => void) => number;
  cancel: (id: number) => void;
  flush: () => number;
  readonly pending: number;
  readonly scheduled: number;
} {
  let next = 1;
  const q = new Map<number, () => void>();
  let scheduled = 0;
  return {
    raf: (cb) => {
      scheduled++;
      q.set(next, cb);
      return next++;
    },
    cancel: (id) => {
      q.delete(id);
    },
    flush: () => {
      const run = [...q.values()];
      q.clear();
      for (const cb of run) cb();
      return run.length;
    },
    get pending() {
      return q.size;
    },
    get scheduled() {
      return scheduled;
    },
  };
}

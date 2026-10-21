// @vitest-environment jsdom
import * as Y from 'yjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { destroyRigs, rig, type Rig } from './testRig';

afterEach(() => {
  destroyRigs();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const N = 500;
const STEPS = 180; // 3 s at 60 Hz

/** Items in the doc's store (every value ever written that is not collected into a range). */
function items(doc: Y.Doc): number {
  let n = 0;
  for (const structs of doc.store.clients.values()) for (const s of structs) if (s instanceof Y.Item) n++;
  return n;
}

/** 500 stickies, all selected, dragged by the first one in `steps` pointer moves, 16 ms apart. */
function dragAll(steps: number): { r: Rig; start: { x: number; y: number }[] } {
  vi.useFakeTimers();
  const r = rig();
  const ids = r.make(...Array.from({ length: N }, (_, i) => ({ init: { kind: 'sticky' as const, x: (i % 25) * 200, y: Math.floor(i / 25) * 200 } })));
  r.engine.doc.checkpoint();
  const start = ids.map((id) => ({ x: r.engine.doc.snapshot(id)?.x as number, y: r.engine.doc.snapshot(id)?.y as number }));
  r.engine.selectAll();
  r.down(80, 80);
  for (let s = 1; s <= steps; s++) {
    const k = Math.round((s / steps) * STEPS);
    r.clock.t += 16;
    vi.advanceTimersByTime(16);
    r.move(80 + k * 2 + 0.37, 80 + k + 0.11);
  }
  r.up(80 + STEPS * 2 + 0.37, 80 + STEPS + 0.11);
  vi.runOnlyPendingTimers();
  return { r, start };
}

describe('a long gesture leaves no history in the document', () => {
  it('180 moves of 500 objects encode to the size of one move, and undo is one step back to the start', () => {
    const one = dragAll(1);
    const long = dragAll(STEPS);
    const oneBytes = Y.encodeStateAsUpdate(one.r.ydoc).length;
    const longBytes = Y.encodeStateAsUpdate(long.r.ydoc).length;
    // Written on every pointermove (before), the same drag took the state from 78 KB to 3.3 MB (184 500 items).
    expect(longBytes - oneBytes).toBeLessThan(4_000);
    expect(items(long.r.ydoc) - items(one.r.ydoc)).toBeLessThan(50);
    const doc = long.r.engine.doc;
    const ids = doc.orderedIds();
    expect(doc.snapshot(ids[0] ?? '')).toMatchObject({ x: STEPS * 2 + 0.37, y: STEPS + 0.11 });
    expect(doc.live.size).toBe(0);
    long.r.engine.undo();
    const back = doc.orderedIds().map((id) => ({ x: doc.snapshot(id)?.x, y: doc.snapshot(id)?.y }));
    expect(back).toEqual(long.start);
    expect(doc.count).toBe(N); // only the move was taken back, not the creation
  });
});

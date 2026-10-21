import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { LIVE_ORIGIN } from './doc';
import { LIVE_MAX_BYTES, LIVE_MIN_MS, LiveLayer } from './live';
import { Scene } from './scene';
import { REMOTE, pair } from './testing';
import type { ObjectPatch } from './types';

function setup() {
  const { a, b, net } = pair();
  const clock = { t: 1000 };
  const timers: { at: number; fn: () => void }[] = [];
  const opts = {
    now: () => clock.t,
    setTimer: (fn: () => void, ms: number) => {
      const t = { at: clock.t + ms, fn };
      timers.push(t);
      return t;
    },
    clearTimer: (t: unknown) => {
      const i = timers.indexOf(t as never);
      if (i >= 0) timers.splice(i, 1);
    },
  };
  const sa = new Scene(a);
  const sb = new Scene(b);
  const la = new LiveLayer(a, sa, opts);
  const lb = new LiveLayer(b, sb, opts);
  const advance = (ms: number): void => {
    clock.t += ms;
    for (const t of timers.filter((x) => x.at <= clock.t)) {
      timers.splice(timers.indexOf(t), 1);
      t.fn();
    }
  };
  // Each sees the other as present (the awareness peers).
  la.setPresent([String(b.ydoc.clientID)]);
  lb.setPresent([String(a.ydoc.clientID)]);
  return { a, b, net, sa, sb, la, lb, clock, advance, timers };
}

const at = (id: string, x: number, y = 0): Map<string, ObjectPatch> => new Map([[id, { x, y }]]);

describe('gesture preview', () => {
  it('shows the preview at once, the others get it throttled, the document only on commit', () => {
    const t = setup();
    const id = t.a.create({ kind: 'sticky', x: 0, y: 0 }) ?? '';
    t.a.checkpoint();
    t.a.beginGesture();
    t.la.preview(at(id, 10));
    expect(t.sa.get(id)?.x).toBe(10);
    expect(t.sb.get(id)?.x).toBe(10); // the first preview goes out at once
    t.la.preview(at(id, 20));
    t.la.preview(at(id, 30));
    expect(t.sa.get(id)?.x).toBe(30);
    expect(t.sb.get(id)?.x).toBe(10);
    t.advance(LIVE_MIN_MS);
    expect(t.sb.get(id)?.x).toBe(30);
    expect(t.a.snapshot(id)?.x).toBe(0);
    expect(t.b.snapshot(id)?.x).toBe(0);
    t.la.preview(at(id, 44.123456));
    t.la.commit();
    t.a.endGesture();
    expect(t.timers).toHaveLength(0);
    expect(t.a.snapshot(id)?.x).toBe(44.123456);
    expect(t.sb.get(id)?.x).toBe(44.123456);
    expect(t.a.live.size).toBe(0);
    expect(t.b.live.size).toBe(0);
    // One step, back to the start.
    t.a.undo.undo();
    expect(t.b.snapshot(id)?.x).toBe(0);
    expect(t.a.count).toBe(1);
  });

  it('never writes nor undoes anything on drop, and undo never takes back a collaborator\'s gesture', () => {
    const t = setup();
    const mine = t.a.create({ kind: 'sticky', x: 0, y: 0 }) ?? '';
    const theirs = t.b.create({ kind: 'sticky', x: 500, y: 0 }) ?? '';
    t.a.beginGesture();
    t.la.preview(at(mine, 80));
    t.la.drop();
    t.a.cancelGesture();
    expect(t.sa.get(mine)?.x).toBe(0);
    expect(t.sb.get(mine)?.x).toBe(0);
    expect(t.a.live.size).toBe(0);
    expect(t.a.count).toBe(2); // the creation was not undone
    t.b.beginGesture();
    t.lb.preview(at(theirs, 700));
    t.lb.commit();
    t.b.endGesture();
    t.a.undo.undo();
    expect(t.a.snapshot(theirs)?.x).toBe(700);
    expect(t.a.objects.has(mine)).toBe(false);
  });

  it('shows an entry only while its author is present, and the next commit removes what an absent one left', () => {
    const t = setup();
    const id = t.a.create({ kind: 'sticky', x: 0, y: 0 }) ?? '';
    t.la.preview(at(id, 90));
    expect(t.sb.get(id)?.x).toBe(90);
    t.lb.setPresent([]); // A's window vanished mid-drag
    expect(t.sb.get(id)?.x).toBe(0);
    expect(t.b.live.size).toBe(1);
    t.lb.preview(at(id, 5));
    t.lb.commit();
    expect(t.b.live.size).toBe(0);
    expect(t.a.live.size).toBe(0);
  });

  it('validates what others write like a stored patch', () => {
    const t = setup();
    const id = t.a.create({ kind: 'sticky', x: 3, y: 4 }) ?? '';
    const key = String(t.a.ydoc.clientID);
    t.a.ydoc.transact(() => t.a.live.set(key, { [id]: { x: 'evil', y: 1e12, w: -5, kind: 'shape' }, nope: { x: 1 } }), LIVE_ORIGIN);
    expect(t.sb.get(id)).toMatchObject({ kind: 'sticky', x: 3, y: 1e7, w: 24 });
    t.a.ydoc.transact(() => t.a.live.set(key, [1, 2, 3]), LIVE_ORIGIN);
    expect(t.sb.get(id)).toMatchObject({ x: 3, y: 4, w: 160 });
  });

  it('a selection too big to send is previewed locally only', () => {
    const t = setup();
    const ids = t.a.createMany(Array.from({ length: 1600 }, (_, i) => ({ init: { kind: 'sticky' as const, x: i, y: 0 } })));
    const p = new Map(ids.map((id, i) => [id, { x: i + 1000.123, y: 2000.456 }]));
    expect(JSON.stringify(Object.fromEntries(p)).length).toBeGreaterThan(LIVE_MAX_BYTES);
    t.la.preview(p);
    expect(t.sa.get(ids[0] ?? '')?.x).toBe(1000.123);
    expect(t.a.live.size).toBe(0);
    expect(t.sb.get(ids[0] ?? '')?.x).toBe(0);
    t.la.commit();
    expect(t.sb.get(ids[0] ?? '')?.x).toBe(1000.123);
  });

  it('180 previews leave about one tombstone in the encoded state', () => {
    const t = setup();
    const ids = t.a.createMany(Array.from({ length: 200 }, (_, i) => ({ init: { kind: 'sticky' as const, x: i * 200, y: 0 } })));
    const base = Y.encodeStateAsUpdate(t.a.ydoc).length;
    for (let s = 1; s <= 180; s++) {
      t.la.preview(new Map(ids.map((id, i) => [id, { x: i * 200 + s * 1.7, y: s }])));
      t.advance(16);
    }
    t.la.drop();
    expect(Y.encodeStateAsUpdate(t.a.ydoc).length - base).toBeLessThan(100);
    // The collaborator's copy as well (it applied every preview and the removal).
    const fresh = new Y.Doc();
    Y.applyUpdate(fresh, Y.encodeStateAsUpdate(t.b.ydoc), REMOTE);
    expect(fresh.getMap('live').size).toBe(0);
  });
});

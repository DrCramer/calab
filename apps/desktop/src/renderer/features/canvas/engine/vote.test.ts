// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { VoteBook } from '../../../lib/canvas/votes';
import { rectCenter, rotatePoint } from '../../../lib/canvas/geometry';
import type { BoxRec } from '../../../lib/canvas/types';
import { badgeBox, hitBadge } from './voteDraw';
import { destroyRigs, rig, type Rig } from './testRig';

afterEach(() => {
  destroyRigs();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const texts = (r: Rig): string[] =>
  r.fake.calls.filter((c) => c.name === 'fillText').map((c) => String(c.args[0]));

/** Frame flushed, calls recorded since the last clear. */
const paint = (r: Rig): string[] => {
  r.fake.clear();
  r.raf.flush();
  return texts(r);
};

const two = (r: Rig): [string, string] => {
  const [a, b] = r.make({ init: { kind: 'sticky', x: 100, y: 100 } }, { init: { kind: 'shape', shape: 'ellipse', x: 600, y: 300, w: 200, h: 120 } });
  return [a ?? '', b ?? ''];
};

/** Screen point on the first sticky away from its badge. */
const BODY: [number, number] = [150, 200];

describe('voting in the engine', () => {
  it('a canvas without a vote draws no badge and has no vote state', () => {
    const r = rig({ userId: 'ann' });
    two(r);
    expect(paint(r)).toEqual([]);
    expect(r.engine.getState()).toMatchObject({ votePhase: 'none', votesPer: 0, votesLeft: 0, canVote: false });
    expect(r.engine.castVote('x', 1)).toBe(false);
  });

  it('a click is +1, Alt-click and a click on the badge are −1; the limit holds', () => {
    const r = rig({ userId: 'ann' });
    const [s] = two(r);
    r.engine.startVote(3);
    expect(r.engine.getState()).toMatchObject({ votePhase: 'open', votesPer: 3, votesLeft: 3, canVote: true });
    r.click(...BODY);
    r.click(...BODY);
    expect(r.engine.votes.own(s)).toBe(2);
    expect(r.engine.getState().votesLeft).toBe(1);
    expect(paint(r)).toContain('2');
    r.click(...BODY, { altKey: true });
    expect(r.engine.votes.own(s)).toBe(1);
    r.click(...BODY);
    r.click(...BODY);
    r.click(...BODY);
    expect(r.engine.votes.own(s)).toBe(3);
    expect(r.engine.getState().votesLeft).toBe(0);
    // on its own badge a click takes one back
    const o = r.engine.scene.get(s);
    const box = o && o.kind !== 'connector' ? badgeBox(o, 3, 1) : null;
    expect(box).not.toBeNull();
    if (!box) return;
    r.click(box.rect.x + box.rect.w / 2, box.rect.y + box.rect.h / 2);
    expect(r.engine.votes.own(s)).toBe(2);
    expect(r.engine.getState().votesLeft).toBe(1);
  });

  it('a drag still moves the object and casts nothing; Shift-click only selects', () => {
    const r = rig({ userId: 'ann' });
    const [s] = two(r);
    r.engine.startVote(5);
    r.drag(BODY, [BODY[0] + 80, BODY[1]]);
    expect(r.engine.votes.own(s)).toBe(0);
    expect(r.engine.doc.snapshot(s)).toMatchObject({ x: 180 });
    r.click(250, 200, { shiftKey: true });
    expect(r.engine.votes.own(s)).toBe(0);
  });

  it('only stickies and shapes take votes; text and empty canvas do not', () => {
    const r = rig({ userId: 'ann' });
    const [t] = r.make({ init: { kind: 'text', x: 10, y: 10, text: 'hello world' } });
    r.engine.startVote(5);
    r.click(20, 20);
    expect(r.engine.votes.own(t ?? '')).toBe(0);
    expect(r.engine.castVote(t ?? '', 1)).toBe(false);
  });

  it('while open only my votes show; a finish shows the totals and marks the leaders; viewers see them too', () => {
    const r = rig({ userId: 'ann' });
    const [s, e] = two(r);
    r.engine.startVote(5);
    r.click(...BODY);
    const bob = new VoteBook(r.ydoc, 'bob', () => true);
    bob.add(e, 1);
    bob.add(e, 1);
    bob.add(s, 1);
    expect(r.engine.votes.total(e)).toBe(2);
    // Bob's votes are hidden from Ann: only her "1" is on the canvas
    expect(paint(r)).toEqual(['1']);
    r.engine.finishVote();
    const after = paint(r);
    expect(after.sort()).toEqual(['2', '2']);
    expect(r.engine.getState().votePhase).toBe('closed');
    expect(r.engine.votes.leaderIds().size).toBe(2); // 2 and 2 tie
    bob.destroy();
  });

  it('a viewer of the same document cannot vote or start; the totals reach them after the finish', () => {
    const w = rig({ userId: 'ann' });
    const [s] = two(w);
    const v = rig({ userId: 'vera', readOnly: true });
    // the two engines share one document through update relays
    w.ydoc.on('update', (u: Uint8Array, origin: unknown) => {
      if (origin !== 'relay') Y.applyUpdate(v.ydoc, u, 'relay');
    });
    v.ydoc.on('update', (u: Uint8Array, origin: unknown) => {
      if (origin !== 'relay') Y.applyUpdate(w.ydoc, u, 'relay');
    });
    Y.applyUpdate(v.ydoc, Y.encodeStateAsUpdate(w.ydoc), 'relay');
    w.engine.startVote(5);
    w.click(...BODY);
    expect(v.engine.getState()).toMatchObject({ votePhase: 'open', canVote: false, votesLeft: 0 });
    expect(v.engine.castVote(s, 1)).toBe(false);
    expect(v.engine.voteClick(s, { x: 150, y: 200 }, false)).toBe(false);
    v.click(...BODY);
    expect(v.engine.votes.total(s)).toBe(1);
    expect(paint(v)).toEqual([]); // not Ann's vote
    expect(v.engine.startVote(3)).toBeNull();
    expect(v.engine.finishVote()).toBe(false);
    expect(v.engine.resetVote()).toBe(false);
    expect(w.engine.getState().votePhase).toBe('open');
    w.engine.finishVote();
    expect(v.engine.getState().votePhase).toBe('closed');
    expect(paint(v)).toEqual(['1']);
  });

  it('leaders get an outline along their shape on top of the badge', () => {
    const r = rig({ userId: 'ann' });
    const [s] = two(r);
    r.engine.startVote(5);
    r.click(...BODY);
    r.engine.finishVote();
    r.fake.clear();
    r.raf.flush();
    expect(r.engine.votes.leaderIds().has(s)).toBe(true);
    expect(r.fake.count('stroke')).toBeGreaterThanOrEqual(1);
    expect(texts(r)).toEqual(['1']);
  });

  it('a vote change repaints only that object, and an idle canvas draws nothing', () => {
    vi.useFakeTimers();
    const r = rig({ userId: 'ann' });
    two(r);
    r.engine.startVote(5);
    r.raf.flush();
    r.raf.flush();
    const { frames, regions } = r.engine.stats;
    r.click(...BODY);
    r.raf.flush();
    expect(r.engine.stats.frames).toBeGreaterThan(frames);
    // the selection moved too (a click selects): one dirty region for the sticky, none for the far shape
    expect(r.engine.stats.regions - regions).toBeLessThanOrEqual(2);
    expect(r.engine.stats.drawn).toBeLessThanOrEqual(1);
    r.raf.flush();
    const idle = r.engine.stats.frames;
    r.clock.t += 30_000;
    vi.advanceTimersByTime(30_000);
    expect(r.raf.pending).toBe(0);
    expect(r.engine.stats.frames).toBe(idle);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a remote vote on an off-screen object paints no frame beyond a dirty rect, and a vote with no change paints none', () => {
    const r = rig({ userId: 'ann' });
    const [, e] = two(r);
    r.engine.startVote(5);
    r.raf.flush();
    const bob = new VoteBook(r.ydoc, 'bob', () => true);
    const before = r.engine.stats.frames;
    bob.add(e, 1);
    r.raf.flush();
    // Bob's vote is hidden from Ann while it is open: nothing visible changes, but the object is repainted at most once
    expect(r.engine.stats.frames - before).toBeLessThanOrEqual(1);
    expect(r.engine.stats.drawn).toBeLessThanOrEqual(1);
    bob.destroy();
  });

  it('deleting a voted object gives the vote back', () => {
    const r = rig({ userId: 'ann' });
    const [s] = two(r);
    r.engine.startVote(2);
    r.click(...BODY);
    r.click(...BODY);
    expect(r.engine.getState().votesLeft).toBe(0);
    r.engine.setSelection([s]);
    r.engine.deleteSelection();
    expect(r.engine.getState().votesLeft).toBe(2);
  });

  it('a double-click while voting is two votes, not a text edit', () => {
    const r = rig({ userId: 'ann' });
    const [s] = two(r);
    r.engine.startVote(5);
    r.click(...BODY);
    r.click(...BODY);
    r.canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: BODY[0], clientY: BODY[1] }));
    expect(r.engine.getState().editing).toBe(false);
    expect(r.engine.votes.own(s)).toBe(2);
    r.engine.resetVote();
    r.canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: BODY[0], clientY: BODY[1] }));
    expect(r.engine.getState().editing).toBe(true);
  });

  it('a new session clears the votes and a reset removes the badges', () => {
    const r = rig({ userId: 'ann' });
    const [s] = two(r);
    r.engine.startVote(5);
    r.click(...BODY);
    r.engine.finishVote();
    expect(paint(r)).toEqual(['1']);
    r.engine.startVote(2);
    expect(r.engine.votes.own(s)).toBe(0);
    expect(paint(r)).toEqual([]);
    r.click(...BODY);
    r.engine.resetVote();
    expect(r.engine.getState().votePhase).toBe('none');
    expect(paint(r)).toEqual([]);
  });

  it('the engine without a user id cannot start or cast', () => {
    const r = rig();
    two(r);
    expect(r.engine.startVote(3)).toBeNull();
    expect(r.engine.canVote).toBe(false);
  });
});

describe('badge geometry', () => {
  const sticky = (rot?: number): BoxRec => ({ kind: 'sticky', id: 's', z: 'a', x: 100, y: 100, w: 160, h: 160, color: 'yellow', text: '', ...(rot ? { rot } : {}) });

  it('sits in the top right corner inside the object and is the same size on screen at any zoom', () => {
    const o = sticky();
    for (const scale of [0.5, 1, 2]) {
      const b = badgeBox(o, 3, scale);
      expect(b).not.toBeNull();
      if (!b) continue;
      expect(b.rect.x + b.rect.w).toBeLessThan(o.x + o.w);
      expect(b.rect.y).toBeGreaterThan(o.y);
      expect(b.rect.h * scale).toBeCloseTo(Math.min(22, Math.max(14, 160 * scale * 0.3)), 5);
    }
  });
  it('is skipped when the object is too small on screen', () => {
    expect(badgeBox(sticky(), 1, 0.1)).toBeNull();
  });
  it('follows a rotated object: the click test turns the pointer back', () => {
    const o = sticky(30);
    const b = badgeBox(o, 1, 1);
    expect(b).not.toBeNull();
    if (!b) return;
    const on = rotatePoint(rectCenter(b.rect), rectCenter(o), 30);
    expect(hitBadge(o, 1, 1, on)).toBe(true);
    expect(hitBadge(o, 1, 1, rectCenter(b.rect))).toBe(false);
    expect(hitBadge(o, 1, 1, { x: 150, y: 200 })).toBe(false);
  });
});

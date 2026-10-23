import { describe, expect, it } from 'vitest';
import { Scene } from '../../../lib/canvas/scene';
import { makeDoc } from '../../../lib/canvas/testing';
import { AwarenessLayer, CURSOR_DIM_MS, CURSOR_FULL_MS, type PeerState } from './awareness';
import { defaultPalette } from './palette';
import { fakeCtx } from './testing';

const peer = (over: Partial<PeerState> = {}): PeerState => ({ id: 'p1', name: 'Анна', color: '#e11d48', cursor: { x: 5, y: 6 }, ...over });

describe('AwarenessLayer', () => {
  it('reports a change only when something visible differs', () => {
    const a = new AwarenessLayer();
    expect(a.setPeers([peer()], 0)).toBe(true);
    expect(a.setPeers([peer()], 10)).toBe(false);
    expect(a.setPeers([peer({ cursor: { x: 6, y: 6 } })], 20)).toBe(true);
    expect(a.setPeers([peer({ cursor: { x: 6, y: 6 }, selection: ['a'] })], 30)).toBe(true);
    expect(a.setPeers([], 40)).toBe(true);
    expect(a.size).toBe(0);
  });
  it('steps a cursor full → dim → gone by time, and a move brings it back', () => {
    const a = new AwarenessLayer();
    a.setPeers([peer()], 1000);
    expect(a.alpha('p1', 1000)).toBe(1);
    expect(a.alpha('p1', 1000 + CURSOR_FULL_MS - 1)).toBe(1);
    expect(a.alpha('p1', 1000 + CURSOR_FULL_MS)).toBe(0.45);
    expect(a.alpha('p1', 1000 + CURSOR_DIM_MS)).toBe(0);
    a.setPeers([peer({ cursor: { x: 50, y: 50 } })], 9000);
    expect(a.alpha('p1', 9000)).toBe(1);
    expect(a.alpha('nobody', 0)).toBe(0);
  });
  it('a peer that arrives without having moved starts hidden', () => {
    const a = new AwarenessLayer();
    a.setPeers([peer({ cursor: null })], 5000);
    expect(a.alpha('p1', 5000)).toBe(0);
    expect(a.nextStepIn(5000)).toBeNull();
  });
  it('tells when the next visibility step is due, so the engine can use one timer', () => {
    const a = new AwarenessLayer();
    a.setPeers([peer()], 0);
    expect(a.nextStepIn(0)).toBe(CURSOR_FULL_MS);
    expect(a.nextStepIn(CURSOR_FULL_MS + 100)).toBe(CURSOR_DIM_MS - CURSOR_FULL_MS - 100);
    expect(a.nextStepIn(CURSOR_DIM_MS)).toBeNull();
  });
  it('draws cursors with their alpha and selections around the objects, nothing when idle', () => {
    const doc = makeDoc();
    doc.create({ kind: 'sticky', x: 100, y: 100 });
    const scene = new Scene(doc);
    const a = new AwarenessLayer();
    const f = fakeCtx();
    a.setPeers([peer({ selection: ['o1', 'gone'] })], 0);
    a.draw(f.ctx, { tx: 0, ty: 0, scale: 1 }, scene, defaultPalette(), 0);
    expect(f.count('strokeRect')).toBe(1);
    expect(f.count('fillText')).toBe(1);
    f.clear();
    a.draw(f.ctx, { tx: 0, ty: 0, scale: 1 }, scene, defaultPalette(), 100_000);
    expect(f.count('fillText')).toBe(0);
    expect(f.count('strokeRect')).toBe(1);
  });
});

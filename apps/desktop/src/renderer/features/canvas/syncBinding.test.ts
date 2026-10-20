import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { CanvasDoc } from '../../lib/canvas/doc';
import { ids, seededRng } from '../../lib/canvas/testing';
import { SCHEMA_VERSION } from '../../lib/canvas/types';
import { canvasSyncUrl, CanvasSync } from '../../lib/canvasSync';
import { MockRelay } from '../../lib/ySyncMock';
import type { PeerState, PeerView } from './engine/awareness';
import type { CanvasEngine } from './engine';
import type { LocalAwareness } from './engine/engine';
import { bindCanvasSync, peerOf, type SyncBinding, type SyncEnginePort } from './syncBinding';

// Compile-time check: the real engine fits the port.
export const enginePort = (e: CanvasEngine): SyncEnginePort => e;

class StubEngine implements SyncEnginePort {
  peers: PeerState[] = [];
  setPeersCalls = 0;
  readOnly: boolean | null = null;
  private fn: ((a: LocalAwareness) => void) | null = null;
  private viewFn: ((v: PeerView) => void) | null = null;
  setPeers(p: readonly PeerState[]): void {
    this.peers = [...p];
    this.setPeersCalls++;
  }
  onLocalAwareness(fn: (a: LocalAwareness) => void): () => void {
    this.fn = fn;
    return () => {
      this.fn = null;
    };
  }
  onLocalView(fn: (v: PeerView) => void): () => void {
    this.viewFn = fn;
    return () => {
      this.viewFn = null;
    };
  }
  emitView(v: PeerView): void {
    this.viewFn?.(v);
  }
  setReadOnly(on: boolean): void {
    this.readOnly = on;
  }
  emit(a: LocalAwareness): void {
    this.fn?.(a);
  }
  get listening(): boolean {
    return this.fn !== null;
  }
}

interface Peer {
  ydoc: Y.Doc;
  doc: CanvasDoc;
  awareness: Awareness;
  sync: CanvasSync;
  engine: StubEngine;
  binding: SyncBinding;
}

let n = 0;
function peer(relay: MockRelay, name: string, opts: { readOnly?: boolean; canWrite?: boolean } = {}): Peer {
  const ydoc = new Y.Doc();
  const awareness = new Awareness(ydoc);
  const doc = new CanvasDoc(ydoc, { rng: seededRng(++n), makeId: ids(`p${n}-`) });
  const make = relay.socketFactory({ canWrite: opts.canWrite ?? true });
  const sync = new CanvasSync(ydoc, awareness, {
    url: () => canvasSyncUrl('https://x', 'c'),
    getToken: () => Promise.resolve('t'),
    createSocket: make,
    readOnly: opts.readOnly,
    random: () => 0,
    visibility: { hidden: () => false, subscribe: () => () => undefined },
  });
  const engine = new StubEngine();
  const binding = bindCanvasSync({
    doc: ydoc,
    awareness,
    sync,
    engine,
    user: { id: `u-${name}`, name, color: '#ff0000' },
    readOnly: opts.readOnly,
  });
  return { ydoc, doc, awareness, sync, engine, binding };
}

const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('peerOf', () => {
  it('maps a well-formed state', () => {
    expect(
      peerOf(7, { user: { id: 'u', name: 'Ann', color: '#abc' }, canvas: { cursor: { x: 1, y: 2 }, selection: ['a', 'b'] } }),
    ).toEqual({ id: '7', userId: 'u', name: 'Ann', color: '#abc', cursor: { x: 1, y: 2 }, selection: ['a', 'b'] });
  });

  it('survives garbage from a peer', () => {
    expect(peerOf(1, null)).toBeNull();
    expect(peerOf(1, {})).toBeNull();
    expect(peerOf(1, { user: { name: 'no id' } })).toBeNull();
    const p = peerOf(2, {
      user: { id: 'u', name: 5, color: 'url(javascript:alert(1))' },
      canvas: { cursor: { x: 'a', y: NaN }, selection: ['ok', 3, 'x'.repeat(100), null] },
    });
    expect(p).toEqual({ id: '2', userId: 'u', name: '', color: '#8e8e93', selection: ['ok'] });
    expect(peerOf(3, { user: { id: 'u', name: 'x' } })).toEqual({ id: '3', userId: 'u', name: 'x', color: '#8e8e93' });
  });
});

describe('peerOf view', () => {
  const user = { id: 'u', name: 'Ann', color: '#abc' };
  it('reads the camera of a peer and drops malformed ones', () => {
    expect(peerOf(1, { user, view: { x: 10, y: -4.5, zoom: 2 } })?.view).toEqual({ x: 10, y: -4.5, zoom: 2 });
    for (const view of [null, {}, { x: 1, y: 2 }, { x: 'a', y: 2, zoom: 1 }, { x: 1, y: NaN, zoom: 1 }, { x: 1, y: 2, zoom: 0 }, { x: 1, y: 2, zoom: Infinity }]) {
      expect(peerOf(1, { user, view })?.view, JSON.stringify(view)).toBeUndefined();
    }
  });
});

describe('bindCanvasSync', () => {
  it('sends our view as the awareness field `view`, skipping an unchanged one; peers read it back', async () => {
    const relay = new MockRelay();
    const a = peer(relay, 'Ann');
    const b = peer(relay, 'Bob');
    await settle();
    a.engine.emitView({ x: 100, y: 50, zoom: 1.5 });
    vi.advanceTimersByTime(50);
    expect(b.engine.peers[0]?.view).toEqual({ x: 100, y: 50, zoom: 1.5 });
    const clock = a.awareness.meta.get(a.awareness.clientID)?.clock ?? 0;
    a.engine.emitView({ x: 100.1, y: 50, zoom: 1.5 });
    a.engine.emitView({ x: 100, y: 50, zoom: 1.5 });
    expect(a.awareness.meta.get(a.awareness.clientID)?.clock).toBe(clock);
    a.engine.emitView({ x: 300, y: 50, zoom: 1.5 });
    expect(a.awareness.getLocalState()).toMatchObject({ view: { x: 300, y: 50, zoom: 1.5 } });
    a.sync.destroy();
    b.sync.destroy();
  });

  it('destroy stops listening for the view too', async () => {
    const relay = new MockRelay();
    const a = peer(relay, 'Ann');
    await settle();
    a.binding.destroy();
    a.engine.emitView({ x: 1, y: 1, zoom: 1 });
    expect(a.awareness.getLocalState()).not.toHaveProperty('view');
    a.sync.destroy();
  });

  it('sends our cursor and selection as awareness; peers see them as PeerState', async () => {
    const relay = new MockRelay();
    const a = peer(relay, 'Ann');
    const b = peer(relay, 'Bob');
    await settle();
    a.engine.emit({ cursor: { x: 10, y: 20 }, selection: ['s1'] });
    vi.advanceTimersByTime(50);
    expect(b.engine.peers).toEqual([
      { id: String(a.awareness.clientID), userId: 'u-Ann', name: 'Ann', color: '#ff0000', cursor: { x: 10, y: 20 }, selection: ['s1'] },
    ]);
    // cursor away, selection kept
    a.engine.emit({ cursor: null, selection: ['s1'] });
    vi.advanceTimersByTime(50);
    expect(b.engine.peers[0]?.cursor).toBeUndefined();
    expect(b.engine.peers[0]?.selection).toEqual(['s1']);
    // we never list ourselves
    expect(a.engine.peers.map((p) => p.name)).toEqual(['Bob']);
    a.sync.destroy();
    b.sync.destroy();
  });

  it('does not re-send an unchanged local state', async () => {
    const relay = new MockRelay();
    const a = peer(relay, 'Ann');
    await settle();
    const clock = a.awareness.meta.get(a.awareness.clientID)?.clock ?? 0;
    a.engine.emit({ cursor: { x: 1, y: 1 }, selection: [] });
    const after = a.awareness.meta.get(a.awareness.clientID)?.clock ?? 0;
    expect(after).toBe(clock + 1);
    a.engine.emit({ cursor: { x: 1, y: 1 }, selection: [] });
    expect(a.awareness.meta.get(a.awareness.clientID)?.clock).toBe(after);
    a.sync.destroy();
  });

  it('clears the peers when the socket drops', async () => {
    const relay = new MockRelay();
    const a = peer(relay, 'Ann');
    const b = peer(relay, 'Bob');
    await settle();
    a.engine.emit({ cursor: { x: 1, y: 1 }, selection: [] });
    vi.advanceTimersByTime(50);
    expect(b.engine.peers).toHaveLength(1);
    relay.dropAll(1006);
    expect(b.engine.peers).toEqual([]);
    a.sync.destroy();
    b.sync.destroy();
  });

  it('writes meta.schema into a fresh document after the first sync, once', async () => {
    const relay = new MockRelay();
    const a = peer(relay, 'Ann');
    expect(a.ydoc.getMap('meta').get('schema')).toBeUndefined();
    await settle();
    expect(a.ydoc.getMap('meta').get('schema')).toBe(SCHEMA_VERSION);
    vi.advanceTimersByTime(200);
    expect(relay.doc.getMap('meta').get('schema')).toBe(SCHEMA_VERSION);
    a.sync.destroy();
  });

  it('a read-only client writes no schema', async () => {
    const relay = new MockRelay();
    const r = peer(relay, 'Rae', { readOnly: true, canWrite: false });
    await settle();
    expect(r.ydoc.getMap('meta').get('schema')).toBeUndefined();
    expect(r.sync.status).toBe('readonly');
    expect(r.engine.readOnly).toBe(true);
    r.sync.destroy();
  });

  it('a newer schema makes both the provider and the engine read-only', async () => {
    const relay = new MockRelay();
    relay.doc.getMap('meta').set('schema', SCHEMA_VERSION + 1);
    const a = peer(relay, 'Ann');
    await settle();
    expect(a.sync.status).toBe('readonly');
    expect(a.engine.readOnly).toBe(true);
    expect(a.ydoc.getMap('meta').get('schema')).toBe(SCHEMA_VERSION + 1);
    a.doc.create({ kind: 'sticky', x: 0, y: 0, text: 'nope' });
    vi.advanceTimersByTime(5000);
    expect(relay.violations).toEqual([]);
    expect(relay.doc.getMap('objects').size).toBe(0);
    a.sync.destroy();
  });

  it('the grant and the schema combine in setReadOnly', async () => {
    const relay = new MockRelay();
    const a = peer(relay, 'Ann');
    await settle();
    expect(a.sync.status).toBe('synced');
    a.binding.setReadOnly(true);
    expect(a.sync.status).toBe('readonly');
    expect(a.engine.readOnly).toBe(true);
    a.binding.setReadOnly(false);
    expect(a.sync.status).toBe('synced');
    expect(a.engine.readOnly).toBe(false);
    // a newer schema arriving later wins over the grant
    a.ydoc.getMap('meta').set('schema', SCHEMA_VERSION + 1);
    expect(a.sync.status).toBe('readonly');
    a.binding.setReadOnly(false);
    expect(a.engine.readOnly).toBe(true);
    a.sync.destroy();
  });

  it('destroy detaches from the engine and the awareness', async () => {
    const relay = new MockRelay();
    const a = peer(relay, 'Ann');
    const b = peer(relay, 'Bob');
    await settle();
    a.binding.destroy();
    expect(a.engine.listening).toBe(false);
    expect(a.engine.peers).toEqual([]);
    const calls = a.engine.setPeersCalls;
    b.engine.emit({ cursor: { x: 3, y: 3 }, selection: [] });
    vi.advanceTimersByTime(50);
    expect(a.engine.setPeersCalls).toBe(calls);
    a.binding.destroy(); // idempotent
    a.sync.destroy();
    b.sync.destroy();
  });
});

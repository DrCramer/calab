/**
 * Binds the engine to the sync provider (ADR-0107 §3, §4): our cursor and selection go into the
 * Yjs awareness, other participants' awareness states come back as `PeerState`s for the engine's
 * awareness layer. It also writes `meta.schema` into a fresh document after the first sync and keeps
 * the provider read-only for a newer schema. No React, no Zustand: awareness never reaches the stores.
 *
 * Awareness state of a participant: `{ user: {id, name, color}, canvas: {cursor, selection} }`
 * (`user` as on the wiki socket). The frame rate is the provider's job (≤ 20/s, none while hidden).
 */
import * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { SCHEMA_VERSION } from '../../lib/canvas/types';
import type { CanvasSync, CanvasSyncStatus } from '../../lib/canvasSync';
import type { PeerState } from './engine/awareness';
import type { LocalAwareness } from './engine/engine';

/** The part of CanvasEngine the binding needs (the engine satisfies it structurally). */
export interface SyncEnginePort {
  setPeers(peers: readonly PeerState[]): void;
  onLocalAwareness(fn: (a: LocalAwareness) => void): () => void;
  setReadOnly?(on: boolean): void;
}

export interface CanvasUser {
  id: string;
  name: string;
  /** CSS color of our cursor for the others. */
  color: string;
}

export interface SyncBinding {
  /** The grant changed (CANVAS_WRITE); the effective mode also stays read-only for a newer schema. */
  setReadOnly(on: boolean): void;
  destroy(): void;
}

const MAX_SELECTION = 1000;
const MAX_ID = 64;

/** One remote awareness state → a peer, null if it is not a well-formed canvas state. */
export function peerOf(clientId: number, state: unknown): PeerState | null {
  if (typeof state !== 'object' || state === null) return null;
  const { user, canvas } = state as { user?: unknown; canvas?: unknown };
  if (typeof user !== 'object' || user === null) return null;
  const u = user as Record<string, unknown>;
  if (typeof u.id !== 'string' || !u.id) return null;
  const peer: PeerState = {
    id: String(clientId),
    name: typeof u.name === 'string' ? u.name.slice(0, 80) : '',
    color: typeof u.color === 'string' && /^(#[0-9a-fA-F]{3,8}|[a-z]+\([^)]{0,40}\))$/.test(u.color) ? u.color : '#8e8e93',
  };
  if (typeof canvas === 'object' && canvas !== null) {
    const c = canvas as { cursor?: unknown; selection?: unknown };
    const cur = c.cursor as { x?: unknown; y?: unknown } | null | undefined;
    if (cur && typeof cur.x === 'number' && typeof cur.y === 'number' && Number.isFinite(cur.x) && Number.isFinite(cur.y)) {
      peer.cursor = { x: cur.x, y: cur.y };
    }
    if (Array.isArray(c.selection)) {
      peer.selection = c.selection.filter((v): v is string => typeof v === 'string' && v.length <= MAX_ID).slice(0, MAX_SELECTION);
    }
  }
  return peer;
}

const sameLocal = (a: LocalAwareness | null, b: LocalAwareness): boolean =>
  !!a &&
  a.cursor?.x === b.cursor?.x &&
  a.cursor?.y === b.cursor?.y &&
  a.selection.length === b.selection.length &&
  a.selection.every((v, i) => v === b.selection[i]);

export function bindCanvasSync(opts: {
  doc: Y.Doc;
  awareness: Awareness;
  sync: CanvasSync;
  engine: SyncEnginePort;
  user: CanvasUser;
  /** The grant at start; default: writable. */
  readOnly?: boolean;
}): SyncBinding {
  const { doc, awareness, sync, engine, user } = opts;
  const meta = doc.getMap<unknown>('meta');
  let grantRO = opts.readOnly ?? false;
  let future = false;
  let last: LocalAwareness | null = null;
  let done = false;

  awareness.setLocalStateField('user', { id: user.id, name: user.name, color: user.color });

  const applyMode = (): void => {
    const ro = grantRO || future;
    sync.setReadOnly(ro);
    engine.setReadOnly?.(ro);
  };

  const onMeta = (): void => {
    const v = meta.get('schema');
    const next = typeof v === 'number' && v > SCHEMA_VERSION;
    if (next === future) return;
    future = next;
    applyMode();
  };
  meta.observe(onMeta);
  onMeta();
  applyMode();

  // A fresh document gets its schema once, after the first sync, by a writer.
  let schemaChecked = false;
  const onStatus = (s: CanvasSyncStatus): void => {
    if (s !== 'synced' || schemaChecked) return;
    schemaChecked = true;
    if (!future && meta.get('schema') === undefined) doc.transact(() => meta.set('schema', SCHEMA_VERSION), 'canvas-init');
  };
  const unsubStatus = sync.subscribe(onStatus);
  onStatus(sync.getStatus());

  const pushPeers = (): void => {
    const peers: PeerState[] = [];
    awareness.getStates().forEach((st, client) => {
      if (client === awareness.clientID) return;
      const p = peerOf(client, st);
      if (p) peers.push(p);
    });
    engine.setPeers(peers);
  };
  awareness.on('change', pushPeers);
  pushPeers();

  const unsubLocal = engine.onLocalAwareness((a) => {
    if (done || sameLocal(last, a)) return;
    last = { cursor: a.cursor ? { x: a.cursor.x, y: a.cursor.y } : null, selection: [...a.selection] };
    awareness.setLocalStateField('canvas', { cursor: last.cursor, selection: last.selection });
  });

  return {
    setReadOnly(on) {
      if (on === grantRO) return;
      grantRO = on;
      applyMode();
    },
    destroy() {
      if (done) return;
      done = true;
      unsubLocal();
      unsubStatus();
      awareness.off('change', pushPeers);
      meta.unobserve(onMeta);
      engine.setPeers([]);
    },
  };
}

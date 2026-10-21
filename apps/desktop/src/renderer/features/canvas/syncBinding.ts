/**
 * Binds the engine to the sync provider (ADR-0114 §3, §4): our cursor and selection go into the
 * Yjs awareness (and our camera as `view`, so the others can follow us), other participants' awareness states come back as `PeerState`s for the engine's
 * awareness layer. It also writes `meta.schema` into a fresh document after the first sync and keeps
 * the provider read-only for a newer schema. No React, no Zustand: awareness never reaches the stores.
 *
 * Awareness state of a participant: `{ user: {id, name, color}, canvas: {cursor, selection} }`
 * (`user` as on the wiki socket), plus `view: {x, y, zoom}` — the center of the visible area in world units and
 * the zoom — sent by the engine at most 5 times a second and only when the camera moved. The frame rate is the provider's job (≤ 20/s, none while hidden).
 *
 * Incoming: each awareness change re-reads only the clients it names (not every peer), and the peer list goes to
 * the engine at most every PEERS_GAP_MS (100 peers moving 10 times a second: 1000 reads, ≤ 20 lists a second).
 */
import * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { SCHEMA_VERSION } from '../../lib/canvas/types';
import type { CanvasSync, CanvasSyncStatus } from '../../lib/canvasSync';
import { sameView, type PeerState, type PeerView } from './engine/awareness';
import type { LocalAwareness } from './engine/engine';

/** The part of CanvasEngine the binding needs (the engine satisfies it structurally). */
export interface SyncEnginePort {
  /** `settled` false: the socket is down and the list is empty for that reason (a follow waits). */
  setPeers(peers: readonly PeerState[], settled?: boolean): void;
  onLocalAwareness(fn: (a: LocalAwareness) => void): () => void;
  /** Our camera (center, zoom), already throttled to 5/s and silent while hidden; optional so older ports still fit. */
  onLocalView?(fn: (v: PeerView) => void): () => void;
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
/** The peer list goes to the engine (and the presence bar) at most this often: ≤ 20 times a second. */
export const PEERS_GAP_MS = 50;
/** After a reconnect the others' states come back within a few awareness frames; a peer still missing then has left. */
export const PEERS_SETTLE_MS = 3000;

const isConnected = (s: CanvasSyncStatus): boolean => s === 'synced' || s === 'readonly';

/** One remote awareness state → a peer, null if it is not a well-formed canvas state. */
export function peerOf(clientId: number, state: unknown): PeerState | null {
  if (typeof state !== 'object' || state === null) return null;
  const { user, canvas } = state as { user?: unknown; canvas?: unknown };
  if (typeof user !== 'object' || user === null) return null;
  const u = user as Record<string, unknown>;
  if (typeof u.id !== 'string' || !u.id) return null;
  const peer: PeerState = {
    id: String(clientId),
    userId: u.id,
    name: typeof u.name === 'string' ? u.name.slice(0, 80) : '',
    color: typeof u.color === 'string' && /^(#[0-9a-fA-F]{3,8}|[a-z]+\([^)]{0,40}\))$/.test(u.color) ? u.color : '#8e8e93',
  };
  const view = (state as { view?: unknown }).view as { x?: unknown; y?: unknown; zoom?: unknown } | null | undefined;
  if (
    view && typeof view.x === 'number' && typeof view.y === 'number' && typeof view.zoom === 'number' &&
    Number.isFinite(view.x) && Number.isFinite(view.y) && Number.isFinite(view.zoom) && view.zoom > 0
  ) {
    peer.view = { x: view.x, y: view.y, zoom: view.zoom };
  }
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

  // A fresh document gets its schema once, after the first sync, by a writer: a read-only client must not write
  // anything (its local write would never reach the others, and a later grant would leave a causality gap).
  let synced = false;
  let schemaChecked = false;
  const initSchema = (): void => {
    if (!synced || schemaChecked || grantRO || future) return;
    schemaChecked = true;
    if (meta.get('schema') === undefined) doc.transact(() => meta.set('schema', SCHEMA_VERSION), 'canvas-init');
  };
  let connected = isConnected(sync.getStatus());
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  const onStatus = (s: CanvasSyncStatus): void => {
    const was = connected;
    connected = isConnected(s);
    // Back online: the list is published as settled once the others had time to announce themselves again.
    if (connected && !was && !done) {
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settleTimer = null;
        publish();
      }, PEERS_SETTLE_MS);
    }
    if (s !== 'synced') return;
    synced = true;
    initSchema();
  };
  const unsubStatus = sync.subscribe(onStatus);
  onStatus(sync.getStatus());

  // The peers by client id, kept up to date from each change event: only the clients it names are read
  // again (a busy board sends ≈ 1000 events a second, one per cursor move). The list goes to the engine at
  // most every PEERS_GAP_MS: the first change after a quiet gap at once, the rest at the end of the gap; a
  // peer gone goes at once.
  const peers = new Map<number, PeerState>();
  let publishedAt = Number.NEGATIVE_INFINITY;
  let publishTimer: ReturnType<typeof setTimeout> | null = null;
  const publish = (): void => {
    if (publishTimer) clearTimeout(publishTimer);
    publishTimer = null;
    publishedAt = Date.now();
    engine.setPeers([...peers.values()], connected && settleTimer === null);
  };
  /** Reads one client's state again; false for ourselves (our own moves change no peer). */
  const read = (client: number): boolean => {
    if (client === awareness.clientID) return false;
    const p = peerOf(client, awareness.getStates().get(client));
    if (p) peers.set(client, p);
    else peers.delete(client);
    return true;
  };
  const onChange = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }): void => {
    let touched = false;
    let gone = false;
    for (const c of added) touched = read(c) || touched;
    for (const c of updated) touched = read(c) || touched;
    for (const c of removed) gone = peers.delete(c) || gone;
    if (gone) {
      publish(); // someone left (or our socket dropped): no ghost waits for the gap
      return;
    }
    if (!touched || publishTimer) return;
    const wait = publishedAt + PEERS_GAP_MS - Date.now();
    if (wait <= 0) publish();
    else publishTimer = setTimeout(publish, wait);
  };
  awareness.on('change', onChange);
  awareness.getStates().forEach((_, client) => read(client));
  publish();

  const unsubLocal = engine.onLocalAwareness((a) => {
    if (done || sameLocal(last, a)) return;
    last = { cursor: a.cursor ? { x: a.cursor.x, y: a.cursor.y } : null, selection: [...a.selection] };
    awareness.setLocalStateField('canvas', { cursor: last.cursor, selection: last.selection });
  });

  let lastView: PeerView | null = null;
  const unsubView = engine.onLocalView?.((v) => {
    if (done || sameView(lastView, v)) return;
    lastView = { x: v.x, y: v.y, zoom: v.zoom };
    awareness.setLocalStateField('view', lastView);
  });

  return {
    setReadOnly(on) {
      if (on === grantRO) return;
      grantRO = on;
      applyMode();
      initSchema();
    },
    destroy() {
      if (done) return;
      done = true;
      unsubLocal();
      unsubView?.();
      unsubStatus();
      awareness.off('change', onChange);
      if (publishTimer) clearTimeout(publishTimer);
      publishTimer = null;
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = null;
      meta.unobserve(onMeta);
      engine.setPeers([]);
    },
  };
}

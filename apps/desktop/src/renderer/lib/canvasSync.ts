/**
 * Client side of the canvas sync socket `GET /api/canvas/items/{id}/sync` (ADR-0113 §3): the generic Yjs
 * provider (lib/ySync.ts; frames 0–4 as on the wiki socket, docs/05) with the canvas's settings.
 *
 * - Updates are batched for 200 ms, an update above 64 KiB goes up as a snapshot (ySync).
 * - Awareness (cursor, selection): ≤ 20 frames/s, nothing while the window is hidden.
 * - Compaction (SNAPSHOT_POST) on COMPACT_REQUEST, after our last edit (3 s; longer for a big document,
 *   canvasIdleSnapshotMs) and on destroy, with
 *   `{plain_text, title, preview, objects}`: `plain_text` is the glued texts of all objects (canvasPlainText),
 *   `objects` their number (0 = no version in the history).
 * - Reconnect (backoff 1 s → 30 s): the server sends the snapshot and the updates after it again, and
 *   whatever this doc has beyond them goes up as one update.
 * - Read-only (no CANVAS_WRITE, or a newer document schema): nothing is sent; setReadOnly flips it.
 * - Anonymous (the public link `/c/{code}`, ADR-0114 wave 5): `GET /api/public/canvas/{code}/sync`, no token,
 *   nothing is ever sent, no awareness either way (canvasPublicSyncUrl).
 *
 * The status is a primitive for the UI: connecting | synced | readonly | offline.
 */
import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import { canvasObjectCount, canvasPlainText } from "./canvas/plainText";
import type { SnapshotMeta } from "./wiki/frames";
import { previewOf } from "./wiki/plainText";
import { IDLE_SNAPSHOT_MS, YSyncProvider, type Visibility, type YSyncStatus } from "./ySync";
import type { SocketLike } from "./gateway/client";

export type CanvasSyncStatus = "connecting" | "synced" | "readonly" | "offline";

/** Awareness ≤ 20 frames/s (the engine throttles its own events to the same rate). */
export const CANVAS_AWARENESS_MIN_GAP_MS = 50;
/** Largest snapshot state of a canvas (ADR-0113 §3). */
export const CANVAS_MAX_STATE = 4 * 1024 * 1024;

/**
 * Idle compaction delay by state size: 3 s up to ≈ 60 KB, then ≈ 20 KB of state per second of quiet (400 KB → 20 s,
 * 1 MB → 52 s), at most a minute. A sparse editor of a 5000-object canvas (a move every 5 s) used to re-upload
 * ≈ 1 MB after each one; destroy and the server's COMPACT_REQUEST still compact at once.
 */
export function canvasIdleSnapshotMs(stateBytes: number): number {
  return Math.min(60_000, Math.max(IDLE_SNAPSHOT_MS, Math.round(stateBytes / 20)));
}

export interface CanvasSyncDeps {
  /** `wss://…/api/canvas/items/{id}/sync`, built per attempt (canvasSyncUrl). */
  url: () => string;
  /** Access token sent as the first (text) frame; null = not signed in (retried with backoff). */
  getToken: () => Promise<string | null>;
  /** Forced refresh after close 4004; null = could not refresh now. */
  refreshToken?: () => Promise<string | null>;
  createSocket: (url: string) => SocketLike;
  /** No CANVAS_WRITE (or a newer schema): receive only. */
  readOnly?: boolean;
  /** The public link's receive-only socket: no token, never sends (YSyncDeps.anonymous). */
  anonymous?: boolean;
  /** The canvas's name (it lives in canvas_items; the snapshot carries the current one). */
  title?: () => string;
  /** The state outgrew 4 MiB: the server will not take a snapshot; the UI warns. */
  onTooLarge?: (bytes: number) => void;
  /** 4003 / 4404: the canvas is gone or no longer visible to me. */
  onFatal?: (code: number) => void;
  random?: () => number;
  visibility?: Visibility;
}

/** `wss://host/api/canvas/items/{id}/sync` from the server URL (the gateway's way). */
export function canvasSyncUrl(serverUrl: string, canvasId: string): string {
  const u = new URL(
    `/api/canvas/items/${encodeURIComponent(canvasId)}/sync`,
    serverUrl,
  );
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.toString();
}

/** `wss://host/api/public/canvas/{code}/sync`: the anonymous receive-only socket of a public link. */
export function canvasPublicSyncUrl(serverUrl: string, code: string): string {
  const u = new URL(`/api/public/canvas/${encodeURIComponent(code)}/sync`, serverUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.toString();
}

const STATUS: Record<YSyncStatus, CanvasSyncStatus> = {
  connecting: "connecting",
  online: "synced",
  readonly: "readonly",
  offline: "offline",
};

/** SNAPSHOT_POST meta of a canvas doc (`objects`: docs/05, an empty canvas gets no version). */
export function canvasMeta(doc: Y.Doc, title = ""): SnapshotMeta {
  const plain = canvasPlainText(doc);
  return { plain_text: plain, title, preview: previewOf(plain), objects: canvasObjectCount(doc) };
}

export class CanvasSync {
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  private readonly provider: YSyncProvider;

  constructor(doc: Y.Doc, awareness: Awareness, deps: CanvasSyncDeps) {
    this.doc = doc;
    this.awareness = awareness;
    this.provider = new YSyncProvider(doc, awareness, {
      url: deps.url,
      getToken: deps.getToken,
      refreshToken: deps.refreshToken,
      createSocket: deps.createSocket,
      readOnly: deps.readOnly,
      ...(deps.anonymous ? { anonymous: true } : {}),
      meta: () => canvasMeta(doc, deps.title?.() ?? ""),
      awarenessMinGapMs: CANVAS_AWARENESS_MIN_GAP_MS,
      maxState: CANVAS_MAX_STATE,
      idleSnapshotMs: canvasIdleSnapshotMs,
      onTooLarge: deps.onTooLarge,
      onFatal: deps.onFatal,
      random: deps.random,
      visibility: deps.visibility,
    });
  }

  get status(): CanvasSyncStatus {
    return STATUS[this.provider.getStatus()];
  }

  /** For useSyncExternalStore: `subscribe` + `getStatus`. */
  subscribe = (cb: (s: CanvasSyncStatus) => void): (() => void) =>
    this.provider.subscribe((s) => cb(STATUS[s]));

  getStatus = (): CanvasSyncStatus => STATUS[this.provider.getStatus()];

  get isSynced(): boolean {
    return this.provider.isSynced;
  }

  get readOnly(): boolean {
    return this.provider.readOnly;
  }

  /** The write grant (or the schema check) changed. */
  setReadOnly(on: boolean): void {
    this.provider.setReadOnly(on);
  }

  /** Sends the batched local updates now. */
  flush(): void {
    this.provider.flush();
  }

  /** Asks for a compaction now (deferred inside the server's per-socket budget). */
  compact(): void {
    this.provider.postSnapshot();
  }

  /** Closing the canvas: flush, snapshot when we edited, bye to peers, close. Doc and awareness stay the caller's. */
  destroy(): void {
    this.provider.destroy();
  }
}

/** The factory the app wires (connection details injected; tests pass a mock socket). */
export function createCanvasSync(
  doc: Y.Doc,
  awareness: Awareness,
  deps: CanvasSyncDeps,
): CanvasSync {
  return new CanvasSync(doc, awareness, deps);
}

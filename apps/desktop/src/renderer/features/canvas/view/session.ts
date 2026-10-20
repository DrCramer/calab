/**
 * One open canvas: Y.Doc + awareness + engine + sync socket + the binding between them, created together
 * and destroyed together (no background sockets or frames after the screen closes). No React.
 *
 * Destroy order (H4 hand-over): pending text edit → binding → sync (flush, compaction snapshot when we
 * edited, bye, close) → engine → awareness → doc.
 */
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { canvasSyncUrl, createCanvasSync, type CanvasSync } from '../../../lib/canvasSync';
import type { SocketLike } from '../../../lib/gateway/client';
import { CanvasEngine, type CanvasPalette, type ClipboardPort } from '../engine';
import { bindCanvasSync, type CanvasUser, type SyncBinding, type SyncEnginePort } from '../syncBinding';
import type { PresenceStore } from './presenceStore';

/** Connection details the screen needs from the app (injected so tests run against a mock socket). */
export interface CanvasViewDeps {
  /** Server origin the API lives on (`https://app.example.com`). */
  serverUrl: () => string;
  getToken: () => Promise<string | null>;
  refreshToken?: () => Promise<string | null>;
  createSocket: (url: string) => SocketLike;
  /** The signed-in person as the others see them. */
  user: () => { id: string; name: string };
  clipboard?: ClipboardPort;
}

export interface SessionOptions {
  canvasId: string;
  canvas: HTMLCanvasElement;
  /** The transparent layer over `canvas` for other people's cursors. */
  remoteCanvas?: HTMLCanvasElement | null;
  editorHost: HTMLElement;
  deps: CanvasViewDeps;
  palette: CanvasPalette;
  /** No CANVAS_WRITE. */
  readOnly: boolean;
  lowPower: boolean;
  reducedMotion: boolean;
  presence: PresenceStore;
  color: (userId: string) => string;
  /** The canvas' name for the snapshot meta (read at call time). */
  title: () => string;
  onTooLarge: (bytes: number) => void;
  onFatal: (code: number) => void;
}

export interface CanvasSession {
  readonly ydoc: Y.Doc;
  readonly awareness: Awareness;
  readonly sync: CanvasSync;
  readonly engine: CanvasEngine;
  readonly binding: SyncBinding;
  destroy(): void;
}

export function openCanvasSession(o: SessionOptions): CanvasSession {
  const ydoc = new Y.Doc();
  const awareness = new Awareness(ydoc);
  const me = o.deps.user();
  const engine = new CanvasEngine({
    canvas: o.canvas,
    userId: me.id,
    ...(o.remoteCanvas ? { remoteCanvas: o.remoteCanvas } : {}),
    doc: ydoc,
    palette: o.palette,
    readOnly: o.readOnly,
    lowPower: o.lowPower,
    reducedMotion: o.reducedMotion,
    editorHost: o.editorHost,
    ...(o.deps.clipboard ? { clipboard: o.deps.clipboard } : {}),
  });
  const sync = createCanvasSync(ydoc, awareness, {
    url: () => canvasSyncUrl(o.deps.serverUrl(), o.canvasId),
    getToken: o.deps.getToken,
    ...(o.deps.refreshToken ? { refreshToken: o.deps.refreshToken } : {}),
    createSocket: o.deps.createSocket,
    readOnly: o.readOnly,
    title: o.title,
    onTooLarge: o.onTooLarge,
    onFatal: o.onFatal,
  });
  const port: SyncEnginePort = {
    setPeers: (peers) => {
      engine.setPeers(peers);
      o.presence.set(peers);
    },
    onLocalAwareness: (fn) => engine.onLocalAwareness(fn),
    onLocalView: (fn) => engine.onLocalView(fn),
    setReadOnly: (on) => engine.setReadOnly(on),
  };
  const user: CanvasUser = { id: me.id, name: me.name, color: o.color(me.id) };
  const binding = bindCanvasSync({ doc: ydoc, awareness, sync, engine: port, user, readOnly: o.readOnly });

  let closed = false;
  return {
    ydoc,
    awareness,
    sync,
    engine,
    binding,
    destroy() {
      if (closed) return;
      closed = true;
      if (engine.editor.isOpen) engine.editor.commit();
      binding.destroy();
      sync.destroy();
      engine.destroy();
      awareness.destroy();
      ydoc.destroy();
    },
  };
}

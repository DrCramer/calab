/**
 * In-memory stand-ins for the Yjs sync socket (docs/05 «Вики: сокет синхронизации»; the canvas socket
 * speaks the same frames), for unit tests and for the mock server of the Canvas screen (H5):
 *
 * - MockSocket — a SocketLike with manual control: `open()`, `receive()`, `drop()`, the frames it
 *   was asked to send.
 * - MockRelay — a server that behaves like the real relay: token (first text frame) → SNAPSHOT of
 *   its doc, UPDATEs applied and relayed with a seq, AWARENESS relayed, SNAPSHOT_POST stored (and
 *   relayed as a SNAPSHOT when `broadcast`), COMPACT_REQUEST on demand, write without a grant →
 *   close 4003, oversized frames → close 4008. Delivery is synchronous, so tests stay simple.
 *   A viewer socket (`socketFactory({ viewer: true })`, the canvas's public link) gets the SNAPSHOT
 *   as soon as it opens (no token), never AWARENESS; any message from it closes it 4013.
 */
import * as Y from "yjs";
import type { SocketLike } from "./gateway/client";
import {
  decodeFrame,
  encodeAwareness,
  encodeCompactRequest,
  encodeSnapshot,
  encodeUpdate,
  FRAME_AWARENESS,
  FRAME_SNAPSHOT_POST,
  FRAME_UPDATE,
  MAX_FRAME,
  type Frame,
  type SnapshotMeta,
} from "./wiki/frames";

export class MockSocket implements SocketLike {
  binaryType: BinaryType = "blob";
  readyState = 0;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  /** Everything the client sent: the token as a string, frames as bytes. */
  sent: Array<Uint8Array | string> = [];
  /** Close code the client closed with, null while open. */
  closed: number | null = null;
  /** Called with every outbound message (the relay hooks in here). */
  onSend: ((data: Uint8Array | string) => void) | null = null;
  /** Called when the client closes the socket. */
  onClientClose: (() => void) | null = null;

  constructor(readonly url: string) {}

  send(data: ArrayBufferLike | Uint8Array | string): void {
    const d =
      typeof data === "string"
        ? data
        : data instanceof Uint8Array
          ? data.slice()
          : new Uint8Array(data);
    this.sent.push(d);
    this.onSend?.(d);
  }

  close(code = 1000, _reason?: string): void {
    if (this.readyState === 3) return;
    this.closed = code;
    this.readyState = 3;
    this.onClientClose?.();
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  receive(frame: Uint8Array): void {
    if (this.readyState !== 1) return;
    this.onmessage?.({
      data: frame.buffer.slice(
        frame.byteOffset,
        frame.byteOffset + frame.byteLength,
      ),
    } as MessageEvent);
  }

  /** The server side closes (or the network drops: 1006). */
  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code } as CloseEvent);
  }

  /** Decoded outbound frames (the token text frame excluded). */
  frames(): Frame[] {
    return this.sent
      .filter((d): d is Uint8Array => typeof d !== "string")
      .map((d) => decodeFrame(d) as Frame);
  }
}

export interface RelayPost {
  throughSeq: number;
  meta: SnapshotMeta;
  broadcast: boolean;
  state: Uint8Array;
}

interface Conn {
  socket: MockSocket;
  canWrite: boolean;
  authed: boolean;
  viewer: boolean;
}

export interface RelayOptions {
  /** Tokens accepted; default: any non-empty one. */
  accept?: (token: string) => boolean;
}

export class MockRelay {
  /** The authoritative document (the server stores bytes; the mock keeps a doc for convenience). */
  readonly doc = new Y.Doc();
  /** Sequence of the last stored update. */
  seq = 0;
  /** The stored SNAPSHOT_POSTs in arrival order. */
  readonly posts: RelayPost[] = [];
  /** Frames the relay refused (oversized etc.), for assertions. */
  readonly violations: string[] = [];
  private readonly conns = new Set<Conn>();
  private readonly opts: RelayOptions;

  constructor(opts: RelayOptions = {}) {
    this.opts = opts;
  }

  /** `createSocket` for a client: its socket opens on a microtask and talks to this relay. */
  socketFactory(grant: { canWrite?: boolean; viewer?: boolean } = {}): (url: string) => MockSocket {
    return (url) => {
      const socket = new MockSocket(url);
      const viewer = grant.viewer ?? false;
      const conn: Conn = {
        socket,
        canWrite: !viewer && (grant.canWrite ?? true),
        authed: false,
        viewer,
      };
      this.conns.add(conn);
      socket.onSend = (d) => this.onMessage(conn, d);
      socket.onClientClose = () => this.conns.delete(conn);
      queueMicrotask(() => {
        socket.open();
        if (viewer && socket.readyState === 1) {
          conn.authed = true;
          socket.receive(encodeSnapshot(this.seq, Y.encodeStateAsUpdate(this.doc)));
        }
      });
      return socket;
    };
  }

  /** Number of connected (authed) sockets. */
  get size(): number {
    let n = 0;
    for (const c of this.conns) if (c.authed && c.socket.readyState === 1) n++;
    return n;
  }

  /** Asks every socket (or just `only`) to post a snapshot (the server's compaction trigger). */
  requestCompaction(only?: MockSocket): void {
    for (const c of this.conns) {
      if (c.authed && (!only || c.socket === only)) c.socket.receive(encodeCompactRequest());
    }
  }

  /** Closes every socket as the server would (e.g. 4003 after the access was revoked). */
  dropAll(code = 1006): void {
    for (const c of [...this.conns]) {
      c.socket.drop(code);
      this.conns.delete(c);
    }
  }

  /** Changes a socket's write grant (the server re-checks access: the next write closes 4003). */
  setGrant(index: number, canWrite: boolean): void {
    const c = [...this.conns][index];
    if (c) c.canWrite = canWrite;
  }

  private onMessage(conn: Conn, d: Uint8Array | string): void {
    if (conn.viewer) {
      this.violations.push("a viewer sent a frame");
      conn.socket.drop(4013);
      this.conns.delete(conn);
      return;
    }
    if (typeof d === "string") {
      if (conn.authed) return;
      if (!d || (this.opts.accept && !this.opts.accept(d))) {
        conn.socket.drop(4004);
        this.conns.delete(conn);
        return;
      }
      conn.authed = true;
      conn.socket.receive(encodeSnapshot(this.seq, Y.encodeStateAsUpdate(this.doc)));
      return;
    }
    if (!conn.authed) return;
    if (d.length > MAX_FRAME && d[0] !== FRAME_SNAPSHOT_POST) {
      this.violations.push(`frame ${d[0]} of ${d.length} bytes`);
      conn.socket.drop(4008);
      this.conns.delete(conn);
      return;
    }
    const f = decodeFrame(d);
    if (!f) return;
    switch (f.type) {
      case FRAME_UPDATE:
      case FRAME_SNAPSHOT_POST:
        if (!conn.canWrite) {
          this.violations.push("write without a grant");
          conn.socket.drop(4003);
          this.conns.delete(conn);
          return;
        }
        if (f.type === FRAME_UPDATE) {
          Y.applyUpdate(this.doc, f.update);
          this.seq++;
          this.relay(conn, encodeUpdate(f.update, this.seq));
        } else {
          this.posts.push({
            throughSeq: f.throughSeq,
            meta: f.meta,
            broadcast: f.broadcast,
            state: f.state,
          });
          if (f.broadcast) {
            Y.applyUpdate(this.doc, f.state);
            this.relay(conn, encodeSnapshot(0, f.state));
          }
        }
        return;
      case FRAME_AWARENESS:
        this.relay(conn, encodeAwareness(f.update));
        return;
      default:
        return;
    }
  }

  private relay(from: Conn, frame: Uint8Array): void {
    for (const c of this.conns) {
      if (c === from || !c.authed || (c.viewer && frame[0] === FRAME_AWARENESS)) continue;
      c.socket.receive(frame);
    }
  }
}

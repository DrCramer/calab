/**
 * Canvas in the mock (ADR-0126, proto/calaba/v1/canvas.proto): the tree of folders and canvases of
 * a workspace with per-item access (the real TS rule `canvasItemPermissions` over the item's chain),
 * the trash, versions, take-over, the trash retention — and the sync socket
 * `GET /api/canvas/items/{id}/sync` speaking lib/wiki/frames.ts (the same frames 0–4 as the Wiki):
 * token as the first text frame, SNAPSHOT + stored UPDATEs on connect, UPDATEs get a seq and go to
 * every socket of the canvas (the sender too), AWARENESS to the others, SNAPSHOT_POST compacts
 * silently (relayed as SNAPSHOT only with `broadcast`). The in-memory twin for unit tests of the
 * client is lib/ySyncMock.ts (MockRelay); this class is the same relay over a real `ws` socket.
 * Routes, the CANVAS_ITEM_* fan-out and the socket upgrade are wired in mock-server.ts.
 *
 * Simplifications against the server: no TrashSweep, no post budget / rate limits, no activity
 * journal (the lists are empty), a version only where a fixture adds it (the server saves one per
 * 10 minutes of edits), bots are not refused.
 */
import { create } from '@bufbuild/protobuf';
import { timestampMs, type Timestamp } from '@bufbuild/protobuf/wkt';
import {
  CANVAS_BITS,
  CanvasItemKind,
  CanvasItemSchema,
  CanvasPermissionEntrySchema,
  CanvasVersionSchema,
  ErrorCode,
  WorkspaceRole,
  canvasItemPermissions,
  canvasStructureAllowed,
  treeLevel,
  type CanvasItem,
  type CanvasPermissionEntry,
  type CanvasVersion,
  type Role,
} from '@calaba/protocol';
import type { WebSocket } from 'ws';
import * as Y from 'yjs';
import { CanvasDoc } from '../src/renderer/lib/canvas/doc';
import { canvasPlainText } from '../src/renderer/lib/canvas/plainText';
import { decodeFrame, encodeAwareness, encodeCompactRequest, encodeSnapshot, encodeUpdate, FRAME_AWARENESS, FRAME_SNAPSHOT_POST, FRAME_UPDATE } from '../src/renderer/lib/wiki/frames';
import type { MemberRec, MockState } from './fixtures';

export class CanvasError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly field = '',
  ) {
    super(message);
  }
}

const notFound = (): CanvasError => new CanvasError(404, ErrorCode.NOT_FOUND, 'canvas item not found');
const forbidden = (what: string): CanvasError => new CanvasError(403, ErrorCode.FORBIDDEN, what);
const conflict = (what: string): CanvasError => new CanvasError(409, ErrorCode.CONFLICT, what);

export interface CanvasDeps {
  state: MockState;
  member: (wsId: string, userId: string) => MemberRec | undefined;
  rolesOf: (m: MemberRec) => Role[];
  tick: () => Timestamp;
  nextId: () => string;
  /** `bitsOf(userId)`: the recipient's canvas bits on the item (0 = not delivered); the gateway puts them in my_bits. */
  emit: (wsId: string, item: CanvasItem, removed: boolean, bitsOf: (userId: string) => bigint) => void;
}

/** One canvas's live document: the snapshot, the updates after it, the open sockets. */
interface DocRoom {
  state: Uint8Array;
  throughSeq: number;
  seq: number;
  updates: Array<{ seq: number; update: Uint8Array }>;
  sockets: Set<{ ws: WebSocket; uid: string; write: boolean }>;
}

const V = CANVAS_BITS.VIEW;
const W = CANVAS_BITS.WRITE | CANVAS_BITS.MANAGE;
const EMPTY_STATE = Y.encodeStateAsUpdate(new Y.Doc());

/** A Yjs state of a canvas built with the engine's own document API (fixtures). */
export function canvasState(build: (d: CanvasDoc) => void): Uint8Array {
  const ydoc = new Y.Doc();
  const d = new CanvasDoc(ydoc);
  d.ensureSchema();
  build(d);
  const state = Y.encodeStateAsUpdate(ydoc);
  d.destroy();
  ydoc.destroy();
  return state;
}

export class CanvasMock {
  readonly items = new Map<string, CanvasItem>();
  readonly perms = new Map<string, CanvasPermissionEntry[]>();
  readonly versions = new Map<string, Array<{ v: CanvasVersion; state: Uint8Array }>>();
  readonly docs = new Map<string, DocRoom>();
  readonly trashDays = new Map<string, number>();

  constructor(private readonly d: CanvasDeps) {}

  // ---------------------------------------------------------------- rights

  private chainOf(p: CanvasItem): CanvasItem[] {
    const out: CanvasItem[] = [];
    let cur: CanvasItem | undefined = p;
    for (let i = 0; cur && i < 40; i++) {
      out.unshift(cur);
      cur = cur.parentId ? this.items.get(cur.parentId) : undefined;
    }
    return out;
  }

  bitsOf(p: CanvasItem | null, wsId: string, uid: string): bigint {
    const m = this.d.member(wsId, uid);
    if (!m) return 0n;
    const chain = p ? this.chainOf(p).map((x) => treeLevel(x, this.perms.get(x.id) ?? [], uid)) : [];
    return canvasItemPermissions(this.d.rolesOf(m), chain, { guest: m.role === WorkspaceRole.GUEST });
  }

  private out(p: CanvasItem, uid: string): CanvasItem {
    const hasChildren = [...this.items.values()].some((c) => c.parentId === p.id && !c.trashedAt && this.bitsOf(c, c.workspaceId, uid) & V);
    return create(CanvasItemSchema, { ...p, myBits: this.bitsOf(p, p.workspaceId, uid), shared: (this.perms.get(p.id)?.length ?? 0) > 0, hasChildren });
  }

  private visible(id: string, uid: string): CanvasItem {
    const p = this.items.get(id);
    if (!p || !(this.bitsOf(p, p.workspaceId, uid) & V)) throw notFound();
    return p;
  }

  private writable(id: string, uid: string): CanvasItem {
    const p = this.visible(id, uid);
    if (!(this.bitsOf(p, p.workspaceId, uid) & W)) throw forbidden('CANVAS_WRITE required');
    return p;
  }

  private structural(id: string, uid: string): CanvasItem {
    const p = this.visible(id, uid);
    if (!canvasStructureAllowed(this.bitsOf(p, p.workspaceId, uid), p.ownerId === uid)) throw forbidden('the owner or CANVAS_MANAGE');
    return p;
  }

  private emit(p: CanvasItem, removed = false): void {
    this.d.emit(p.workspaceId, p, removed, (u) => this.bitsOf(p, p.workspaceId, u));
  }

  private siblings(wsId: string, parentId: string, except = ''): CanvasItem[] {
    return [...this.items.values()].filter((p) => p.workspaceId === wsId && p.parentId === parentId && !p.trashedAt && p.id !== except).sort((a, b) => a.position - b.position);
  }

  private renumber(wsId: string, parentId: string): void {
    this.siblings(wsId, parentId).forEach((p, i) => {
      if (p.position !== i) this.items.set(p.id, { ...p, position: i });
    });
  }

  private subtree(id: string): CanvasItem[] {
    const out: CanvasItem[] = [];
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop() as string;
      const p = this.items.get(cur);
      if (p) out.push(p);
      for (const c of this.items.values()) if (c.parentId === cur) stack.push(c.id);
    }
    return out;
  }

  /** The parent of a new / moved item: a live folder I can write in (the server: 404 / 403 / 409). */
  private folder(parentId: string, wsId: string, uid: string): void {
    const parent = this.writable(parentId, uid);
    if (parent.workspaceId !== wsId || parent.trashedAt) throw notFound();
    if (parent.kind !== CanvasItemKind.FOLDER) throw conflict('only a folder can be a parent');
  }

  // ---------------------------------------------------------------- tree

  /** Inserts a fixture (no rights, no events); `build` seeds a canvas's document. */
  put(init: Omit<Partial<CanvasItem>, '$typeName' | '$unknown'> & { workspaceId: string; name: string; ownerId: string }, build?: (d: CanvasDoc) => void): CanvasItem {
    const id = init.id ?? this.d.nextId();
    const position = init.position ?? this.siblings(init.workspaceId, init.parentId ?? '').length;
    const at = init.updatedAt ?? this.d.tick();
    const kind = init.kind ?? CanvasItemKind.CANVAS;
    const p = create(CanvasItemSchema, { createdAt: at, updatedAt: at, updatedBy: init.ownerId, ...init, kind, id, position });
    this.items.set(id, p);
    if (build && kind === CanvasItemKind.CANVAS) {
      const state = canvasState(build);
      const ydoc = new Y.Doc();
      Y.applyUpdate(ydoc, state);
      const plain = canvasPlainText(ydoc);
      ydoc.destroy();
      this.items.set(id, { ...p, preview: init.preview ?? plain.slice(0, 200), docSize: state.length });
      this.docs.set(id, { state, throughSeq: 0, seq: 0, updates: [], sockets: new Set() });
    }
    return this.items.get(id) as CanvasItem;
  }

  list(wsId: string, uid: string, p: { parent: string; trashed: boolean }): CanvasItem[] {
    if (!this.d.member(wsId, uid)) throw notFound();
    if (p.parent && !p.trashed) {
      const parent = this.visible(p.parent, uid);
      if (parent.kind !== CanvasItemKind.FOLDER) throw conflict('a canvas has no children');
    }
    const ms = (t?: Timestamp): number => (t ? timestampMs(t) : 0);
    const all = p.trashed
      ? [...this.items.values()].filter((x) => x.workspaceId === wsId && !!x.trashedAt && x.trashedRoot).sort((a, b) => ms(b.trashedAt) - ms(a.trashedAt))
      : this.siblings(wsId, p.parent);
    return all.filter((x) => this.bitsOf(x, wsId, uid) & V).map((x) => this.out(x, uid));
  }

  /** `GET /api/search?type=canvas&scope=<ws>&q=`: live items whose name or text (the preview) contain q, that I see. */
  search(wsId: string, uid: string, q: string, limit: number): CanvasItem[] {
    if (!this.d.member(wsId, uid)) return [];
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    return [...this.items.values()]
      .filter((x) => x.workspaceId === wsId && !x.trashedAt && this.bitsOf(x, wsId, uid) & V && `${x.name}\n${x.preview}`.toLowerCase().includes(needle))
      .slice(0, limit)
      .map((x) => this.out(x, uid));
  }

  /** The names of an item's ancestors, the top-level one first (a search hit's `path`; the item itself is not in it). */
  ancestorNames(p: CanvasItem): string[] {
    return this.chainOf(p).slice(0, -1).map((x) => x.name);
  }

  get(id: string, uid: string): CanvasItem {
    return this.out(this.visible(id, uid), uid);
  }

  path(id: string, uid: string): CanvasItem[] {
    return this.chainOf(this.visible(id, uid)).map((x) => this.out(x, uid));
  }

  create(wsId: string, uid: string, b: { parentId: string; kind: CanvasItemKind; name: string }): CanvasItem {
    if (b.kind !== CanvasItemKind.FOLDER && b.kind !== CanvasItemKind.CANVAS) throw new CanvasError(422, ErrorCode.VALIDATION, 'kind is required', 'kind');
    if (b.parentId) this.folder(b.parentId, wsId, uid);
    else if (!(this.bitsOf(null, wsId, uid) & W)) throw forbidden('CANVAS_WRITE required');
    const p = this.put({ workspaceId: wsId, parentId: b.parentId, kind: b.kind, name: b.name.trim().slice(0, 200), ownerId: uid }, b.kind === CanvasItemKind.CANVAS ? () => undefined : undefined);
    this.emit(p);
    return this.out(p, uid);
  }

  update(id: string, uid: string, b: { name?: string | undefined; parentId?: string | undefined; position?: number | undefined; restricted?: boolean | undefined }): CanvasItem {
    const p = this.structural(id, uid);
    let next: CanvasItem = { ...p, updatedAt: this.d.tick(), updatedBy: uid };
    if (b.name !== undefined) next.name = b.name.trim().slice(0, 200);
    if (b.restricted !== undefined) next.restricted = b.restricted;
    if (b.parentId !== undefined || b.position !== undefined) {
      const parentId = b.parentId ?? p.parentId;
      if (parentId) {
        this.folder(parentId, p.workspaceId, uid);
        if (this.chainOf(this.items.get(parentId) as CanvasItem).some((x) => x.id === id)) throw conflict('an item cannot move into itself'); // 409 on the server (H8 walk)
      }
      const sib = this.siblings(p.workspaceId, parentId, id);
      const at = Math.max(0, Math.min(sib.length, b.position ?? sib.length));
      sib.splice(at, 0, { ...next, parentId });
      sib.forEach((s, i) => this.items.set(s.id, s.id === id ? { ...next, parentId, position: i } : { ...s, position: i }));
      if (parentId !== p.parentId) this.renumber(p.workspaceId, p.parentId);
      next = this.items.get(id) ?? next;
    }
    this.items.set(id, next);
    this.emit(next);
    return this.out(next, uid);
  }

  trash(id: string, uid: string): CanvasItem {
    const p = this.structural(id, uid);
    const at = this.d.tick();
    for (const x of this.subtree(id)) if (!x.trashedAt) this.items.set(x.id, { ...x, trashedAt: at, trashedBy: uid, trashedRoot: x.id === id });
    this.renumber(p.workspaceId, p.parentId);
    const next = this.items.get(id) as CanvasItem;
    this.emit(next);
    return this.out(next, uid);
  }

  restore(id: string, uid: string): CanvasItem {
    const p = this.structural(id, uid);
    if (!p.trashedRoot) throw notFound();
    const parentGone = p.parentId && (!this.items.get(p.parentId) || this.items.get(p.parentId)?.trashedAt);
    for (const x of this.subtree(id)) if (x.trashedAt && timestampMs(x.trashedAt) === timestampMs(p.trashedAt as Timestamp)) this.items.set(x.id, { ...x, trashedAt: undefined, trashedBy: '', trashedRoot: false });
    const cur = this.items.get(id) as CanvasItem;
    const next = { ...cur, parentId: parentGone ? '' : cur.parentId, position: this.siblings(cur.workspaceId, parentGone ? '' : cur.parentId, id).length };
    this.items.set(id, next);
    this.emit(next);
    return this.out(next, uid);
  }

  remove(id: string, uid: string): void {
    const p = this.structural(id, uid);
    if (!p.trashedAt) throw conflict('only an item in the trash can be deleted forever'); // 409 on the server (H8 walk)
    for (const x of this.subtree(id)) {
      this.items.delete(x.id);
      this.docs.delete(x.id);
      this.versions.delete(x.id);
    }
    this.emit(p, true);
  }

  emptyTrash(wsId: string, uid: string): number {
    let n = 0;
    for (const p of [...this.items.values()]) {
      if (p.workspaceId !== wsId || !p.trashedRoot || !this.items.has(p.id)) continue;
      try {
        this.remove(p.id, uid);
        n++;
      } catch {
        // not mine
      }
    }
    return n;
  }

  permissions(id: string, uid: string): { entries: CanvasPermissionEntry[]; restricted: boolean } {
    const p = this.structural(id, uid);
    return { entries: this.perms.get(id) ?? [], restricted: p.restricted };
  }

  setPermissions(id: string, uid: string, entries: readonly CanvasPermissionEntry[], restricted?: boolean): void {
    const p = this.structural(id, uid);
    this.perms.set(id, entries.map((e) => create(CanvasPermissionEntrySchema, e)));
    const next = { ...p, restricted: restricted ?? p.restricted };
    this.items.set(id, next);
    this.emit(next);
  }

  /** «Сделать меня владельцем»: the workspace owner takes over a private item whose owner is not a member any more. */
  takeOver(id: string, uid: string): CanvasItem {
    const p = this.visible(id, uid);
    if (this.d.state.workspaces.get(p.workspaceId)?.ownerId !== uid) throw forbidden('only the workspace owner takes over');
    if (this.d.member(p.workspaceId, p.ownerId)) throw conflict("the item's owner is still a member of the workspace");
    if (!p.restricted) throw conflict('only a private item can be taken over');
    const next = { ...p, ownerId: uid };
    this.items.set(id, next);
    this.emit(next);
    return this.out(next, uid);
  }

  listVersions(id: string, uid: string): CanvasVersion[] {
    this.visible(id, uid);
    return (this.versions.get(id) ?? []).map((x) => x.v);
  }

  versionState(id: string, vid: string, uid: string): Uint8Array {
    this.visible(id, uid);
    const v = this.versions.get(id)?.find((x) => x.v.id === vid);
    if (!v) throw notFound();
    return v.state;
  }

  addVersion(canvasId: string, build: (d: CanvasDoc) => void, authorIds: string[], createdAt: Timestamp): void {
    const state = canvasState(build);
    const v = create(CanvasVersionSchema, { id: this.d.nextId(), canvasId, authorIds, createdAt, size: state.length });
    this.versions.set(canvasId, [{ v, state }, ...(this.versions.get(canvasId) ?? [])]);
  }

  settings(wsId: string, uid: string): number {
    if (!(this.bitsOf(null, wsId, uid) & V)) throw notFound();
    return this.trashDays.get(wsId) ?? 0;
  }

  setSettings(wsId: string, uid: string, days: number): void {
    if (!(this.bitsOf(null, wsId, uid) & CANVAS_BITS.MANAGE)) throw forbidden('CANVAS_MANAGE required');
    this.trashDays.set(wsId, days);
  }

  // ---------------------------------------------------------------- the sync socket

  /** A socket on `/api/canvas/items/{id}/sync`; `auth` maps the first text frame (the token) to a user. */
  connect(ws: WebSocket, canvasId: string, auth: (token: string) => string | null): void {
    let sock: { ws: WebSocket; uid: string; write: boolean } | null = null;
    ws.binaryType = 'nodebuffer';
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (!sock) {
        if (isBinary) { ws.close(4004, 'token first'); return; }
        const uid = auth(data.toString('utf8'));
        if (!uid) { ws.close(4004, 'bad token'); return; }
        const p = this.items.get(canvasId);
        // Only a live canvas has a socket: a folder, a trashed or a missing item closes 4404.
        if (!p || p.kind !== CanvasItemKind.CANVAS || p.trashedAt) { ws.close(4404, 'no canvas'); return; }
        const bits = this.bitsOf(p, p.workspaceId, uid);
        if (!(bits & V)) { ws.close(4003, 'no access'); return; }
        const room = this.room(canvasId);
        sock = { ws, uid, write: (bits & W) !== 0n };
        room.sockets.add(sock);
        ws.send(encodeSnapshot(room.throughSeq, room.state));
        for (const u of room.updates) ws.send(encodeUpdate(u.update, u.seq));
        return;
      }
      if (!isBinary) return;
      const f = decodeFrame(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      if (!f) return;
      const room = this.room(canvasId);
      const me = sock;
      // A write frame from a socket without CANVAS_WRITE: the server closes 4003; its awareness is dropped.
      if ((f.type === FRAME_UPDATE || f.type === FRAME_SNAPSHOT_POST) && !me.write) {
        ws.close(4003, 'read only');
      } else if (f.type === FRAME_UPDATE) {
        const seq = ++room.seq;
        const update = f.update.slice();
        room.updates.push({ seq, update });
        const frame = encodeUpdate(update, seq);
        for (const s of room.sockets) s.ws.send(frame);
      } else if (f.type === FRAME_AWARENESS && me.write) {
        const frame = encodeAwareness(f.update.slice());
        for (const s of room.sockets) if (s !== me) s.ws.send(frame);
      } else if (f.type === FRAME_SNAPSHOT_POST) {
        if (f.throughSeq < room.throughSeq) {
          ws.send(encodeCompactRequest());
          return;
        }
        room.state = f.state.slice();
        room.throughSeq = f.throughSeq;
        room.updates = room.updates.filter((u) => u.seq > f.throughSeq);
        const p = this.items.get(canvasId);
        if (p) {
          const next = { ...p, preview: f.meta.preview, docSize: room.state.length, updatedAt: this.d.tick(), updatedBy: me.uid };
          this.items.set(canvasId, next);
          this.emit(next);
        }
        if (f.broadcast) {
          const frame = encodeSnapshot(room.throughSeq, room.state);
          for (const s of room.sockets) if (s !== me) s.ws.send(frame);
        }
      }
    });
    ws.on('close', () => {
      if (sock) this.docs.get(canvasId)?.sockets.delete(sock);
    });
  }

  private room(canvasId: string): DocRoom {
    let r = this.docs.get(canvasId);
    if (!r) {
      r = { state: EMPTY_STATE, throughSeq: 0, seq: 0, updates: [], sockets: new Set() };
      this.docs.set(canvasId, r);
    }
    return r;
  }

  /** Closes every sync socket (reset / shutdown). */
  closeAll(): void {
    for (const r of this.docs.values()) for (const s of r.sockets) s.ws.terminate();
  }
}

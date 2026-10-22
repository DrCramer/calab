/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument -- the REST answers are protojson read as it comes (the wire shapes are checked by services/canvas.wire.test.ts) */
// eslint-disable-next-line no-restricted-imports -- a Node-only test (the fixtures dump), never part of the renderer
import { mkdirSync, writeFileSync } from "node:fs";
import { fromJson, type JsonValue } from "@bufbuild/protobuf";
import { CanvasVersionsResponseSchema } from "@calaba/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { CanvasDoc } from "./canvas/doc";
import { restoreCanvasState } from "./canvas/restore";
import { canWrite } from "./canvas/tree";
import { canvasSyncUrl, CanvasSync, type CanvasSyncStatus } from "./canvasSync";
import {
  encodeSnapshotPost,
  encodeUpdate,
  FRAME_COMPACT_REQUEST,
  FRAME_SNAPSHOT,
} from "./wiki/frames";

/**
 * H8 (docs/plans/canvas-v1-tasks.md): the real client — lib/canvasSync.ts over lib/ySync.ts with the
 * engine's document model (lib/canvas/doc.ts) — against a live Go server, two or three people on one
 * canvas. Needs no browser: Node's own WebSocket is the socket. Off by default (CI and a plain
 * `pnpm test` skip it); how to start the server: docs/plans/canvas-v1-tasks.md «Проверка H8».
 *
 *   CALABA_CANVAS_LIVE=1 CALABA_LIVE_BASE=http://127.0.0.1:3078 pnpm -F @calaba/desktop exec vitest run canvasSync.live
 *
 * The server must run with REGISTRATION_MODE=open (the test registers its own people, a workspace and
 * canvases). CALABA_CANVAS_DUMP=<dir> also saves the answers that need a document (the versions, the
 * list after a compactions, the text search) as fixtures of services/canvas.wire.test.ts.
 */
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const LIVE = env.CALABA_CANVAS_LIVE === "1";
const BASE = env.CALABA_LIVE_BASE ?? "http://127.0.0.1:3078";
const DUMP = env.CALABA_CANVAS_DUMP ?? "";

const VIEW = 1n << 41n;
const WRITE = 1n << 42n;

// ---------------------------------------------------------------- REST

interface Person {
  id: string;
  token: string;
  name: string;
}

interface Answer {
  status: number;
  json: any;
}

async function rest(token: string, method: string, path: string, body?: unknown): Promise<Answer> {
  const res = await fetch(BASE + path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  try {
    return { status: res.status, json: text ? JSON.parse(text) : null };
  } catch {
    return { status: res.status, json: text };
  }
}

async function ok(token: string, method: string, path: string, body?: unknown): Promise<any> {
  const a = await rest(token, method, path, body);
  if (a.status >= 300) throw new Error(`${method} ${path}: ${a.status} ${JSON.stringify(a.json)}`);
  return a.json;
}

const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

async function register(name: string): Promise<Person> {
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `h8-${name}-${uniq}@example.com`, password: "h8-password-1", displayName: name }),
  });
  if (!res.ok) throw new Error(`register ${name}: ${res.status} ${await res.text()}`);
  const j = (await res.json()) as { tokens: { accessToken: string }; me: { user: { id: string } } };
  return { id: j.me.user.id, token: j.tokens.accessToken, name };
}

function dump(name: string, json: unknown): void {
  if (!DUMP) return;
  mkdirSync(DUMP, { recursive: true });
  writeFileSync(`${DUMP}/${name}.json`, JSON.stringify(json, null, 2) + "\n");
}

// ---------------------------------------------------------------- clients

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(what: string, cond: () => boolean | Promise<boolean>, ms = 10_000, step = 20): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - t0 > ms) throw new Error(`timeout (${ms} ms): ${what}`);
    await sleep(step);
  }
}

/** Resolves (in ms) as soon as `cond` holds, checked on every update of `ydoc` — the latency to the millisecond. */
function arrival(ydoc: Y.Doc, cond: () => boolean, ms = 10_000): Promise<number> {
  const t0 = performance.now();
  return new Promise((resolve, reject) => {
    if (cond()) {
      resolve(0);
      return;
    }
    const timer = setTimeout(() => {
      ydoc.off("update", on);
      reject(new Error("timeout waiting for the update"));
    }, ms);
    const on = (): void => {
      if (!cond()) return;
      clearTimeout(timer);
      ydoc.off("update", on);
      resolve(performance.now() - t0);
    };
    ydoc.on("update", on);
  });
}

/** The socket the app would create (the browser's WebSocket); the test keeps it to close it and to log frames. */
interface Wire {
  sockets: WebSocket[];
  frames: number[]; // types of the frames received (first byte)
}

interface Client {
  person: Person;
  ydoc: Y.Doc;
  awareness: Awareness;
  doc: CanvasDoc;
  sync: CanvasSync;
  wire: Wire;
  statuses: CanvasSyncStatus[];
  fatal: number[];
  tooLarge: number[];
  close(): void;
}

let counter = 0;

function open(canvasId: string, person: Person, opts: { readOnly?: boolean; token?: string } = {}): Client {
  const ydoc = new Y.Doc();
  const awareness = new Awareness(ydoc);
  const n = ++counter;
  const doc = new CanvasDoc(ydoc, { makeId: () => `${person.name[0]}${n}-${Math.random().toString(36).slice(2, 8)}` });
  const wire: Wire = { sockets: [], frames: [] };
  const statuses: CanvasSyncStatus[] = [];
  const fatal: number[] = [];
  const tooLarge: number[] = [];
  const sync = new CanvasSync(ydoc, awareness, {
    url: () => canvasSyncUrl(BASE, canvasId),
    getToken: () => Promise.resolve(opts.token ?? person.token),
    createSocket: (url) => {
      const ws = new WebSocket(url);
      ws.addEventListener("message", (ev) => {
        const d = ev.data;
        if (d instanceof ArrayBuffer && d.byteLength > 0) wire.frames.push(new Uint8Array(d)[0] ?? -1);
      });
      wire.sockets.push(ws);
      return ws;
    },
    ...(opts.readOnly === undefined ? {} : { readOnly: opts.readOnly }),
    onFatal: (c) => fatal.push(c),
    onTooLarge: (b) => tooLarge.push(b),
    random: () => 0,
  });
  sync.subscribe((s) => statuses.push(s));
  return {
    person, ydoc, awareness, doc, sync, wire, statuses, fatal, tooLarge,
    close: () => {
      sync.destroy();
      awareness.destroy();
    },
  };
}

const synced = (c: Client, ms = 10_000): Promise<void> => waitFor(`${c.person.name} synced`, () => c.sync.isSynced, ms);

/** Plain JSON of the objects with sorted keys: two converged documents give the same string. */
function canon(v: unknown): string {
  if (v instanceof Y.AbstractType) return canon(v.toJSON());
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}
const objectsOf = (c: Client): string => canon(c.ydoc.getMap("objects"));
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

async function converge(...cs: Client[]): Promise<void> {
  const [first, ...rest] = cs;
  if (!first) return;
  await waitFor(
    "documents converge",
    () => rest.every((c) => objectsOf(c) === objectsOf(first) && sameBytes(Y.encodeStateVector(c.ydoc), Y.encodeStateVector(first.ydoc))),
    10_000,
  );
  for (const c of rest) {
    expect(objectsOf(c)).toBe(objectsOf(first));
    expect(Y.equalSnapshots(Y.snapshot(c.ydoc), Y.snapshot(first.ydoc))).toBe(true); // state vector and delete set
  }
}

/** A raw socket (no provider): the first text frame is the token; used to look at the server's side of the protocol. */
function raw(canvasId: string, token: string): { ws: WebSocket; frames: Uint8Array[]; closed: Promise<{ code: number; reason: string }> } {
  const ws = new WebSocket(canvasSyncUrl(BASE, canvasId));
  ws.binaryType = "arraybuffer";
  const frames: Uint8Array[] = [];
  ws.addEventListener("open", () => ws.send(token));
  ws.addEventListener("message", (ev) => {
    if (ev.data instanceof ArrayBuffer) frames.push(new Uint8Array(ev.data));
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => ws.addEventListener("close", (ev) => resolve({ code: ev.code, reason: ev.reason })));
  return { ws, frames, closed };
}

const stats = (xs: number[]): string => {
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number): number => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
  return `n=${s.length} min=${s[0]?.toFixed(0)} median=${at(0.5).toFixed(0)} p90=${at(0.9).toFixed(0)} max=${s[s.length - 1]?.toFixed(0)} ms`;
};

// ---------------------------------------------------------------- the scenario

describe.skipIf(!LIVE)("Canvas sync against a live server (H8)", () => {
  let alice: Person; // the workspace owner
  let bob: Person; // a member
  let carol: Person; // a member, view only on the canvases made for it
  let dave: Person; // not in the workspace
  let ws = "";
  const open_: Client[] = [];
  const track = (c: Client): Client => {
    open_.push(c);
    return c;
  };

  /** A new canvas of Alice's (and, with `viewOnly`, Carol may only view it). */
  async function mk(name: string, viewOnly = false): Promise<string> {
    const j = await ok(alice.token, "POST", `/api/workspaces/${ws}/canvas/items`, { parentId: "", kind: "CANVAS_ITEM_KIND_CANVAS", name });
    const id = j.item.id as string;
    if (viewOnly) {
      await ok(alice.token, "PUT", `/api/canvas/items/${id}/permissions`, {
        entries: [{ targetType: "PERMISSION_TARGET_TYPE_USER", targetId: carol.id, deny: String(WRITE) }],
      });
    }
    return id;
  }

  beforeAll(async () => {
    [alice, bob, carol, dave] = await Promise.all([register("Alice"), register("Bob"), register("Carol"), register("Dave")]);
    const w = await ok(alice.token, "POST", "/api/workspaces", { slug: `h8l-${uniq}`, name: "H8 live" });
    ws = w.workspace.id;
    for (const p of [bob, carol]) {
      const inv = await ok(alice.token, "POST", `/api/workspaces/${ws}/invites`, {});
      await ok(p.token, "POST", `/api/invites/${inv.invite.code}/join`);
    }
  }, 30_000);

  afterAll(() => {
    for (const c of open_) {
      try {
        c.close();
      } catch {
        // already closed
      }
    }
  });

  it("A creates a sticky, a shape and a connector: B sees them, both documents are byte-identical", async () => {
    const id = await mk("convergence");
    const a = track(open(id, alice));
    const b = track(open(id, bob));
    await Promise.all([synced(a), synced(b)]);
    expect(a.sync.status).toBe("synced");
    expect(b.sync.status).toBe("synced");
    expect(a.doc.ensureSchema()).toBe(true);
    const sticky = a.doc.create({ kind: "sticky", x: 10, y: 20, text: "Купить молоко" });
    const shape = a.doc.create({ kind: "shape", shape: "ellipse", x: 300, y: 40, text: "Старт" });
    const link = a.doc.create({ kind: "connector", from: { id: sticky ?? "", side: "right" }, to: { id: shape ?? "", side: "left" }, route: "elbow" });
    expect([sticky, shape, link].every(Boolean)).toBe(true);
    await arrival(b.ydoc, () => b.doc.objects.size === 3 && b.doc.getText(sticky ?? "") === "Купить молоко");
    expect(b.doc.snapshot(sticky ?? "")).toMatchObject({ kind: "sticky", x: 10, y: 20, text: "Купить молоко" });
    expect(b.doc.snapshot(shape ?? "")).toMatchObject({ kind: "shape", shape: "ellipse", text: "Старт" });
    expect(b.doc.snapshot(link ?? "")).toMatchObject({ kind: "connector", route: "elbow", from: { id: sticky, side: "right" } });
    expect(b.doc.schema).toBe(1);
    await converge(a, b);
  });

  it("simultaneous edits converge: fields, a deletion against a move, and Y.Text typed at both ends", async () => {
    const id = await mk("concurrent");
    const a = track(open(id, alice));
    const b = track(open(id, bob));
    await Promise.all([synced(a), synced(b)]);
    const s = a.doc.create({ kind: "sticky", x: 0, y: 0, text: "middle" }) ?? "";
    const gone = a.doc.create({ kind: "sticky", x: 5, y: 5, text: "to delete" }) ?? "";
    await arrival(b.ydoc, () => b.doc.objects.size === 2);
    // Both sides edit in the same instant (before any frame can arrive).
    a.doc.patch(s, { x: 111, color: "yellow" });
    a.doc.setText(s, "AAA middle");
    a.doc.create({ kind: "text", x: 1, y: 1, text: "from A" });
    a.doc.patch(gone, { x: 500 });
    b.doc.patch(s, { x: 222, y: 333 });
    b.doc.setText(s, "middle BBB");
    b.doc.create({ kind: "shape", x: 2, y: 2, text: "from B" });
    b.doc.remove([gone]);
    await converge(a, b);
    expect(a.doc.getText(s)).toBe("AAA middle BBB");
    expect(a.doc.count).toBe(3);
    expect(a.doc.objects.has(gone)).toBe(false);
    expect(a.doc.snapshot(s)?.y).toBe(333);
    expect([111, 222]).toContain(a.doc.snapshot(s)?.x); // concurrent writes of one field: one wins, the same one everywhere
    expect(b.doc.snapshot(s)?.x).toBe(a.doc.snapshot(s)?.x);
  });

  it("awareness (cursor, selection, name) reaches the other client and goes away with it", async () => {
    const id = await mk("awareness");
    const a = track(open(id, alice));
    const b = track(open(id, bob));
    await Promise.all([synced(a), synced(b)]);
    const state = { user: { name: "Alice", color: "#3366cc" }, cursor: { x: 12.5, y: -7 }, selection: ["x1"] };
    a.awareness.setLocalState(state);
    await waitFor("Alice's state at Bob", () => b.awareness.getStates().has(a.awareness.clientID));
    expect(b.awareness.getStates().get(a.awareness.clientID)).toEqual(state);
    a.awareness.setLocalStateField("cursor", { x: 99, y: 1 });
    await waitFor("cursor moved at Bob", () => (b.awareness.getStates().get(a.awareness.clientID) as typeof state | undefined)?.cursor.x === 99);
    // The late joiner gets the current state on its first sync.
    const c = track(open(id, bob));
    await synced(c);
    b.awareness.setLocalState({ user: { name: "Bob", color: "#cc6633" } });
    await waitFor("Bob's state at the late joiner", () => c.awareness.getStates().has(b.awareness.clientID));
    // Leaving removes the cursor.
    a.sync.destroy();
    await waitFor("Alice's cursor removed", () => !b.awareness.getStates().has(a.awareness.clientID));
  });

  it("a view-only person: the server closes 4003 on a write, the client shows «readonly» and never writes", async () => {
    const id = await mk("viewonly", true);
    const item = await ok(carol.token, "GET", `/api/canvas/items/${id}`);
    const bits = BigInt(item.item.myBits);
    expect(bits & VIEW).toBe(VIEW);
    expect(canWrite(bits)).toBe(false);
    const a = track(open(id, alice));
    await synced(a);
    const sticky = a.doc.create({ kind: "sticky", x: 1, y: 1, text: "visible to all" }) ?? "";
    // The app: read-only from my_bits.
    const c = track(open(id, carol, { readOnly: !canWrite(bits) }));
    await synced(c);
    expect(c.sync.status).toBe("readonly");
    expect(c.sync.readOnly).toBe(true);
    await arrival(c.ydoc, () => c.doc.objects.has(sticky));
    // Local edits of a read-only client go nowhere (the provider drops them), and nobody else sees them.
    c.doc.create({ kind: "sticky", x: 9, y: 9, text: "ghost" });
    c.sync.flush();
    await sleep(1200);
    expect(a.doc.count).toBe(1);
    expect(c.sync.status).toBe("readonly");
    expect(c.fatal).toEqual([]);
    // A client that wrongly believes it may write: the server closes the socket 4003 on the first UPDATE and the
    // provider stops for good («offline», onFatal(4003)).
    const rogue = track(open(id, carol, { readOnly: false }));
    await synced(rogue);
    expect(rogue.sync.status).toBe("synced");
    rogue.doc.create({ kind: "sticky", x: 7, y: 7, text: "forbidden" });
    await waitFor("4003 for the writer without WRITE", () => rogue.fatal.length > 0);
    expect(rogue.fatal).toEqual([4003]);
    expect(rogue.sync.status).toBe("offline");
    await sleep(300);
    expect(a.doc.count).toBe(1);
    // The raw protocol: UPDATE and SNAPSHOT_POST from a view-only socket both close 4003.
    for (const frame of [encodeUpdate(Y.encodeStateAsUpdate(rogue.ydoc)), encodeSnapshotPost(0, { plain_text: "", title: "", preview: "" }, Y.encodeStateAsUpdate(rogue.ydoc), false)]) {
      const r = raw(id, carol.token);
      await waitFor("snapshot frame", () => r.frames.some((f) => f[0] === FRAME_SNAPSHOT));
      r.ws.send(frame);
      expect((await r.closed).code).toBe(4003);
    }
    // The canvas on the server did not change.
    await sleep(200);
    const fresh = track(open(id, bob));
    await synced(fresh);
    expect(fresh.doc.count).toBe(1);
  });

  it("who may not open it: a private canvas, a non-member, a bot, a folder, a trashed or unknown id", async () => {
    // Bob's private canvas: Alice (workspace owner, «owner sees private» off) gets nothing, not even a socket.
    const priv = (await ok(bob.token, "POST", `/api/workspaces/${ws}/canvas/items`, { parentId: "", kind: "CANVAS_ITEM_KIND_CANVAS", name: "Bob's private" })).item.id as string;
    await ok(bob.token, "PATCH", `/api/canvas/items/${priv}`, { restricted: true });
    expect((await rest(alice.token, "GET", `/api/canvas/items/${priv}`)).status).toBe(404);
    const viaAlice = track(open(priv, alice));
    await waitFor("Alice refused", () => viaAlice.fatal.length > 0);
    expect(viaAlice.fatal).toEqual([4003]);
    expect(viaAlice.sync.status).toBe("offline");
    expect(viaAlice.sync.isSynced).toBe(false);
    const own = track(open(priv, bob));
    await synced(own);
    expect(own.sync.status).toBe("synced");
    // Not a member of the workspace.
    const open1 = await mk("members only");
    const outsider = track(open(open1, dave));
    await waitFor("Dave refused", () => outsider.fatal.length > 0);
    expect(outsider.fatal).toEqual([4003]);
    // A bot: v1 has no bots on the Canvas (ADR-0115).
    const bot = await rest(alice.token, "POST", `/api/workspaces/${ws}/bots`, { displayName: "H8 bot", username: `h8bot_${uniq.replace(/\W/g, "").slice(0, 12)}`, description: "" });
    if (bot.status === 200 || bot.status === 201) {
      const viaBot = track(open(open1, { id: "", token: bot.json.token as string, name: "bot" }));
      await waitFor("bot refused", () => viaBot.fatal.length > 0);
      expect(viaBot.fatal).toEqual([4003]);
    } else {
      console.log(`BOT skipped: POST /bots answered ${bot.status} ${JSON.stringify(bot.json)}`);
    }
    // A folder, an unknown id, a trashed canvas: 4404.
    const folder = (await ok(alice.token, "POST", `/api/workspaces/${ws}/canvas/items`, { parentId: "", kind: "CANVAS_ITEM_KIND_FOLDER", name: "Папка" })).item.id as string;
    const gone = await mk("to trash");
    await ok(alice.token, "POST", `/api/canvas/items/${gone}/trash`);
    for (const target of [folder, "00000000-0000-7000-8000-000000000000", gone]) {
      const c = track(open(target, alice));
      await waitFor(`4404 for ${target}`, () => c.fatal.length > 0);
      expect(c.fatal).toEqual([4404]);
    }
    // A bad token: 4004 (the provider has no refresh here and retries with backoff; the raw socket shows the code).
    const badToken = raw(open1, "not-a-token");
    expect((await badToken.closed).code).toBe(4004);
  });

  it("reconnect: the socket drops, B writes meanwhile, A returns with the snapshot and its own offline edits", async () => {
    const id = await mk("reconnect");
    const a = track(open(id, alice));
    const b = track(open(id, bob));
    await Promise.all([synced(a), synced(b)]);
    const first = a.doc.create({ kind: "sticky", x: 0, y: 0, text: "before" }) ?? "";
    await arrival(b.ydoc, () => b.doc.objects.has(first));
    a.awareness.setLocalState({ user: { name: "Alice" } });
    await waitFor("A's state at B", () => b.awareness.getStates().has(a.awareness.clientID));
    const t0 = performance.now();
    a.wire.sockets[0]?.close(4000, "test drop");
    await waitFor("A offline", () => a.sync.status === "offline");
    // (The server relays awareness but never invents a removal: B keeps A's cursor until the 30 s expiry; destroy() sends one.)
    const fromB = b.doc.create({ kind: "shape", x: 50, y: 50, text: "while A was away" }) ?? "";
    const fromA = a.doc.create({ kind: "text", x: 70, y: 70, text: "typed offline" }) ?? ""; // no socket: kept for the replay
    a.doc.setText(first, "before, edited offline");
    await synced(a, 15_000);
    const back = performance.now() - t0;
    await converge(a, b);
    expect(a.doc.objects.has(fromB)).toBe(true);
    expect(b.doc.objects.has(fromA)).toBe(true);
    expect(b.doc.getText(first)).toBe("before, edited offline");
    expect(a.wire.sockets).toHaveLength(2);
    expect(a.statuses).toContain("connecting");
    expect(a.statuses.at(-1)).toBe("synced");
    // Its cursor is announced again after the reconnect.
    await waitFor("A's cursor back at B", () => b.awareness.getStates().has(a.awareness.clientID));
    console.log(`RECONNECT drop → synced again: ${back.toFixed(0)} ms (backoff 1 s with the test's jitter 0 → 500 ms)`);
  });

  it("compaction by idleness: 3 s after the last edit the item gets size, preview, a version, and the text is searchable", async () => {
    const id = await mk("compaction");
    const a = track(open(id, alice));
    await synced(a);
    const before = (await ok(alice.token, "GET", `/api/canvas/items/${id}`)).item;
    expect(before.docSize ?? 0).toBe(0);
    expect((await ok(alice.token, "GET", `/api/canvas/items/${id}/versions`)).versions ?? []).toHaveLength(0);
    a.doc.ensureSchema();
    a.doc.create({ kind: "sticky", x: 0, y: 0, text: "Купить молоко" });
    a.doc.create({ kind: "shape", x: 200, y: 0, text: "Позвонить в бухгалтерию" });
    const t0 = Date.now();
    await waitFor("snapshot stored", async () => ((await ok(alice.token, "GET", `/api/canvas/items/${id}`)).item.docSize ?? 0) > 0, 15_000, 100);
    const after = (await ok(alice.token, "GET", `/api/canvas/items/${id}`)).item;
    console.log(`COMPACTION idle: size/preview stored ${Date.now() - t0} ms after the last edit (client waits 3 s)`);
    expect(after.docSize).toBeGreaterThan(20);
    expect(after.preview).toContain("Купить молоко");
    expect(after.preview).toContain("Позвонить в бухгалтерию");
    // The first compaction makes the first version; the plain text is what the search finds.
    await waitFor("first version", async () => ((await ok(alice.token, "GET", `/api/canvas/items/${id}/versions`)).versions ?? []).length === 1, 5_000, 100);
    const vers = await ok(alice.token, "GET", `/api/canvas/items/${id}/versions`);
    const parsed = fromJson(CanvasVersionsResponseSchema, vers as JsonValue);
    expect(parsed.versions).toHaveLength(1);
    expect(parsed.versions[0]?.canvasId).toBe(id);
    expect(parsed.versions[0]?.authorIds).toEqual([alice.id]);
    expect(parsed.versions[0]?.size).toBeGreaterThan(20);
    const hit = async (q: string): Promise<any> => rest(alice.token, "GET", `/api/search?q=${encodeURIComponent(q)}&scope=${ws}&type=canvas&limit=20`);
    let found: Answer = { status: 0, json: null };
    await waitFor("search finds the text of an object", async () => {
      found = await hit("бухгалтерию");
      return found.json?.sections?.[0]?.items?.some((i: any) => i.canvas?.itemId === id) === true;
    }, 10_000, 200);
    expect(found.json.sections[0].type).toBe("SEARCH_TYPE_CANVAS");
    dump("search-text", found.json);
    dump("versions", vers);
    // A second compaction changes the preview and the size; within the version interval it makes no new version.
    a.doc.setText(a.doc.orderedIds()[0] ?? "", "Совсем другой текст");
    await waitFor("preview changed", async () => !((await ok(alice.token, "GET", `/api/canvas/items/${id}`)).item.preview ?? "").includes("Купить молоко"), 15_000, 100);
    const again = (await ok(alice.token, "GET", `/api/canvas/items/${id}`)).item;
    expect(again.preview).toContain("Совсем другой текст");
    expect((await ok(alice.token, "GET", `/api/canvas/items/${id}/versions`)).versions).toHaveLength(1);
    const list = await ok(alice.token, "GET", `/api/workspaces/${ws}/canvas/items`);
    dump("list-compacted", list);
    // Explicit compact() (the engine's «save now»): the third post is spaced by the 2 s budget, never rejected.
    a.doc.create({ kind: "text", x: 9, y: 9, text: "и ещё немного" });
    a.sync.compact();
    await sleep(2500);
    expect(a.sync.status).toBe("synced");
    expect(a.fatal).toEqual([]);
  }, 60_000);

  it("COMPACT_REQUEST: >1 MiB after the snapshot makes the server ask, and the client answers with a snapshot", async () => {
    const id = await mk("big");
    const a = track(open(id, alice));
    const b = track(open(id, bob));
    await Promise.all([synced(a), synced(b)]);
    a.doc.ensureSchema();
    const text = "Estimate line item, hardly compressible. ".repeat(120).slice(0, 4900); // one byte per character
    // 260 stickies of ~5 KB in chunks of 6 (~30 KB, an UPDATE frame each; a bigger transaction goes as a snapshot): ≈ 8 chunks
    // per second, far below the 20 frames/s limit.
    const N = 260;
    for (let i = 0; i < N; i += 6) {
      a.doc.createMany(Array.from({ length: Math.min(6, N - i) }, (_, k) => ({ init: { kind: "sticky" as const, x: (i + k) * 10, y: 0, text: `${i + k} ${text}` } })));
      await sleep(120);
    }
    expect(a.doc.count).toBe(N);
    const wrote = Date.now();
    // The server checks the thresholds when an UPDATE arrives, at most every 2 s: one more small edit after the bulk.
    await sleep(2300);
    a.doc.create({ kind: "text", x: -1, y: -1, text: "tail" });
    // The server asks the writer (maybeCompact → enqueue to the sender), not the room.
    await waitFor("COMPACT_REQUEST reached A", () => a.wire.frames.includes(FRAME_COMPACT_REQUEST), 20_000, 100);
    const asked = Date.now();
    await waitFor("size stored", async () => ((await ok(alice.token, "GET", `/api/canvas/items/${id}`)).item.docSize ?? 0) > 1 << 20, 20_000, 50);
    // The answer comes at once (the idle compaction would be 3 s after the tail edit).
    expect(Date.now() - asked).toBeLessThan(2000);
    expect(Date.now() - wrote).toBeLessThan(2300 + 4000);
    const sz = (await ok(alice.token, "GET", `/api/canvas/items/${id}`)).item.docSize as number;
    console.log(`COMPACT_REQUEST: ${(sz / 1048576).toFixed(2)} MiB stored; A (the writer) got ${a.wire.frames.filter((f) => f === FRAME_COMPACT_REQUEST).length}, B ${b.wire.frames.filter((f) => f === FRAME_COMPACT_REQUEST).length} request(s)`);
    await waitFor("B has everything", () => b.doc.count === N + 1, 20_000, 100);
    await converge(a, b);
    // A fresh client loads the 1+ MiB snapshot (plus the updates after it) in one go.
    const t0 = performance.now();
    const late = track(open(id, bob));
    await waitFor("late joiner has 230 objects", () => late.doc.count === N + 1, 20_000, 20);
    console.log(`LOAD of a ${(sz / 1048576).toFixed(2)} MiB canvas by a late joiner: ${(performance.now() - t0).toFixed(0)} ms`);
    await converge(a, late);
    expect(a.fatal).toEqual([]);
    expect(b.fatal).toEqual([]);
  }, 90_000);

  it("limits: an edit above 64 KiB (one transaction, then many in one batch) and a state above 4 MiB do not break the client", async () => {
    const id = await mk("limits");
    const a = track(open(id, alice));
    const b = track(open(id, bob));
    await Promise.all([synced(a), synced(b)]);
    const text = (c: string): string => c.repeat(4900);
    // One transaction of ~100 KB: no UPDATE frame can carry it → a snapshot with broadcast, B gets it as a SNAPSHOT.
    const ids = a.doc.createMany(Array.from({ length: 20 }, (_, k) => ({ init: { kind: "sticky" as const, x: k, y: 0, text: text(String.fromCharCode(97 + k)) } })));
    expect(ids).toHaveLength(20);
    expect(Y.encodeStateAsUpdate(a.ydoc).length).toBeGreaterThan(64 * 1024);
    await waitFor("B has the oversized transaction", () => b.doc.count === 20, 15_000, 50);
    await converge(a, b);
    expect(a.sync.status).toBe("synced");
    expect(b.sync.status).toBe("synced");
    // Many small transactions inside one 200 ms batch, above 64 KiB together: packed into several frames.
    for (let i = 0; i < 30; i++) a.doc.create({ kind: "sticky", x: i, y: 100, text: text("z") });
    await waitFor("B has the batch", () => b.doc.count === 50, 15_000, 50);
    await converge(a, b);
    // Both sides stay writable afterwards.
    const after = b.doc.create({ kind: "text", x: 0, y: 0, text: "still alive" }) ?? "";
    await arrival(a.ydoc, () => a.doc.objects.has(after));
    expect(a.fatal).toEqual([]);
    expect(b.fatal).toEqual([]);
    // A paste above the state limit (CANVAS_MAX_STATE): ~5 MB in 1000 objects is refused whole, so
    // nothing of it leaves the client (in ≈ 40 KB UPDATE chunks the server would take only about
    // 4 MiB of it, the others would keep a part). The over-the-limit snapshot: canvasSync.test.ts.
    const id2 = await mk("too large");
    const c = track(open(id2, alice));
    await synced(c);
    expect(c.doc.createMany(Array.from({ length: 1000 }, (_, i) => ({ init: { kind: "sticky" as const, x: i, y: 0, text: text("q") } })))).toEqual([]);
    expect(c.doc.count).toBe(0);
    expect(c.sync.status).toBe("synced");
    expect(c.fatal).toEqual([]);
    const watcher = track(open(id2, bob));
    await synced(watcher);
    expect(watcher.doc.count).toBe(0); // the server never got it
    // The server's side: a SNAPSHOT_POST of 4 MiB + 1 byte is refused by closing the socket, not by dying.
    const r = raw(id, alice.token);
    await waitFor("snapshot frame", () => r.frames.some((f) => f[0] === FRAME_SNAPSHOT));
    r.ws.send(encodeSnapshotPost(0, { plain_text: "", title: "", preview: "" }, new Uint8Array(4 * 1024 * 1024 + 1), false));
    // Over the limit the server stores nothing and says nothing (the client warns); the socket stays.
    const verdict = await Promise.race([r.closed.then((c) => `closed ${c.code}`), sleep(1500).then(() => "open")]);
    console.log(`SNAPSHOT_POST of 4 MiB + 1: socket ${verdict}`);
    expect(verdict).toBe("open");
    expect(((await ok(alice.token, "GET", `/api/canvas/items/${id}`)).item.docSize as number) < 4 * 1024 * 1024).toBe(true);
    r.ws.close();
    expect((await rest(alice.token, "GET", `/api/canvas/items/${id}`)).status).toBe(200); // the server is alive
    const fresh = track(open(id, bob));
    await synced(fresh);
    expect(fresh.doc.count).toBe(51);
  }, 90_000);

  it("restore a version: A restores the first version on the live document, B sees it, a new client loads the restored canvas", async () => {
    const id = await mk("restore");
    const a = track(open(id, alice));
    const b = track(open(id, bob));
    await Promise.all([synced(a), synced(b)]);
    a.doc.ensureSchema();
    const keep = a.doc.create({ kind: "sticky", x: 0, y: 0, text: "версия один" }) ?? "";
    const drop = a.doc.create({ kind: "shape", x: 100, y: 0, text: "будет удалён" }) ?? "";
    await arrival(b.ydoc, () => b.doc.objects.has(drop));
    await waitFor("the first version", async () => ((await ok(alice.token, "GET", `/api/canvas/items/${id}/versions`)).versions ?? []).length === 1, 15_000, 100);
    const v = (await ok(alice.token, "GET", `/api/canvas/items/${id}/versions`)).versions[0] as { id: string };
    // Work on after the version: change one, delete one, add one.
    a.doc.setText(keep, "версия два");
    a.doc.remove([drop]);
    const extra = a.doc.create({ kind: "text", x: 5, y: 5, text: "лишний" }) ?? "";
    await arrival(b.ydoc, () => b.doc.objects.has(extra) && !b.doc.objects.has(drop));
    expect(b.doc.getText(keep)).toBe("версия два");
    // The version's state: GET …/versions/{vid} is application/octet-stream (services/canvas.ts versionState).
    const res = await fetch(`${BASE}/api/canvas/items/${id}/versions/${v.id}`, { headers: { authorization: `Bearer ${alice.token}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/octet-stream");
    const state = new Uint8Array(await res.arrayBuffer());
    const t0 = performance.now();
    expect(restoreCanvasState(a.doc, state)).toBe(true);
    const seen = await arrival(b.ydoc, () => b.doc.objects.has(drop) && !b.doc.objects.has(extra) && b.doc.getText(keep) === "версия один");
    console.log(`RESTORE version: A restores → B sees it in ${(performance.now() - t0).toFixed(0)} ms (wait ${seen.toFixed(0)} ms)`);
    await converge(a, b);
    expect(a.doc.count).toBe(2);
    expect(a.sync.status).toBe("synced");
    // A new client reads the restored document from the server (snapshot + updates) once the restore is stored.
    await waitFor("restored canvas persisted", async () => {
      const late = open(id, bob);
      try {
        await synced(late);
        await sleep(300);
        return late.doc.count === 2 && late.doc.getText(keep) === "версия один" && !late.doc.objects.has(extra);
      } finally {
        late.close();
      }
    }, 20_000, 500);
  }, 60_000);

  it("latency of a change from one client to the other, both ways", async () => {
    const id = await mk("latency");
    const a = track(open(id, alice));
    const b = track(open(id, bob));
    await Promise.all([synced(a), synced(b)]);
    const N = 15;
    const run = async (from: Client, to: Client, flush: boolean): Promise<number[]> => {
      const out: number[] = [];
      for (let i = 0; i < N; i++) {
        const t0 = performance.now();
        const sid = from.doc.create({ kind: "sticky", x: i, y: flush ? 1 : 2, text: `n${i}` }) ?? "";
        const got = arrival(to.ydoc, () => to.doc.objects.has(sid));
        if (flush) from.sync.flush();
        await got;
        out.push(performance.now() - t0);
        await sleep(60);
      }
      return out;
    };
    const ab = await run(a, b, false);
    const ba = await run(b, a, false);
    const abNet = await run(a, b, true);
    const baNet = await run(b, a, true);
    console.log(`LATENCY A→B  (as typed, incl. the 200 ms batch): ${stats(ab)}`);
    console.log(`LATENCY B→A  (as typed, incl. the 200 ms batch): ${stats(ba)}`);
    console.log(`LATENCY A→B  (flushed, the network + server): ${stats(abNet)}`);
    console.log(`LATENCY B→A  (flushed, the network + server): ${stats(baNet)}`);
    // Awareness: no batching, only the 50 ms floor between frames.
    const aw: number[] = [];
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      a.awareness.setLocalStateField("cursor", { x: i + 1000, y: 0 });
      await waitFor("cursor", () => (b.awareness.getStates().get(a.awareness.clientID) as { cursor?: { x: number } } | undefined)?.cursor?.x === i + 1000, 3000, 2);
      aw.push(performance.now() - t0);
      await sleep(70);
    }
    console.log(`LATENCY awareness A→B: ${stats(aw)}`);
    expect(Math.max(...ab, ...ba)).toBeLessThan(2000);
    expect(Math.max(...abNet, ...baNet)).toBeLessThan(1000);
    await converge(a, b);
  }, 60_000);
});

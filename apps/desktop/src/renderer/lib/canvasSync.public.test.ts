import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import { CanvasDoc } from "./canvas/doc";
import { canvasPlainText } from "./canvas/plainText";
import { ids, seededRng } from "./canvas/testing";
import { canvasPublicSyncUrl, CanvasSync, type CanvasSyncStatus } from "./canvasSync";
import { encodeAwareness, encodeCompactRequest } from "./wiki/frames";
import { MockRelay, type MockSocket } from "./ySyncMock";
import { BATCH_MS, CLOSE_RECEIVE_ONLY, IDLE_SNAPSHOT_MS } from "./ySync";

const CODE = "A".repeat(43);
const sticky = (x: number, text = "") => ({ kind: "sticky" as const, x, y: 0, text });
const visible = { hidden: () => false, subscribe: () => () => undefined };

let n = 0;
function open(relay: MockRelay, viewer: boolean) {
  const ydoc = new Y.Doc();
  const awareness = new Awareness(ydoc);
  const doc = new CanvasDoc(ydoc, { rng: seededRng(++n), makeId: ids(`p${n}-`) });
  const sockets: MockSocket[] = [];
  const make = relay.socketFactory(viewer ? { viewer: true } : { canWrite: true });
  const getToken = vi.fn(() => Promise.resolve("tok"));
  const onFatal = vi.fn();
  const sync = new CanvasSync(ydoc, awareness, {
    url: () => canvasPublicSyncUrl("https://app.example", CODE),
    getToken,
    createSocket: (url) => {
      const s = make(url);
      sockets.push(s);
      return s;
    },
    ...(viewer ? { anonymous: true } : {}),
    onFatal,
    random: () => 0,
    visibility: visible,
  });
  const statuses: CanvasSyncStatus[] = [sync.getStatus()];
  sync.subscribe((s) => statuses.push(s));
  return { ydoc, awareness, doc, sync, sockets, getToken, onFatal, statuses, last: () => sockets[sockets.length - 1] as MockSocket };
}

const settle = async (ms = 0): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("canvasPublicSyncUrl", () => {
  it("is a ws(s) URL of /api/public/canvas/{code}/sync", () => {
    expect(canvasPublicSyncUrl("https://app.calab.io", CODE)).toBe(`wss://app.calab.io/api/public/canvas/${CODE}/sync`);
    expect(canvasPublicSyncUrl("http://localhost:8080", "a/b")).toBe("ws://localhost:8080/api/public/canvas/a%2Fb/sync");
  });
});

describe("CanvasSync anonymous (the public link, ADR-0115 wave 5)", () => {
  it("reads the snapshot and the writers' updates without a token, and sends nothing at all", async () => {
    const relay = new MockRelay();
    new CanvasDoc(relay.doc, { rng: seededRng(7), makeId: ids("srv") }).create(sticky(0, "from server"));
    const writer = open(relay, false);
    const v = open(relay, true);
    await settle();
    expect(v.last().url).toBe(`wss://app.example/api/public/canvas/${CODE}/sync`);
    expect(v.getToken).not.toHaveBeenCalled();
    expect(v.sync.status).toBe("readonly");
    expect(v.statuses).toEqual(["connecting", "readonly"]);
    expect(canvasPlainText(v.ydoc)).toBe("from server");

    writer.doc.create(sticky(1, "live"));
    await settle(BATCH_MS);
    expect(canvasPlainText(v.ydoc)).toContain("live");

    // Whatever happens on the viewer's side, nothing goes out.
    v.doc.create(sticky(2, "local"));
    v.awareness.setLocalStateField("cursor", { x: 1, y: 2 });
    v.sync.setReadOnly(false);
    v.sync.flush();
    v.sync.compact();
    v.last().receive(encodeCompactRequest());
    await settle(BATCH_MS + IDLE_SNAPSHOT_MS + 60_000);
    v.sync.destroy();
    expect(v.last().sent).toEqual([]);
    expect(relay.violations).toEqual([]);
    expect(canvasPlainText(relay.doc)).not.toContain("local");
    writer.sync.destroy();
  });

  it("ignores awareness even if a frame arrives (who is on the canvas stays hidden)", async () => {
    const relay = new MockRelay();
    const v = open(relay, true);
    await settle();
    const other = new Awareness(new Y.Doc());
    other.setLocalState({ user: { id: "u1", name: "Ann" } });
    v.last().receive(encodeAwareness(encodeAwarenessUpdate(other, [other.clientID])));
    expect([...v.awareness.getStates().keys()].filter((id) => id !== v.awareness.clientID)).toEqual([]);
    v.sync.destroy();
  });

  it("4013 and 4404 stop for good; a dropped socket reconnects with backoff, still without a token", async () => {
    for (const code of [CLOSE_RECEIVE_ONLY, 4404]) {
      const relay = new MockRelay();
      const v = open(relay, true);
      await settle();
      v.last().drop(code);
      await settle(120_000);
      expect(v.sockets).toHaveLength(1);
      expect(v.sync.status).toBe("offline");
      expect(v.onFatal).toHaveBeenCalledWith(code);
    }
    const relay = new MockRelay();
    const v = open(relay, true);
    await settle();
    v.last().drop(4000); // the socket's life ended (ViewerMaxLife)
    await settle(1100);
    expect(v.sockets).toHaveLength(2);
    expect(v.sync.status).toBe("readonly");
    expect(v.getToken).not.toHaveBeenCalled();
    expect(v.sockets.every((s) => s.sent.length === 0)).toBe(true);
    v.sync.destroy();
  });

  it("at rest holds no timer at all (no awareness heartbeat for a viewer)", async () => {
    const relay = new MockRelay();
    const v = open(relay, true);
    await settle(1000);
    expect(vi.getTimerCount()).toBe(0);
    v.sync.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { CanvasDoc } from "./canvas/doc";
import { canvasPlainText, MAX_PLAIN_TEXT } from "./canvas/plainText";
import { ids, seededRng } from "./canvas/testing";
import {
  canvasSyncUrl,
  CANVAS_AWARENESS_MIN_GAP_MS,
  CanvasSync,
  type CanvasSyncDeps,
  type CanvasSyncStatus,
} from "./canvasSync";
import {
  FRAME_AWARENESS,
  FRAME_UPDATE,
  MAX_FRAME,
  type Frame,
} from "./wiki/frames";
import { MockRelay, type MockSocket } from "./ySyncMock";
import { BATCH_MS, IDLE_SNAPSHOT_MS, SNAPSHOT_GAP_MS, type Visibility } from "./ySync";

function fakeVisibility(): Visibility & { set(h: boolean): void } {
  let hidden = false;
  const subs = new Set<() => void>();
  return {
    hidden: () => hidden,
    subscribe: (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    set(h) {
      hidden = h;
      for (const s of subs) s();
    },
  };
}

interface Client {
  ydoc: Y.Doc;
  doc: CanvasDoc;
  awareness: Awareness;
  sync: CanvasSync;
  vis: ReturnType<typeof fakeVisibility>;
  sockets: MockSocket[];
  last(): MockSocket;
  statuses: CanvasSyncStatus[];
}

let n = 0;
function client(
  relay: MockRelay,
  over: Partial<CanvasSyncDeps> & { canWrite?: boolean } = {},
): Client {
  const ydoc = new Y.Doc();
  const awareness = new Awareness(ydoc);
  const doc = new CanvasDoc(ydoc, { rng: seededRng(++n), makeId: ids(`c${n}-`) });
  const vis = fakeVisibility();
  const sockets: MockSocket[] = [];
  const make = relay.socketFactory({ canWrite: over.canWrite ?? true });
  const sync = new CanvasSync(ydoc, awareness, {
    url: () => canvasSyncUrl("https://app.example", "cv1"),
    getToken: () => Promise.resolve("tok"),
    createSocket: (url) => {
      const s = make(url);
      sockets.push(s);
      return s;
    },
    random: () => 0,
    visibility: vis,
    ...over,
  });
  const statuses: CanvasSyncStatus[] = [sync.getStatus()];
  sync.subscribe((s) => statuses.push(s));
  return {
    ydoc,
    doc,
    awareness,
    sync,
    vis,
    sockets,
    last: () => sockets[sockets.length - 1] as MockSocket,
    statuses,
  };
}

/** Lets the microtask-driven open/token/snapshot handshake run. */
const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

const sticky = (x: number, text = "") => ({ kind: "sticky" as const, x, y: 0, text });

const frames = (c: Client, type: number): Frame[] =>
  c.last().frames().filter((f) => f.type === type);

/** Pseudo-random text that does not collapse when encoded. */
function noise(len: number, seed: number): string {
  const r = seededRng(seed);
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(97 + Math.floor(r() * 26));
  return s;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("canvasPlainText", () => {
  it("glues the texts of all objects bottom → top, connector labels included", () => {
    const d = new CanvasDoc(new Y.Doc(), { rng: seededRng(1), makeId: ids() });
    const a = d.create(sticky(0, "first"));
    d.create({ kind: "shape", x: 0, y: 0, text: "  in shape  " });
    d.create(sticky(0, ""));
    d.create({ kind: "connector", from: { x: 0, y: 0 }, to: { x: 5, y: 5 }, label: "yes" });
    d.create(sticky(0, "last\nline"));
    expect(canvasPlainText(d.ydoc)).toBe("first\nin shape\nyes\nlast\nline");
    d.sendToBack([d.orderedIds()[4] as string]);
    expect(canvasPlainText(d.ydoc).startsWith("last\nline\nfirst")).toBe(true);
    expect(a).not.toBeNull();
  });

  it("is empty for an empty doc and creates no types", () => {
    const y = new Y.Doc();
    expect(canvasPlainText(y)).toBe("");
    expect(y.share.has("objects")).toBe(false);
  });

  it("is capped", () => {
    const d = new CanvasDoc(new Y.Doc(), { rng: seededRng(1), makeId: ids() });
    for (let i = 0; i < 30; i++) d.create(sticky(i, noise(4999, i)));
    expect(canvasPlainText(d.ydoc).length).toBe(MAX_PLAIN_TEXT);
  });
});

describe("canvasSyncUrl", () => {
  it("is a ws(s) URL of /api/canvas/items/{id}/sync", () => {
    expect(canvasSyncUrl("https://app.calab.io", "a1")).toBe("wss://app.calab.io/api/canvas/items/a1/sync");
    expect(canvasSyncUrl("http://localhost:8080", "a/b")).toBe("ws://localhost:8080/api/canvas/items/a%2Fb/sync");
  });
});

describe("CanvasSync", () => {
  it("authenticates, applies the snapshot and reports connecting → synced", async () => {
    const relay = new MockRelay();
    new CanvasDoc(relay.doc, { rng: seededRng(5), makeId: ids("srv") }).create(sticky(10, "from server"));
    const c = client(relay);
    expect(c.sync.status).toBe("connecting");
    await settle();
    expect(c.last().url).toBe("wss://app.example/api/canvas/items/cv1/sync");
    expect(c.last().sent[0]).toBe("tok");
    expect(c.sync.status).toBe("synced");
    expect(c.statuses).toEqual(["connecting", "synced"]);
    expect(canvasPlainText(c.ydoc)).toBe("from server");
    c.sync.destroy();
  });

  it("batches local edits for 200 ms into one UPDATE", async () => {
    const relay = new MockRelay();
    const c = client(relay);
    await settle();
    c.doc.create(sticky(0, "a"));
    c.doc.create(sticky(1, "b"));
    c.doc.create(sticky(2, "c"));
    vi.advanceTimersByTime(BATCH_MS - 1);
    expect(frames(c, FRAME_UPDATE)).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(frames(c, FRAME_UPDATE)).toHaveLength(1);
    expect(relay.seq).toBe(1);
    expect(canvasPlainText(relay.doc)).toBe("a\nb\nc");
    c.sync.destroy();
  });

  it("splits a batch above 64 KiB into frames that fit", async () => {
    const relay = new MockRelay();
    const c = client(relay);
    await settle();
    for (let i = 0; i < 30; i++) c.doc.create(sticky(i, noise(4000, i)));
    vi.advanceTimersByTime(BATCH_MS);
    const ups = frames(c, FRAME_UPDATE);
    expect(ups.length).toBeGreaterThan(1);
    for (const d of c.last().sent) if (typeof d !== "string") expect(d.length).toBeLessThanOrEqual(MAX_FRAME);
    expect(relay.violations).toEqual([]);
    expect(relay.doc.getMap("objects").size).toBe(30);
    c.sync.destroy();
  });

  it("sends one transaction above 64 KiB as a broadcast snapshot", async () => {
    const relay = new MockRelay();
    const a = client(relay);
    const b = client(relay);
    await settle();
    a.doc.createMany(Array.from({ length: 20 }, (_, i) => ({ init: sticky(i, noise(4500, i)) })));
    vi.advanceTimersByTime(BATCH_MS);
    expect(frames(a, FRAME_UPDATE)).toHaveLength(0);
    const posts = relay.posts;
    expect(posts).toHaveLength(1);
    expect(posts[0]?.broadcast).toBe(true);
    expect(relay.violations).toEqual([]);
    expect(b.ydoc.getMap("objects").size).toBe(20);
    a.sync.destroy();
    b.sync.destroy();
  });

  it("applies remote updates without echoing them", async () => {
    const relay = new MockRelay();
    const a = client(relay);
    const b = client(relay);
    await settle();
    a.doc.create(sticky(0, "hello"));
    vi.advanceTimersByTime(BATCH_MS);
    expect(canvasPlainText(b.ydoc)).toBe("hello");
    vi.advanceTimersByTime(BATCH_MS * 3);
    expect(frames(b, FRAME_UPDATE)).toHaveLength(0);
    a.sync.destroy();
    b.sync.destroy();
  });

  it("converges two clients editing concurrently through the relay", async () => {
    const relay = new MockRelay();
    const a = client(relay);
    const b = client(relay);
    await settle();
    const id = a.doc.create(sticky(0, "shared")) as string;
    vi.advanceTimersByTime(BATCH_MS);
    // concurrent: both move it, both edit its text, both add objects, A deletes one of B's later
    a.doc.patch(id, { x: 100 });
    a.doc.setText(id, "shared A");
    a.doc.create(sticky(5, "only A"));
    b.doc.patch(id, { y: 50 });
    b.doc.setText(id, "B shared");
    const bOnly = b.doc.create(sticky(6, "only B")) as string;
    vi.advanceTimersByTime(BATCH_MS);
    a.doc.remove([bOnly]);
    vi.advanceTimersByTime(BATCH_MS);
    const objects = (y: Y.Doc): string => JSON.stringify(y.getMap("objects").toJSON());
    expect(objects(a.ydoc)).toBe(objects(b.ydoc));
    expect(objects(relay.doc)).toBe(objects(a.ydoc));
    expect(Y.encodeStateVector(a.ydoc)).toEqual(Y.encodeStateVector(b.ydoc));
    expect(canvasPlainText(a.ydoc)).toBe(canvasPlainText(b.ydoc));
    expect(canvasPlainText(relay.doc)).toBe(canvasPlainText(a.ydoc));
    expect(a.doc.snapshot(id)).toEqual(b.doc.snapshot(id));
    expect(b.doc.snapshot(bOnly)).toBeNull();
    a.sync.destroy();
    b.sync.destroy();
  });

  it("reconnects with backoff, gets the snapshot again and replays offline edits", async () => {
    const relay = new MockRelay();
    const a = client(relay);
    const b = client(relay);
    await settle();
    a.doc.create(sticky(0, "base"));
    vi.advanceTimersByTime(BATCH_MS);
    relay.dropAll(1006);
    expect(a.sync.status).toBe("offline");
    // offline: A edits locally, B (reconnected first) adds something the relay now holds
    a.doc.create(sticky(1, "offline A"));
    vi.advanceTimersByTime(499);
    expect(a.sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(a.sockets).toHaveLength(2);
    expect(a.sync.status).toBe("connecting");
    new CanvasDoc(relay.doc, { rng: seededRng(99), makeId: ids("late") }).create(sticky(2, "while away"));
    await settle();
    expect(a.sync.status).toBe("synced");
    vi.advanceTimersByTime(BATCH_MS);
    // A has the server's news (fresh snapshot) and the server has A's offline edit
    expect(canvasPlainText(a.ydoc).split("\n").sort()).toEqual(["base", "offline A", "while away"]);
    expect(canvasPlainText(relay.doc).split("\n").sort()).toEqual(["base", "offline A", "while away"]);
    expect(a.statuses).toEqual(["connecting", "synced", "offline", "connecting", "synced"]);
    // B reconnects (its own timer) and sees everything
    vi.advanceTimersByTime(600);
    await settle();
    expect(canvasPlainText(b.ydoc).split("\n").sort()).toEqual(["base", "offline A", "while away"]);
    a.sync.destroy();
    b.sync.destroy();
  });

  it("backs off further while the server stays away and stops on 4003", async () => {
    const relay = new MockRelay();
    const onFatal = vi.fn();
    const c = client(relay, { onFatal });
    await settle();
    c.last().drop(1006);
    vi.advanceTimersByTime(500);
    expect(c.sockets).toHaveLength(2);
    c.last().drop(1006); // never opened a session: attempt 1 → 1000 ms
    vi.advanceTimersByTime(999);
    expect(c.sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(c.sockets).toHaveLength(3);
    await settle();
    c.last().drop(4003);
    expect(onFatal).toHaveBeenCalledWith(4003);
    vi.advanceTimersByTime(60_000);
    expect(c.sockets).toHaveLength(3);
    expect(c.sync.status).toBe("offline");
  });

  describe("compaction", () => {
    it("on COMPACT_REQUEST: SNAPSHOT_POST with plain_text, title and preview", async () => {
      const relay = new MockRelay();
      const peer = client(relay);
      const c = client(relay, { title: () => "Roadmap" });
      await settle();
      peer.doc.create(sticky(9, ""));
      vi.advanceTimersByTime(BATCH_MS); // the relay stores update #1; c applies it
      c.doc.create(sticky(0, "alpha"));
      c.doc.create(sticky(1, "beta   gamma"));
      vi.advanceTimersByTime(BATCH_MS);
      relay.requestCompaction(c.last());
      expect(relay.posts).toHaveLength(1);
      const p = relay.posts[0];
      if (!p) throw new Error("no post");
      expect(p.meta).toEqual({ plain_text: "alpha\nbeta   gamma", title: "Roadmap", preview: "alpha beta gamma" });
      expect(p.throughSeq).toBe(1); // the highest seq c has seen
      expect(p.broadcast).toBe(false);
      const check = new Y.Doc();
      Y.applyUpdate(check, p.state);
      expect(canvasPlainText(check)).toBe("alpha\nbeta   gamma");
      c.sync.destroy();
      peer.sync.destroy();
    });

    it("3 s after our last edit (each edit restarts the timer)", async () => {
      const relay = new MockRelay();
      const c = client(relay);
      await settle();
      c.doc.create(sticky(0, "one"));
      vi.advanceTimersByTime(IDLE_SNAPSHOT_MS - 100);
      c.doc.create(sticky(1, "two"));
      vi.advanceTimersByTime(IDLE_SNAPSHOT_MS - 100);
      expect(relay.posts).toHaveLength(0);
      vi.advanceTimersByTime(100);
      expect(relay.posts).toHaveLength(1);
      expect(relay.posts[0]?.meta.plain_text).toBe("one\ntwo");
      vi.advanceTimersByTime(60_000); // nothing more to compact
      expect(relay.posts).toHaveLength(1);
      c.sync.destroy();
    });

    it("on close, only when we edited since the last snapshot", async () => {
      const relay = new MockRelay();
      const idle = client(relay);
      await settle();
      idle.sync.destroy();
      expect(relay.posts).toHaveLength(0);
      expect(idle.last().closed).toBe(1000);

      const c = client(relay);
      await settle();
      c.doc.create(sticky(0, "unsaved"));
      c.sync.destroy(); // inside the batch window and before the idle timer
      expect(relay.posts).toHaveLength(1);
      expect(relay.posts[0]?.meta.plain_text).toBe("unsaved");
      expect(canvasPlainText(relay.doc)).toBe("unsaved"); // flushed before the post
    });

    it("spaces posts by 2 s and merges requests made meanwhile", async () => {
      const relay = new MockRelay();
      const c = client(relay);
      await settle();
      c.doc.create(sticky(0, "x"));
      vi.advanceTimersByTime(BATCH_MS);
      relay.requestCompaction();
      c.doc.create(sticky(1, "y"));
      vi.advanceTimersByTime(BATCH_MS);
      relay.requestCompaction();
      relay.requestCompaction();
      expect(relay.posts).toHaveLength(1);
      vi.advanceTimersByTime(SNAPSHOT_GAP_MS);
      expect(relay.posts).toHaveLength(2);
      expect(relay.posts[1]?.meta.plain_text).toBe("x\ny");
      c.sync.destroy();
    });

    it("compact() asks for one now", async () => {
      const relay = new MockRelay();
      const c = client(relay);
      await settle();
      c.doc.create(sticky(0, "z"));
      c.sync.compact();
      expect(relay.posts).toHaveLength(1);
      expect(canvasPlainText(relay.doc)).toBe("z");
      c.sync.destroy();
    });

    it("does not post a state above 4 MiB", async () => {
      const relay = new MockRelay();
      const onTooLarge = vi.fn();
      const c = client(relay, { onTooLarge });
      await settle();
      // 5000-char texts, 70 per transaction group stay under the frame limit as snapshots
      for (let i = 0; i < 900; i++) {
        c.doc.create(sticky(i, noise(4999, i)));
        if (i % 12 === 11) vi.advanceTimersByTime(BATCH_MS);
      }
      vi.advanceTimersByTime(BATCH_MS);
      relay.requestCompaction();
      expect(onTooLarge).toHaveBeenCalledTimes(1);
      expect(onTooLarge.mock.calls[0]?.[0]).toBeGreaterThan(4 * 1024 * 1024);
      expect(relay.posts).toHaveLength(0);
      c.sync.destroy();
    });
  });

  describe("read-only", () => {
    it("applies remote edits but never sends updates, awareness or snapshots", async () => {
      const relay = new MockRelay();
      const w = client(relay);
      const r = client(relay, { readOnly: true, canWrite: false });
      await settle();
      expect(r.sync.status).toBe("readonly");
      expect(r.sync.readOnly).toBe(true);
      w.doc.create(sticky(0, "visible"));
      vi.advanceTimersByTime(BATCH_MS);
      expect(canvasPlainText(r.ydoc)).toBe("visible");
      // a (forbidden) local edit and a cursor move go nowhere
      r.doc.create(sticky(9, "ignored"));
      r.awareness.setLocalStateField("canvas", { cursor: { x: 1, y: 2 } });
      relay.requestCompaction();
      vi.advanceTimersByTime(IDLE_SNAPSHOT_MS * 2);
      expect(r.last().frames()).toEqual([]);
      expect(relay.violations).toEqual([]);
      expect(r.sync.status).toBe("readonly");
      const stored = relay.posts.length; // the writer's own idle compaction
      r.sync.destroy();
      expect(relay.posts).toHaveLength(stored);
      w.sync.destroy();
    });

    it("setReadOnly flips the mode at run time", async () => {
      const relay = new MockRelay();
      const c = client(relay);
      await settle();
      expect(c.sync.status).toBe("synced");
      c.doc.create(sticky(0, "queued"));
      c.sync.setReadOnly(true); // grant lost inside the batch window: the queue is dropped
      expect(c.sync.status).toBe("readonly");
      vi.advanceTimersByTime(IDLE_SNAPSHOT_MS * 2);
      expect(frames(c, FRAME_UPDATE)).toHaveLength(0);
      expect(relay.posts).toHaveLength(0);
      c.sync.setReadOnly(false);
      expect(c.sync.status).toBe("synced");
      expect(frames(c, FRAME_AWARENESS).length).toBeGreaterThan(0); // cursor announced again
      c.doc.create(sticky(1, "after"));
      vi.advanceTimersByTime(BATCH_MS);
      expect(frames(c, FRAME_UPDATE)).toHaveLength(1);
      c.sync.destroy();
    });

    it("a status change before the first snapshot waits for the snapshot", async () => {
      const relay = new MockRelay();
      const c = client(relay);
      c.sync.setReadOnly(true);
      expect(c.sync.status).toBe("connecting");
      await settle();
      expect(c.sync.status).toBe("readonly");
      c.sync.destroy();
    });
  });

  describe("awareness", () => {
    it("is throttled to 20 frames/s and stops while the window is hidden", async () => {
      const relay = new MockRelay();
      const c = client(relay);
      await settle();
      const base = frames(c, FRAME_AWARENESS).length; // the full state on sync
      expect(CANVAS_AWARENESS_MIN_GAP_MS).toBe(50);
      for (let t = 0; t < 1000; t += 5) {
        c.awareness.setLocalStateField("canvas", { cursor: { x: t, y: 0 }, selection: [] });
        vi.advanceTimersByTime(5);
      }
      vi.advanceTimersByTime(60);
      const sent = frames(c, FRAME_AWARENESS).length - base;
      expect(sent).toBeGreaterThanOrEqual(18);
      expect(sent).toBeLessThanOrEqual(21);
      c.vis.set(true);
      const hiddenBase = frames(c, FRAME_AWARENESS).length;
      for (let i = 0; i < 20; i++) {
        c.awareness.setLocalStateField("canvas", { cursor: { x: -i, y: 0 }, selection: [] });
        vi.advanceTimersByTime(60);
      }
      expect(frames(c, FRAME_AWARENESS).length).toBe(hiddenBase);
      c.vis.set(false); // back on screen: the current state goes out once
      expect(frames(c, FRAME_AWARENESS).length).toBe(hiddenBase + 1);
      c.sync.destroy();
    });

    it("shows peers' cursors and forgets them when the socket drops", async () => {
      const relay = new MockRelay();
      const a = client(relay);
      const b = client(relay);
      await settle();
      a.awareness.setLocalStateField("canvas", { cursor: { x: 7, y: 8 }, selection: ["s1"] });
      vi.advanceTimersByTime(CANVAS_AWARENESS_MIN_GAP_MS);
      const seen = [...b.awareness.getStates().values()].find((s) => (s as { canvas?: unknown }).canvas);
      expect(seen).toEqual({ canvas: { cursor: { x: 7, y: 8 }, selection: ["s1"] } });
      b.last().drop(1006);
      expect(b.awareness.getStates().size).toBe(1);
      a.sync.destroy();
      b.sync.destroy();
    });

    it("tells peers our cursor is gone on close", async () => {
      const relay = new MockRelay();
      const a = client(relay);
      const b = client(relay);
      await settle();
      a.awareness.setLocalStateField("canvas", { cursor: { x: 1, y: 1 }, selection: [] });
      vi.advanceTimersByTime(CANVAS_AWARENESS_MIN_GAP_MS);
      expect(b.awareness.getStates().size).toBe(2);
      a.sync.destroy();
      expect(b.awareness.getStates().size).toBe(1);
      b.sync.destroy();
    });
  });
});

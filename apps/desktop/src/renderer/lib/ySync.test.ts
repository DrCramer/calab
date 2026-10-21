import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import {
  encodeCompactRequest,
  encodeSnapshot,
  FRAME_SNAPSHOT_POST,
  FRAME_UPDATE,
} from "./wiki/frames";
import { docMeta, docPlainText } from "./wiki/plainText";
import { MockSocket } from "./ySyncMock";
import { YSyncProvider, type YSyncDeps } from "./ySync";

// The generic provider's behaviour beyond the wiki's original one (lib/wikiSync.test.ts keeps that):
// what only a canvas server triggers (4012 / 4014) and the options only the canvas sets.

function setup(over: Partial<YSyncDeps> = {}) {
  const sockets: MockSocket[] = [];
  const doc = new Y.Doc();
  const provider = new YSyncProvider(doc, new Awareness(doc), {
    url: () => "wss://x/sync",
    getToken: () => Promise.resolve("tok"),
    createSocket: (url) => {
      const s = new MockSocket(url);
      sockets.push(s);
      return s;
    },
    meta: () => docMeta(doc),
    random: () => 0,
    ...over,
  });
  const last = (): MockSocket => sockets[sockets.length - 1] as MockSocket;
  return { doc, provider, last };
}

/** A server-side doc with some text, as a snapshot state (memoized: same text → same bytes). */
const states = new Map<string, Uint8Array>();
function serverState(text: string): Uint8Array {
  const have = states.get(text);
  if (have) return have;
  const d = new Y.Doc();
  const p = new Y.XmlElement("paragraph");
  p.insert(0, [new Y.XmlText(text)]);
  d.getXmlFragment("default").insert(0, [p]);
  const out = Y.encodeStateAsUpdate(d);
  states.set(text, out);
  return out;
}

function type(doc: Y.Doc, text: string): void {
  const frag = doc.getXmlFragment("default");
  const p = new Y.XmlElement("paragraph");
  p.insert(0, [new Y.XmlText(text)]);
  frag.insert(frag.length, [p]);
}

async function connect(s: MockSocket, state: Uint8Array): Promise<void> {
  s.open();
  await Promise.resolve();
  await Promise.resolve();
  s.receive(encodeSnapshot(0, state));
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("YSyncProvider", () => {
  it.each([4012, 4014])(
    "replays again after %i (updates refused at the ceiling) even when that session only replayed",
    async (code) => {
      const { doc, last } = setup();
      await connect(last(), serverState("base"));
      last().drop(1006);
      type(doc, "refused edit");
      vi.advanceTimersByTime(500);
      await connect(last(), serverState("base"));
      const replayed = () =>
        last()
          .frames()
          .filter((f) => f.type === FRAME_UPDATE);
      expect(replayed()).toHaveLength(1); // the server refuses it at the ceiling …
      last().drop(code);
      vi.advanceTimersByTime(500);
      await connect(last(), serverState("base")); // … and still lacks it after the reconnect
      const ups = replayed();
      expect(ups).toHaveLength(1);
      const server = new Y.Doc();
      Y.applyUpdate(server, serverState("base"));
      for (const f of ups) Y.applyUpdate(server, f.update);
      expect(docPlainText(server)).toBe("base\nrefused edit");
    },
  );

  it.each([
    [false, 0, 1],
    [true, 1, 0],
  ])(
    "a state over maxState only by undo history: collectOverLimit %s → %i posts, %i warnings",
    async (collect, posts, warnings) => {
      const onTooLarge = vi.fn();
      const { doc, last } = setup({
        maxState: 4000,
        onTooLarge,
        collectOverLimit: collect,
      });
      await connect(last(), serverState(""));
      const text = doc.getText("t");
      const undo = new Y.UndoManager(text);
      text.insert(0, "x".repeat(5000));
      text.delete(0, 5000); // kept for the undo: still in the encoded state
      undo.stopCapturing();
      expect(Y.encodeStateAsUpdate(doc).length).toBeGreaterThan(4000);
      last().receive(encodeCompactRequest());
      expect(
        last()
          .frames()
          .filter((f) => f.type === FRAME_SNAPSHOT_POST),
      ).toHaveLength(posts);
      expect(onTooLarge).toHaveBeenCalledTimes(warnings);
    },
  );
});

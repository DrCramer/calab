import * as Y from 'yjs';
import { CanvasDoc, type CanvasDocOptions } from './doc';

/** Origin of updates arriving from "the network" in tests (anything but LOCAL_ORIGIN). */
export const REMOTE = 'remote';

export function seededRng(seed = 1): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

export function ids(prefix = 'o'): () => string {
  let n = 0;
  return () => `${prefix}${++n}`;
}

/** Wires two Y.Docs so every update reaches the other one (synchronously), or buffers it while `paused`. */
export function link(a: Y.Doc, b: Y.Doc): { pause(): void; flush(): void } {
  let paused = false;
  const qa: Uint8Array[] = [];
  const qb: Uint8Array[] = [];
  a.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin === REMOTE) return;
    if (paused) qa.push(u);
    else Y.applyUpdate(b, u, REMOTE);
  });
  b.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin === REMOTE) return;
    if (paused) qb.push(u);
    else Y.applyUpdate(a, u, REMOTE);
  });
  return {
    pause: () => {
      paused = true;
    },
    flush: () => {
      paused = false;
      for (const u of qa.splice(0)) Y.applyUpdate(b, u, REMOTE);
      for (const u of qb.splice(0)) Y.applyUpdate(a, u, REMOTE);
    },
  };
}

export function makeDoc(opts: CanvasDocOptions = {}): CanvasDoc {
  return new CanvasDoc(new Y.Doc(), { rng: seededRng(7), makeId: ids(), ...opts });
}

/** Two clients on a shared network. */
export function pair(): { a: CanvasDoc; b: CanvasDoc; net: ReturnType<typeof link> } {
  const ya = new Y.Doc();
  const yb = new Y.Doc();
  const net = link(ya, yb);
  return {
    a: new CanvasDoc(ya, { rng: seededRng(11), makeId: ids('a') }),
    b: new CanvasDoc(yb, { rng: seededRng(13), makeId: ids('b') }),
    net,
  };
}

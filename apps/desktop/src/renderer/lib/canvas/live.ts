import { CanvasDoc, LIVE_ORIGIN, isKind, normalizePatch, type StoredFields } from './doc';
import type { Scene } from './scene';
import { MAX_OBJECTS, type ObjectPatch } from './types';

/** Others get our preview at most this often… */
export const LIVE_MIN_MS = 100;
/** …and at most this many bytes a second (a bigger selection updates less often)… */
export const LIVE_BYTES_PER_S = 64_000;
/** …and not at all above this size per write (≈ 1000 moved objects): they see the result on release. */
export const LIVE_MAX_BYTES = 48_000;

export interface LiveOptions {
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

const round = (v: unknown): unknown => {
  if (typeof v === 'number') return Math.round(v * 100) / 100;
  if (typeof v === 'object' && v !== null && 'x' in v && 'y' in v) return { x: round(v.x), y: round(v.y) };
  return v;
};

/**
 * The preview of a gesture in progress (move, resize, rotate, a connector end). A gesture used to write the document on
 * every pointermove; the UndoManager keeps every overwritten value for the step, so a three-second drag of 500 objects
 * grew the state from 78 KB to 3.3 MB and a bigger one pushed the snapshot past its limit. Now:
 *
 * - our own preview is fields the scene shows instead of the document's (`Scene.setOverrides`), set on every move,
 *   nothing written;
 * - the others see it through `doc.live[clientId]`, one plain value overwritten at most LIVE_MIN_MS apart (fewer for
 *   a big selection). It is outside the undo scope, so each overwritten value is collected at once, and consecutive
 *   ones merge into a single tombstone: 180 previews leave a few bytes;
 * - the release writes the final fields once (`commit`, one undo step), then removes the entry; a cancel only drops it.
 *
 * An entry is shown only while its author is present (`setPresent`: the awareness peers), so a client that vanished
 * mid-drag leaves nothing on the others' screens; the next commit by anyone removes such leftovers.
 */
export class LiveLayer {
  private readonly key: string;
  private patches: ReadonlyMap<string, ObjectPatch> | null = null;
  private local = new Map<string, StoredFields>();
  private readonly remote = new Map<string, Map<string, StoredFields>>();
  private present: ReadonlySet<string> = new Set();
  private wrote = false;
  private lastWrite = -Infinity;
  private lastBytes = 0;
  private timer: unknown = null;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;

  constructor(private readonly doc: CanvasDoc, private readonly scene: Scene, opts: LiveOptions = {}) {
    this.key = String(doc.ydoc.clientID);
    this.now = opts.now ?? Date.now;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
    for (const k of doc.live.keys()) this.readRemote(k);
    doc.live.observe(this.onLive);
    this.push();
  }

  /** A gesture is being previewed. */
  get active(): boolean {
    return this.patches !== null;
  }

  /** The gesture's fields now (every object it changes, in full): shown at once, sent to the others throttled. */
  preview(patches: ReadonlyMap<string, ObjectPatch>): void {
    this.patches = patches;
    const next = new Map<string, StoredFields>();
    for (const [id, p] of patches) {
      const kind = this.doc.objects.get(id)?.get('kind');
      if (isKind(kind)) next.set(id, normalizePatch(kind, p));
    }
    this.local = next;
    this.push();
    this.schedule();
  }

  /** Writes the previewed fields to the document (one transaction: the gesture's undo step) and ends the preview. */
  commit(): void {
    const patches = this.patches;
    this.stop();
    if (patches) this.doc.patchMany(patches);
    this.local = new Map();
    this.push();
    this.clearEntries(true);
  }

  /** Ends the preview without writing anything. */
  drop(): void {
    this.stop();
    if (this.local.size > 0) {
      this.local = new Map();
      this.push();
    }
    this.clearEntries(false);
  }

  /** Client ids of the participants present now (the awareness peers). */
  setPresent(keys: Iterable<string>): void {
    const next = new Set(keys);
    const old = this.present;
    this.present = next;
    for (const k of this.remote.keys()) {
      if (old.has(k) !== next.has(k)) {
        this.push();
        return;
      }
    }
  }

  destroy(): void {
    this.doc.live.unobserve(this.onLive);
    this.stop();
    // A window closed mid-drag: the others stop showing it once we are gone anyway, but the entry would stay in the doc.
    if (this.wrote && this.doc.live.has(this.key)) this.doc.ydoc.transact(() => this.doc.live.delete(this.key), LIVE_ORIGIN);
  }

  private stop(): void {
    this.patches = null;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (this.timer !== null) return;
    const gap = Math.max(LIVE_MIN_MS, (this.lastBytes * 1000) / LIVE_BYTES_PER_S);
    const wait = this.lastWrite + gap - this.now();
    if (wait <= 0) this.write();
    else this.timer = this.setTimer(() => {
      this.timer = null;
      this.write();
    }, wait);
  }

  private write(): void {
    const patches = this.patches;
    if (!patches) return;
    const out: Record<string, Record<string, unknown>> = {};
    for (const [id, p] of patches) {
      const o: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(p)) o[k] = round(v);
      out[id] = o;
    }
    const bytes = JSON.stringify(out).length;
    this.lastWrite = this.now();
    this.lastBytes = bytes;
    if (bytes > LIVE_MAX_BYTES) return;
    this.wrote = true;
    this.doc.ydoc.transact(() => this.doc.live.set(this.key, out), LIVE_ORIGIN);
  }

  /** Removes our entry (if we wrote one) and, after a commit, the ones left by participants who are gone. */
  private clearEntries(sweep: boolean): void {
    const live = this.doc.live;
    const gone = sweep ? [...live.keys()].filter((k) => k !== this.key && !this.present.has(k)) : [];
    const own = this.wrote && live.has(this.key);
    this.wrote = false;
    this.lastWrite = -Infinity;
    if (!own && gone.length === 0) return;
    this.doc.ydoc.transact(() => {
      if (own) live.delete(this.key);
      for (const k of gone) live.delete(k);
    }, LIVE_ORIGIN);
  }

  private readonly onLive = (ev: { keysChanged: Set<string> }): void => {
    let changed = false;
    for (const k of ev.keysChanged) changed = this.readRemote(k) || changed;
    if (changed) this.push();
  };

  /** Parses someone else's entry (untrusted: the same validation as a stored patch). True if it is shown now. */
  private readRemote(k: string): boolean {
    if (k === this.key) return false;
    const was = this.remote.has(k);
    const raw = this.doc.live.get(k);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      this.remote.delete(k);
      return was && this.present.has(k);
    }
    const fields = new Map<string, StoredFields>();
    for (const [id, p] of Object.entries(raw as Record<string, unknown>)) {
      if (fields.size >= MAX_OBJECTS) break;
      if (typeof p !== 'object' || p === null || Array.isArray(p)) continue;
      const kind = this.doc.objects.get(id)?.get('kind');
      if (isKind(kind)) fields.set(id, normalizePatch(kind, p));
    }
    this.remote.set(k, fields);
    return this.present.has(k);
  }

  /** Our preview over the present participants' ones. */
  private push(): void {
    const all = new Map<string, StoredFields>();
    for (const [k, fields] of this.remote) {
      if (!this.present.has(k)) continue;
      for (const [id, f] of fields) all.set(id, f);
    }
    for (const [id, f] of this.local) all.set(id, f);
    this.scene.setOverrides(all);
  }
}

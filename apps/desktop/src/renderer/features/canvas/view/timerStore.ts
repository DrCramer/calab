/**
 * The countdown of a canvas as an external store (no React, no Zustand): the leaf component reads its snapshot,
 * the toolbar calls its commands. It owns the only timer the feature has, and that exists only while the shared
 * timer RUNS and the canvas is VISIBLE: one `setTimeout` to the next change of the shown seconds (never a fixed
 * interval), none when idle, paused, over or hidden. A hidden canvas recomputes when it is shown again.
 *
 * Time is server time: `now()` is the local clock plus an offset estimated once per session from the `Date` header
 * of one light REST call (fetched lazily, the first time a timer is seen or started; no periodic requests). Without
 * the header (cross-origin without `Access-Control-Expose-Headers: Date`) the offset stays 0 — the clocks' own error.
 */
import type * as Y from 'yjs';
import {
  NO_TIMER, finishTimer, nextTickIn, parseTimer, pauseTimer, resetTimer, resumeTimer, startTimer, viewOf, type TimerDoc, type TimerView,
} from '../../../lib/canvas/timer';

/** A timer that ran out longer ago than this when the canvas becomes visible is old news: no signal. */
export const SIGNAL_GRACE_MS = 30_000;

export interface TimerStoreOptions {
  meta: Y.Map<unknown>;
  /** Me: only the person who started a timer writes its `done`. */
  userId: string;
  /** Write access right now (the engine is not read-only). */
  canWrite: () => boolean;
  /** The canvas is on screen and the window is visible (`engine.isActive`). */
  visible: () => boolean;
  /** Tells when `visible()` may have changed; returns the unsubscribe. */
  onVisible: (fn: () => void) => () => void;
  /** Server-time offset in ms (`serverNow − localNow`), estimated once; null = unknown. */
  fetchOffset?: () => Promise<number | null>;
  /** The cue at the end (once per timer per client). */
  playEnd: () => void;
  /** Timers this app session has chimed for (default: shared by the whole session, so a reopened canvas stays quiet). */
  signalled?: Set<string>;
  /** Local clock, for tests. */
  clock?: () => number;
  /** Scheduling, for tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

/** Timers already signalled in this app session (a reopened canvas does not chime again). */
const sessionSignalled = new Set<string>();

export class TimerStore {
  private view: TimerView = NO_TIMER;
  private doc: TimerDoc | null;
  private offset = 0;
  private offsetState: 'idle' | 'loading' | 'done' = 'idle';
  private timer: unknown = null;
  private readonly subs = new Set<() => void>();
  private readonly clock: () => number;
  private readonly offMeta: () => void;
  private readonly offVisible: () => void;
  private destroyed = false;
  private shown: boolean;

  constructor(private readonly o: TimerStoreOptions) {
    this.clock = o.clock ?? Date.now;
    this.doc = parseTimer(o.meta.get('timer'));
    const onMeta = (e: Y.YMapEvent<unknown>): void => {
      if (e.keysChanged.has('timer')) this.refresh();
    };
    o.meta.observe(onMeta);
    this.offMeta = () => o.meta.unobserve(onMeta);
    this.shown = o.visible();
    this.offVisible = o.onVisible(() => {
      // Tells about every camera move too: only a real change of visibility matters.
      const v = o.visible();
      if (v === this.shown) return;
      this.shown = v;
      this.refresh();
    });
    this.refresh();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clear();
    this.offMeta();
    this.offVisible();
    this.subs.clear();
  }

  // ── store ──────────────────────────────────────────────────────────────────

  subscribe = (fn: () => void): (() => void) => {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  };

  getSnapshot = (): TimerView => this.view;

  get canControl(): boolean {
    return this.o.canWrite();
  }

  /** Server time now (ms). */
  now(): number {
    return this.clock() + this.offset;
  }

  /** Whether a one-shot timer is armed (tests: idle, paused, over and hidden mean none). */
  get ticking(): boolean {
    return this.timer !== null;
  }

  // ── commands (writers only) ────────────────────────────────────────────────

  async start(minutes: number): Promise<boolean> {
    if (!this.o.canWrite()) return false;
    await this.ensureOffset();
    if (this.destroyed || !this.o.canWrite()) return false;
    startTimer(this.o.meta, minutes, this.o.userId, this.now());
    return true;
  }

  pause(): boolean {
    return this.o.canWrite() && pauseTimer(this.o.meta, this.o.userId, this.now());
  }

  resume(): boolean {
    return this.o.canWrite() && resumeTimer(this.o.meta, this.o.userId, this.now());
  }

  reset(): boolean {
    return this.o.canWrite() && resetTimer(this.o.meta);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private clear(): void {
    if (this.timer === null) return;
    (this.o.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = null;
  }

  private ensureOffset(): Promise<void> {
    const f = this.o.fetchOffset;
    if (!f || this.offsetState === 'done') return Promise.resolve();
    if (this.offsetState === 'loading') return this.pending;
    this.offsetState = 'loading';
    this.pending = f()
      .then((v) => {
        if (v !== null && Number.isFinite(v)) this.offset = v;
      })
      .catch(() => undefined)
      .then(() => {
        this.offsetState = 'done';
        if (!this.destroyed) this.refresh();
      });
    return this.pending;
  }

  private pending: Promise<void> = Promise.resolve();

  /** Re-reads the document and the clock; notifies on a change; (re)arms the single timer. */
  private refresh(): void {
    if (this.destroyed) return;
    this.doc = parseTimer(this.o.meta.get('timer'));
    if (this.doc && this.offsetState === 'idle') void this.ensureOffset();
    const prev = this.view;
    const next = viewOf(this.doc, this.now());
    const changed = next.phase !== prev.phase || next.secs !== prev.secs || next.durationMs !== prev.durationMs || next.by !== prev.by;
    if (changed) {
      this.view = next;
      for (const fn of this.subs) fn();
    }
    if (next.phase === 'ended' && this.doc) this.ended(this.doc);
    this.arm();
  }

  /** The end of a timer: the cue once, and the starter writes `done`. */
  private ended(t: TimerDoc): void {
    if (!this.o.visible()) return;
    const key = `${t.by}|${t.durationMs}|${t.endsAt}`;
    const signalled = this.o.signalled ?? sessionSignalled;
    if (!signalled.has(key)) {
      signalled.add(key);
      if (signalled.size > 50) signalled.delete(signalled.values().next().value as string);
      // Only a timer that ended just now chimes: one found over long ago (a canvas opened later) stays quiet.
      // A `done` written by the starter's client first still chimes here (its `endsAt` is kept).
      if (this.now() - t.endsAt <= SIGNAL_GRACE_MS) this.o.playEnd();
    }
    if (t.state === 'running' && t.by === this.o.userId && this.o.canWrite()) finishTimer(this.o.meta);
  }

  private arm(): void {
    this.clear();
    if (this.destroyed || !this.o.visible()) return;
    const d = nextTickIn(this.doc, this.now());
    if (d === null) return;
    const set = this.o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.timer = set(() => {
      this.timer = null;
      this.refresh();
    }, d + 4);
  }
}

/**
 * Voice connection watchdog (docs/09 #131). Nothing on the connect path may park the UI in
 * «Подключение…» for good: the old room's teardown is bounded (settleWithin), and a connect that
 * stays unfinished is noticed here and handed back to services/voice.ts, which retries once with a
 * fresh Room and token and otherwise leaves voice with a toast. Pure timing logic: the timers are
 * injectable for the unit tests.
 */

/** «Подключение…» (a join or a room switch) longer than this: stuck. */
export const CONNECT_STUCK_MS = 15_000;
/** «Переподключение…» with nobody making progress on it longer than this: stuck. */
export const RECONNECT_STUCK_MS = 30_000;
/**
 * LiveKit's own resume (its DefaultReconnectPolicy runs ~45 s before it gives up with
 * Disconnected, which starts our rejoin) is trusted this long; after it we rejoin ourselves.
 */
export const LK_RESUME_MAX_MS = 60_000;
/** The old room's `room.disconnect()` is waited for at most this long (a half-open socket may never answer). */
export const DISCONNECT_WAIT_MS = 3_000;
/** Stopping my screen share (unpublish over a dead link) is waited for at most this long. */
export const STOP_STREAM_WAIT_MS = 2_000;
/** A connect waits at most this long for a teardown still running (its own awaits are bounded above). */
export const TEARDOWN_WAIT_MS = DISCONNECT_WAIT_MS + STOP_STREAM_WAIT_MS + 1_000;

/** Where the current connect attempt is: the old room's teardown, the /join request, LiveKit's `Room.connect`. */
export type ConnectStage = 'teardown' | 'join' | 'signal';
export type StuckKind = 'connecting' | 'reconnecting';

/**
 * Waits for `p` at most `ms`: true when it settled in time (resolved or rejected), false on the
 * timeout. Never rejects; the promise itself is left running.
 */
export function settleWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((r) => {
    timer = setTimeout(() => r(false), ms);
  });
  const done = p.then(
    () => true,
    () => true,
  );
  return Promise.race([done, timeout]).finally(() => clearTimeout(timer));
}

/** `p`, or a rejection once `ms` pass without it settling (the promise itself is left running). */
export function rejectAfter<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export interface WatchdogTimers {
  set(fn: () => void, ms: number): unknown;
  clear(id: unknown): void;
  now(): number;
}

const realTimers: WatchdogTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

/**
 * Arms one timer while the voice store is connecting or reconnecting. `update` is called on every
 * store change with primitives only (cheap: the store also changes on meter / speaking updates);
 * the wait starts when the kind or the target room changes. `onStuck` gets the total time spent.
 */
export class ConnectWatchdog {
  private kind: StuckKind | null = null;
  private key: string | null = null;
  private since = 0;
  private timer: unknown = null;

  constructor(
    private readonly onStuck: (kind: StuckKind, ms: number) => void,
    private readonly timers: WatchdogTimers = realTimers,
  ) {}

  /** The watched state: connecting / reconnecting to `key` (the target room), or neither (null). */
  update(kind: StuckKind | null, key: string | null): void {
    if (kind === this.kind && (kind === null || key === this.key)) return;
    this.clearTimer();
    this.kind = kind;
    this.key = kind ? key : null;
    if (!kind) return;
    this.since = this.timers.now();
    this.arm();
  }

  /** Waits another period for the same state (a retry or a cycle still at work); the total time keeps counting. */
  rearm(): void {
    if (!this.kind) return;
    this.clearTimer();
    this.arm();
  }

  /** How long the current connecting / reconnecting lasts, or null. */
  elapsed(): { kind: StuckKind; ms: number } | null {
    return this.kind ? { kind: this.kind, ms: this.timers.now() - this.since } : null;
  }

  private arm(): void {
    const kind = this.kind;
    if (!kind) return;
    this.timer = this.timers.set(
      () => {
        this.timer = null;
        if (this.kind === kind) this.onStuck(kind, this.timers.now() - this.since);
      },
      kind === 'connecting' ? CONNECT_STUCK_MS : RECONNECT_STUCK_MS,
    );
  }

  private clearTimer(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
  }
}

/** What to do about a stuck «Переподключение…» (services/voice.ts carries it out). */
export type ReconnectVerdict = 'wait' | 'connected' | 'rejoin';

/**
 * `loop`: our rejoin cycle runs and its current attempt (or backoff) is younger than
 * RECONNECT_STUCK_MS; `livekit`: the LiveKit room's own state; `ms`: time in «Переподключение…».
 */
export function reconnectVerdict(v: { loop: boolean; livekit: 'connected' | 'reconnecting' | 'none'; ms: number }): ReconnectVerdict {
  if (v.livekit === 'connected') return 'connected'; // the store missed the Connected event
  if (v.loop) return 'wait';
  if (v.livekit === 'reconnecting' && v.ms < LK_RESUME_MAX_MS) return 'wait';
  return 'rejoin';
}

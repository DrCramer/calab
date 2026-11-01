/**
 * My voice flags → the server (`PATCH /api/voice/self`), converging on the latest intent
 * (ADR-0134; docs/05 «Состояние голоса»).
 *
 * The flags the others see (mic, deafen, musician, PTT mode, «on the phone») are what the user
 * clicked; the request may fail or hang on a flaky network. Rules:
 *  - one request in flight: a newer intent waits and is sent after it, so an older request can
 *    never land last (latest wins, no reordering on the wire);
 *  - intents in between are merged (a one-off `onPhone` survives a later plain push);
 *  - a failed request is retried with backoff (RETRY_MS, capped), at most MAX_ATTEMPTS in a
 *    row; `kick()` (the gateway / LiveKit are back) retries at once and resets the count;
 *  - a request unanswered for SELF_SYNC_TIMEOUT_MS counts as failed (it must not block newer ones);
 *  - an error the server will repeat (`retriable` false) drops the intent;
 *  - `lagging` turns on when an intent stays unconfirmed for LAG_MS, so the UI never claims the
 *    others already see it; off once confirmed or dropped.
 * Timers exist only while something is unconfirmed; `stop()` (out of voice) clears everything.
 */

import { rejectAfter } from './voiceWatchdog';

export interface SelfFlags {
  muted?: boolean;
  deafened?: boolean;
  musician?: boolean;
  ptt?: boolean;
  onPhone?: boolean;
}

export const SELF_SYNC_RETRY_MS = [1000, 2000, 4000, 8000, 15000] as const;
export const SELF_SYNC_MAX_ATTEMPTS = 12; // ≈ 2.5 min of backoff, then wait for kick()
export const SELF_SYNC_LAG_MS = 1500;
/**
 * A request with no answer by then (a stalled TCP connection) counts as failed and is retried;
 * should it still land late, the self VOICE_STATE_UPDATE it causes is reconciled (voice.ts).
 */
export const SELF_SYNC_TIMEOUT_MS = 8000;

export interface SelfStateSyncOpts {
  send: (flags: SelfFlags) => Promise<unknown>;
  /** False: the server will refuse it again (4xx other than «not in voice yet») — drop the intent. */
  retriable: (err: unknown, flags: SelfFlags) => boolean;
  onLag: (lagging: boolean) => void;
  onError?: (err: unknown) => void;
}

export class SelfStateSync {
  private pending: SelfFlags | null = null;
  private inFlight: SelfFlags | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private lagTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private lagging = false;
  /** Bumped by stop(): a request answered after it changes nothing. */
  private epoch = 0;

  constructor(private readonly opts: SelfStateSyncOpts) {}

  /** A new intent (merged over one not yet sent). */
  push(flags: SelfFlags): void {
    this.pending = { ...(this.pending ?? {}), ...flags };
    this.attempts = 0;
    this.armLag();
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.flush();
  }

  /** The link is back: an unconfirmed intent is retried now, with a fresh attempt budget. */
  kick(): void {
    if (!this.pending || this.inFlight) return;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.attempts = 0;
    this.flush();
  }

  /** Out of voice: nothing to converge any more. */
  stop(): void {
    this.epoch++;
    this.pending = null;
    this.inFlight = null;
    this.attempts = 0;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.clearLag();
  }

  get unconfirmed(): boolean {
    return this.pending !== null || this.inFlight !== null;
  }

  private flush(): void {
    if (this.inFlight || !this.pending) return;
    const flags = this.pending;
    this.pending = null;
    this.inFlight = flags;
    const epoch = this.epoch;
    void rejectAfter(this.opts.send(flags), SELF_SYNC_TIMEOUT_MS).then(
      () => {
        if (epoch !== this.epoch) return;
        this.inFlight = null;
        this.attempts = 0;
        if (this.pending) this.flush();
        else this.clearLag();
      },
      (err: unknown) => {
        if (epoch !== this.epoch) return;
        this.inFlight = null;
        this.opts.onError?.(err);
        if (!this.opts.retriable(err, flags)) {
          // Refused for good: a newer intent (if any) still goes.
          if (this.pending) this.flush();
          else this.clearLag();
          return;
        }
        // Retry the failed intent under anything newer; a newer intent waiting goes at once.
        const newer = this.pending !== null;
        this.pending = { ...flags, ...(this.pending ?? {}) };
        this.attempts++;
        if (newer) {
          this.flush();
          return;
        }
        if (this.attempts >= SELF_SYNC_MAX_ATTEMPTS) return; // waits for kick() / a new push
        const delay = SELF_SYNC_RETRY_MS[Math.min(this.attempts - 1, SELF_SYNC_RETRY_MS.length - 1)];
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this.flush();
        }, delay);
      },
    );
  }

  private armLag(): void {
    if (this.lagging || this.lagTimer !== null) return;
    this.lagTimer = setTimeout(() => {
      this.lagTimer = null;
      if (!this.unconfirmed) return;
      this.lagging = true;
      this.opts.onLag(true);
    }, SELF_SYNC_LAG_MS);
  }

  private clearLag(): void {
    if (this.lagTimer !== null) clearTimeout(this.lagTimer);
    this.lagTimer = null;
    if (!this.lagging) return;
    this.lagging = false;
    this.opts.onLag(false);
  }
}

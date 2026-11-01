import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SELF_SYNC_LAG_MS, SELF_SYNC_MAX_ATTEMPTS, SELF_SYNC_TIMEOUT_MS, SelfStateSync, type SelfFlags } from './selfStateSync';

interface Call { flags: SelfFlags; resolve: () => void; reject: (e: unknown) => void }

function setup(retriable = (): boolean => true) {
  const calls: Call[] = [];
  const lag: boolean[] = [];
  const sync = new SelfStateSync({
    send: (flags) => new Promise<void>((resolve, reject) => void calls.push({ flags, resolve, reject })),
    retriable,
    onLag: (on) => void lag.push(on),
  });
  return { sync, calls, lag };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('SelfStateSync (ADR-0134)', () => {
  it('one request in flight: a newer intent goes after it, never before (latest wins)', async () => {
    const { sync, calls } = setup();
    sync.push({ muted: true });
    sync.push({ muted: false });
    sync.push({ deafened: true });
    expect(calls).toHaveLength(1);
    calls[0]?.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.map((c) => c.flags)).toEqual([{ muted: true }, { muted: false, deafened: true }]);
    calls[1]?.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(sync.unconfirmed).toBe(false);
  });

  it('a failed request is retried with backoff until it lands', async () => {
    const { sync, calls, lag } = setup();
    sync.push({ muted: false });
    calls[0]?.reject(new Error('offline'));
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    expect(lag).toEqual([]);
    calls[1]?.reject(new Error('offline'));
    await vi.advanceTimersByTimeAsync(SELF_SYNC_LAG_MS);
    expect(lag).toEqual([true]); // still unconfirmed after 1.5 s: the UI says so
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toHaveLength(3);
    expect(calls[2]?.flags).toEqual({ muted: false });
    calls[2]?.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(lag).toEqual([true, false]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(3); // no timer left
  });

  it('a newer intent during the backoff is sent at once and replaces the failed one', async () => {
    const { sync, calls } = setup();
    sync.push({ muted: true, onPhone: false });
    calls[0]?.reject(new Error('offline'));
    await vi.advanceTimersByTimeAsync(0);
    sync.push({ muted: false });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.flags).toEqual({ muted: false, onPhone: false });
  });

  it('bounded: stops after the attempt budget, kick() resumes at once', async () => {
    const { sync, calls } = setup();
    sync.push({ muted: true });
    for (let i = 0; i < SELF_SYNC_MAX_ATTEMPTS; i++) {
      calls[i]?.reject(new Error('offline'));
      await vi.advanceTimersByTimeAsync(20_000);
    }
    expect(calls).toHaveLength(SELF_SYNC_MAX_ATTEMPTS);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(calls).toHaveLength(SELF_SYNC_MAX_ATTEMPTS);
    sync.kick();
    expect(calls).toHaveLength(SELF_SYNC_MAX_ATTEMPTS + 1);
  });

  it('a hung request times out instead of blocking newer intents', async () => {
    const { sync, calls } = setup();
    sync.push({ muted: true });
    sync.push({ muted: false });
    await vi.advanceTimersByTimeAsync(SELF_SYNC_TIMEOUT_MS);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.flags).toEqual({ muted: false });
  });

  it('a refusal the server would repeat drops the intent; stop() clears all timers', async () => {
    const { sync, calls, lag } = setup(() => false);
    sync.push({ musician: true });
    calls[0]?.reject(new Error('PLAN_LIMIT'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toHaveLength(1);
    expect(sync.unconfirmed).toBe(false);
    expect(lag).toEqual([]);
    sync.push({ muted: true });
    sync.stop();
    calls[1]?.reject(new Error('late'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});

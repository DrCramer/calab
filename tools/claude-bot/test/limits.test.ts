import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/ratelimit.js';
import { RunLock } from '../src/runlock.js';

const MIN = 60_000;

describe('RunLock', () => {
  it('allows one run at a time', () => {
    const lock = new RunLock(10 * MIN);
    const a = lock.tryAcquire(0);
    expect(a.ok).toBe(true);
    expect(lock.running).toBe(true);
    expect(lock.tryAcquire(5 * MIN)).toEqual({ ok: false, reason: 'running', since: 0 });
    // still running long after the cooldown: still busy
    expect(lock.tryAcquire(60 * MIN)).toEqual({ ok: false, reason: 'running', since: 0 });
    if (a.ok) a.release();
    expect(lock.running).toBe(false);
  });

  it('keeps 10 minutes between run starts', () => {
    const lock = new RunLock(10 * MIN);
    const a = lock.tryAcquire(0);
    if (a.ok) a.release();
    expect(lock.tryAcquire(2 * MIN)).toEqual({ ok: false, reason: 'cooldown', lastStart: 0, nextAt: 10 * MIN });
    expect(lock.tryAcquire(10 * MIN - 1).ok).toBe(false);
    const b = lock.tryAcquire(10 * MIN);
    expect(b.ok).toBe(true);
  });

  it('release is idempotent and does not free a newer run', () => {
    const lock = new RunLock(0);
    const a = lock.tryAcquire(0);
    if (!a.ok) throw new Error('expected ok');
    a.release();
    const b = lock.tryAcquire(1);
    expect(b.ok).toBe(true);
    a.release();
    expect(lock.running).toBe(true);
  });
});

describe('RateLimiter', () => {
  it('allows 10 messages per 10 minutes per user', () => {
    const rl = new RateLimiter(10, 10 * MIN);
    for (let i = 0; i < 10; i++) expect(rl.hit('u1', i * 1000).ok).toBe(true);
    const r = rl.hit('u1', 10_000);
    expect(r).toEqual({ ok: false, retryAfterMs: 10 * MIN - 10_000, firstRefusal: true });
    expect(rl.hit('u1', 11_000)).toMatchObject({ ok: false, firstRefusal: false });
    // another user is not affected
    expect(rl.hit('u2', 11_000).ok).toBe(true);
  });

  it('frees slots as the window slides', () => {
    const rl = new RateLimiter(2, 10 * MIN);
    expect(rl.hit('u', 0).ok).toBe(true);
    expect(rl.hit('u', 5 * MIN).ok).toBe(true);
    expect(rl.hit('u', 9 * MIN)).toMatchObject({ ok: false, retryAfterMs: MIN });
    expect(rl.hit('u', 10 * MIN).ok).toBe(true);
    rl.sweep(100 * MIN);
    expect(rl.hit('u', 100 * MIN).ok).toBe(true);
  });
});

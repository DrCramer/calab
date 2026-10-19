// Sliding-window limit per key (user id): at most `max` hits in `windowMs`.

export type Hit = { ok: true } | { ok: false; retryAfterMs: number; firstRefusal: boolean };

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  /** Keys already told «slow down» in the current window (answer once, then stay silent). */
  private readonly warned = new Set<string>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  hit(key: string, now: number): Hit {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.max) {
      this.hits.set(key, list);
      const firstRefusal = !this.warned.has(key);
      this.warned.add(key);
      return { ok: false, retryAfterMs: this.windowMs - (now - (list[0] ?? now)), firstRefusal };
    }
    list.push(now);
    this.hits.set(key, list);
    this.warned.delete(key);
    return { ok: true };
  }

  /** Drops keys with no hits in the window (call now and then; the map stays small). */
  sweep(now: number): void {
    for (const [k, list] of this.hits) {
      if (list.every((t) => now - t >= this.windowMs)) {
        this.hits.delete(k);
        this.warned.delete(k);
      }
    }
  }
}

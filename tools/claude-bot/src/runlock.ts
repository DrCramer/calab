// One lead run at a time, and at least `cooldownMs` between run starts.

export type Acquire =
  | { ok: true; release: () => void }
  | { ok: false; reason: 'running'; since: number }
  | { ok: false; reason: 'cooldown'; lastStart: number; nextAt: number };

export class RunLock {
  private runningSince: number | null = null;
  private lastStart: number | null = null;

  constructor(private readonly cooldownMs: number) {}

  get running(): boolean {
    return this.runningSince !== null;
  }

  tryAcquire(now: number): Acquire {
    if (this.runningSince !== null) return { ok: false, reason: 'running', since: this.runningSince };
    if (this.lastStart !== null && now - this.lastStart < this.cooldownMs) {
      return { ok: false, reason: 'cooldown', lastStart: this.lastStart, nextAt: this.lastStart + this.cooldownMs };
    }
    this.runningSince = now;
    this.lastStart = now;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.runningSince = null;
      },
    };
  }
}

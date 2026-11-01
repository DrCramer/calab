// Crash guard: an uncaught exception or unhandled rejection is logged and the daemon keeps running (the
// SDK's gateway reconnects on its own, e.g. after `ws` emitted 'error' for a socket closed while still
// connecting). If the gateway is not back to `ready` within `recoverMs`, or errors keep coming, the daemon
// exits non-zero on purpose and launchd restarts it.

export interface GuardDeps {
  /** process (or a fake in tests). */
  proc: { on(ev: 'uncaughtException' | 'unhandledRejection', fn: (err: unknown) => void): unknown };
  log: (line: string) => void;
  /** The gateway's current status (`ready`, `reconnecting`…). */
  gatewayStatus: () => string;
  exit: (code: number) => void;
  /** Masks secrets in the logged message. */
  redact: (s: string) => string;
  setTimer?: (fn: () => void, ms: number) => unknown;
  now?: () => number;
  recoverMs?: number;
  /** More than this many errors within `windowMs` → exit. */
  maxErrors?: number;
  windowMs?: number;
}

export function describeError(err: unknown, redact: (s: string) => string): string {
  const e = err instanceof Error ? err : new Error(String(err));
  const frame = (e.stack ?? '').split('\n').find((l) => l.trim().startsWith('at ')) ?? '';
  return redact(`${e.name}: ${e.message}${frame ? ` (${frame.trim()})` : ''}`).slice(0, 500);
}

export function installCrashGuard(d: GuardDeps): void {
  const setTimer = d.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms).unref());
  const now = d.now ?? Date.now;
  const recoverMs = d.recoverMs ?? 120_000;
  const maxErrors = d.maxErrors ?? 20;
  const windowMs = d.windowMs ?? 10 * 60_000;
  let recent: number[] = [];
  let watching = false;
  let exiting = false;

  const quit = (why: string): void => {
    if (exiting) return;
    exiting = true;
    d.log(`exiting (launchd restarts the daemon): ${why}`);
    setTimer(() => {
      d.exit(1);
    }, 1000);
  };

  const onError = (kind: string) => (err: unknown) => {
    const t = now();
    recent = [...recent.filter((x) => t - x < windowMs), t];
    d.log(`warning: ${kind}, the daemon keeps running: ${describeError(err, d.redact)}`);
    if (recent.length > maxErrors) {
      quit(`${String(recent.length)} errors in ${String(Math.round(windowMs / 60_000))} min`);
      return;
    }
    if (watching) return;
    watching = true;
    setTimer(() => {
      watching = false;
      const s = d.gatewayStatus();
      if (s === 'ready') d.log('gateway recovered after the error');
      else quit(`the gateway did not recover within ${String(Math.round(recoverMs / 1000))} s (status ${s})`);
    }, recoverMs);
  };

  d.proc.on('uncaughtException', onError('uncaught exception'));
  d.proc.on('unhandledRejection', onError('unhandled rejection'));
}

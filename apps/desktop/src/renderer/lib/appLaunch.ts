/**
 * «Открыть в Calab» from a web link page (docs/09 #53): browsers give no answer to «is there a
 * handler for calab://?». The page fires the deep link and watches itself: when the OS hands the
 * link to the app, the page loses focus / gets hidden / is unloaded. If nothing of that happens
 * within the timeout, the app is (most likely) not installed.
 *
 * Pure state machine — no DOM, the timer is injected — so it is unit-tested with fake timers;
 * `bindLaunchSignals` below wires it to a real window/document.
 */

export type LaunchState = 'idle' | 'trying' | 'opened' | 'not-found';
/** What the page saw: window blur, document hidden, page unloaded (bfcache / navigation). */
export type LaunchSignal = 'blur' | 'hidden' | 'pagehide';

export interface LaunchTimers {
  set: (cb: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

export interface LaunchProbeOptions {
  /** Without a signal within this time → 'not-found'. 1.5–2 s: an app launch blurs the page well within it. */
  timeoutMs?: number;
  /**
   * A signal shortly after 'not-found' still flips to 'opened': Chrome/Safari first ask «Open Calab?»
   * and the user may take longer than the timeout to confirm.
   */
  lateMs?: number;
  timers?: LaunchTimers;
  onChange: (s: LaunchState) => void;
}

export const LAUNCH_TIMEOUT_MS = 1800;
export const LAUNCH_LATE_MS = 60_000; // Windows/Chrome: «Open Calab?» may wait for the user a long while

export interface LaunchProbe {
  readonly state: LaunchState;
  /** Starts an attempt (a repeated click restarts it). Call right before firing the deep link. */
  start: () => void;
  signal: (s: LaunchSignal) => void;
  dispose: () => void;
}

const realTimers: LaunchTimers = {
  set: (cb, ms) => setTimeout(cb, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export function createLaunchProbe(opts: LaunchProbeOptions): LaunchProbe {
  const timeoutMs = opts.timeoutMs ?? LAUNCH_TIMEOUT_MS;
  const lateMs = opts.lateMs ?? LAUNCH_LATE_MS;
  const timers = opts.timers ?? realTimers;
  let state: LaunchState = 'idle';
  let timer: unknown = null;
  /** Late signals are accepted until this timer fires. */
  let lateOpen = false;
  let disposed = false;

  const stop = (): void => {
    if (timer !== null) timers.clear(timer);
    timer = null;
  };
  const go = (s: LaunchState): void => {
    if (state === s) return;
    state = s;
    opts.onChange(s);
  };

  return {
    get state() {
      return state;
    },
    start() {
      if (disposed) return;
      stop();
      lateOpen = false;
      go('trying');
      timer = timers.set(() => {
        timer = null;
        go('not-found');
        lateOpen = true;
        timer = timers.set(() => {
          timer = null;
          lateOpen = false;
        }, lateMs);
      }, timeoutMs);
    },
    signal() {
      if (disposed) return;
      if (state === 'trying' || (state === 'not-found' && lateOpen)) {
        stop();
        lateOpen = false;
        go('opened');
      }
    },
    dispose() {
      disposed = true;
      stop();
    },
  };
}

/** Feeds window blur, document hidden and pagehide into the probe. Returns the unsubscribe. */
export function bindLaunchSignals(probe: Pick<LaunchProbe, 'signal'>, win: Window = window, doc: Document = document): () => void {
  const blur = (): void => probe.signal('blur');
  const vis = (): void => {
    if (doc.visibilityState === 'hidden') probe.signal('hidden');
  };
  const hide = (): void => probe.signal('pagehide');
  win.addEventListener('blur', blur);
  doc.addEventListener('visibilitychange', vis);
  win.addEventListener('pagehide', hide);
  return () => {
    win.removeEventListener('blur', blur);
    doc.removeEventListener('visibilitychange', vis);
    win.removeEventListener('pagehide', hide);
  };
}

/**
 * How to fire the deep link. Firefox replaces the page with an error page for an unknown scheme
 * on a top-level navigation — a hidden iframe keeps the error inside it. Chromium and Safari
 * ignore (or ask about) a top-level navigation and keep the page.
 */
export function launchMethod(userAgent: string): 'iframe' | 'location' {
  return /Firefox\//.test(userAgent) ? 'iframe' : 'location';
}

/** The internal deep link for a web link page (never shown or copied: links are https, docs/09 #53). */
export function deepLinkFor(kind: 'join' | 'r' | 't', code: string): string {
  return `calab://${kind}/${code}`;
}

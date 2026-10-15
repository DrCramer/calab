/**
 * Web «Обновить страницу» (docs/09 #130): make the reload that follows really load the new build.
 * Activate a waiting service worker (SKIP_WAITING; sw.js also skips on install), wait for the
 * `controllerchange` (bounded), and refresh the cached index document so the reload does not
 * serve the old shell (then the version bar would still show). Never throws: the caller reloads
 * either way.
 */

const STEP_TIMEOUT_MS = 2500;

export interface UpdateEnv {
  sw?: Pick<ServiceWorkerContainer, 'getRegistration' | 'addEventListener' | 'removeEventListener'>;
  refetchIndex?: () => Promise<unknown>;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

/** The worker that is installed but not yet in control, if any. */
export function pendingWorker(reg: Pick<ServiceWorkerRegistration, 'waiting' | 'installing'> | undefined): ServiceWorker | null {
  return reg?.waiting ?? reg?.installing ?? null;
}

export async function activateWebUpdate(env: UpdateEnv): Promise<void> {
  try {
    const sw = env.sw;
    const reg = sw
      ? await withTimeout(
          sw.getRegistration().then(async (r) => {
            await r?.update().catch(() => undefined);
            return r;
          }),
          STEP_TIMEOUT_MS,
        )
      : undefined;
    const worker = pendingWorker(reg);
    if (worker && sw) {
      const changed = new Promise<void>((resolve) => {
        const on = (): void => {
          sw.removeEventListener('controllerchange', on);
          resolve();
        };
        sw.addEventListener('controllerchange', on);
      });
      worker.postMessage({ type: 'SKIP_WAITING' });
      await withTimeout(changed, STEP_TIMEOUT_MS);
    }
  } catch {
    // reload anyway
  }
  await withTimeout(env.refetchIndex?.() ?? Promise.resolve(), STEP_TIMEOUT_MS);
}

/** The browser wiring: the real container and a cache-bypassing fetch of the shell. */
export function browserUpdateEnv(): UpdateEnv {
  return {
    sw: 'serviceWorker' in navigator ? navigator.serviceWorker : undefined,
    refetchIndex: () => fetch('/', { cache: 'reload', credentials: 'same-origin' }),
  };
}

import { describe, expect, it, vi } from 'vitest';
import { activateWebUpdate, pendingWorker, type UpdateEnv } from './webUpdate';

function fakeSw(reg: unknown) {
  const listeners = new Set<() => void>();
  return {
    listeners,
    sw: {
      getRegistration: () => Promise.resolve(reg as ServiceWorkerRegistration | undefined),
      addEventListener: (_: string, fn: () => void) => void listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => void listeners.delete(fn),
    } as UpdateEnv['sw'],
  };
}

describe('webUpdate', () => {
  it('prefers waiting over installing', () => {
    const a = {} as ServiceWorker;
    const b = {} as ServiceWorker;
    expect(pendingWorker({ waiting: a, installing: b })).toBe(a);
    expect(pendingWorker({ waiting: null, installing: b })).toBe(b);
    expect(pendingWorker(undefined)).toBeNull();
  });

  it('posts SKIP_WAITING, waits for controllerchange, then refetches the shell', async () => {
    const order: string[] = [];
    const holder: { f?: ReturnType<typeof fakeSw> } = {};
    const postMessage = vi.fn(() => {
      order.push('skip');
      setTimeout(() => holder.f?.listeners.forEach((l) => l()), 0);
    });
    const f = fakeSw({ waiting: { postMessage }, installing: null, update: () => Promise.resolve() });
    holder.f = f;
    await activateWebUpdate({
      sw: f.sw,
      refetchIndex: () => {
        order.push('refetch');
        return Promise.resolve();
      },
    });
    expect(postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    expect(order).toEqual(['skip', 'refetch']);
    expect(f.listeners.size).toBe(0);
  });

  it('without a pending worker only refetches; failures never throw', async () => {
    const refetch = vi.fn(() => Promise.reject(new Error('offline')));
    await expect(activateWebUpdate({ sw: fakeSw(undefined).sw, refetchIndex: refetch })).resolves.toBeUndefined();
    expect(refetch).toHaveBeenCalled();
  });
});

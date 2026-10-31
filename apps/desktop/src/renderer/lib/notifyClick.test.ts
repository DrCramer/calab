import { describe, expect, it, vi } from 'vitest';

const showWindow = vi.hoisted(() => vi.fn());
vi.mock('../platform', () => ({ platform: { app: { showWindow } } }));

const { toSource } = await import('./notifyClick');

describe('toSource (ADR-0141)', () => {
  it('brings the window to the front before it leads to the source', () => {
    const calls: string[] = [];
    toSource(
      () => calls.push('open'),
      () => calls.push('show'),
    )();
    expect(calls).toEqual(['show', 'open']);
  });

  it('by default asks the platform to show the main window', () => {
    const open = vi.fn();
    toSource(open)();
    expect(showWindow).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
  });
});

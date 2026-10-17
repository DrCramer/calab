import { afterEach, describe, expect, it, vi } from 'vitest';
import { CAP, isOpen, resetDisclosures, setOpen, subscribe } from './disclosure';

afterEach(() => resetDisclosures());

describe('disclosure store (a feed row unmounted and mounted again)', () => {
  it('an unfold outlives its subscriber: a remounted row reads it open', () => {
    const stop = subscribe('m1\u0001summary', () => undefined);
    setOpen('m1\u0001summary', true);
    stop(); // Virtuoso unmounted the row
    expect(isOpen('m1\u0001summary')).toBe(true);
    setOpen('m1\u0001summary', false);
    expect(isOpen('m1\u0001summary')).toBe(false);
  });

  it('a toggle wakes only the subscribers of its own key', () => {
    const a = vi.fn();
    const b = vi.fn();
    subscribe('m1\u0001summary', a);
    subscribe('m2\u0001summary', b);
    setOpen('m1\u0001summary', true);
    setOpen('m1\u0001summary', true); // no change, no wake-up
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
  });

  it('keeps at most CAP keys, dropping the oldest', () => {
    for (let i = 0; i <= CAP; i++) setOpen(`m${i}`, true);
    expect(isOpen('m0')).toBe(false);
    expect(isOpen('m1')).toBe(true);
    expect(isOpen(`m${CAP}`)).toBe(true);
  });
});

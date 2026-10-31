import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AVATAR_RAIL_HEIGHT, CLOSE_GRACE_MS, IslandHover, OPEN_DELAY_MS, islandMode, islandVars } from './islandModel';

describe('islandMode', () => {
  const base = { shown: true, section: 'chats' as const, file: false, app: false, collapse: true };
  it('«Команда» keeps the full island', () => {
    expect(islandMode(base)).toBe('full');
  });
  it('every other section folds into the avatar', () => {
    for (const section of ['dms', 'calendar', 'boards', 'mail', 'wiki', 'canvas', 'disk', 'telephony'] as const) {
      expect(islandMode({ ...base, section })).toBe('avatar');
    }
  });
  it('an opened office file and a web app fold too', () => {
    expect(islandMode({ ...base, file: true })).toBe('avatar');
    expect(islandMode({ ...base, section: null, app: true })).toBe('avatar');
  });
  it('the setting off: the old behaviour (full, none over a web app)', () => {
    expect(islandMode({ ...base, section: 'disk', collapse: false })).toBe('full');
    expect(islandMode({ ...base, file: true, collapse: false })).toBe('full');
    expect(islandMode({ ...base, section: null, app: true, collapse: false })).toBe('none');
  });
  it('no island where the shell shows none', () => {
    expect(islandMode({ ...base, shown: false })).toBe('none');
    expect(islandMode({ ...base, section: 'disk', shown: false })).toBe('none');
  });
});

describe('islandVars', () => {
  it('full: the lists and the rail keep the island height clear', () => {
    expect(islandVars('full', 56)).toEqual({ island: '56px', rail: '56px' });
  });
  it('avatar: nothing reserved for the lists, the rail keeps the avatar clear', () => {
    expect(islandVars('avatar', 180)).toEqual({ island: null, rail: `${AVATAR_RAIL_HEIGHT}px` });
  });
  it('none: nothing', () => {
    expect(islandVars('none', 56)).toEqual({ island: null, rail: null });
  });
});

describe('IslandHover', () => {
  let changes: boolean[];
  let h: IslandHover;
  beforeEach(() => {
    vi.useFakeTimers();
    changes = [];
    h = new IslandHover((o) => changes.push(o));
  });
  afterEach(() => vi.useRealTimers());

  it('opens after the hover intent, not on a pass-by', () => {
    h.pointerEnter();
    vi.advanceTimersByTime(OPEN_DELAY_MS - 1);
    h.pointerLeave();
    vi.advanceTimersByTime(1000);
    expect(changes).toEqual([]);
    h.pointerEnter();
    vi.advanceTimersByTime(OPEN_DELAY_MS);
    expect(h.open).toBe(true);
    expect(changes).toEqual([true]);
  });

  it('closes after the grace; coming back within it keeps it open', () => {
    h.pointerEnter();
    vi.advanceTimersByTime(OPEN_DELAY_MS);
    h.pointerLeave();
    vi.advanceTimersByTime(CLOSE_GRACE_MS - 1);
    h.pointerEnter();
    vi.advanceTimersByTime(1000);
    expect(h.open).toBe(true);
    h.pointerLeave();
    vi.advanceTimersByTime(CLOSE_GRACE_MS);
    expect(h.open).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it('a menu keeps it open until it closes, then the grace', () => {
    h.pointerEnter();
    vi.advanceTimersByTime(OPEN_DELAY_MS);
    h.setHeld(true);
    h.pointerLeave();
    vi.advanceTimersByTime(5000);
    h.focusLeft();
    h.pressOutside();
    expect(h.escape()).toBe(false);
    expect(h.open).toBe(true);
    h.setHeld(false);
    vi.advanceTimersByTime(CLOSE_GRACE_MS - 1);
    expect(h.open).toBe(true);
    vi.advanceTimersByTime(1);
    expect(h.open).toBe(false);
  });

  it('a menu closing with the pointer still over the island keeps it open', () => {
    h.pointerEnter();
    vi.advanceTimersByTime(OPEN_DELAY_MS);
    h.setHeld(true);
    h.setHeld(false);
    vi.advanceTimersByTime(5000);
    expect(h.open).toBe(true);
  });

  it('keyboard: the toggle opens and closes at once, Esc and focus leaving close', () => {
    h.toggle();
    expect(h.open).toBe(true);
    h.toggle();
    expect(h.open).toBe(false);
    h.toggle();
    expect(h.escape()).toBe(true);
    expect(h.open).toBe(false);
    expect(h.escape()).toBe(false);
    h.toggle();
    h.focusLeft();
    expect(h.open).toBe(false);
    expect(changes).toEqual([true, false, true, false, true, false]);
  });

  it('focus leaving while the mouse is over the island does not close it', () => {
    h.pointerEnter();
    vi.advanceTimersByTime(OPEN_DELAY_MS);
    h.focusLeft();
    expect(h.open).toBe(true);
  });

  it('a click during the hover intent opens at once and leaves no timer behind', () => {
    h.pointerEnter();
    h.toggle();
    expect(h.open).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(changes).toEqual([true]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a prompt opens it and holds it until answered', () => {
    h.show();
    h.setHeld(true);
    expect(h.open).toBe(true);
    h.pressOutside();
    expect(h.escape()).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(h.open).toBe(true);
    h.setHeld(false);
    vi.advanceTimersByTime(CLOSE_GRACE_MS);
    expect(h.open).toBe(false);
  });

  it('a tap outside closes it (touch: no hover events)', () => {
    h.toggle();
    h.pressOutside();
    expect(h.open).toBe(false);
  });

  it('reset: closed, no timers (the setting switched off, another section)', () => {
    h.pointerEnter();
    vi.advanceTimersByTime(OPEN_DELAY_MS);
    h.setHeld(true);
    h.pointerLeave();
    h.reset();
    expect(h.open).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    // The hold is forgotten: the next hover-open closes on leave as usual.
    h.pointerEnter();
    vi.advanceTimersByTime(OPEN_DELAY_MS);
    h.pointerLeave();
    vi.advanceTimersByTime(CLOSE_GRACE_MS);
    expect(h.open).toBe(false);
  });

  it('idle: no timers', () => {
    expect(vi.getTimerCount()).toBe(0);
    h.pointerEnter();
    vi.advanceTimersByTime(OPEN_DELAY_MS);
    expect(vi.getTimerCount()).toBe(0);
  });
});

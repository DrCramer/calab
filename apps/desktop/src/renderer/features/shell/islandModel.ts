import type { Section } from '../../lib/sections';

/**
 * The bottom island folded into my avatar (ADR-0146, docs/08 «Нижний островок»): pure parts —
 * which form the island takes on the current screen, the layout variables it publishes, and the
 * open / close state machine of the folded form (hover intent, grace, a menu holding it open,
 * keyboard / tap toggling). No React, no DOM: unit tests drive it with fake timers.
 */

/** `full`: today's island under the left column; `avatar`: my avatar in the corner, the island over the content on hover; `none`: no island. */
export type IslandMode = 'full' | 'avatar' | 'none';

/**
 * The island's form. «Команда» (the rooms, the chat) keeps the full island; every other section,
 * an opened office file and a web app fold it into the avatar while the setting is on (default).
 * With the setting off: the old behaviour (full everywhere but a web app's native view, which DOM
 * cannot cover). `shown`: the shell shows an island on this screen at all.
 */
export function islandMode(s: { shown: boolean; section: Section | null; file: boolean; app: boolean; collapse: boolean }): IslandMode {
  if (!s.shown) return 'none';
  const team = s.section === 'chats' && !s.file && !s.app;
  if (team || !s.collapse) return s.app ? 'none' : 'full';
  return 'avatar';
}

/**
 * The folded avatar's footprint in the rail, as an «island height» for the rail's bottom padding
 * and fade: the avatar (32 px) sits 20 px above the bottom edge, the island box 8 px — 52 − 8.
 */
export const AVATAR_RAIL_HEIGHT = 44;

/**
 * What the island publishes on the shell (CSS variables, null = removed). `--island-height` is
 * what lists, columns and the office view keep clear (bottom padding, `.island-fade`, spacers);
 * the folded avatar keeps nothing clear there — it lies on the rail. `--island-rail` is the rail's
 * own copy: the full island's height, or the avatar's footprint.
 */
export function islandVars(mode: IslandMode, height: number): { island: string | null; rail: string | null } {
  if (mode === 'full') return { island: `${height}px`, rail: `${height}px` };
  if (mode === 'avatar') return { island: null, rail: `${AVATAR_RAIL_HEIGHT}px` };
  return { island: null, rail: null };
}

/** Hover intent before opening: a pass-by does not pop the island open. */
export const OPEN_DELAY_MS = 80;
/** Grace after the pointer leaves: crossing a small gap (to a menu, between parts) does not flicker. */
export const CLOSE_GRACE_MS = 250;

export interface IslandTimers {
  set(fn: () => void, ms: number): unknown;
  clear(id: unknown): void;
}

const realTimers: IslandTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

/**
 * The folded island's open state. Inputs: the mouse entering / leaving the whole island (avatar +
 * overlay + its menus), a toggle (click, tap, Enter / Space on the avatar), Esc, focus leaving,
 * a press outside, and `held` — a menu or popover of the island is open (it stays open until the
 * menu closes, then closes after the grace if the pointer is gone). At most one timer, and only
 * between an input and its outcome: nothing runs while idle.
 */
export class IslandHover {
  open = false;
  private inside = false;
  private held = false;
  private timer: unknown = null;

  constructor(
    private readonly onChange: (open: boolean) => void,
    private readonly timers: IslandTimers = realTimers,
  ) {}

  /** The mouse entered the island (touch and pen do not hover: they toggle). */
  pointerEnter(): void {
    this.inside = true;
    this.cancel();
    if (!this.open) this.schedule(true, OPEN_DELAY_MS);
  }

  pointerLeave(): void {
    this.inside = false;
    this.cancel();
    if (this.open && !this.held) this.schedule(false, CLOSE_GRACE_MS);
  }

  /** Click / tap / Enter / Space on the avatar. */
  toggle(): void {
    this.cancel();
    this.set(!this.open);
  }

  /** Something in the island needs an answer (a prompt): open now; the caller also holds it. */
  show(): void {
    this.cancel();
    this.set(true);
  }

  /** Esc inside the island: closes unless a menu takes the key (it closes first). */
  escape(): boolean {
    if (!this.open || this.held) return false;
    this.cancel();
    this.set(false);
    return true;
  }

  /** Focus went outside the island (and not into its menu): closes unless the mouse is over it. */
  focusLeft(): void {
    if (!this.open || this.held || this.inside) return;
    this.cancel();
    this.set(false);
  }

  /** A press outside the island and its menus. */
  pressOutside(): void {
    if (!this.open || this.held) return;
    this.cancel();
    this.inside = false;
    this.set(false);
  }

  /** A menu / popover of the island opened (true) or closed (false). */
  setHeld(held: boolean): void {
    if (this.held === held) return;
    this.held = held;
    if (held) this.cancel();
    else if (this.open && !this.inside) this.schedule(false, CLOSE_GRACE_MS);
  }

  /** The island left the avatar form (setting off, another section): closed, no timer left. */
  reset(): void {
    this.cancel();
    this.inside = false;
    this.held = false;
    this.set(false);
  }

  private set(open: boolean): void {
    if (this.open === open) return;
    this.open = open;
    this.onChange(open);
  }

  private schedule(open: boolean, ms: number): void {
    this.timer = this.timers.set(() => {
      this.timer = null;
      this.set(open);
    }, ms);
  }

  private cancel(): void {
    if (this.timer === null) return;
    this.timers.clear(this.timer);
    this.timer = null;
  }
}

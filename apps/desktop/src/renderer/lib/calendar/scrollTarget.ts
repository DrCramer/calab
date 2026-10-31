/*
 * Where the day / week hour grid opens (CBF-57). Pure.
 * A selected meeting (created, deep link) wins and sits a third from the top; otherwise the start
 * of the user's working day is at the top, less a little context. «Now» never moves it.
 */

/** No working hours set → the grid opens at 08:00. */
export const DEFAULT_OPEN_MIN = 8 * 60;
/** Context shown above the working day's start. */
export const OPEN_CONTEXT_MIN = 30;

export interface ScrollTarget {
  /** Minute of the day to bring into view. */
  minute: number;
  /** `top`: that minute is the grid's first line; `third`: a third from the top. */
  at: 'top' | 'third';
}

export function gridScrollTarget(workStartMin: number | undefined, selectedTopMin: number | undefined): ScrollTarget {
  if (selectedTopMin !== undefined) return { minute: selectedTopMin, at: 'third' };
  if (workStartMin === undefined) return { minute: DEFAULT_OPEN_MIN, at: 'top' };
  return { minute: Math.max(0, workStartMin - OPEN_CONTEXT_MIN), at: 'top' };
}

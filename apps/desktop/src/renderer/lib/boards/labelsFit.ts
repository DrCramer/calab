/**
 * Which labels of a task show as pills and which collapse into the «+N» group pill (docs/08).
 * A pure function of widths: the browser's `flex-wrap` is replayed (an item goes to the next row
 * when it does not fit; one wider than the row is clamped to it, pills truncate their text), so
 * the answer for a given width never depends on how the DOM looked before.
 */
export interface FitInput {
  /** Natural widths of the label pills, in display order. */
  widths: readonly number[];
  /** The group pill's width, reserved for the worst case (it depends on the label count, not on how many hide). */
  group: number;
  /** A trailing control that always shows (the «+» of the properties panel), 0 when there is none. */
  tail?: number;
  /** The row width available to the pills. */
  max: number;
  gap: number;
  /** At most this many rows (2 on cards and in the panel, 1 in a list row). */
  rows: number;
}

interface Cursor {
  row: number;
  used: number;
}

/** Places an item of width `w` after `c`, the way a wrapping flex row does. */
function place(c: Cursor, w: number, max: number, gap: number): Cursor {
  const width = Math.min(w, max);
  if (c.used === 0) return { row: c.row, used: width };
  if (c.used + gap + width <= max) return { row: c.row, used: c.used + gap + width };
  return { row: c.row + 1, used: width };
}

/** How many leading labels show; the rest (`widths.length - visible`) go to the group pill. */
export function fitLabels({ widths, group, tail = 0, max, gap, rows }: FitInput): number {
  const n = widths.length;
  if (n === 0 || max <= 0) return n;
  // The cursor after each prefix of the labels (index k = the first k placed).
  const prefix: Cursor[] = [{ row: 1, used: 0 }];
  for (let i = 0; i < n; i++) prefix.push(place(prefix[i] as Cursor, widths[i] ?? 0, max, gap));
  const closes = (c: Cursor): boolean => (tail > 0 ? place(c, tail, max, gap) : c).row <= rows;
  if (closes(prefix[n] as Cursor)) return n;
  for (let k = n - 1; k >= 0; k--) {
    if (closes(place(prefix[k] as Cursor, group, max, gap))) return k;
  }
  return 0;
}

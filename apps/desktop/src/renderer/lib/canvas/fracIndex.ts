/**
 * Fractional z-order keys (ADR-0107 §3): strings over a 62-digit alphabet whose plain code-unit order
 * is the layer order. Inserting between two keys never rewrites a neighbour, so reordering one object
 * does not conflict with an insert of another.
 */
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = DIGITS.length;

const digitAt = (i: number): string => DIGITS.charAt(i);
const digitOf = (ch: string | undefined): number => {
  if (ch === undefined) return 0;
  const i = DIGITS.indexOf(ch);
  return i < 0 ? 0 : i;
};

/** True if `s` is a well-formed key: non-empty, alphabet digits only. */
export const isValidKey = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 256 && /^[0-9A-Za-z]+$/.test(s);

/** Two random digits (zeros trimmed off the end so a key built from `between` never ends in 0). */
const randomTail = (rng: (() => number) | null): string => {
  if (!rng) return '';
  let out = '';
  for (let k = 0; k < 2; k++) out += digitAt(Math.min(BASE - 1, Math.floor(rng() * BASE)));
  return out.replace(/0+$/, '');
};

/**
 * A key strictly between `a` and `b` (`''`/null = open ends). Requires a < b. `rng` (0..1) adds a short
 * random tail so two clients appending at once rarely produce the same key; the tail keeps the result
 * inside (a, b).
 */
export function between(a: string | null, b: string | null, rng: (() => number) | null = Math.random): string {
  const lo = a ?? '';
  let hi = b;
  if (hi !== null && lo >= hi) throw new Error(`fracIndex: ${lo} >= ${hi}`);
  let out = '';
  for (let i = 0; ; i++) {
    const ca = digitOf(lo[i]);
    const cb = hi !== null && i < hi.length ? digitOf(hi[i]) : BASE;
    if (ca === cb) {
      out += digitAt(ca);
      continue;
    }
    const mid = (ca + cb) >> 1;
    if (mid > ca) {
      out += digitAt(mid);
      break;
    }
    // Adjacent digits: keep a's digit and continue below an open upper bound.
    out += digitAt(ca);
    hi = null;
  }
  if (rng) {
    out += randomTail(rng);
    if (out <= lo || (b !== null && out >= b)) out = between(a, b, null);
  }
  return out;
}

/**
 * Appended keys are "integers": a head letter a–z says how many digits follow (a → 2, b → 3, …), then a
 * fixed-width base-62 counter. Appending N objects costs O(log N) characters, not O(N) as repeated
 * midpoints would. Anything that does not look like that (a key made by `between`) is handled generically.
 */
const HEADS = 'abcdefghijklmnopqrstuvwxyz';
const intDigits = (head: string): number => HEADS.indexOf(head) + 2;

/** Key above everything (`max` = the current highest key, if any). */
export function after(max: string | null, rng: (() => number) | null = Math.random): string {
  if (!max) return 'a' + '0'.repeat(intDigits('a')) + randomTail(rng);
  const head = max.charAt(0);
  const n = HEADS.includes(head) ? intDigits(head) : 0;
  if (n === 0 || max.length < n + 1) return between(max, null, rng);
  const digits = max.slice(1, n + 1).split('').map(digitOf);
  let i = digits.length - 1;
  while (i >= 0 && digits[i] === BASE - 1) digits[i--] = 0;
  if (i >= 0) {
    digits[i] = (digits[i] ?? 0) + 1;
    return head + digits.map(digitAt).join('') + randomTail(rng);
  }
  // Overflow: the next head letter with one more digit.
  const next = HEADS.charAt(HEADS.indexOf(head) + 1);
  if (next === '') return between(max, null, rng);
  return next + '0'.repeat(intDigits(next)) + randomTail(rng);
}

/** Key below everything. */
export function before(min: string | null, rng: (() => number) | null = Math.random): string {
  return between(null, min, rng);
}

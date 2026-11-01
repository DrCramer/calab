/**
 * Phone numbers of «Телефония» (ADR-0137 §2): the TS mirror of the server's normalisation —
 * `sip.NormalizeNumber` (calls from a room, caller ID) and `sip.NormalizeContactNumber` (the phone
 * book, the dial pad, CSV import) — run against the shared vectors
 * `proto/testdata/phone_numbers.json` (phoneNumber.test.ts), like the permission vectors. The
 * server stays the source of truth: the client uses these for hints (the dial pad's suggestions,
 * «is this a number?») and never rejects what the server might accept.
 *
 * Plus the dial pad's input helpers: what a pasted text («Тел.: 8 (916) 123-45-67») leaves in
 * the field, and the digits a number compares by.
 */

/** E.164 as the server checks it: «+», a non-zero first digit, 7..15 digits in all. */
const E164 = /^\+[1-9]\d{6,14}$/;

/** The separators the server skips: space, NBSP, dash, dot, brackets. */
const SEP = new Set([' ', '\u00a0', '-', '.', '(', ')']);

/**
 * sip.NormalizeNumber: separators dropped, «+…» as is, «00…» → «+…», 11 digits on 8 / 7 → +7…;
 * anything else (letters, a «+» not first, too short / long) → ''.
 */
export function normalizeNumber(input: string): string {
  let n = '';
  const s = input.trim();
  for (let i = 0; i < s.length; i++) {
    const r = s[i] ?? '';
    if (r >= '0' && r <= '9') n += r;
    else if (r === '+' && i === 0) n += r;
    else if (!SEP.has(r)) return '';
  }
  if (n.startsWith('+')) {
    // as is
  } else if (n.startsWith('00')) n = `+${n.slice(2)}`;
  else if (n.length === 11 && (n[0] === '8' || n[0] === '7')) n = `+7${n.slice(1)}`;
  else return '';
  return E164.test(n) ? n : '';
}

/**
 * sip.NormalizeContactNumber: normalizeNumber, plus a Russian mobile number without the trunk
 * prefix (10 digits on 9) → +7… when the workspace's own number (`callerId`) is a +7 number.
 */
export function normalizeContactNumber(input: string, callerId: string): string {
  const n = normalizeNumber(input);
  if (n) return n;
  if (!callerId.startsWith('+7')) return '';
  let d = '';
  for (const r of input.trim()) {
    if (r >= '0' && r <= '9') d += r;
    else if (!SEP.has(r)) return '';
  }
  return d.length === 10 && d[0] === '9' ? `+7${d}` : '';
}

/** The digits of a number (for matching: «+7 916 123-45-67» → «79161234567»). */
export const digitsOf = (s: string): string => s.replace(/\D/g, '');

/**
 * The comparable digits of what is typed on the dial pad: a Russian national «8…» counts as «7…»
 * (8 916 … and +7 916 … are the same number), a «00» prefix as nothing.
 */
export function dialKey(typed: string): string {
  const d = digitsOf(typed);
  if (typed.trim().startsWith('+')) return d;
  if (d.startsWith('00')) return d.slice(2);
  if (d.startsWith('8') && d.length > 1) return `7${d.slice(1)}`;
  return d;
}

/** Characters the dial pad keeps: a leading «+», digits, «*» and «#». */
export function dialChars(s: string): string {
  const plus = s.trimStart().startsWith('+');
  const rest = s.replace(/[^\d*#]/g, '');
  return (plus ? '+' : '') + rest;
}

/**
 * A pasted text → what the dial field keeps (ADR-0137 §7 «вставка чистит мусор»): the first run
 * that looks like a number — digits with spaces, dashes, dots and brackets, maybe a «+» in front —
 * reduced to «+» and digits. «Тел.: 8 (916) 123-45-67, доб. 12» → «89161234567»; «+7 916 …» keeps
 * the «+». Nothing that looks like a number → ''.
 */
export function cleanPastedNumber(text: string): string {
  const m = /\+?\d[\d\s\u00a0\-.()]*\d/.exec(text) ?? /\+?\d/.exec(text);
  if (!m) return '';
  const run = m[0];
  return (run.startsWith('+') ? '+' : '') + digitsOf(run).slice(0, 15);
}

/** An internal number of the workspace (ADR-0117): 2..6 digits. */
export const isExtensionLike = (typed: string): boolean => /^\d{2,6}$/.test(typed);

/** The longest extension a dialed number may carry, keys and pauses (sip.MaxExtension). */
export const MAX_EXTENSION = 20;

/** Where an extension starts: «,», «;», «x», «доб», «ext» (any case). */
const EXT_MARKER = /[,;xX]|доб|ext/i;

/**
 * sip.SplitExtension (ADR-0046 addendum «Тональный набор»): «+7 495 123-45-67 доб. 101»,
 * «… ext. 101», «… x101», «…,101», «…;101» → the text before the marker and the extension. The
 * marker is the first 2 s pause after the answer; every further «,» / «;» is one more pause
 * (kept as «,»); keys 0-9 * #; spaces, NBSP, dots and dashes are skipped. No marker: the whole
 * input and ''. null: a marker without keys after it, anything else after it, or longer than
 * MAX_EXTENSION.
 */
export function splitExtension(input: string): { number: string; ext: string } | null {
  const s = input.trim();
  const m = EXT_MARKER.exec(s);
  if (!m) return { number: s, ext: '' };
  let ext = '';
  let keys = 0;
  for (const r of s.slice(m.index + m[0].length)) {
    if ((r >= '0' && r <= '9') || r === '*' || r === '#') {
      ext += r;
      keys++;
    } else if (r === ',' || r === ';') ext += ',';
    else if (r !== ' ' && r !== '\u00a0' && r !== '.' && r !== '-') return null;
  }
  ext = ext.replace(/,+$/, '');
  if (keys === 0 || ext.length > MAX_EXTENSION) return null;
  return { number: s.slice(0, m.index).trim(), ext };
}

/**
 * Charset resolution for mail text (bodies and snippets).
 *
 * Bank and legacy gateways send single-byte cyrillic mail either unlabelled or mislabelled as
 * utf-8; a naive utf-8 decode turns every high byte into U+FFFD ("���") while ascii survives.
 * We pick the encoding by sniffing the bytes: trust a valid label unless the bytes say
 * otherwise (valid utf-8 behind a single-byte cyrillic label, or a dirty decode), otherwise
 * score the two common single-byte cyrillic encodings against each other.
 */
import { Transform } from 'node:stream';

const REPLACEMENT = '�';
/** The frequent letters of running Russian text (о, е, а, и, н, т, с, р, в); case-insensitive. */
const FREQ = 'оаеинтсрв';
/** Box drawing / block elements (koi8-r's control area), C1 controls, replacement chars — never real text. */
const GARBAGE = /[\u2500-\u25FF\u0080-\u009F\uFFFD]/;
/** Cyrillic block incl. Ё/ё. */
const CYRILLIC = /[Ѐ-ӿ]/;
/** Share of cyrillic (among non-ascii) above which utf-8 bytes behind a cyrillic label are considered utf-8. */
const CYR_THRESHOLD = 0.5;

/** Canonical TextDecoder encodings that are single-byte cyrillic (labels are normalized by TextDecoder). */
const SINGLE_BYTE_CYR = new Set(['windows-1251', 'koi8-r', 'iso-8859-5', 'ibm866', 'x-mac-cyrillic']);

function safeDecoder(label: string): TextDecoder | null {
  try {
    return new TextDecoder(label);
  } catch {
    return null;
  }
}

function isUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * Share of cyrillic among the non-ascii characters: markup, urls and digits are ascii in every
 * candidate encoding and say nothing about it (an html part is mostly tags).
 */
function cyrShare(text: string): number {
  let cyr = 0;
  let wide = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) < 0x80) continue;
    wide++;
    if (CYRILLIC.test(ch)) cyr++;
  }
  return wide ? cyr / wide : 0;
}

/**
 * `bytes` without a trailing incomplete utf-8 sequence. Snippets are a partial fetch and stream
 * chunks end anywhere, so a cut cyrillic letter at the very end must not make honest utf-8 look
 * invalid (it used to send the whole part to the single-byte scorer: "РџРѕРґ…").
 */
export function trimUtf8Tail(bytes: Uint8Array): Uint8Array {
  const n = bytes.length;
  for (let i = n - 1; i >= 0 && i >= n - 4; i--) {
    const b = bytes[i] ?? 0;
    if ((b & 0xc0) === 0x80) continue; // continuation byte: keep looking for the lead
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return i + need > n ? bytes.subarray(0, i) : bytes;
  }
  return bytes;
}

/** Decode both single-byte cyrillic candidates; keep the one that reads like Russian (tie → windows-1251). */
function scoreCyrillic(bytes: Uint8Array): string {
  let best = 'windows-1251';
  let bestScore = -Infinity;
  for (const enc of ['windows-1251', 'koi8-r']) {
    const text = new TextDecoder(enc).decode(bytes);
    let score = 0;
    for (const ch of text) {
      if (FREQ.includes(ch) || FREQ.includes(ch.toLowerCase())) score += 1;
      else if (GARBAGE.test(ch)) score -= 4;
    }
    // strict > keeps windows-1251 on a tie — the more common of the two in the wild
    if (score > bestScore) {
      bestScore = score;
      best = enc;
    }
  }
  return best;
}

/**
 * The encoding to decode `bytes` with. `declared` is the label from the MIME part, if any.
 * Fast path for honest utf-8/ascii mail is one decode plus a U+FFFD scan.
 */
export function sniffCharset(input: Uint8Array, declared?: string): string {
  const bytes = trimUtf8Tail(input);
  const label = (declared ?? '').trim();
  const dec = label ? safeDecoder(label) : null;
  if (dec) {
    const text = dec.decode(bytes);
    if (!text.includes(REPLACEMENT)) {
      // A valid, clean label. One exception: valid utf-8 bytes behind a single-byte cyrillic
      // label (the "РџСЂРёРІРµС‚" pattern) decode cleanly both ways — prefer utf-8 when the
      // utf-8 reading is mostly cyrillic.
      if (SINGLE_BYTE_CYR.has(dec.encoding) && isUtf8(bytes)) {
        const asUtf8 = new TextDecoder('utf-8').decode(bytes);
        if (cyrShare(asUtf8) >= CYR_THRESHOLD) return 'utf-8';
      }
      return dec.encoding;
    }
  }
  // No usable label (missing, unknown, or it produces U+FFFD): are the bytes utf-8 at all?
  if (isUtf8(bytes)) return 'utf-8';
  return scoreCyrillic(bytes);
}

/** The smallest byte count SniffingIconv buffers before it locks the encoding decision. */
const SNIFF_MIN = 16;

/**
 * node-iconv-compatible Transform for mailparser's `Iconv` option (mailparser does
 * `new Iconv(fromCharset, 'UTF-8//TRANSLIT//IGNORE')` and pumps raw part bytes through
 * write()/end(), reading UTF-8 chunks back). The encoding is chosen by sniffCharset from the
 * first ≥ SNIFF_MIN bytes and stays locked for the whole stream; smaller parts are buffered
 * until the decision can be made (or the stream ends).
 */
export class SniffingIconv extends Transform {
  private readonly declared: string;
  private decoder: TextDecoder | null = null;
  /** Locked to utf-8: the bytes are already utf-8, forward them without a re-encode. */
  private passthrough = false;
  private pending: Buffer[] = [];
  private pendingLen = 0;

  constructor(fromCharset: string | undefined, _toCharset?: string) {
    super();
    // The '//TRANSLIT//IGNORE' suffix is node-iconv syntax on the target; output here is plain UTF-8.
    this.declared = (fromCharset ?? '').trim();
  }

  // Node's Transform types the callback as Error | null; a wrapper keeps the override signature tight.
  override _transform(chunk: Buffer | string, _encoding: string, done: (error?: Error | null) => void): void {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'latin1') : chunk;
    if (this.decoder || this.passthrough) {
      this.pushDecoded(buf);
      done();
      return;
    }
    this.pending.push(buf);
    this.pendingLen += buf.length;
    if (this.pendingLen >= SNIFF_MIN) this.lock();
    done();
  }

  override _flush(done: (error?: Error | null) => void): void {
    if (!this.decoder && !this.passthrough) this.lock();
    done();
  }

  private lock(): void {
    const single = this.pending.length === 1 ? this.pending[0] : undefined;
    const bytes = single ?? Buffer.concat(this.pending, this.pendingLen);
    this.pending = [];
    this.pendingLen = 0;
    const choice = sniffCharset(bytes, this.declared);
    if (choice === 'utf-8') {
      this.passthrough = true;
      if (bytes.length) this.push(bytes);
      return;
    }
    this.decoder = new TextDecoder(choice);
    this.pushDecoded(bytes);
  }

  // NB: deliberately not named `emit` — Transform inherits it from EventEmitter.
  private pushDecoded(buf: Buffer): void {
    if (this.passthrough) {
      if (buf.length) this.push(buf);
      return;
    }
    if (!this.decoder) return;
    const text = this.decoder.decode(buf, { stream: true });
    if (text) this.push(Buffer.from(text, 'utf8'));
  }
}

let cp1251Bytes: Map<string, number> | null = null;

/**
 * Undoes "utf-8 bytes read as windows-1251" mojibake ("РџСЂРёРІРµС‚" → "Привет") in text that
 * was already stored, e.g. list snippets cached before the truncated-tail fix. Returns null
 * unless the reversal is unambiguous: every char maps back to a cp1251 byte, the bytes are
 * valid utf-8 (a cut tail allowed) and the result reads as cyrillic. Real Russian text never
 * re-encodes to valid utf-8, so it is left alone.
 */
export function repairUtf8AsCp1251(text: string): string | null {
  if (!/[\u0080-￿]/.test(text)) return null;
  if (!cp1251Bytes) {
    const dec = new TextDecoder('windows-1251');
    cp1251Bytes = new Map();
    for (let b = 0x80; b <= 0xff; b++) cp1251Bytes.set(dec.decode(Uint8Array.of(b)), b);
  }
  const ellipsis = text.endsWith('…');
  const body = ellipsis ? text.slice(0, -1) : text;
  const bytes: number[] = [];
  for (const ch of body) {
    const code = ch.charCodeAt(0);
    if (code < 0x80) {
      // whitespace collapsing turned a 0xA0 continuation byte (U+00A0 in cp1251) into a space
      const prev = bytes[bytes.length - 1] ?? 0;
      bytes.push(ch === ' ' && prev >= 0xc2 && prev <= 0xf4 ? 0xa0 : code);
      continue;
    }
    const b = cp1251Bytes.get(ch);
    if (b === undefined) return null;
    bytes.push(b);
  }
  let out: string;
  try {
    out = new TextDecoder('utf-8', { fatal: true }).decode(trimUtf8Tail(Uint8Array.from(bytes)));
  } catch {
    return null;
  }
  if (cyrShare(out) < CYR_THRESHOLD) return null;
  return ellipsis ? `${out.trimEnd()}…` : out;
}

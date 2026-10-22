/** Text wrapping with a cache keyed by (text, size, width) — ADR-0115 §4. Pure given a measure function. */
import { F_BOLD, F_ITALIC, flagsOf, listNumbers, paragraphCount, type Fmt } from './richText';
import type { BoxRec } from './types';

export const LINE_HEIGHT = 1.3;
export const STICKY_PAD = 14;
export const SHAPE_PAD = 10;
export const TEXT_PAD = 4;
export const STICKY_TEXT_SIZE = 18;
export const SHAPE_TEXT_SIZE = 16;
export const LABEL_SIZE = 13;

/** Font-size tokens of the object-level `fontSize` (ADR-0116): S, M (the default, absent in the doc), L, XL. */
export type FontToken = 's' | 'm' | 'l' | 'xl';
export const FONT_TOKENS: readonly FontToken[] = ['s', 'm', 'l', 'xl'];
export const isFontToken = (v: unknown): v is FontToken => v === 's' || v === 'm' || v === 'l' || v === 'xl';
/** Pixel sizes per token: stickies, shapes and the free text object (whose own `size` is any number, these are its presets). */
export const STICKY_FONT: Readonly<Record<FontToken, number>> = { s: 14, m: STICKY_TEXT_SIZE, l: 26, xl: 38 };
export const SHAPE_FONT: Readonly<Record<FontToken, number>> = { s: 12, m: SHAPE_TEXT_SIZE, l: 24, xl: 34 };
export const TEXT_FONT: Readonly<Record<FontToken, number>> = { s: 14, m: 20, l: 32, xl: 48 };

/** The size of an object's text in world units: a sticky's or shape's exact `fontPx` when it has one, else its token's preset. */
export function boxFontSize(o: BoxRec): number {
  switch (o.kind) {
    case 'text':
      return o.size;
    case 'sticky':
      return o.fontPx ?? STICKY_FONT[o.fontSize ?? 'm'];
    case 'shape':
      return o.fontPx ?? SHAPE_FONT[o.fontSize ?? 'm'];
  }
}

/** Kinds that carry a text size, and their token → px tables. */
export type SizedKind = BoxRec['kind'];
const FONT_TABLE: Readonly<Record<SizedKind, Readonly<Record<FontToken, number>>>> = { sticky: STICKY_FONT, shape: SHAPE_FONT, text: TEXT_FONT };

/** The token of `kind` whose preset is nearest to `px`. */
export function nearestFontToken(kind: SizedKind, px: number): FontToken {
  const table = FONT_TABLE[kind];
  let best: FontToken = 'm';
  for (const t of FONT_TOKENS) if (Math.abs(table[t] - px) < Math.abs(table[best] - px)) best = t;
  return best;
}

/**
 * What a sticky or shape stores for a text size of `px` (ADR-0116): a size equal to a preset is just that token
 * (`m` = nothing at all); any other is the exact `fontPx` next to the nearest token, so a client that only knows
 * tokens still shows a close size. `fontPx` is trusted only while its token is still the nearest one (see `storedFontPx`).
 */
export function fontFields(kind: 'sticky' | 'shape', px: number): { fontSize?: FontToken; fontPx?: number } {
  const table = FONT_TABLE[kind];
  const exact = FONT_TOKENS.find((t) => table[t] === px);
  if (exact) return exact === 'm' ? {} : { fontSize: exact };
  const token = nearestFontToken(kind, px);
  return token === 'm' ? { fontPx: px } : { fontSize: token, fontPx: px };
}

/**
 * The exact size stored next to a token, or undefined when it is absent, not a number, or stale: an older client that
 * changed only the token leaves a `fontPx` whose nearest token differs from the stored one — the token then wins.
 */
export function storedFontPx(kind: 'sticky' | 'shape', px: unknown, token: FontToken, min: number, max: number): number | undefined {
  if (typeof px !== 'number' || !Number.isFinite(px)) return undefined;
  const v = Math.min(max, Math.max(min, px));
  return nearestFontToken(kind, v) === token && FONT_TABLE[kind][token] !== v ? v : undefined;
}

/** The token whose preset is nearest to a text object's size. */
export function nearestToken(size: number): FontToken {
  let best: FontToken = 'm';
  for (const t of FONT_TOKENS) if (Math.abs(TEXT_FONT[t] - size) < Math.abs(TEXT_FONT[best] - size)) best = t;
  return best;
}

/** Width in px of `text` at `size` px (one line, no wrapping) in the font of the style `flags` (richText F_* bits; 0 = regular). */
export type MeasureFn = (text: string, size: number, flags?: number) => number;

/** A piece of a line in one font style, `x` from the line's left edge (the list indent included). */
export interface LineSeg {
  readonly text: string;
  readonly x: number;
  readonly w: number;
  readonly f: number;
}

export interface TextLayout {
  /** The plain text of each line (what a plaque stands for). */
  readonly lines: readonly string[];
  /** Width of each line, a list indent included. */
  readonly widths: readonly number[];
  readonly lineHeight: number;
  readonly height: number;
  /** Rich layouts only: the styled pieces of each line, and the list marker of its first line (`x` = 0). */
  readonly segs?: readonly (readonly LineSeg[])[];
  readonly marks?: readonly (string | null)[];
}

/** Rough measure when no canvas is around (tests, SSR): half an em per UTF-16 unit, bold a tenth wider. */
export const estimateMeasure: MeasureFn = (text, size, flags = 0) => text.length * size * 0.5 * (flags & F_BOLD ? 1.1 : 1);

/** Canvas font shorthand of a style: `italic 600 16px family`. */
export const fontOf = (size: number, family: string, flags = 0): string => `${flags & F_ITALIC ? 'italic ' : ''}${flags & F_BOLD ? '600 ' : ''}${size}px ${family}`;

export class TextLayouter {
  private readonly cache = new Map<string, TextLayout>();
  hits = 0;
  misses = 0;

  constructor(
    private measure: MeasureFn = estimateMeasure,
    private readonly cap = 3000,
  ) {}

  /** Swap the measuring function (the font changed); drops the cache. */
  setMeasure(fn: MeasureFn): void {
    this.measure = fn;
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  layout(text: string, size: number, maxWidth: number): TextLayout {
    const w = Math.max(1, Math.round(maxWidth));
    const key = `${size}|${w}|${text}`;
    const hit = this.cache.get(key);
    if (hit) {
      this.hits++;
      // LRU refresh.
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    this.misses++;
    const out = this.compute(text, size, w);
    if (this.cache.size >= this.cap) {
      const first = this.cache.keys().next();
      if (!first.done) this.cache.delete(first.value);
    }
    this.cache.set(key, out);
    return out;
  }

  /**
   * Layout of formatted text: the same greedy wrapping as `layout`, but a word is measured piece by piece in the font
   * of its characters, and a list item is indented with its marker. Cached by (text, formatting, size, width).
   */
  layoutRich(text: string, fmt: Fmt, size: number, maxWidth: number): TextLayout {
    const w = Math.max(1, Math.round(maxWidth));
    const key = `r|${size}|${w}|${fmt.key}|${text}`;
    const hit = this.cache.get(key);
    if (hit) {
      this.hits++;
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    this.misses++;
    const out = this.computeRich(text, fmt, size, w);
    if (this.cache.size >= this.cap) {
      const first = this.cache.keys().next();
      if (!first.done) this.cache.delete(first.value);
    }
    this.cache.set(key, out);
    return out;
  }

  private computeRich(text: string, fmt: Fmt, size: number, maxW: number): TextLayout {
    const flags = flagsOf(fmt, text);
    const nums = listNumbers(text, fmt);
    const lines: string[] = [];
    const widths: number[] = [];
    const allSegs: LineSeg[][] = [];
    const marks: (string | null)[] = [];
    const m = (s: string, f: number): number => this.measure(s, size, f);
    // Number items of one run share an indent that fits the widest marker of the run.
    const paras = paragraphCount(text);
    const indents: number[] = new Array<number>(paras).fill(0);
    for (let i = 0; i < paras; ) {
      const kind = fmt.lists[i] ?? null;
      if (kind === null) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < paras && fmt.lists[j + 1] === kind) j++;
      const ind = kind === 'bullet' ? size * 1.4 : Math.max(size * 1.4, m(`${nums[j] ?? 1}.`, 0) + size * 0.5);
      for (let k = i; k <= j; k++) indents[k] = ind;
      i = j + 1;
    }
    let start = 0;
    for (let pi = 0; pi < paras; pi++) {
      const nl = text.indexOf('\n', start);
      const end = nl === -1 ? text.length : nl;
      const kind = fmt.lists[pi] ?? null;
      const indent = indents[pi] ?? 0;
      const avail = Math.max(1, maxW - indent);
      const mark = kind === 'bullet' ? '•' : kind === 'number' ? `${nums[pi] ?? 1}.` : null;
      let first = true;
      // The line being built: pieces in order, their total width.
      let cur: { text: string; f: number; w: number }[] = [];
      let curW = 0;
      const flush = (): void => {
        // Trailing spaces do not count (nor are drawn).
        for (let last = cur[cur.length - 1]; last; last = cur[cur.length - 1]) {
          const trimmed = last.text.trimEnd();
          if (trimmed === last.text) break;
          curW -= last.w;
          if (trimmed === '') {
            cur.pop();
            continue;
          }
          const w = m(trimmed, last.f);
          cur[cur.length - 1] = { text: trimmed, f: last.f, w };
          curW += w;
          break;
        }
        let x = indent;
        const segs: LineSeg[] = cur.map((p) => {
          const seg = { text: p.text, x, w: p.w, f: p.f };
          x += p.w;
          return seg;
        });
        lines.push(cur.map((p) => p.text).join(''));
        widths.push(indent + curW);
        allSegs.push(segs);
        marks.push(first ? mark : null);
        first = false;
        cur = [];
        curW = 0;
      };
      const add = (s: string, f: number): void => {
        const last = cur[cur.length - 1];
        const sw = m(s, f);
        if (last && last.f === f) {
          const joined = last.text + s;
          const jw = m(joined, f);
          curW += jw - last.w;
          cur[cur.length - 1] = { text: joined, f, w: jw };
        } else {
          cur.push({ text: s, f, w: sw });
          curW += sw;
        }
      };
      // Words: runs of characters up to and including a space, each split into style pieces.
      let i = start;
      while (i < end) {
        let j = i;
        while (j < end && text[j] !== ' ') j++;
        if (j < end) j++; // the space belongs to the word
        const pieces: { text: string; f: number }[] = [];
        for (let k = i; k < j; ) {
          const f = flags[k] ?? 0;
          let e = k + 1;
          while (e < j && (flags[e] ?? 0) === f) e++;
          pieces.push({ text: text.slice(k, e), f });
          k = e;
        }
        let wordCore = 0;
        for (const p of pieces) wordCore += m(p.text, p.f);
        // The width that must fit: without the trailing space.
        const lastPiece = pieces[pieces.length - 1];
        if (lastPiece && lastPiece.text.endsWith(' ')) wordCore += m(lastPiece.text.trimEnd(), lastPiece.f) - m(lastPiece.text, lastPiece.f);
        if (cur.length > 0 && curW + wordCore > avail) flush();
        if (wordCore > avail) {
          // A word wider than the box: break it by code points.
          for (const p of pieces) {
            for (const ch of Array.from(p.text)) {
              const cw = m(ch, p.f);
              if (curW + cw > avail && cur.length > 0) flush();
              add(ch, p.f);
            }
          }
        } else {
          for (const p of pieces) add(p.text, p.f);
        }
        i = j;
      }
      flush();
      start = end + 1;
    }
    const lineHeight = size * LINE_HEIGHT;
    return { lines, widths, lineHeight, height: lines.length * lineHeight, segs: allSegs, marks };
  }

  private compute(text: string, size: number, maxW: number): TextLayout {
    const lines: string[] = [];
    const widths: number[] = [];
    const push = (s: string, w: number): void => {
      lines.push(s);
      widths.push(w);
    };
    for (const para of text.split('\n')) {
      if (para === '') {
        push('', 0);
        continue;
      }
      const whole = this.measure(para, size);
      if (whole <= maxW) {
        push(para, whole);
        continue;
      }
      let line = '';
      let lineW = 0;
      for (const word of para.split(/(?<= )/)) {
        const ww = this.measure(word, size);
        if (line !== '' && this.measure(line + word, size) > maxW && this.measure((line + word).trimEnd(), size) > maxW) {
          push(line.trimEnd(), lineW);
          line = '';
        }
        if (this.measure(word.trimEnd(), size) > maxW) {
          // A word wider than the box: break it by code points.
          for (const ch of Array.from(word)) {
            const cw = this.measure(line + ch, size);
            if (cw > maxW && line !== '') {
              push(line, this.measure(line, size));
              line = ch;
            } else line += ch;
          }
          lineW = this.measure(line, size);
          continue;
        }
        line += word;
        lineW = line === word ? ww : this.measure(line, size);
      }
      if (line !== '') push(line.trimEnd(), this.measure(line.trimEnd(), size));
    }
    const lineHeight = size * LINE_HEIGHT;
    return { lines, widths, lineHeight, height: lines.length * lineHeight };
  }
}

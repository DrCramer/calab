/** Text wrapping with a cache keyed by (text, size, width) — ADR-0113 §4. Pure given a measure function. */

export const LINE_HEIGHT = 1.3;
export const STICKY_PAD = 14;
export const SHAPE_PAD = 10;
export const TEXT_PAD = 4;
export const STICKY_TEXT_SIZE = 18;
export const SHAPE_TEXT_SIZE = 16;
export const LABEL_SIZE = 13;

/** Width in px of `text` at `size` px (one line, no wrapping). */
export type MeasureFn = (text: string, size: number) => number;

export interface TextLayout {
  readonly lines: readonly string[];
  readonly widths: readonly number[];
  readonly lineHeight: number;
  readonly height: number;
}

/** Rough measure when no canvas is around (tests, SSR): half an em per UTF-16 unit. */
export const estimateMeasure: MeasureFn = (text, size) => text.length * size * 0.5;

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

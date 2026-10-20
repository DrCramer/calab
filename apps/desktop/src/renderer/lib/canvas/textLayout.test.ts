import { describe, expect, it } from 'vitest';
import { F_BOLD, F_ITALIC, toggleFlag, toggleList } from './richText';
import { LINE_HEIGHT, TextLayouter, boxFontSize, nearestToken } from './textLayout';
import type { BoxRec } from './types';

// 10 px per character at size 20 → 0.5 em.
const L = (cap?: number) => new TextLayouter((t, s) => t.length * s * 0.5, cap);

describe('TextLayouter', () => {
  it('keeps a short line whole', () => {
    const l = L().layout('hello', 20, 200);
    expect(l.lines).toEqual(['hello']);
    expect(l.widths).toEqual([50]);
    expect(l.height).toBe(20 * LINE_HEIGHT);
  });
  it('keeps explicit newlines, including empty lines', () => {
    expect(L().layout('a\n\nb', 20, 200).lines).toEqual(['a', '', 'b']);
  });
  it('wraps at spaces', () => {
    const l = L().layout('aaa bbb ccc ddd', 20, 80);
    expect(l.lines).toEqual(['aaa bbb', 'ccc ddd']);
    expect(Math.max(...l.widths)).toBeLessThanOrEqual(80);
  });
  it('breaks a word wider than the box', () => {
    const l = L().layout('abcdefghijkl', 20, 50);
    expect(l.lines.join('')).toBe('abcdefghijkl');
    expect(l.lines.every((x) => x.length * 10 <= 50)).toBe(true);
  });
  it('does not split surrogate pairs when breaking', () => {
    const l = L().layout('😀😀😀😀😀😀', 20, 45);
    expect(l.lines.join('')).toBe('😀😀😀😀😀😀');
    for (const line of l.lines) expect(line === Array.from(line).join('')).toBe(true);
  });
  it('caches by (text, size, width)', () => {
    const t = L();
    const a = t.layout('hello world', 20, 100);
    expect(t.layout('hello world', 20, 100)).toBe(a);
    expect(t.hits).toBe(1);
    expect(t.layout('hello world', 20, 120)).not.toBe(a);
    expect(t.layout('hello world', 24, 100)).not.toBe(a);
    expect(t.misses).toBe(3);
  });
  it('evicts the least recently used entry', () => {
    const t = L(2);
    t.layout('a', 20, 100);
    t.layout('b', 20, 100);
    t.layout('a', 20, 100); // refresh a
    t.layout('c', 20, 100); // evicts b
    t.layout('a', 20, 100);
    const misses = t.misses;
    t.layout('b', 20, 100);
    expect(t.misses).toBe(misses + 1);
    expect(t.size).toBe(2);
  });
  it('drops the cache when the font changes', () => {
    const t = L();
    t.layout('a', 20, 100);
    t.setMeasure((x, s) => x.length * s);
    expect(t.size).toBe(0);
    expect(t.layout('ab', 20, 100).widths).toEqual([40]);
  });
});

describe('TextLayouter: formatted text', () => {
  // 10 px per char at size 20; bold is 10 % wider.
  const R = (cap?: number) => new TextLayouter((t, s, f = 0) => t.length * s * 0.5 * (f & F_BOLD ? 1.1 : 1), cap);
  it('measures each piece in its own font and wraps by those widths', () => {
    const text = 'aaa bbb ccc';
    const bold = toggleFlag(undefined, text, 4, 7, F_BOLD);
    const l = R().layoutRich(text, bold ?? ({} as never), 20, 80);
    // regular 'aaa ' = 40, bold 'bbb ' = 44 → 84 > 80 with the trailing space trimmed? 40 + 33 = 73 fits.
    expect(l.lines).toEqual(['aaa bbb', 'ccc']);
    expect(l.segs?.[0]?.map((x) => [x.text, x.f])).toEqual([['aaa ', 0], ['bbb', F_BOLD]]);
    expect(l.segs?.[0]?.[1]?.x).toBeCloseTo(40);
    expect(l.widths[0]).toBeCloseTo(73);
    const wide = R().layoutRich(text, bold ?? ({} as never), 20, 72);
    expect(wide.lines).toEqual(['aaa', 'bbb', 'ccc']);
  });
  it('a word split across two styles stays one word when it fits, and breaks by characters when it does not', () => {
    const text = 'abcdef';
    const f = toggleFlag(toggleFlag(undefined, text, 0, 3, F_BOLD), text, 3, 6, F_ITALIC);
    const l = R().layoutRich(text, f ?? ({} as never), 20, 100);
    expect(l.lines).toEqual(['abcdef']);
    expect(l.segs?.[0]?.map((x) => x.f)).toEqual([F_BOLD, F_ITALIC]);
    const narrow = R().layoutRich(text, f ?? ({} as never), 20, 35);
    expect(narrow.lines.join('')).toBe(text);
    expect(narrow.lines.length).toBeGreaterThan(1);
    for (const w of narrow.widths) expect(w).toBeLessThanOrEqual(35);
  });
  it('a bullet list indents its items, wraps inside the indent and marks the first line only', () => {
    const text = 'aaa bbb ccc\nddd';
    const f = toggleList(undefined, text, 0, 11, 'bullet');
    const l = R().layoutRich(text, f ?? ({} as never), 20, 100);
    expect(l.marks).toEqual(['•', null, null]);
    expect(l.lines).toEqual(['aaa bbb', 'ccc', 'ddd']);
    expect(l.segs?.[0]?.[0]?.x).toBeCloseTo(28); // indent = 1.4 em
    expect(l.segs?.[2]?.[0]?.x).toBe(0);
    expect(l.widths[0]).toBeLessThanOrEqual(100);
  });
  it('numbers count up per run, restart after a plain paragraph, and an empty item keeps its marker', () => {
    const text = 'a\nb\nplain\nc\n';
    const f = toggleList(toggleList(undefined, text, 0, 3, 'number'), text, 10, 11, 'number');
    const l = R().layoutRich(text, f ?? ({} as never), 20, 200);
    expect(l.marks).toEqual(['1.', '2.', null, '1.', null]);
    const empty = toggleList(undefined, 'x\n', 2, 2, 'bullet');
    expect(R().layoutRich('x\n', empty ?? ({} as never), 20, 200).marks).toEqual([null, '•']);
  });
  it('the cache key includes the formatting and the size', () => {
    const t = R();
    const text = 'hello world';
    const a = toggleFlag(undefined, text, 0, 5, F_BOLD) ?? ({} as never);
    const b = toggleFlag(undefined, text, 0, 5, F_ITALIC) ?? ({} as never);
    const l1 = t.layoutRich(text, a, 20, 200);
    expect(t.layoutRich(text, a, 20, 200)).toBe(l1);
    expect(t.layoutRich(text, b, 20, 200)).not.toBe(l1);
    expect(t.layoutRich(text, a, 24, 200)).not.toBe(l1);
    expect(t.layout(text, 20, 200).segs).toBeUndefined();
    expect(t.hits).toBe(1);
  });
  it('without formatting nothing changes: the plain path has no segments', () => {
    const l = R().layout('aaa bbb ccc ddd', 20, 80);
    expect(l.segs).toBeUndefined();
    expect(l.lines).toEqual(['aaa bbb', 'ccc ddd']);
  });
});

describe('font tokens', () => {
  const sticky = (fontSize?: 's' | 'm' | 'l' | 'xl'): BoxRec => ({ kind: 'sticky', id: 'a', z: 'a', x: 0, y: 0, w: 160, h: 160, color: 'yellow', text: '', ...(fontSize ? { fontSize } : {}) });
  it('stickies and shapes scale their text; the default is unchanged', () => {
    expect(boxFontSize(sticky())).toBe(18);
    expect(boxFontSize(sticky('xl'))).toBe(38);
    expect(boxFontSize({ kind: 'shape', id: 's', z: 'a', x: 0, y: 0, w: 1, h: 1, shape: 'rect', fill: 'none', stroke: 'stroke', strokeWidth: 2, text: '', fontSize: 's' })).toBe(12);
    expect(boxFontSize({ kind: 'text', id: 't', z: 'a', x: 0, y: 0, w: 1, h: 1, size: 27, color: 'text', text: '' })).toBe(27);
  });
  it('a free size maps to the nearest token', () => {
    expect(nearestToken(20)).toBe('m');
    expect(nearestToken(41)).toBe('xl');
    expect(nearestToken(10)).toBe('s');
    expect(F_ITALIC).toBe(2);
  });
});

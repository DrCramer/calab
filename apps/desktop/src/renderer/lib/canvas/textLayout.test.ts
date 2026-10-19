import { describe, expect, it } from 'vitest';
import { LINE_HEIGHT, TextLayouter } from './textLayout';

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

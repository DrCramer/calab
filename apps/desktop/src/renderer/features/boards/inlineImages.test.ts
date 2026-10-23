import { describe, expect, it } from 'vitest';
import { imageToken, insertImage, splitDescription } from './inlineImages';

describe('inline description images', () => {
  it('splits text around picture lines', () => {
    const t = `before\n${imageToken('a-1', 'shot.png')}\nafter\nmore`;
    expect(splitDescription(t)).toEqual([
      { k: 'text', v: 'before' },
      { k: 'img', id: 'a-1', name: 'shot.png' },
      { k: 'text', v: 'after\nmore' },
    ]);
  });
  it('keeps plain text and mid-line references as text', () => {
    expect(splitDescription('no image')).toEqual([{ k: 'text', v: 'no image' }]);
    expect(splitDescription('see ![x](calaba-file:1) here')).toEqual([{ k: 'text', v: 'see ![x](calaba-file:1) here' }]);
    expect(splitDescription('')).toEqual([]);
  });
  it('sanitises the name in the token', () => {
    expect(imageToken('i', 'a]b[c.png')).toBe('![a b c.png](calaba-file:i)');
  });
  it('inserts on its own lines at the caret', () => {
    const tk = imageToken('i', 'p');
    expect(insertImage('abcdef', 3, tk)).toEqual({ text: `abc\n${tk}\ndef`, caret: 3 + 1 + tk.length + 1 });
    expect(insertImage('', 0, tk)).toEqual({ text: tk, caret: tk.length });
    expect(insertImage('abc\n', 4, tk).text).toBe(`abc\n${tk}`);
    expect(insertImage('abc', 99, tk).text).toBe(`abc\n${tk}`);
  });
});

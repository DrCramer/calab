import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import {
  F_BOLD, F_ITALIC, F_STRIKE, clearList, editFmt, flagsAtCaret, flagsIn, fmtFromDelta, fmtToDelta, formatChanges, listIn, listNumbers, rawText,
  sameFmt, sliceFmt, toggleFlag, toggleList, type Fmt,
} from './richText';

const fmtOf = (text: string, ...ops: [number, number, number][]): Fmt | undefined => {
  let f: Fmt | undefined;
  for (const [from, to, flag] of ops) {
    // build through the public API: toggle a flag on a range
    f = toggleFlag(f, text, from, to, flag);
  }
  return f;
};

describe('Y.Text delta ↔ Fmt', () => {
  it('plain text has no formatting', () => {
    expect(fmtFromDelta([{ insert: 'hello' }])).toEqual({ text: 'hello', fmt: undefined });
    expect(fmtFromDelta([])).toEqual({ text: '', fmt: undefined });
  });
  it('reads inline attributes into spans, ignoring unknown ones', () => {
    const { text, fmt } = fmtFromDelta([
      { insert: 'a ' },
      { insert: 'bold', attributes: { bold: true } },
      { insert: ' and ' },
      { insert: 'both', attributes: { bold: true, italic: true, color: 'red' } },
    ]);
    expect(text).toBe('a bold and both');
    expect(fmt?.spans).toEqual([{ from: 2, to: 6, f: F_BOLD }, { from: 11, to: 15, f: F_BOLD | F_ITALIC }]);
  });
  it('a list is an attribute of the paragraph\'s newline, and a last list item\'s terminator is not text', () => {
    const { text, fmt } = fmtFromDelta([
      { insert: 'one' },
      { insert: '\n', attributes: { list: 'bullet' } },
      { insert: 'two' },
      { insert: '\n', attributes: { list: 'number' } },
    ]);
    expect(text).toBe('one\ntwo');
    expect(fmt?.lists).toEqual(['bullet', 'number']);
    expect(rawText(text, fmt)).toBe('one\ntwo\n');
  });
  it('an ordinary trailing newline stays an empty last line', () => {
    const { text, fmt } = fmtFromDelta([{ insert: 'a\n' }]);
    expect(text).toBe('a\n');
    expect(fmt).toBeUndefined();
  });
  it('a newline never carries inline flags and a list value that is unknown is ignored', () => {
    const { fmt } = fmtFromDelta([{ insert: 'x\ny', attributes: { bold: true } }, { insert: '\n', attributes: { list: 'checked' } }]);
    expect(fmt?.spans).toEqual([{ from: 0, to: 1, f: F_BOLD }, { from: 2, to: 3, f: F_BOLD }]);
    expect(fmt?.lists).toEqual([]);
  });
  it('round-trips through the delta', () => {
    const text = 'one bold\ntwo\n\nlast';
    let f = toggleFlag(undefined, text, 4, 8, F_BOLD);
    f = toggleFlag(f, text, 9, 12, F_STRIKE);
    f = toggleList(f, text, 0, 3, 'bullet');
    f = toggleList(f, text, 14, 18, 'number');
    const back = fmtFromDelta(fmtToDelta(text, f));
    expect(back.text).toBe(text);
    expect(back.fmt?.key).toBe(f?.key);
  });
});

describe('editing keeps the formatting in step', () => {
  const text = 'hello world';
  const bold = fmtOf(text, [6, 11, F_BOLD]);
  it('typing inside a bold run is bold; typing after plain text is plain', () => {
    const f = editFmt(bold, text, 8, 0, 'XX');
    expect(f?.spans).toEqual([{ from: 6, to: 13, f: F_BOLD }]);
    const g = editFmt(bold, text, 3, 0, 'XX');
    expect(g?.spans).toEqual([{ from: 8, to: 13, f: F_BOLD }]);
  });
  it('pending flags win over the neighbour', () => {
    const f = editFmt(undefined, 'ab', 1, 0, 'X', F_ITALIC);
    expect(f?.spans).toEqual([{ from: 1, to: 2, f: F_ITALIC }]);
    const g = editFmt(bold, text, 8, 0, 'X', 0);
    expect(g?.spans).toEqual([{ from: 6, to: 8, f: F_BOLD }, { from: 9, to: 12, f: F_BOLD }]);
  });
  it('deleting removes the flags of what went', () => {
    const f = editFmt(bold, text, 4, 4, '');
    expect(f?.spans).toEqual([{ from: 4, to: 7, f: F_BOLD }]);
    expect(editFmt(bold, text, 6, 5, '')).toBeUndefined();
  });
  it('replacing a selection (autocorrect, IME) is one step', () => {
    const f = editFmt(bold, text, 6, 5, 'there');
    expect(f?.spans).toEqual([{ from: 6, to: 11, f: F_BOLD }]);
  });
  it('a newline typed at a line start does not inherit the previous line\'s flags', () => {
    const t = 'ab\ncd';
    const f = toggleFlag(undefined, t, 0, 2, F_BOLD);
    const g = editFmt(f, t, 3, 0, 'X');
    expect(g?.spans).toEqual([{ from: 0, to: 2, f: F_BOLD }]);
  });
  it('Enter inside a list item continues the list; joining items keeps the last one\'s list', () => {
    const t = 'one\ntwo';
    const f = toggleList(undefined, t, 0, 3, 'bullet');
    expect(f?.lists).toEqual(['bullet']);
    const split = editFmt(f, t, 2, 0, '\n');
    expect(split?.lists).toEqual(['bullet', 'bullet']);
    const both = toggleList(toggleList(undefined, t, 0, 7, 'number'), t, 0, 7, 'number');
    expect(both).toBeUndefined();
    const two = toggleList(undefined, t, 0, 7, 'bullet');
    expect(two?.lists).toEqual(['bullet', 'bullet']);
    const joined = editFmt(two, t, 3, 1, '');
    expect(joined?.lists).toEqual(['bullet']);
    const plainFirst = toggleList(undefined, t, 4, 7, 'bullet');
    expect(editFmt(plainFirst, t, 3, 1, '')?.lists).toEqual(['bullet']);
  });
  it('no formatting and no pending flags is a no-op', () => {
    expect(editFmt(undefined, 'ab', 1, 0, 'x')).toBeUndefined();
  });
});

describe('toggling', () => {
  const t = 'one two\nthree';
  it('turns a flag on for a range, then off when it is on for all of it', () => {
    const on = toggleFlag(undefined, t, 0, 3, F_BOLD);
    expect(flagsIn(on, t, 0, 3)).toMatchObject({ all: F_BOLD, any: F_BOLD, count: 3 });
    expect(toggleFlag(on, t, 0, 3, F_BOLD)).toBeUndefined();
  });
  it('a mixed range turns on first (Word-like), and the flags are independent', () => {
    const a = toggleFlag(undefined, t, 0, 3, F_BOLD);
    const b = toggleFlag(a, t, 0, 7, F_BOLD);
    expect(flagsIn(b, t, 0, 7).all).toBe(F_BOLD);
    const c = toggleFlag(b, t, 4, 7, F_ITALIC);
    expect(flagsIn(c, t, 0, 7)).toMatchObject({ all: F_BOLD, any: F_BOLD | F_ITALIC });
  });
  it('skips newlines and does nothing on an empty range', () => {
    const f = toggleFlag(undefined, t, 0, t.length, F_STRIKE);
    expect(f?.spans).toEqual([{ from: 0, to: 7, f: F_STRIKE }, { from: 8, to: 13, f: F_STRIKE }]);
    expect(toggleFlag(undefined, t, 3, 3, F_BOLD)).toBeUndefined();
    expect(toggleFlag(undefined, 'a\nb', 1, 2, F_BOLD)).toBeUndefined();
  });
  it('the caret takes the flags of the character to its left, or of the right one at a line start', () => {
    const f = toggleFlag(undefined, t, 0, 3, F_BOLD);
    expect(flagsAtCaret(f, t, 2)).toBe(F_BOLD);
    expect(flagsAtCaret(f, t, 3)).toBe(F_BOLD);
    expect(flagsAtCaret(f, t, 4)).toBe(0);
    expect(flagsAtCaret(f, t, 0)).toBe(F_BOLD);
  });
  it('lists: toggle on, switch kind, toggle off; a selection ending after a newline does not touch the next paragraph', () => {
    const a = toggleList(undefined, t, 0, 8, 'bullet');
    expect(a?.lists).toEqual(['bullet']);
    expect(listIn(a, t, 0, 8)).toBe('bullet');
    const b = toggleList(a, t, 0, 8, 'number');
    expect(b?.lists).toEqual(['number']);
    expect(toggleList(b, t, 0, 8, 'number')).toBeUndefined();
    const both = toggleList(undefined, t, 2, 10, 'bullet');
    expect(both?.lists).toEqual(['bullet', 'bullet']);
    expect(listIn(both, t, 0, 13)).toBe('bullet');
    expect(listIn(toggleList(undefined, t, 0, 3, 'bullet'), t, 0, 13)).toBeNull();
  });
  it('clearList and numbering', () => {
    const a = toggleList(undefined, 'a\nb\nc\nd', 0, 3, 'number');
    expect(listNumbers('a\nb\nc\nd', a)).toEqual([1, 2, 0, 0]);
    const b = toggleList(toggleList(a, 'a\nb\nc\nd', 6, 7, 'number'), 'a\nb\nc\nd', 0, 1, 'number');
    expect(listNumbers('a\nb\nc\nd', b)).toEqual([0, 1, 0, 1]);
    expect(listNumbers('a\nb\nc', toggleList(undefined, 'a\nb\nc', 0, 5, 'number'))).toEqual([1, 2, 3]);
    expect(clearList(a, 'a\nb\nc\nd', 0)?.lists).toEqual([null, 'number']);
    expect(clearList(clearList(a, 'a\nb\nc\nd', 0), 'a\nb\nc\nd', 1)).toBeUndefined();
  });
  it('sliceFmt carries the formatting of the slice', () => {
    const s = 'aa bb\ncc';
    const f = toggleList(toggleFlag(undefined, s, 3, 5, F_BOLD), s, 6, 8, 'bullet');
    const out = sliceFmt(f, s, 3, 8);
    expect(out.text).toBe('bb\ncc');
    expect(out.fmt?.spans).toEqual([{ from: 0, to: 2, f: F_BOLD }]);
    expect(out.fmt?.lists).toEqual([null, 'bullet']);
  });
  it('sameFmt compares by content', () => {
    expect(sameFmt(undefined, undefined)).toBe(true);
    expect(sameFmt(toggleFlag(undefined, t, 0, 3, F_BOLD), toggleFlag(undefined, t, 0, 3, F_BOLD))).toBe(true);
    expect(sameFmt(toggleFlag(undefined, t, 0, 3, F_BOLD), undefined)).toBe(false);
  });
});

describe('Y.Text format changes', () => {
  const mk = (ops: { insert: string; attributes?: Record<string, unknown> }[]): Y.Text => {
    const doc = new Y.Doc();
    const yt = doc.getText('t');
    yt.applyDelta(ops);
    return yt;
  };
  it('are minimal: only the differing ranges, only our attributes', () => {
    const yt = mk([{ insert: 'abc', attributes: { bold: true } }, { insert: 'def', attributes: { underline: true } }]);
    const text = 'abcdef';
    const target = fmtToDelta(text, toggleFlag(undefined, text, 1, 3, F_BOLD));
    const ch = formatChanges(yt.toDelta() as never, target);
    expect(ch).toEqual([{ index: 0, length: 1, attrs: { bold: null } }]);
    for (const c of ch) yt.format(c.index, c.length, c.attrs);
    expect(yt.toDelta()).toEqual([
      { insert: 'a' },
      { insert: 'bc', attributes: { bold: true } },
      { insert: 'def', attributes: { underline: true } },
    ]);
  });
  it('sets and clears a list on the newline only', () => {
    const yt = mk([{ insert: 'one\ntwo' }]);
    const text = 'one\ntwo';
    const f = toggleList(undefined, text, 0, 3, 'bullet');
    // 'one\ntwo' raw text has no terminator for the plain last paragraph
    const ch = formatChanges(yt.toDelta() as never, fmtToDelta(text, f));
    expect(ch).toEqual([{ index: 3, length: 1, attrs: { list: 'bullet' } }]);
  });
});

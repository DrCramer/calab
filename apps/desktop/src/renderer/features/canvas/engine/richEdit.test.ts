// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { F_BOLD, F_ITALIC, F_STRIKE } from '../../../lib/canvas/richText';
import { destroyRigs, rig, type Rig } from './testRig';

afterEach(() => {
  destroyRigs();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const open = (r: Rig, text: string, kind: 'sticky' | 'shape' | 'text' = 'sticky'): { id: string; ta: HTMLTextAreaElement } => {
  const [id] = r.make({ init: { kind, x: 200, y: 200, text } });
  r.engine.startTextEdit(id);
  const ta = r.host.querySelector('textarea');
  if (!ta || !id) throw new Error('no editor');
  return { id, ta };
};
const type = (ta: HTMLTextAreaElement, value: string, caret = value.length): void => {
  ta.value = value;
  ta.setSelectionRange(caret, caret);
  ta.dispatchEvent(new Event('input'));
};
const select = (ta: HTMLTextAreaElement, a: number, b: number): void => {
  ta.setSelectionRange(a, b);
  ta.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight' }));
};
const key = (ta: HTMLTextAreaElement, k: string, init: KeyboardEventInit = {}): KeyboardEvent => {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  ta.dispatchEvent(e);
  return e;
};

describe('formatting while editing', () => {
  it('⌘B on a selection bolds it; the result reaches the Y.Text on commit, with the text', () => {
    const r = rig();
    const { id, ta } = open(r, 'hello world');
    select(ta, 6, 11);
    expect(key(ta, 'b', { metaKey: true }).defaultPrevented).toBe(true);
    expect(r.engine.editor.getSnapshot()).toMatchObject({ open: true, rich: true, bold: true, italic: false });
    r.engine.editor.commit();
    expect(r.engine.doc.getRich(id).fmt?.spans).toEqual([{ from: 6, to: 11, f: F_BOLD }]);
    expect(r.engine.doc.getText(id)).toBe('hello world');
    expect(r.engine.scene.get(id)).toMatchObject({ fmt: { spans: [{ from: 6, to: 11, f: F_BOLD }] } });
  });
  it('⌘I, ⇧⌘X and Ctrl variants; the format bar state follows the selection', () => {
    const r = rig();
    const { id, ta } = open(r, 'abcdef');
    select(ta, 0, 3);
    key(ta, 'i', { ctrlKey: true });
    key(ta, 'X', { metaKey: true, shiftKey: true });
    expect(r.engine.editor.getSnapshot()).toMatchObject({ italic: true, strike: true, bold: false });
    select(ta, 3, 6);
    expect(r.engine.editor.getSnapshot()).toMatchObject({ italic: false, strike: false });
    select(ta, 0, 6);
    expect(r.engine.editor.getSnapshot()).toMatchObject({ italic: false }); // only half of it
    r.engine.editor.commit();
    expect(r.engine.doc.getRich(id).fmt?.spans).toEqual([{ from: 0, to: 3, f: F_ITALIC | F_STRIKE }]);
  });
  it('typing keeps the attributes in step: text before a bold word shifts them, text inside is bold', () => {
    const r = rig();
    const { id, ta } = open(r, 'say hello');
    select(ta, 4, 9);
    r.engine.editor.toggleFlag(F_BOLD);
    type(ta, 'oh say hello'); // «oh » typed at the start
    type(ta, 'oh say heXllo', 10); // typed inside the bold word
    r.engine.editor.commit();
    expect(r.engine.doc.getRich(id).fmt?.spans).toEqual([{ from: 7, to: 13, f: F_BOLD }]);
    expect(r.engine.doc.getText(id)).toBe('oh say heXllo');
  });
  it('a toggle at a caret styles what is typed next, and ends when the caret moves', () => {
    const r = rig();
    const { id, ta } = open(r, 'ab');
    select(ta, 2, 2);
    r.engine.editor.toggleFlag(F_BOLD);
    expect(r.engine.editor.getSnapshot().bold).toBe(true);
    type(ta, 'abc');
    type(ta, 'abcd');
    expect(r.engine.editor.getSnapshot().bold).toBe(true);
    select(ta, 0, 0);
    expect(r.engine.editor.getSnapshot().bold).toBe(false);
    type(ta, 'Xabcd', 1);
    r.engine.editor.commit();
    expect(r.engine.doc.getRich(id).fmt?.spans).toEqual([{ from: 3, to: 5, f: F_BOLD }]);
  });
  it('an autocorrect/IME style replacement of a bold word keeps it bold', () => {
    const r = rig();
    const { id, ta } = open(r, 'teh cat');
    select(ta, 0, 3);
    r.engine.editor.toggleFlag(F_BOLD);
    type(ta, 'the cat', 3);
    r.engine.editor.commit();
    expect(r.engine.doc.getRich(id).fmt?.spans).toEqual([{ from: 0, to: 3, f: F_BOLD }]);
  });
  it('composition: an input event with isComposing in between does not break the model; Esc/⌘B during it are ignored', () => {
    const r = rig();
    const { id, ta } = open(r, 'ab');
    select(ta, 0, 2);
    r.engine.editor.toggleFlag(F_BOLD);
    type(ta, 'ab' + 'н', 3); // composing
    type(ta, 'ab' + 'ни', 4);
    expect(key(ta, 'b', { metaKey: true, isComposing: true }).defaultPrevented).toBe(false);
    r.engine.editor.commit();
    expect(r.engine.doc.getRich(id).text).toBe('abни');
    expect(r.engine.doc.getRich(id).fmt?.spans).toEqual([{ from: 0, to: 4, f: F_BOLD }]);
  });
  it('lists: toggling marks the paragraph; Enter continues it, Enter on an empty item leaves it', () => {
    const r = rig();
    const { id, ta } = open(r, 'one');
    r.engine.editor.toggleList('bullet');
    expect(r.engine.editor.getSnapshot().list).toBe('bullet');
    type(ta, 'one\n'); // Enter typed natively
    expect(r.engine.editor.getSnapshot().list).toBe('bullet');
    expect(key(ta, 'Enter').defaultPrevented).toBe(true); // empty item → leaves the list
    expect(r.engine.editor.getSnapshot().list).toBeNull();
    r.engine.editor.commit();
    // The empty plain line after the item is dropped: its newline is the item's terminator in the Y.Text.
    expect(r.engine.doc.getRich(id)).toMatchObject({ text: 'one' });
    expect(r.engine.doc.getRich(id).fmt?.lists).toEqual(['bullet']);
  });
  it('a numbered list on the last line stores the terminator; the plain text stays clean', () => {
    const r = rig();
    const { id } = open(r, 'a\nb');
    r.engine.editor.toggleList('number');
    r.engine.editor.commit();
    expect(r.engine.doc.getText(id)).toBe('a\nb');
    expect(r.engine.doc.getRich(id).fmt?.lists).toEqual([null, 'number']);
  });
  it('without any formatting action nothing extra is written; an unchanged edit writes nothing at all', () => {
    const r = rig();
    const { id } = open(r, 'plain');
    const steps = r.engine.doc.undo.undoStack.length;
    r.engine.editor.commit();
    expect(r.engine.doc.getRich(id).fmt).toBeUndefined();
    expect(r.engine.doc.undo.undoStack.length).toBe(steps);
  });
  it('a connector label has no formatting', () => {
    const r = rig();
    const [a, b] = r.make({ init: { kind: 'sticky', x: 0, y: 0 } }, { init: { kind: 'sticky', x: 400, y: 0 } });
    const [c] = r.make({ init: { kind: 'connector', from: { id: a ?? '', side: 'right' }, to: { id: b ?? '', side: 'left' }, label: 'go' } });
    r.engine.startTextEdit(c);
    expect(r.engine.editor.getSnapshot()).toMatchObject({ open: true, rich: false, token: null });
    const ta = r.host.querySelector('textarea');
    if (ta) {
      select(ta, 0, 2);
      key(ta, 'b', { metaKey: true });
    }
    expect(r.engine.editor.getSnapshot().bold).toBe(false);
    r.engine.editor.commit();
  });
  it('the size buttons change the object and the textarea follows', () => {
    const r = rig();
    const { id, ta } = open(r, 'big');
    const before = parseFloat(ta.style.fontSize);
    r.engine.setEditFontSize('xl');
    expect(r.engine.scene.get(id)).toMatchObject({ fontSize: 'xl' });
    expect(parseFloat(ta.style.fontSize)).toBeGreaterThan(before);
    expect(r.engine.editor.getSnapshot().token).toBe('xl');
    r.engine.editor.commit();
    const t = open(r, 'free', 'text');
    r.engine.setEditFontSize('l');
    expect(r.engine.scene.get(t.id)).toMatchObject({ size: 32 });
    r.engine.editor.commit();
  });
  it('the editor opens with the formatting the object has and writes it back when only the text changes', () => {
    const r = rig();
    const [id] = r.make({ init: { kind: 'shape', x: 0, y: 0, text: 'ab cd' } });
    const f = (): void => {
      r.engine.startTextEdit(id);
    };
    f();
    const ta = r.host.querySelector('textarea');
    if (!ta || !id) throw new Error('no editor');
    select(ta, 3, 5);
    r.engine.editor.toggleFlag(F_BOLD);
    r.engine.editor.commit();
    f();
    const ta2 = r.host.querySelector('textarea');
    if (!ta2) throw new Error('no editor');
    expect(r.engine.editor.getSnapshot().bold).toBe(true); // the caret is after the bold word
    select(ta2, 0, 2);
    expect(r.engine.editor.getSnapshot().bold).toBe(false);
    select(ta2, 3, 5);
    expect(r.engine.editor.getSnapshot().bold).toBe(true);
    type(ta2, 'ab cdx', 6);
    r.engine.editor.commit();
    expect(r.engine.doc.getRich(id).fmt?.spans).toEqual([{ from: 3, to: 6, f: F_BOLD }]);
  });
});

describe('templates', () => {
  const tr = (key: string, p?: Record<string, string | number>): string => (p ? `${key} ${Object.values(p).join(',')}` : key);
  it('insertTemplate puts the objects at the center of the view, selects them, and is one undo step', () => {
    const r = rig();
    const steps = r.engine.doc.undo.undoStack.length;
    const view = r.engine.visibleWorld();
    const ids = r.engine.insertTemplate('kanban', tr);
    expect(ids).toHaveLength(12);
    expect(r.engine.selection.size).toBe(12);
    const b = r.engine.scene.bounds(ids);
    expect(b ? b.x + b.w / 2 : 0).toBeCloseTo(view.x + view.w / 2);
    expect(b ? b.y + b.h / 2 : 0).toBeCloseTo(view.y + view.h / 2);
    r.engine.doc.undo.undo();
    expect(r.engine.doc.count).toBe(0);
    expect(r.engine.doc.undo.undoStack.length).toBe(steps);
  });
  it('refuses on a read-only canvas', () => {
    const r = rig({ readOnly: true });
    expect(r.engine.insertTemplate('flow', tr)).toEqual([]);
    expect(r.engine.doc.count).toBe(0);
  });
  it('connectors of a template follow the (moved) shapes', () => {
    const r = rig();
    const ids = r.engine.insertTemplate('flow', tr);
    const conn = ids.map((i) => r.engine.scene.get(i)).find((o) => o?.kind === 'connector');
    const before = conn?.kind === 'connector' ? [...conn.points] : [];
    r.engine.doc.patch(ids[0] ?? '', { x: (r.engine.scene.get(ids[0] ?? '')?.x ?? 0) - 200 });
    const after = r.engine.scene.get(conn?.id ?? '');
    expect(after?.kind === 'connector' ? after.points[0] : 0).not.toBe(before[0]);
  });
});

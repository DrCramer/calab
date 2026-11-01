import { describe, expect, it } from 'vitest';
import { applyEdit, editorKey, formatSelection, isExpandHotkey, offersExpand, type FormatKind, type KeyLike } from './editorLogic';

const key = (o: Partial<KeyLike>): KeyLike => ({ key: '', code: '', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...o });
const fmt = (text: string, s: number, e: number, k: FormatKind) => applyEdit(text, formatSelection(text, s, e, k));

describe('offersExpand', () => {
  it('stays hidden for short text and shows for 4 lines or a long paragraph', () => {
    expect(offersExpand('')).toBe(false);
    expect(offersExpand('a\nb\nc')).toBe(false);
    expect(offersExpand('a\nb\nc\nd')).toBe(true);
    expect(offersExpand('x'.repeat(299))).toBe(false);
    expect(offersExpand('x'.repeat(300))).toBe(true);
  });
});

describe('keys', () => {
  it('opens on Cmd/Ctrl+Shift+E by the physical key', () => {
    expect(isExpandHotkey(key({ metaKey: true, shiftKey: true, code: 'KeyE', key: 'У' }))).toBe(true);
    expect(isExpandHotkey(key({ ctrlKey: true, shiftKey: true, code: 'KeyE', key: 'E' }))).toBe(true);
    expect(isExpandHotkey(key({ metaKey: true, code: 'KeyE' }))).toBe(false);
    expect(isExpandHotkey(key({ shiftKey: true, code: 'KeyE' }))).toBe(false);
  });
  it('Enter is a newline; only Cmd/Ctrl+Enter sends', () => {
    expect(editorKey(key({ key: 'Enter' }))).toBeNull();
    expect(editorKey(key({ key: 'Enter', shiftKey: true }))).toBeNull();
    expect(editorKey(key({ key: 'Enter', metaKey: true }))).toEqual({ type: 'send' });
    expect(editorKey(key({ key: 'Enter', ctrlKey: true }))).toEqual({ type: 'send' });
    expect(editorKey(key({ key: 'Enter', metaKey: true, isComposing: true }))).toBeNull();
  });
  it('maps formatting chords', () => {
    expect(editorKey(key({ metaKey: true, code: 'KeyB' }))).toEqual({ type: 'format', kind: 'bold' });
    expect(editorKey(key({ ctrlKey: true, code: 'KeyI' }))).toEqual({ type: 'format', kind: 'italic' });
    expect(editorKey(key({ metaKey: true, shiftKey: true, code: 'KeyX' }))).toEqual({ type: 'format', kind: 'strike' });
    expect(editorKey(key({ metaKey: true, code: 'KeyK' }))).toBeNull();
  });
});

describe('formatSelection', () => {
  it('wraps and unwraps', () => {
    expect(fmt('say hello now', 4, 9, 'bold')).toEqual({ text: 'say **hello** now', selStart: 6, selEnd: 11 });
    expect(fmt('say **hello** now', 6, 11, 'bold').text).toBe('say hello now');
    expect(fmt('say **hello** now', 4, 13, 'bold').text).toBe('say hello now');
  });
  it('keeps spaces outside the markers', () => {
    expect(fmt('a hello b', 1, 8, 'italic').text).toBe('a *hello* b');
  });
  it('does not take italic off a bold span', () => {
    expect(fmt('**x**', 2, 3, 'italic').text).toBe('***x***');
  });
  it('puts a pair with the caret between when nothing is selected', () => {
    expect(fmt('ab', 1, 1, 'strike')).toEqual({ text: 'a~~~~b', selStart: 3, selEnd: 3 });
  });
  it('code: inline for one line, fenced block for several', () => {
    expect(fmt('x y', 0, 1, 'code').text).toBe('`x` y');
    expect(fmt('a\nb', 0, 3, 'code').text).toBe('```\na\nb\n```');
    expect(fmt('```\na\nb\n```', 0, 11, 'code').text).toBe('a\nb');
  });
  it('link: brackets around the text and a selected placeholder address', () => {
    const r = fmt('see docs', 4, 8, 'link');
    expect(r.text).toBe('see [docs](https://)');
    expect(r.text.slice(r.selStart, r.selEnd)).toBe('https://');
    expect(fmt('https://a.io/x', 0, 14, 'link').text).toBe('[](https://a.io/x)');
  });
});

/**
 * Pure logic of the expanded editor (docs/08 «Расширенный редактор»): when the composer offers it,
 * the key map of the editor, and the formatting edits. The formatting is the markup the messages
 * already render (lib/markdown: **bold**, *italic*, ~~strike~~, `code`, ``` blocks, [text](url)) —
 * nothing new is invented here.
 */

/** The «expand» button shows from this many lines… */
export const EXPAND_LINES = 4;
/** …or this many characters (a long paragraph wraps over several lines of the field). */
export const EXPAND_CHARS = 300;

/** The composer shows the «expand» button once the text no longer sits comfortably in the field. */
export function offersExpand(text: string): boolean {
  if (text.length >= EXPAND_CHARS) return true;
  let lines = 1;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
    if (++lines >= EXPAND_LINES) return true;
  }
  return false;
}

export interface KeyLike {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  isComposing?: boolean | undefined;
}

/** ⌘⇧E / Ctrl+Shift+E in the composer field: open the editor (by the physical key — any layout). */
export function isExpandHotkey(e: KeyLike): boolean {
  return (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.code === 'KeyE' && !e.isComposing;
}

export type FormatKind = 'bold' | 'italic' | 'strike' | 'code' | 'link';

export type EditorKey = { type: 'send' } | { type: 'format'; kind: FormatKind } | null;

/**
 * Keys of the editor's field. Enter is a plain newline (the browser's), so only ⌘/Ctrl+Enter sends.
 * ⌘K stays the global search, so a link has no hotkey.
 */
export function editorKey(e: KeyLike): EditorKey {
  if (e.isComposing) return null;
  const mod = e.metaKey || e.ctrlKey;
  if (!mod || e.altKey) return null;
  if (e.key === 'Enter') return e.shiftKey ? null : { type: 'send' };
  if (e.shiftKey) return e.code === 'KeyX' ? { type: 'format', kind: 'strike' } : null;
  if (e.code === 'KeyB') return { type: 'format', kind: 'bold' };
  if (e.code === 'KeyI') return { type: 'format', kind: 'italic' };
  if (e.code === 'KeyE') return { type: 'format', kind: 'code' };
  return null;
}

/** Replace `text[from, to)` with `insert`, then select `[selStart, selEnd)` (absolute offsets of the new text). */
export interface Edit {
  from: number;
  to: number;
  insert: string;
  selStart: number;
  selEnd: number;
}

const MARK: Record<Exclude<FormatKind, 'link'>, string> = { bold: '**', italic: '*', strike: '~~', code: '`' };

/** Is `m` at `at` a lone marker (a single `*` next to another `*` belongs to bold)? */
function loneAt(text: string, at: number, m: string): boolean {
  if (text.slice(at, at + m.length) !== m) return false;
  if (m.length > 1 || m === '`') return true;
  return text[at - 1] !== m && text[at + 1] !== m;
}

/**
 * The edit that formats the selection `[start, end)`; a second press on the same format takes the
 * markers off. Spaces at the edges of the selection stay outside (the parser wants a non-space next
 * to the marker). Without a selection the markers go in as a pair with the caret between.
 */
export function formatSelection(text: string, start: number, end: number, kind: FormatKind): Edit {
  let a = Math.min(start, end);
  let b = Math.max(start, end);
  while (a < b && /\s/.test(text[a] ?? '')) a++;
  while (b > a && /\s/.test(text[b - 1] ?? '')) b--;
  const sel = text.slice(a, b);

  if (kind === 'link') {
    if (/^https?:\/\/\S+$/.test(sel)) return { from: a, to: b, insert: `[](${sel})`, selStart: a + 1, selEnd: a + 1 };
    const insert = `[${sel}](https://)`;
    // No text yet: the caret goes between the brackets; otherwise the placeholder address is selected.
    return sel ? { from: a, to: b, insert, selStart: a + sel.length + 3, selEnd: a + insert.length - 1 } : { from: a, to: b, insert, selStart: a + 1, selEnd: a + 1 };
  }

  const m = MARK[kind];
  if (kind === 'code' && sel.includes('\n')) {
    // A multi-line selection is a code block, not an inline span.
    if (/^```[^\n]*\n[\s\S]*\n```$/.test(sel)) {
      const inner = sel.replace(/^```[^\n]*\n/, '').replace(/\n```$/, '');
      return { from: a, to: b, insert: inner, selStart: a, selEnd: a + inner.length };
    }
    const insert = `\`\`\`\n${sel}\n\`\`\``;
    return { from: a, to: b, insert, selStart: a + 4, selEnd: a + 4 + sel.length };
  }
  // Markers just outside the selection: take them off.
  if (a >= m.length && loneAt(text, a - m.length, m) && loneAt(text, b, m)) {
    return { from: a - m.length, to: b + m.length, insert: sel, selStart: a - m.length, selEnd: a - m.length + sel.length };
  }
  // Markers inside the selection (the whole span selected with them).
  if (sel.length > 2 * m.length && loneAt(sel, 0, m) && loneAt(sel, sel.length - m.length, m)) {
    const inner = sel.slice(m.length, sel.length - m.length);
    return { from: a, to: b, insert: inner, selStart: a, selEnd: a + inner.length };
  }
  return { from: a, to: b, insert: m + sel + m, selStart: a + m.length, selEnd: a + m.length + sel.length };
}

/** Applies an edit to a string (the unit-test oracle and the fallback when `execCommand` is gone). */
export function applyEdit(text: string, e: Edit): { text: string; selStart: number; selEnd: number } {
  return { text: text.slice(0, e.from) + e.insert + text.slice(e.to), selStart: e.selStart, selEnd: e.selEnd };
}

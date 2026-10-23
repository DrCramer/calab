/**
 * Text formatting of a canvas object (ADR-0127 §Волна 2). Pure: no Yjs, no DOM.
 *
 * Stored in the object's `Y.Text` as Quill-style attributes: inline `bold` / `italic` / `strike` on characters and the
 * paragraph attribute `list: 'bullet' | 'number'` on the paragraph's terminating `\n`. A client that knows nothing of
 * them reads the same `Y.Text` as plain text. Here the formatting is a small immutable value, `Fmt`, next to the plain
 * `text` of a scene record; both are derived from the `Y.Text` delta.
 *
 * One quirk keeps the plain text clean: the last paragraph has no `\n` of its own, so a list on it needs one to carry
 * the attribute. That terminator is part of the delta (`fmtToDelta` writes it, `fmtFromDelta` strips it): the
 * record's `text` never ends with it, and an ordinary trailing newline (no `list` on it) is kept as an empty last line.
 */

export type ListKind = 'bullet' | 'number';

export const F_BOLD = 1;
export const F_ITALIC = 2;
export const F_STRIKE = 4;
export const F_ALL = F_BOLD | F_ITALIC | F_STRIKE;

/** Characters [from, to) carry `f` (never a `\n`; sorted, not overlapping, adjacent equal ones merged). */
export interface Span {
  readonly from: number;
  readonly to: number;
  readonly f: number;
}

export interface Fmt {
  readonly spans: readonly Span[];
  /** Per paragraph (`text.split('\n')`) of the plain text; trailing «no list» entries are trimmed. */
  readonly lists: readonly (ListKind | null)[];
  /** Identity of the content: layout caches key on it, and a rebuilt record reuses the old object while it is equal. */
  readonly key: string;
}

/** A Quill-style delta op as `Y.Text.toDelta()` returns it (non-string inserts are ignored). */
export interface DeltaOp {
  insert?: unknown;
  attributes?: Record<string, unknown>;
  retain?: number;
  delete?: number;
}

const ATTR_FLAG: readonly [string, number][] = [['bold', F_BOLD], ['italic', F_ITALIC], ['strike', F_STRIKE]];

/** Keys of `Y.Text` attributes this build owns; others (from newer builds) are never touched. */
export const FMT_ATTR_KEYS: readonly string[] = ['bold', 'italic', 'strike', 'list'];

const isList = (v: unknown): v is ListKind => v === 'bullet' || v === 'number';

/** Dense form used while editing: one flags entry per character, one list entry per paragraph. */
interface Dense {
  flags: number[];
  lists: (ListKind | null)[];
}

function keyOf(spans: readonly Span[], lists: readonly (ListKind | null)[]): string {
  let k = '';
  for (const s of spans) k += `${s.from}-${s.to}:${s.f},`;
  k += '|';
  for (const l of lists) k += l === 'bullet' ? 'b' : l === 'number' ? 'n' : '.';
  return k;
}

function build(spans: Span[], lists: (ListKind | null)[]): Fmt | undefined {
  let n = lists.length;
  while (n > 0 && lists[n - 1] === null) n--;
  const ls = n === lists.length ? lists : lists.slice(0, n);
  if (spans.length === 0 && ls.length === 0) return undefined;
  return { spans, lists: ls, key: keyOf(spans, ls) };
}

export function paragraphCount(text: string): number {
  let n = 1;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) n++;
  return n;
}

/** Index of the paragraph the position `pos` (0..text.length) lies in. */
export function paragraphAt(text: string, pos: number): number {
  let n = 0;
  const end = Math.min(pos, text.length);
  for (let i = text.indexOf('\n'); i !== -1 && i < end; i = text.indexOf('\n', i + 1)) n++;
  return n;
}

function toDense(fmt: Fmt | undefined, text: string): Dense {
  const flags: number[] = new Array<number>(text.length).fill(0);
  const lists: (ListKind | null)[] = new Array<ListKind | null>(paragraphCount(text)).fill(null);
  if (fmt) {
    for (const s of fmt.spans) for (let i = Math.max(0, s.from); i < Math.min(s.to, text.length); i++) flags[i] = s.f;
    for (let i = 0; i < lists.length; i++) lists[i] = fmt.lists[i] ?? null;
  }
  return { flags, lists };
}

function fromDense(d: Dense, text: string): Fmt | undefined {
  const spans: Span[] = [];
  let from = -1;
  let cur = 0;
  for (let i = 0; i <= d.flags.length; i++) {
    const f = i < d.flags.length && text[i] !== '\n' ? (d.flags[i] ?? 0) : 0;
    if (f !== cur) {
      if (cur !== 0) spans.push({ from, to: i, f: cur });
      from = i;
      cur = f;
    }
  }
  return build(spans, d.lists);
}

/** Flags of every character of `text` (a dense array); empty formatting gives zeros. */
export function flagsOf(fmt: Fmt | undefined, text: string): number[] {
  return toDense(fmt, text).flags;
}

// ── Y.Text delta ↔ Fmt ────────────────────────────────────────────────────────

/** The plain text and its formatting from a `Y.Text` delta (the list terminator of the last paragraph is stripped). */
export function fmtFromDelta(ops: readonly DeltaOp[]): { text: string; fmt: Fmt | undefined } {
  let text = '';
  const spans: Span[] = [];
  const lists: (ListKind | null)[] = [null];
  for (const op of ops) {
    if (typeof op.insert !== 'string' || op.insert === '') continue;
    const a = op.attributes;
    let f = 0;
    let list: ListKind | null = null;
    if (a) {
      for (const [name, bit] of ATTR_FLAG) if (a[name] === true) f |= bit;
      if (isList(a.list)) list = a.list;
    }
    const s = op.insert;
    let i = 0;
    while (i < s.length) {
      const nl = s.indexOf('\n', i);
      const end = nl === -1 ? s.length : nl;
      if (end > i) {
        const from = text.length;
        text += s.slice(i, end);
        if (f !== 0) {
          const last = spans[spans.length - 1];
          if (last && last.to === from && last.f === f) spans[spans.length - 1] = { from: last.from, to: from + (end - i), f };
          else spans.push({ from, to: from + (end - i), f });
        }
      }
      if (nl === -1) break;
      lists[lists.length - 1] = list;
      lists.push(null);
      text += '\n';
      i = nl + 1;
    }
  }
  // The terminator of a last list paragraph carries the list but starts no paragraph.
  if (text.endsWith('\n') && lists.length >= 2 && lists[lists.length - 2] !== null) {
    text = text.slice(0, -1);
    lists.pop();
  }
  return { text, fmt: build(spans, lists) };
}

/** The `Y.Text` form of text + formatting: what the terminator rule above says. Plain text gives one op. */
export function fmtToDelta(text: string, fmt: Fmt | undefined): DeltaOp[] {
  const raw = rawText(text, fmt);
  if (!fmt) return raw === '' ? [] : [{ insert: raw }];
  const { flags, lists } = toDense(fmt, text);
  const ops: DeltaOp[] = [];
  const attrsOf = (f: number): Record<string, unknown> | undefined => {
    if (f === 0) return undefined;
    const a: Record<string, unknown> = {};
    for (const [name, bit] of ATTR_FLAG) if (f & bit) a[name] = true;
    return a;
  };
  let para = 0;
  let i = 0;
  const pushText = (s: string, f: number): void => {
    if (s === '') return;
    const last = ops[ops.length - 1];
    const a = attrsOf(f);
    if (last && !last.attributes?.list && typeof last.insert === 'string' && last.insert !== '\n' && sameAttrs(last.attributes, a)) last.insert += s;
    else ops.push(a ? { insert: s, attributes: a } : { insert: s });
  };
  while (i < text.length) {
    if (text[i] === '\n') {
      const list = lists[para] ?? null;
      ops.push(list ? { insert: '\n', attributes: { list } } : { insert: '\n' });
      para++;
      i++;
      continue;
    }
    const f = flags[i] ?? 0;
    let j = i + 1;
    while (j < text.length && text[j] !== '\n' && (flags[j] ?? 0) === f) j++;
    pushText(text.slice(i, j), f);
    i = j;
  }
  if (raw.length > text.length) ops.push({ insert: '\n', attributes: { list: lists[para] ?? 'bullet' } });
  return ops;
}

function sameAttrs(a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined): boolean {
  const ka = a ? Object.keys(a) : [];
  const kb = b ? Object.keys(b) : [];
  return ka.length === kb.length && ka.every((k) => a?.[k] === b?.[k]);
}

/** What the `Y.Text` holds for `text` + `fmt`: with the list terminator when the last paragraph is a list item. */
export function rawText(text: string, fmt: Fmt | undefined): string {
  if (!fmt) return text;
  const last = paragraphCount(text) - 1;
  return fmt.lists[last] ? `${text}\n` : text;
}

export interface FormatChange {
  index: number;
  length: number;
  /** Attribute → value, `null` removes it (`Y.Text.format` semantics). */
  attrs: Record<string, true | ListKind | null>;
}

/**
 * The `Y.Text.format` calls that turn the current delta into the wanted one (only the attributes this build owns;
 * both deltas must describe the same raw text). Minimal: untouched ranges stay untouched.
 */
export function formatChanges(current: readonly DeltaOp[], wanted: readonly DeltaOp[]): FormatChange[] {
  const runs = (ops: readonly DeltaOp[]): { len: number; a: Record<string, unknown> }[] => {
    const out: { len: number; a: Record<string, unknown> }[] = [];
    for (const op of ops) {
      if (typeof op.insert !== 'string') continue;
      const own: Record<string, unknown> = {};
      for (const k of FMT_ATTR_KEYS) if (op.attributes && k in op.attributes) own[k] = op.attributes[k];
      const s = op.insert;
      let i = 0;
      while (i < s.length) {
        // A newline is its own run: only it carries `list`; text carries only the inline ones.
        const nl = s[i] === '\n';
        let j = i + 1;
        if (!nl) while (j < s.length && s[j] !== '\n') j++;
        const a: Record<string, unknown> = {};
        for (const k of FMT_ATTR_KEYS) if (k in own && (k === 'list') === nl) a[k] = own[k];
        out.push({ len: j - i, a });
        i = j;
      }
    }
    return out;
  };
  const cur = runs(current);
  const want = runs(wanted);
  const out: FormatChange[] = [];
  let ci = 0;
  let wi = 0;
  let cl = cur[0]?.len ?? 0;
  let wl = want[0]?.len ?? 0;
  let index = 0;
  while (ci < cur.length && wi < want.length) {
    const len = Math.min(cl, wl);
    const ca = cur[ci]?.a ?? {};
    const wa = want[wi]?.a ?? {};
    const diff: Record<string, true | ListKind | null> = {};
    let any = false;
    for (const k of FMT_ATTR_KEYS) {
      const cv = ca[k] ?? null;
      const wv = wa[k] ?? null;
      if (cv !== wv) {
        diff[k] = (wv === null ? null : wv) as true | ListKind | null;
        any = true;
      }
    }
    if (any) {
      const last = out[out.length - 1];
      if (last && last.index + last.length === index && sameAttrs(last.attrs, diff)) last.length += len;
      else out.push({ index, length: len, attrs: diff });
    }
    index += len;
    cl -= len;
    wl -= len;
    if (cl === 0) {
      ci++;
      cl = cur[ci]?.len ?? 0;
    }
    if (wl === 0) {
      wi++;
      wl = want[wi]?.len ?? 0;
    }
  }
  return out;
}

// ── editing ───────────────────────────────────────────────────────────────────

/**
 * The formatting after the text changed: `delLen` characters at `pos` of `before` were replaced by `inserted`.
 * Inserted characters take `pending` flags when given, else those of the character to the left (or, at a line start,
 * of the one to the right); a paragraph keeps its list when it is split (Enter continues a list) and, when paragraphs
 * merge, takes the list of the last of them (its terminator survives).
 */
export function editFmt(fmt: Fmt | undefined, before: string, pos: number, delLen: number, inserted: string, pending?: number | null): Fmt | undefined {
  if (!fmt && pending == null) return undefined;
  const d = toDense(fmt, before);
  // A replaced selection (autocorrect, IME, typing over it) keeps the style of its first character.
  let inherit = delLen > 0 && before[pos] !== '\n' ? (d.flags[pos] ?? 0) : pos > 0 && before[pos - 1] !== '\n' ? (d.flags[pos - 1] ?? 0) : 0;
  if (inherit === 0 && delLen === 0 && (pos === 0 || before[pos - 1] === '\n')) {
    const right = pos + delLen;
    if (right < before.length && before[right] !== '\n') inherit = d.flags[right] ?? 0;
  }
  const f = pending ?? inherit;
  const removed = before.slice(pos, pos + delLen);
  let nlDel = 0;
  for (let i = removed.indexOf('\n'); i !== -1; i = removed.indexOf('\n', i + 1)) nlDel++;
  let nlIns = 0;
  for (let i = inserted.indexOf('\n'); i !== -1; i = inserted.indexOf('\n', i + 1)) nlIns++;
  const pi = paragraphAt(before, pos);
  const kind = d.lists[pi + nlDel] ?? null;
  d.flags.splice(pos, delLen, ...Array.from(inserted, (c) => (c === '\n' ? 0 : f)));
  d.lists.splice(pi, nlDel + 1, ...new Array<ListKind | null>(nlIns + 1).fill(kind));
  return fromDense(d, before.slice(0, pos) + inserted + before.slice(pos + delLen));
}

/** Common flags of the non-newline characters of [from, to): `all` = on every one, `any` = on at least one. */
export function flagsIn(fmt: Fmt | undefined, text: string, from: number, to: number): { all: number; any: number; count: number } {
  const flags = flagsOf(fmt, text);
  let all = F_ALL;
  let any = 0;
  let count = 0;
  for (let i = Math.max(0, from); i < Math.min(to, text.length); i++) {
    if (text[i] === '\n') continue;
    all &= flags[i] ?? 0;
    any |= flags[i] ?? 0;
    count++;
  }
  return count === 0 ? { all: 0, any: 0, count: 0 } : { all, any, count };
}

/** Flags a character typed at `pos` would inherit (what the caret «is in»). */
export function flagsAtCaret(fmt: Fmt | undefined, text: string, pos: number): number {
  if (!fmt) return 0;
  const flags = flagsOf(fmt, text);
  if (pos > 0 && text[pos - 1] !== '\n') return flags[pos - 1] ?? 0;
  if (pos < text.length && text[pos] !== '\n') return flags[pos] ?? 0;
  return 0;
}

/** Turns `flag` on for [from, to) unless it is already on for all of it, then off. Newlines are skipped. */
export function toggleFlag(fmt: Fmt | undefined, text: string, from: number, to: number, flag: number): Fmt | undefined {
  const { all, count } = flagsIn(fmt, text, from, to);
  if (count === 0) return fmt;
  const on = (all & flag) === 0;
  const d = toDense(fmt, text);
  for (let i = Math.max(0, from); i < Math.min(to, text.length); i++) {
    if (text[i] === '\n') continue;
    d.flags[i] = on ? (d.flags[i] ?? 0) | flag : (d.flags[i] ?? 0) & ~flag;
  }
  return fromDense(d, text);
}

/** Paragraph range [first, last] a selection touches (a selection ending just after a `\n` does not touch the next one). */
export function paragraphsIn(text: string, from: number, to: number): [number, number] {
  const a = paragraphAt(text, from);
  const b = to > from && text[to - 1] === '\n' ? paragraphAt(text, to - 1) : paragraphAt(text, to);
  return [a, Math.max(a, b)];
}

/** The list kind shared by every paragraph of the selection (null when none, or when they differ). */
export function listIn(fmt: Fmt | undefined, text: string, from: number, to: number): ListKind | null {
  const [a, b] = paragraphsIn(text, from, to);
  const first = fmt?.lists[a] ?? null;
  for (let i = a + 1; i <= b; i++) if ((fmt?.lists[i] ?? null) !== first) return null;
  return first;
}

/** Makes every paragraph of the selection a `kind` list item; when they all are already, removes the list. */
export function toggleList(fmt: Fmt | undefined, text: string, from: number, to: number, kind: ListKind): Fmt | undefined {
  const [a, b] = paragraphsIn(text, from, to);
  const off = listIn(fmt, text, from, to) === kind;
  const d = toDense(fmt, text);
  for (let i = a; i <= b; i++) d.lists[i] = off ? null : kind;
  return fromDense(d, text);
}

/** Removes the list of one paragraph (Enter on an empty item leaves the list). */
export function clearList(fmt: Fmt | undefined, text: string, paragraph: number): Fmt | undefined {
  if (!fmt?.lists[paragraph]) return fmt;
  const d = toDense(fmt, text);
  d.lists[paragraph] = null;
  return fromDense(d, text);
}

/** The slice [from, to) of `text` with its formatting (copy inside the canvas): offsets and paragraphs start at 0. */
export function sliceFmt(fmt: Fmt | undefined, text: string, from: number, to: number): { text: string; fmt: Fmt | undefined } {
  const sub = text.slice(from, to);
  if (!fmt) return { text: sub, fmt: undefined };
  const d = toDense(fmt, text);
  const p0 = paragraphAt(text, from);
  const n = paragraphCount(sub);
  const out: Dense = { flags: d.flags.slice(from, to), lists: d.lists.slice(p0, p0 + n) };
  while (out.lists.length < n) out.lists.push(null);
  return { text: sub, fmt: fromDense(out, sub) };
}

/** Marker numbers of the number-list paragraphs: 1, 2, … restarting after any paragraph that is not one. */
export function listNumbers(text: string, fmt: Fmt | undefined): number[] {
  const n = paragraphCount(text);
  const out = new Array<number>(n).fill(0);
  let k = 0;
  for (let i = 0; i < n; i++) {
    if (fmt?.lists[i] === 'number') out[i] = ++k;
    else k = 0;
  }
  return out;
}

export const sameFmt = (a: Fmt | undefined, b: Fmt | undefined): boolean => a === b || (a?.key ?? '') === (b?.key ?? '');

import type { Camera } from '../../../lib/canvas/camera';
import type { Point, Rect } from '../../../lib/canvas/geometry';
import {
  F_BOLD, F_ITALIC, F_STRIKE, clearList, editFmt, flagsAtCaret, flagsIn, listIn, paragraphAt, sameFmt, toggleFlag, toggleList,
  type Fmt, type ListKind,
} from '../../../lib/canvas/richText';
import { MAX_TEXT } from '../../../lib/canvas/types';
import { LINE_HEIGHT, type FontToken } from '../../../lib/canvas/textLayout';

export interface EditSpec {
  /** Where the text lives, world units. */
  box: Rect;
  text: string;
  size: number;
  color: string;
  align: 'left' | 'center';
  /** Center the text vertically in the box (shapes, labels) or grow downward from its top (stickies, text). */
  vcenter: boolean;
  /** Grow the textarea with its content instead of scrolling (free text objects). */
  autoHeight: boolean;
  fontFamily: string;
  /** The object is rotated by this many degrees (about `center`, world units): the textarea turns with it. */
  rot?: number;
  center?: Point;
  /** Formatting of `text` (stickies, text objects, shapes); the editor keeps it in step with the typing. */
  fmt?: Fmt;
  /** Bold / italic / strike / lists are available (not for a connector label). */
  rich?: boolean;
  /** Size token shown in the format bar (null: the object has none, e.g. a label). */
  token?: FontToken | null;
}

/** What the format bar shows: replaced (not mutated) whenever any of it changes, so it is a `useSyncExternalStore` snapshot. */
export interface FormatState {
  readonly open: boolean;
  readonly rich: boolean;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly strike: boolean;
  readonly list: ListKind | null;
  readonly token: FontToken | null;
  /** The textarea's box in CSS px of the editor host, for placing the bar. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

const CLOSED: FormatState = { open: false, rich: false, bold: false, italic: false, strike: false, list: null, token: null, x: 0, y: 0, w: 0, h: 0 };

export type EditDone = (text: string, changed: boolean, fmt: Fmt | undefined, fmtChanged: boolean) => void;

export interface TextEditorOptions {
  /** Positioned ancestor of the canvas (the textarea is appended here). */
  host: HTMLElement;
  canvas: HTMLElement;
  getCamera: () => Camera;
}

/**
 * A real `<textarea>` over the object while it is edited — IME, autocorrect and selection come for free,
 * which canvas text cannot do (ADR-0113 §4). The result is written once, on commit (blur, Escape,
 * ⌘/Ctrl+Enter), by the caller. Key events never reach the engine's hotkeys: the textarea is not inside
 * the canvas.
 *
 * Formatting (ADR-0114): a textarea cannot show a bold word, so it stays a plain-text surface and the styles live in
 * a model beside it (`Fmt`, lib/canvas/richText): every `input` is diffed against the previous value and mapped onto
 * the model, so typing, deleting, autocorrect, IME composition and native undo keep the attributes in step with the
 * characters. The format bar (view/TextFormatBar) toggles them on the selection — or, at a caret, for what is typed
 * next — and the object is drawn formatted on the canvas as soon as editing ends.
 */
export class TextEditor {
  private ta: HTMLTextAreaElement | null = null;
  private spec: EditSpec | null = null;
  private done: EditDone | null = null;
  private original = '';
  private initialFmt: Fmt | undefined;
  /** The formatting model and the text it describes (the textarea's value as of the last input). */
  private fmt: Fmt | undefined;
  private text = '';
  /** Flags the next typed characters take (a toggle at a caret); dropped when the caret moves elsewhere. */
  private pending: number | null = null;
  private pendingAt = -1;
  private snap: FormatState = CLOSED;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly o: TextEditorOptions) {}

  get isOpen(): boolean {
    return this.ta !== null;
  }

  /** The element, for tests and focus management. */
  get element(): HTMLTextAreaElement | null {
    return this.ta;
  }

  /** The current formatting (tests, the engine). */
  get format(): Fmt | undefined {
    return this.fmt;
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): FormatState => this.snap;

  open(spec: EditSpec, onDone: EditDone): void {
    if (this.ta) this.commit();
    const ta = this.o.host.ownerDocument.createElement('textarea');
    ta.value = spec.text;
    ta.maxLength = MAX_TEXT;
    ta.spellcheck = true;
    ta.setAttribute('aria-label', 'Canvas text');
    ta.dataset.canvasEditor = '1';
    const st = ta.style;
    st.position = 'absolute';
    st.margin = '0';
    st.padding = '0';
    st.border = '0';
    st.outline = 'none';
    st.resize = 'none';
    st.overflow = 'hidden';
    st.background = 'transparent';
    st.whiteSpace = 'pre-wrap';
    st.overflowWrap = 'break-word';
    st.lineHeight = String(LINE_HEIGHT);
    st.boxSizing = 'content-box';
    st.textAlign = spec.align;
    st.color = spec.color;
    st.fontFamily = spec.fontFamily;
    st.caretColor = spec.color;
    this.ta = ta;
    this.spec = spec;
    this.done = onDone;
    this.original = spec.text;
    this.initialFmt = spec.rich ? spec.fmt : undefined;
    this.fmt = this.initialFmt;
    this.text = spec.text;
    this.pending = null;
    this.o.host.appendChild(ta);
    ta.addEventListener('input', this.onInput);
    ta.addEventListener('keydown', this.onKey);
    ta.addEventListener('blur', this.onBlur);
    ta.addEventListener('keyup', this.onCaret);
    ta.addEventListener('mouseup', this.onCaret);
    ta.ownerDocument.addEventListener('selectionchange', this.onCaret);
    this.reposition();
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    this.refresh();
  }

  /** Follows the camera (call after any pan/zoom while open). */
  reposition(): void {
    const { ta, spec } = this;
    if (!ta || !spec) return;
    const cam = this.o.getCamera();
    const left = this.o.canvas.offsetLeft;
    const top = this.o.canvas.offsetTop;
    const st = ta.style;
    st.left = `${left + spec.box.x * cam.scale + cam.tx}px`;
    st.top = `${top + spec.box.y * cam.scale + cam.ty}px`;
    st.width = `${spec.box.w * cam.scale}px`;
    st.fontSize = `${spec.size * cam.scale}px`;
    if (spec.rot && spec.center) {
      st.transformOrigin = `${(spec.center.x - spec.box.x) * cam.scale}px ${(spec.center.y - spec.box.y) * cam.scale}px`;
      st.transform = `rotate(${spec.rot}deg)`;
    }
    this.fit();
    this.refresh();
  }

  /** The object's text size changed while editing (the format bar's size buttons). */
  setSize(size: number, token: FontToken | null): void {
    if (!this.spec) return;
    this.spec = { ...this.spec, size, token };
    this.reposition();
  }

  private fit(): void {
    const { ta, spec } = this;
    if (!ta || !spec) return;
    const cam = this.o.getCamera();
    const boxH = spec.box.h * cam.scale;
    ta.style.paddingTop = '0px';
    ta.style.height = 'auto';
    const content = ta.scrollHeight;
    if (spec.autoHeight) {
      ta.style.height = `${Math.max(content, spec.size * cam.scale * LINE_HEIGHT)}px`;
      return;
    }
    ta.style.height = `${boxH}px`;
    if (spec.vcenter && content < boxH) {
      const pad = (boxH - content) / 2;
      ta.style.paddingTop = `${pad}px`;
      ta.style.height = `${boxH - pad}px`;
    }
  }

  // ── formatting ──────────────────────────────────────────────────────────────

  private get selection(): [number, number] {
    const ta = this.ta;
    return ta ? [ta.selectionStart, ta.selectionEnd] : [0, 0];
  }

  /** Bold / italic / strike on the selection, or for what is typed next when there is none. */
  toggleFlag(flag: number): void {
    const ta = this.ta;
    if (!ta || !this.spec?.rich) return;
    const [from, to] = this.selection;
    if (from === to) {
      const cur = this.pending ?? flagsAtCaret(this.fmt, this.text, from);
      this.pending = cur & flag ? cur & ~flag : cur | flag;
      this.pendingAt = from;
    } else this.fmt = toggleFlag(this.fmt, this.text, from, to, flag);
    this.refresh();
  }

  /** Makes the paragraphs of the selection a list of `kind`, or takes them out of it. */
  toggleList(kind: ListKind): void {
    const ta = this.ta;
    if (!ta || !this.spec?.rich) return;
    const [from, to] = this.selection;
    this.fmt = toggleList(this.fmt, this.text, from, to, kind);
    this.refresh();
  }

  /** Maps the textarea's current value onto the model: the changed middle is one replacement. */
  private syncModel(): void {
    const ta = this.ta;
    if (!ta || !this.spec?.rich) return;
    const next = ta.value;
    const prev = this.text;
    if (next === prev) return;
    let p = 0;
    const max = Math.min(prev.length, next.length);
    while (p < max && prev.charCodeAt(p) === next.charCodeAt(p)) p++;
    let q = 0;
    while (q < max - p && prev.charCodeAt(prev.length - 1 - q) === next.charCodeAt(next.length - 1 - q)) q++;
    this.fmt = editFmt(this.fmt, prev, p, prev.length - p - q, next.slice(p, next.length - q), this.pending);
    this.text = next;
    if (this.pending !== null) this.pendingAt = ta.selectionStart;
  }

  private readonly onInput = (): void => {
    this.syncModel();
    this.fit();
    this.refresh();
  };

  /** The caret or selection moved: a pending style is dropped unless the caret is where typing left it. */
  private readonly onCaret = (): void => {
    const ta = this.ta;
    if (!ta || ta.ownerDocument.activeElement !== ta) return;
    if (this.pending !== null && !(ta.selectionStart === ta.selectionEnd && ta.selectionStart === this.pendingAt)) this.pending = null;
    this.refresh();
  };

  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      this.commit();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      this.commit();
    } else if (this.spec?.rich && (e.metaKey || e.ctrlKey) && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 'b' && !e.shiftKey) this.hotkey(e, F_BOLD);
      else if (k === 'i' && !e.shiftKey) this.hotkey(e, F_ITALIC);
      else if (k === 'x' && e.shiftKey) this.hotkey(e, F_STRIKE);
    } else if (e.key === 'Enter' && !e.shiftKey && this.spec?.rich && this.leaveEmptyItem()) {
      e.preventDefault();
    }
  };

  private hotkey(e: KeyboardEvent, flag: number): void {
    e.preventDefault();
    this.toggleFlag(flag);
  }

  /** Enter on an empty list item ends the list instead of adding an item (what every editor does). */
  private leaveEmptyItem(): boolean {
    const ta = this.ta;
    if (!ta || ta.selectionStart !== ta.selectionEnd) return false;
    const pos = ta.selectionStart;
    const para = paragraphAt(this.text, pos);
    if (!this.fmt?.lists[para]) return false;
    const start = this.text.lastIndexOf('\n', pos - 1) + 1;
    const nl = this.text.indexOf('\n', pos);
    const end = nl === -1 ? this.text.length : nl;
    if (end !== start) return false;
    this.fmt = clearList(this.fmt, this.text, para);
    this.refresh();
    return true;
  }

  private readonly onBlur = (): void => {
    this.commit();
  };

  /** Rebuilds the snapshot the format bar reads; listeners are told only when something it shows changed. */
  private refresh(): void {
    const { ta, spec } = this;
    if (!ta || !spec) {
      this.setSnap(CLOSED);
      return;
    }
    const rich = spec.rich === true;
    const [from, to] = this.selection;
    let flags = 0;
    if (rich) flags = from === to ? (this.pending ?? flagsAtCaret(this.fmt, this.text, from)) : flagsIn(this.fmt, this.text, from, to).all;
    const r = (n: number): number => Math.round(n);
    const x = parseFloat(ta.style.left) || 0;
    const y = parseFloat(ta.style.top) || 0;
    const next: FormatState = {
      open: true,
      rich,
      bold: (flags & F_BOLD) !== 0,
      italic: (flags & F_ITALIC) !== 0,
      strike: (flags & F_STRIKE) !== 0,
      list: rich ? listIn(this.fmt, this.text, from, to) : null,
      token: spec.token ?? null,
      x: r(x),
      y: r(y),
      w: r(parseFloat(ta.style.width) || 0),
      h: r(parseFloat(ta.style.height) || 0),
    };
    this.setSnap(next);
  }

  private setSnap(next: FormatState): void {
    const a = this.snap;
    if (
      a.open === next.open && a.rich === next.rich && a.bold === next.bold && a.italic === next.italic && a.strike === next.strike &&
      a.list === next.list && a.token === next.token && a.x === next.x && a.y === next.y && a.w === next.w && a.h === next.h
    ) return;
    this.snap = next;
    for (const fn of [...this.listeners]) fn();
  }

  private detach(ta: HTMLTextAreaElement): void {
    ta.removeEventListener('input', this.onInput);
    ta.removeEventListener('keydown', this.onKey);
    ta.removeEventListener('blur', this.onBlur);
    ta.removeEventListener('keyup', this.onCaret);
    ta.removeEventListener('mouseup', this.onCaret);
    ta.ownerDocument.removeEventListener('selectionchange', this.onCaret);
  }

  /** Finishes editing and reports the text (changed = differs from what it opened with) and its formatting. */
  commit(): void {
    const ta = this.ta;
    const done = this.done;
    if (!ta || !done) return;
    this.syncModel();
    const fmt = this.fmt;
    const fmtChanged = !sameFmt(fmt, this.initialFmt);
    this.ta = null;
    this.done = null;
    this.spec = null;
    this.fmt = undefined;
    this.pending = null;
    this.detach(ta);
    const text = ta.value;
    ta.remove();
    this.setSnap(CLOSED);
    done(text, text !== this.original, fmt, fmtChanged);
  }

  /** Closes without reporting. */
  cancel(): void {
    const ta = this.ta;
    if (!ta) return;
    this.ta = null;
    this.done = null;
    this.spec = null;
    this.fmt = undefined;
    this.pending = null;
    this.detach(ta);
    ta.remove();
    this.setSnap(CLOSED);
  }
}

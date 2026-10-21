import { keyIs } from './keys';
import type { Camera } from '../../../lib/canvas/camera';
import type { Point, Rect } from '../../../lib/canvas/geometry';
import {
  F_BOLD, F_ITALIC, F_STRIKE, clearList, editFmt, flagsAtCaret, flagsIn, listIn, paragraphAt, sameFmt, toggleFlag, toggleList,
  type Fmt, type ListKind,
} from '../../../lib/canvas/richText';
import { MAX_TEXT } from '../../../lib/canvas/types';
import { LINE_HEIGHT } from '../../../lib/canvas/textLayout';

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
  /** The object has a text size the format bar can change (false: e.g. a connector label). */
  sized?: boolean;
}

/** What the format bar shows: replaced (not mutated) whenever any of it changes, so it is a `useSyncExternalStore` snapshot. */
export interface FormatState {
  readonly open: boolean;
  readonly rich: boolean;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly strike: boolean;
  readonly list: ListKind | null;
  /** The text size in px the format bar's size field shows (null: this text has none to change). */
  readonly size: number | null;
  /** The textarea's box in CSS px of the editor host, for placing the bar. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Phone: px of the host's bottom the on-screen keyboard covers (the format bar sits above it); 0 without one. */
  readonly kbd: number;
}

const CLOSED: FormatState = { open: false, rich: false, bold: false, italic: false, strike: false, list: null, size: null, x: 0, y: 0, w: 0, h: 0, kbd: 0 };

/** Keeping the text clear of the on-screen keyboard (the phone's edit mode, ADR-0115 wave 5b). */
export interface PhoneKeyboard {
  /** The view must move by `dy` px (negative: up) so the text stays in the free part of the screen. */
  keepVisible(dy: number): void;
  /** Px at the bottom of the host that the format bar takes. */
  reserve: number;
  /** Px at the top of the host that the screen's own bars cover. */
  top: number;
}

/** Air between the text and the keyboard / bar above it. */
const KBD_GAP = 12;

export type EditDone = (text: string, changed: boolean, fmt: Fmt | undefined, fmtChanged: boolean) => void;

export interface TextEditorOptions {
  /** Positioned ancestor of the canvas (the textarea is appended here). */
  host: HTMLElement;
  canvas: HTMLElement;
  getCamera: () => Camera;
  /** The phone: follow `window.visualViewport` while a text is open and keep the text above the keyboard. */
  phone?: PhoneKeyboard;
  /** The textarea's accessible name, read at every open (the engine has no i18n of its own). */
  label?: () => string;
}

/**
 * A real `<textarea>` over the object while it is edited — IME, autocorrect and selection come for free,
 * which canvas text cannot do (ADR-0114 §4). The result is written once, on commit (blur, Escape,
 * ⌘/Ctrl+Enter), by the caller. Key events never reach the engine's hotkeys: the textarea is not inside
 * the canvas.
 *
 * Formatting (ADR-0115): a textarea cannot show a bold word, so it stays a plain-text surface and the styles live in
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
  /** The keyboard's overlap with the host (px), read when the visual viewport changes — only while open. */
  private kbd = 0;
  private vv: VisualViewport | null = null;
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
    const label = this.o.label?.();
    if (label) ta.setAttribute('aria-label', label);
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
    // The app smooths DOM text as `antialiased` (thinner); the canvas cannot, so match its default weight.
    st.setProperty('-webkit-font-smoothing', 'auto');
    // A textarea is two rows tall by default: `height: auto` would measure an empty second line and push centered text up.
    ta.rows = 1;
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
    ta.addEventListener('wheel', this.onWheel, { passive: false });
    ta.addEventListener('gestureend', this.onGesture);
    ta.addEventListener('gesturechange', this.onGesture);
    ta.addEventListener('gesturestart', this.onGesture);
    ta.addEventListener('keyup', this.onCaret);
    ta.addEventListener('mouseup', this.onCaret);
    ta.ownerDocument.addEventListener('selectionchange', this.onCaret);
    this.reposition();
    if (this.o.phone) {
      // The keyboard narrows the visible area: watch it only while this text is open (no listener at rest).
      const vv = ta.ownerDocument.defaultView?.visualViewport ?? null;
      this.vv = vv;
      vv?.addEventListener('resize', this.onViewport);
      vv?.addEventListener('scroll', this.onViewport);
      ta.focus({ preventScroll: true });
    } else ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    this.onViewport();
    this.refresh();
  }

  /**
   * The visible area changed (the keyboard came up or went) or the text grew: measure how much of the host the keyboard
   * covers and, if the text sits below the free part or under the top bars, ask the screen to move the view by that much.
   */
  private readonly onViewport = (): void => {
    const { ta } = this;
    const phone = this.o.phone;
    if (!ta || !phone) return;
    // The camera may have moved since the last frame placed the box: measure where it is now.
    this.reposition();
    const host = this.o.host.getBoundingClientRect();
    const vv = this.vv;
    const visibleTop = vv ? vv.offsetTop : -Infinity;
    const visibleBottom = vv ? vv.offsetTop + vv.height : Infinity;
    const kbd = Math.max(0, Math.round(host.bottom - visibleBottom));
    if (kbd !== this.kbd) {
      this.kbd = kbd;
      this.refresh();
    }
    const limitBottom = Math.min(host.bottom, visibleBottom) - phone.reserve - KBD_GAP;
    const limitTop = Math.max(host.top, visibleTop) + phone.top;
    const r = ta.getBoundingClientRect();
    if (r.height === 0 && r.width === 0) return;
    let dy = r.bottom > limitBottom ? limitBottom - r.bottom : 0;
    // Never push the start of the text off the top to show its end.
    dy = Math.min(0, Math.max(dy, limitTop - r.top));
    if (Math.abs(dy) >= 1) phone.keepVisible(dy);
  };

  /**
   * A wheel or trackpad over the open text: scrolls the text when it is taller than the card (the textarea hides its
   * scrollbar but scrolls), otherwise — and for a pinch — pans / zooms the canvas.
   */
  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const ta = this.ta;
    if (ta && !e.ctrlKey && ta.scrollHeight > ta.clientHeight + 1) {
      ta.scrollTop += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      return;
    }
    this.o.canvas.dispatchEvent(
      new WheelEvent('wheel', {
        deltaX: e.deltaX, deltaY: e.deltaY, deltaZ: e.deltaZ, deltaMode: e.deltaMode,
        clientX: e.clientX, clientY: e.clientY, screenX: e.screenX, screenY: e.screenY,
        ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, altKey: e.altKey, cancelable: true,
      }),
    );
  };

  /** Safari's trackpad pinch (gesture events) over the open text: handed to the canvas, which zooms. */
  private readonly onGesture = (e: Event): void => {
    e.preventDefault();
    const g = e as Event & { scale?: number; clientX?: number; clientY?: number };
    const copy = new Event(e.type, { cancelable: true });
    Object.defineProperties(copy, { scale: { value: g.scale }, clientX: { value: g.clientX }, clientY: { value: g.clientY } });
    this.o.canvas.dispatchEvent(copy);
  };

  /**
   * Follows the camera (call after any pan/zoom while open). The textarea is laid out at the object's world size and
   * scaled by a transform, so it wraps lines exactly like the canvas at any zoom (a font scaled to a few px wraps
   * differently: hinting and the minimum font size).
   */
  reposition(): void {
    const { ta, spec } = this;
    if (!ta || !spec) return;
    const cam = this.o.getCamera();
    const left = this.o.canvas.offsetLeft;
    const top = this.o.canvas.offsetTop;
    const st = ta.style;
    st.left = `${left + spec.box.x * cam.scale + cam.tx}px`;
    st.top = `${top + spec.box.y * cam.scale + cam.ty}px`;
    st.width = `${spec.box.w}px`;
    st.fontSize = `${spec.size}px`;
    st.transformOrigin = '0 0';
    if (spec.rot && spec.center) {
      const cx = spec.center.x - spec.box.x;
      const cy = spec.center.y - spec.box.y;
      st.transform = `scale(${cam.scale}) translate(${cx}px, ${cy}px) rotate(${spec.rot}deg) translate(${-cx}px, ${-cy}px)`;
    } else {
      st.transform = `scale(${cam.scale})`;
    }
    this.fit();
    this.refresh();
  }

  /** The object moved, resized or turned under the open editor (a co-author): the textarea follows it. */
  moveTo(geom: Pick<EditSpec, 'box' | 'rot' | 'center'>): void {
    if (!this.spec) return;
    const next: EditSpec = { ...this.spec, box: geom.box };
    delete next.rot;
    delete next.center;
    if (geom.rot && geom.center) Object.assign(next, { rot: geom.rot, center: geom.center });
    this.spec = next;
    this.reposition();
  }

  /** The object's text size changed while editing (the format bar's size field). */
  setSize(size: number): void {
    if (!this.spec) return;
    this.spec = { ...this.spec, size };
    this.reposition();
  }

  /** Hands the focus back to the textarea (after the format bar's size field took it to type a number). */
  refocus(): void {
    this.ta?.focus({ preventScroll: true });
  }

  /** The focus moved to `el`: still part of editing (the textarea, or a control of the format bar that marks itself `data-keeps-editing`). */
  keepsEditing(el: EventTarget | null): boolean {
    return el !== null && (el === this.ta || (el instanceof Element && el.closest('[data-keeps-editing]') !== null));
  }

  private fit(): void {
    const { ta, spec } = this;
    if (!ta || !spec) return;
    const boxH = spec.box.h;
    ta.style.paddingTop = '0px';
    ta.style.height = 'auto';
    const content = ta.scrollHeight;
    if (spec.autoHeight) {
      ta.style.height = `${Math.max(content, spec.size * LINE_HEIGHT)}px`;
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
    // A growing text (more lines) may reach the keyboard.
    this.onViewport();
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
      if (keyIs(e, 'b') && !e.shiftKey) this.hotkey(e, F_BOLD);
      else if (keyIs(e, 'i') && !e.shiftKey) this.hotkey(e, F_ITALIC);
      else if (keyIs(e, 'x') && e.shiftKey) this.hotkey(e, F_STRIKE);
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

  private readonly onBlur = (e: FocusEvent): void => {
    // The format bar's size field takes the focus to type a number: that is still editing.
    if (this.keepsEditing(e.relatedTarget)) return;
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
      size: spec.sized ? spec.size : null,
      x: r(x),
      y: r(y),
      w: r(parseFloat(ta.style.width) || 0),
      h: r(parseFloat(ta.style.height) || 0),
      kbd: this.kbd,
    };
    this.setSnap(next);
  }

  private setSnap(next: FormatState): void {
    const a = this.snap;
    if (
      a.open === next.open && a.rich === next.rich && a.bold === next.bold && a.italic === next.italic && a.strike === next.strike &&
      a.list === next.list && a.size === next.size && a.x === next.x && a.y === next.y && a.w === next.w && a.h === next.h && a.kbd === next.kbd
    ) return;
    this.snap = next;
    for (const fn of [...this.listeners]) fn();
  }

  private detach(ta: HTMLTextAreaElement): void {
    ta.removeEventListener('input', this.onInput);
    ta.removeEventListener('keydown', this.onKey);
    ta.removeEventListener('blur', this.onBlur);
    ta.removeEventListener('wheel', this.onWheel);
    ta.removeEventListener('gestureend', this.onGesture);
    ta.removeEventListener('gesturechange', this.onGesture);
    ta.removeEventListener('gesturestart', this.onGesture);
    ta.removeEventListener('keyup', this.onCaret);
    ta.removeEventListener('mouseup', this.onCaret);
    ta.ownerDocument.removeEventListener('selectionchange', this.onCaret);
    this.vv?.removeEventListener('resize', this.onViewport);
    this.vv?.removeEventListener('scroll', this.onViewport);
    this.vv = null;
    this.kbd = 0;
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

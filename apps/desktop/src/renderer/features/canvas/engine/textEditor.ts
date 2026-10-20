import type { Camera } from '../../../lib/canvas/camera';
import type { Point, Rect } from '../../../lib/canvas/geometry';
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
}

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
 */
export class TextEditor {
  private ta: HTMLTextAreaElement | null = null;
  private spec: EditSpec | null = null;
  private done: ((text: string, changed: boolean) => void) | null = null;
  private original = '';

  constructor(private readonly o: TextEditorOptions) {}

  get isOpen(): boolean {
    return this.ta !== null;
  }

  /** The element, for tests and focus management. */
  get element(): HTMLTextAreaElement | null {
    return this.ta;
  }

  open(spec: EditSpec, onDone: (text: string, changed: boolean) => void): void {
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
    this.o.host.appendChild(ta);
    ta.addEventListener('input', this.onInput);
    ta.addEventListener('keydown', this.onKey);
    ta.addEventListener('blur', this.onBlur);
    this.reposition();
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
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

  private readonly onInput = (): void => {
    this.fit();
  };

  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      this.commit();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      this.commit();
    }
  };

  private readonly onBlur = (): void => {
    this.commit();
  };

  /** Finishes editing and reports the text (changed = differs from what it opened with). */
  commit(): void {
    const ta = this.ta;
    const done = this.done;
    if (!ta || !done) return;
    this.ta = null;
    this.done = null;
    this.spec = null;
    ta.removeEventListener('input', this.onInput);
    ta.removeEventListener('keydown', this.onKey);
    ta.removeEventListener('blur', this.onBlur);
    const text = ta.value;
    ta.remove();
    done(text, text !== this.original);
  }

  /** Closes without reporting. */
  cancel(): void {
    const ta = this.ta;
    if (!ta) return;
    this.ta = null;
    this.done = null;
    this.spec = null;
    ta.removeEventListener('input', this.onInput);
    ta.removeEventListener('keydown', this.onKey);
    ta.removeEventListener('blur', this.onBlur);
    ta.remove();
  }
}

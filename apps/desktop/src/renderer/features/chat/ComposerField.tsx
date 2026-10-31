/**
 * The room-agnostic core of the chat composer (docs/08 «Композер»): the rounded field with autosize,
 * the one-line placeholder stand-in, the emoji button, the round send button, the edit / reply strip
 * and the @ autocomplete state. The chat's Composer and the comments' CommentComposer (canvas,
 * meetings — owner 23.10: «как в чате») are both built from these, so the two cannot drift apart.
 */
import { ArrowUp, Check, Maximize2, Smile } from 'lucide-react';
import { useId, useLayoutEffect, useState, type KeyboardEvent, type ReactNode, type RefObject, type TextareaHTMLAttributes } from 'react';
import { CloseButton, IconButton, MOD, Tip, cx } from '../../components/ui';
import { t } from '../../i18n';
import { mentionQuery } from '../../lib/mentions';
import { useMobile } from '../../lib/mobile';
import { EmojiPicker } from './EmojiPicker';
import { MentionPopover, optionKey, type MentionOption } from './MentionPopover';

/** Field grows up to 6 lines (15 px text on a 20 px line — integer line boxes keep layout pixel-exact). */
export const MAX_FIELD_H = 6 * 20 + 16;
/** Phone: the field is taller than this (one 44 px line + slack) → the multiline layout. */
const MULTILINE_PX = 52;

/**
 * Autosize of the field (up to MAX_FIELD_H); on a phone, whether the text took a row of its own
 * (sticky until the field is empty again: at the full width the same text may fit one line).
 */
export function useFieldAutosize(ref: RefObject<HTMLTextAreaElement | null>, text: string): boolean {
  const mobile = useMobile();
  const [multi, setMulti] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Empty: exactly the one-line min-height — a native placeholder that wraps (a long room name)
    // must not inflate the field; the visible placeholder is the one-line stand-in.
    el.style.height = 'auto';
    el.style.height = text === '' ? '0px' : `${Math.min(el.scrollHeight, MAX_FIELD_H)}px`;
    if (mobile) setMulti((was) => (text === '' ? false : was || el.scrollHeight > MULTILINE_PX));
  }, [ref, text, mobile, multi]);
  return multi;
}

export interface MentionPicker {
  listId: string;
  query: { start: number; query: string } | null;
  options: MentionOption[];
  open: boolean;
  sel: number;
  setSel: (i: number) => void;
  /** The list closes for the @ under the caret (Esc, blur). */
  dismiss: () => void;
  /** Focus: the list may open again. */
  undismiss: () => void;
  /** aria-activedescendant of the field. */
  activeId: string | undefined;
  /** ↑ ↓ Enter Tab Esc while the list is open; true when handled. */
  onKey: (e: KeyboardEvent<HTMLTextAreaElement>, pick: (o: MentionOption) => void) => boolean;
}

/** The @ autocomplete state over `text` at `caret`; `build` turns the query into options. */
export function useMentionPicker(text: string, caret: number, build: (q: { start: number; query: string }) => MentionOption[]): MentionPicker {
  const listId = useId();
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [sel, setSel] = useState(0);
  const query = mentionQuery(text, caret);
  const options = query && query.start !== dismissed ? build(query) : [];
  const open = options.length > 0;
  const selIdx = Math.min(sel, Math.max(0, options.length - 1));
  const [track, setTrack] = useState<string | null>(null);
  const key = query ? `${query.start}:${query.query}` : null;
  if (key !== track) {
    setTrack(key);
    setSel(0);
  }
  const current = options[selIdx];
  return {
    listId,
    query,
    options,
    open,
    sel: selIdx,
    setSel,
    dismiss: () => setDismissed(query?.start ?? null),
    undismiss: () => setDismissed(null),
    activeId: open && current ? `${listId}-${optionKey(current)}` : undefined,
    onKey: (e, pick) => {
      if (!open || e.nativeEvent.isComposing) return false;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setSel((selIdx + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length);
        return true;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault();
        if (current) pick(current);
        return true;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissed(query?.start ?? null);
        return true;
      }
      return false;
    },
  };
}

/** The list of a MentionPicker, above the field. */
export function MentionList({ m, onPick }: { m: MentionPicker; onPick: (o: MentionOption) => void }): ReactNode {
  return m.open ? <MentionPopover id={m.listId} options={m.options} sel={m.sel} onPick={onPick} onHover={m.setSel} /> : null;
}

/** The round send button (✓ while editing). */
export function SendButton({ editing, onClick, testId }: { editing: boolean; onClick: () => void; testId?: string | undefined }): ReactNode {
  const label = editing ? t('common.save') : t('chat.send');
  return (
    <Tip label={label} shortcut="↵">
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        data-testid={testId}
        className="anim-pop mb-0.5 grid size-9 shrink-0 mobile:mb-0 mobile:size-11 place-items-center rounded-full bg-accent-strong text-accent-fg shadow-[var(--shadow-card)] hover:brightness-110 active:brightness-95"
      >
        {editing ? <Check className="size-5" strokeWidth={2.25} /> : <ArrowUp className="size-5" strokeWidth={2.25} />}
      </button>
    </Tip>
  );
}

/** Reply / edit strip above the field (accent bar, title, snippet, ×). */
export function ContextBar({ icon, title, text, onClose }: { icon: ReactNode; title: string; text?: ReactNode; onClose: () => void }): ReactNode {
  return (
    <div className="mb-2 flex items-center gap-3 pl-2" data-testid="composer-context">
      <span className="text-accent-text">{icon}</span>
      <div className="min-w-0 flex-1 border-l-2 border-accent pl-2">
        <div className="truncate text-body font-semibold text-accent-text">{title}</div>
        {text !== undefined ? <div className="truncate text-body text-muted">{text}</div> : null}
      </div>
      <CloseButton label={t('common.cancel')} shortcut="" className="rounded-full" onClick={onClose} />
    </div>
  );
}

type FieldAttrs = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'rows' | 'maxLength' | 'placeholder' | 'className' | 'style' | 'aria-label'>;

/**
 * The field row: [leading | text | extra, emoji] in the rounded box, the action (send / mic) to its
 * right, a popover slot above. Telegram-like (docs/09 #37); on a phone a grid whose second line puts
 * the text on a row of its own.
 */
export function ComposerField({
  fieldRef,
  text,
  placeholder,
  maxLength,
  multi,
  field,
  onEmoji,
  leading,
  hiddenInputs,
  extra,
  popover,
  strip,
  action,
  hidden = false,
  onExpand,
}: {
  fieldRef: RefObject<HTMLTextAreaElement | null>;
  text: string;
  placeholder: string;
  maxLength: number;
  /** useFieldAutosize's answer. */
  multi: boolean;
  /** Handlers and aria of the textarea. */
  field: FieldAttrs & { 'data-testid'?: string | undefined };
  onEmoji: (s: string) => void;
  /** The left button (the chat's 📎); a spacer without it. Gets `multi` for the phone's row. */
  leading?: ((multi: boolean) => ReactNode) | undefined;
  hiddenInputs?: ReactNode;
  /** Before the emoji button (the chat's sticker button). */
  extra?: ReactNode;
  popover?: ReactNode;
  /** Beside the box (the chat's voice recorder strip). */
  strip?: ReactNode;
  action?: ReactNode;
  /** The box is hidden (a voice recording takes its place). */
  hidden?: boolean;
  /** The «expand» corner button (the long-text editor, #97); absent while the text is short. */
  onExpand?: (() => void) | undefined;
}): ReactNode {
  return (
    <>
      <div className="relative flex items-end gap-2">
        {popover}
        {strip}
        <div
          data-focus-box
          className={cx(
            'relative flex min-h-10 min-w-0 flex-1 items-end rounded-[20px] border border-line bg-elev px-1 mobile:rounded-[22px] shadow-[var(--shadow-card)] focus-within:border-focus',
            // Phone: one grid, [attach | text | sticker emoji]; a second line puts the text on its own row above them.
            'mobile:grid mobile:min-h-11 mobile:grid-cols-[auto_minmax(0,1fr)_auto] mobile:items-center mobile:px-0',
            // Phone, two lines and more: a large radius that still reads as round (no corners).
            multi && 'mobile:rounded-[26px]',
            // mobile:hidden too: the phone's mobile:grid would otherwise win over hidden and squeeze the recorder.
            hidden && 'hidden mobile:hidden',
          )}
        >
          {leading ? leading(multi) : <span className="w-2 mobile:hidden" />}
          {hiddenInputs}
          {/* Desktop: a wrapper for the field and its placeholder (a span: the layout invariants look for the field's closest div); phone: `contents`, the grid places them. */}
          <span className="relative flex min-w-0 flex-1 items-end mobile:contents">
            <textarea
              ref={fieldRef}
              value={text}
              rows={1}
              maxLength={maxLength}
              // The visible placeholder is drawn below (a native one wraps and inflates the field); this one
              // stays for assistive tech and tests, transparent.
              placeholder={placeholder}
              aria-label={placeholder}
              {...field}
              className={cx(
                'selectable min-h-[38px] min-w-0 flex-1 resize-none bg-transparent px-1.5 py-[9px] text-list leading-5 placeholder:text-transparent',
                'mobile:min-h-11 mobile:py-3 mobile:row-start-1',
                multi ? 'mobile:col-span-3 mobile:col-start-1 mobile:px-3 mobile:pb-1' : 'mobile:col-start-2',
                // The corner button sits over the first line of a phone's full-width text.
                onExpand && multi && 'mobile:pr-11',
              )}
              style={{ maxHeight: MAX_FIELD_H }}
            />
            {!text ? (
              // The placeholder of a textarea wraps (a long room name made it four lines): a one-line,
              // ellipsised stand-in over the field (phone: in the same grid cell), transparent to touches.
              <span aria-hidden className="pointer-events-none absolute inset-x-0 top-[9px] min-w-0 truncate px-1.5 text-list leading-5 text-faint mobile:static mobile:col-start-2 mobile:row-start-1">
                {placeholder}
              </span>
            ) : null}
          </span>
          <div className={cx('contents mobile:col-start-3 mobile:flex mobile:items-center', multi ? 'mobile:row-start-2' : 'mobile:row-start-1')}>
            {extra}
            <EmojiPicker onPick={onEmoji} label={t('chat.emoji')}>
              <IconButton tip={false} label={t('chat.emoji')} className="mb-1 rounded-full mobile:mb-0 mobile:size-11">
                <Smile className="size-5" />
              </IconButton>
            </EmojiPicker>
          </div>
          {onExpand ? (
            <Tip label={t('chat.editor.expand')} shortcut={`${MOD}⇧E`}>
              <button
                type="button"
                onClick={onExpand}
                aria-label={t('chat.editor.expand')}
                data-testid="composer-expand"
                className="absolute right-1.5 top-1.5 grid size-7 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg mobile:right-0 mobile:top-0 mobile:size-11"
              >
                <Maximize2 className="size-4" aria-hidden />
              </button>
            </Tip>
          ) : null}
        </div>
        {action}
      </div>
      {text.length > maxLength - 200 ? (
        <div className="mt-1 text-right text-micro text-warn">
          {text.length}/{maxLength}
        </div>
      ) : null}
    </>
  );
}

/** Inserts `s` at the field's selection; returns the new text and caret. */
export function insertAt(el: HTMLTextAreaElement | null, text: string, s: string): { text: string; caret: number } {
  if (!el) return { text: text + s, caret: text.length + s.length };
  const start = el.selectionStart;
  return { text: text.slice(0, start) + s + text.slice(el.selectionEnd), caret: start + s.length };
}

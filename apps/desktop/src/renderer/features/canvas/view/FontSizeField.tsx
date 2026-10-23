import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronDown, Minus, Plus } from 'lucide-react';
import { memo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Tip, cx } from '../../../components/ui';
import { t } from '../../../i18n';
import { DEFAULTS } from '../../../lib/canvas/types';
import { MENU_BOX, keepFocus } from './chrome';
import { FONT_PRESETS } from './model';

const MIN = DEFAULTS.minTextSize;
const MAX = DEFAULTS.maxTextSize;
const clamp = (n: number): number => Math.min(MAX, Math.max(MIN, n));
/** A size as shown: whole numbers as they are, an odd stored one (31.5) to a tenth. */
const show = (n: number): string => String(Math.round(n * 10) / 10);

/** Hover hint for an icon-only control (docs/08); a finger has no hover, so the touch sheets go bare. */
const hint = (touch: boolean | undefined, label: string, node: ReactNode): ReactNode => (touch ? node : <Tip label={label}>{node}</Tip>);

const BTN = 'grid shrink-0 place-items-center rounded-[var(--radius-icon)] text-muted hover:bg-hover hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted';

/**
 * The text size as a number (ADR-0127): a field you type in (Enter / blur applies, Esc cancels, ↑ / ↓ ± 1, Shift ± 10), − / + steppers and a
 * list of presets. One control for the properties panel, the format bar over the text being edited and the phone sheets
 * (`touch`: 44 px targets and the numeric keyboard). `value` undefined = the selection differs: the field is empty («—») and the
 * steppers are off. In the format bar (`keepsEditing`) the controls are marked so that moving the focus into the field does not
 * end the text edit; `release` hands the focus back (to the canvas or the textarea) and `leave` hears where it went when the field loses it.
 */
export const FontSizeField = memo(function FontSizeField({
  value, onCommit, release, leave, keepsEditing, touch, testId,
}: {
  value: number | undefined;
  onCommit: (px: number) => void;
  release: () => void;
  leave?: (to: EventTarget | null) => void;
  keepsEditing?: boolean;
  touch?: boolean;
  testId: string;
}): ReactNode {
  const label = t('canvasBoard.props.textSize');
  const input = useRef<HTMLInputElement>(null);
  // The raw text while the field is being typed in (a ref beside the state: Enter applies and blurs in one go).
  const draftRef = useRef<string | null>(null);
  const [draft, setDraftState] = useState<string | null>(null);
  const setDraft = (v: string | null): void => {
    draftRef.current = v;
    setDraftState(v);
  };
  const mark = keepsEditing ? { 'data-keeps-editing': '' } : {};

  const apply = (n: number): number => {
    const v = clamp(n);
    if (v !== value) onCommit(v);
    return v;
  };
  const commit = (): void => {
    const raw = draftRef.current;
    setDraft(null);
    if (raw === null) return;
    const n = Number.parseInt(raw, 10);
    if (!Number.isNaN(n)) apply(n);
  };
  const step = (d: number): void => {
    const typed = draftRef.current === null ? null : Number.parseInt(draftRef.current, 10);
    const base = typed !== null && !Number.isNaN(typed) ? typed : value;
    if (base === undefined) return;
    const v = apply(Math.round(base) + d);
    setDraft(document.activeElement === input.current ? String(v) : null);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
      release();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setDraft(null);
      release();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      step((e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1));
    }
  };

  const mixed = value === undefined;
  const btn = touch ? 'size-11' : 'size-7';
  const icon = touch ? 'size-5' : 'size-4';
  return (
    <div role="group" aria-label={label} className="flex items-center gap-0.5" data-testid={testId} {...mark}>
      {hint(touch, t('common.decrease', { label }), <button
        type="button"
        aria-label={t('common.decrease', { label })}
        disabled={mixed || value <= MIN}
        onMouseDown={keepFocus}
        onClick={(e) => step(e.shiftKey ? -10 : -1)}
        className={cx(BTN, btn)}
        data-testid={`${testId}-less`}
      >
        <Minus className={icon} strokeWidth={1.75} aria-hidden />
      </button>)}
      <input
        ref={input}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        spellCheck={false}
        role="spinbutton"
        aria-label={label}
        aria-valuemin={MIN}
        aria-valuemax={MAX}
        aria-valuenow={value}
        aria-valuetext={mixed ? '—' : undefined}
        placeholder="—"
        value={draft ?? (mixed ? '' : show(value))}
        onFocus={(e) => {
          setDraft(mixed ? '' : show(value));
          const el = e.currentTarget;
          requestAnimationFrame(() => el.select());
        }}
        onChange={(e) => setDraft(e.target.value.replace(/\D/g, '').slice(0, String(MAX).length))}
        onBlur={(e) => {
          commit();
          leave?.(e.relatedTarget);
        }}
        onKeyDown={onKey}
        className={cx(
          'selectable min-w-0 rounded-[var(--radius-control)] border border-line bg-elev text-center tabular-nums text-fg placeholder:text-faint',
          touch ? 'h-11 w-14 text-control' : 'h-7 w-11 text-body',
        )}
        data-testid={`${testId}-input`}
      />
      {hint(touch, t('common.increase', { label }), <button
        type="button"
        aria-label={t('common.increase', { label })}
        disabled={mixed || value >= MAX}
        onMouseDown={keepFocus}
        onClick={(e) => step(e.shiftKey ? 10 : 1)}
        className={cx(BTN, btn)}
        data-testid={`${testId}-more`}
      >
        <Plus className={icon} strokeWidth={1.75} aria-hidden />
      </button>)}
      <Presets value={value} onPick={onCommit} release={release} touch={touch} keepsEditing={keepsEditing} testId={testId} />
    </div>
  );
});

/** The list of preset sizes behind a chevron; the focus stays where it was on a pointer (the textarea being edited, the canvas). */
function Presets({
  value, onPick, release, touch, keepsEditing, testId,
}: {
  value: number | undefined;
  onPick: (px: number) => void;
  release: () => void;
  touch?: boolean;
  keepsEditing?: boolean;
  testId: string;
}): ReactNode {
  const label = t('canvasBoard.props.sizePresets');
  const list = useRef<HTMLDivElement>(null);
  const move = (e: KeyboardEvent<HTMLDivElement>): void => {
    const items = [...(list.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const to = e.key === 'ArrowDown' ? at + 1 : e.key === 'ArrowUp' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    items[Math.min(items.length - 1, Math.max(0, to))]?.focus();
  };
  return (
    <Popover.Root>
      {hint(touch, label, <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={label}
          onMouseDown={keepFocus}
          className={cx(BTN, touch ? 'size-11' : 'h-7 w-5')}
          data-testid={`${testId}-presets`}
        >
          <ChevronDown className={touch ? 'size-5' : 'size-3.5'} strokeWidth={1.75} aria-hidden />
        </button>
      </Popover.Trigger>)}
      <Popover.Portal>
        <Popover.Content
          side={touch ? 'top' : 'bottom'}
          align="end"
          sideOffset={8}
          collisionPadding={8}
          className={cx(MENU_BOX, 'w-auto min-w-0 p-1')}
          {...(keepsEditing ? { 'data-keeps-editing': '' } : {})}
          onOpenAutoFocus={(e) => {
            // A finger has no use for a focused row (and would lose the keyboard); the keyboard lands on the current size.
            e.preventDefault();
            if (touch) return;
            const items = list.current?.querySelectorAll<HTMLElement>('[role="option"]');
            (list.current?.querySelector<HTMLElement>('[aria-selected="true"]') ?? items?.[0])?.focus();
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            release();
          }}
        >
          <div ref={list} role="listbox" aria-label={label} className="flex flex-col" onKeyDown={move}>
            {FONT_PRESETS.map((n) => (
              <Popover.Close asChild key={n}>
                <button
                  type="button"
                  role="option"
                  aria-selected={n === value}
                  onMouseDown={keepFocus}
                  onClick={() => onPick(n)}
                  className={cx(
                    'flex cursor-default items-center justify-between gap-3 rounded-[6px] px-2.5 tabular-nums text-fg hover:bg-hover focus-visible:bg-hover',
                    touch ? 'h-11 min-w-24 text-control' : 'h-8 min-w-16 text-body',
                    n === value && 'bg-active',
                  )}
                  data-testid={`${testId}-preset-${n}`}
                >
                  {n}
                  {n === value ? <Check className="size-3.5 text-muted" strokeWidth={2} aria-hidden /> : null}
                </button>
              </Popover.Close>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

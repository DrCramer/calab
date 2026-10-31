import { forwardRef, memo, useCallback, useLayoutEffect, useRef, useState, type DragEvent, type HTMLAttributes, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import * as Popover from '../../components/radix/popover';
import { cx } from '../../components/ui';
import { t } from '../../i18n';
import { fitLabels } from '../../lib/boards/labelsFit';
import { Dot, colorCss } from './visuals';

/**
 * The labels of a task as pills, at most `rows` rows (docs/08 «Лейблы»): what does not fit
 * collapses into one «+N» pill with the colours of the hidden labels, which opens a popover with
 * them (hover with a mouse, click / tap, Enter / Space; Esc closes). One component for the cards,
 * the list rows, the task panel and the rule editor.
 *
 * Measuring: every pill is in the DOM in its own order, so its real width is read as it is; the
 * hidden ones are taken out of the flow (absolute, invisible, `inert`), which keeps their natural
 * width measurable and does not depend on the pills' height (a phone's 44 px target). The widths are read in a layout effect and when the container's width
 * changes (one shared ResizeObserver), the split is `fitLabels` (pure), so a given width always
 * gives the same answer and the first paint is already right. The group pill's width is reserved
 * with an invisible probe of the worst case (the same markup, `+{n-1}`, three dots).
 */
export interface LabelItem {
  id: string;
  name: string;
  color: number;
}

/** A stable handler: a click on the labels does not reach the card / row under them. */
export const stopClick = (e: MouseEvent): void => e.stopPropagation();

const GAP = 4;
const PILL = {
  sm: 'inline-flex h-5 min-w-0 max-w-full shrink-0 items-center gap-1 rounded-full border border-line px-1.5 text-micro text-muted',
  md: 'inline-flex h-6 min-w-0 max-w-full shrink-0 items-center gap-1.5 rounded-full border border-line px-2 text-caption',
} as const;

type Size = keyof typeof PILL;

/** A label pill: the colour dot and the name (truncated). `measured`: part of the fitted row; `off`: behind the group, inert. */
export const LabelPill = memo(function LabelPill({ label, size = 'sm', dragLabel, measured, off }: { label: LabelItem; size?: Size; dragLabel?: boolean; measured?: boolean; off?: boolean }): ReactNode {
  return (
    <span
      className={cx(PILL[size], off && 'pointer-events-none invisible absolute left-0 top-0')}
      data-testid="label-pill"
      {...(measured ? { 'data-lo-pill': '' } : {})}
      {...(off ? { inert: true, 'aria-hidden': true } : {})}
      {...(dragLabel ? { draggable: true, onDragStart: (e: DragEvent) => e.dataTransfer.setData('application/x-calab-label', label.id) } : {})}
    >
      <Dot color={label.color} />
      <span className="truncate">{label.name}</span>
    </span>
  );
});

/** Up to three overlapping dots of the hidden labels. */
function Dots({ labels }: { labels: readonly LabelItem[] }): ReactNode {
  return (
    <span className="flex shrink-0 items-center" aria-hidden>
      {labels.slice(0, 3).map((l, i) => (
        <span key={l.id} className={cx('size-2.5 rounded-full shadow-[0_0_0_1.5px_var(--color-elev)]', i > 0 && '-ml-1')} style={{ background: colorCss(l.color) }} />
      ))}
    </span>
  );
}

// One observer for every card on the screen.
const watchers = new WeakMap<Element, () => void>();
let observer: ResizeObserver | undefined;
function watch(el: Element, run: () => void): () => void {
  if (typeof ResizeObserver === 'undefined') return () => undefined;
  observer ??= new ResizeObserver((entries) => {
    for (const e of entries) watchers.get(e.target)?.();
  });
  watchers.set(el, run);
  observer.observe(el);
  return () => {
    watchers.delete(el);
    observer?.unobserve(el);
  };
}

interface Props extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  labels: readonly LabelItem[];
  size?: Size;
  /** Rows before the group (2; a list row takes 1). */
  rows?: number;
  /** The pills are buttons that bubble their click (the parent's menu trigger, e.g. LabelMenu): the first one is the Tab stop. */
  interactive?: boolean;
  /** Pills can be dragged onto a task (the task panel). */
  dragLabels?: boolean;
  /** A control that always shows after the pills (the «+» of the panel), counted in the fit. */
  trailing?: ReactNode;
}

export const LabelsOverflow = memo(
  forwardRef<HTMLDivElement, Props>(function LabelsOverflow({ labels, size = 'sm', rows = 2, interactive = false, dragLabels = false, trailing, className, style, ...rest }, ref): ReactNode {
    const n = labels.length;
    const [shown, setShown] = useState(n);
    // One-row mode (list rows): the container's basis is the natural width of all the pills, so it is as wide as its content up to the parent's cap and does not depend on how many are hidden.
    const [natural, setNatural] = useState(0);
    const visible = Math.min(shown, n);
    const rootRef = useRef<HTMLDivElement | null>(null);
    const setRef = useCallback(
      (el: HTMLDivElement | null) => {
        rootRef.current = el;
        if (typeof ref === 'function') ref(el);
        else if (ref) ref.current = el;
      },
      [ref],
    );
    const sig = labels.map((l) => `${l.id}\u0000${l.name}`).join('\u0001');
    const hasTail = trailing != null;

    const run = useCallback((): void => {
      const root = rootRef.current;
      if (!root || n === 0) return;
      const max = root.getBoundingClientRect().width - 0.5;
      if (max <= 0) return; // hidden (display: none): nothing to measure
      const widths: number[] = [];
      let group = 0;
      let tail = 0;
      for (const el of Array.from(root.children) as HTMLElement[]) {
        const w = el.getBoundingClientRect().width;
        if (el.dataset['loPill'] !== undefined) widths.push(w);
        else if (el.dataset['loProbe'] !== undefined) group = w;
        else if (el.dataset['loTail'] !== undefined) tail = w;
      }
      if (widths.length !== n) return;
      if (rows === 1) {
        const total = Math.ceil(widths.reduce((a, w) => a + Math.min(w, max), 0) + GAP * (n - 1)) + 1; // +1: the fit keeps 0.5 px of slack
        setNatural((cur) => (cur === total ? cur : total));
      }
      const next = fitLabels({ widths, group, tail, max, gap: GAP, rows });
      setShown((cur) => (cur === next ? cur : next));
    }, [n, rows]);

    // Before the first paint and whenever the labels, the size or the trailing control change.
    useLayoutEffect(() => {
      run();
    }, [run, sig, size, hasTail]);
    // And when the container's width (a resize, a zoom, a font scale) changes.
    useLayoutEffect(() => {
      const root = rootRef.current;
      return root ? watch(root, run) : undefined;
    }, [run]);

    const hidden = labels.slice(visible);
    const probe = Math.max(n - 1, 1);
    // The trigger's ARIA (haspopup / expanded / controls) belongs on the control that has focus: the first pill.
    const { 'aria-expanded': expanded, 'aria-haspopup': haspopup, 'aria-controls': controls, 'aria-label': groupLabel, ...root } = rest;
    const state = (rest as Record<string, unknown>)['data-state'] as string | undefined;
    const pills = labels.map((l, i) =>
      interactive && i < visible ? (
        <button
          key={l.id}
          type="button"
          data-lo-pill=""
          tabIndex={i === 0 ? 0 : -1}
          className={cx(PILL[size], 'cursor-default hover:border-[var(--color-fill-hover)] hover:text-fg')}
          {...(i === 0 ? { 'aria-haspopup': haspopup, 'aria-expanded': expanded, 'aria-controls': controls, ...(state ? { 'data-state': state } : {}) } : {})}
        >
          <Dot color={l.color} />
          <span className="truncate">{l.name}</span>
        </button>
      ) : (
        <LabelPill key={l.id} label={l} size={size} measured off={i >= visible} dragLabel={dragLabels && i < visible} />
      ),
    );
    return (
      <div
        {...root}
        ref={setRef}
        role="group"
        aria-label={groupLabel ?? t('boards.f.label')}
        className={cx('relative flex min-w-0 flex-wrap items-center gap-1', className)}
        style={{ ...(rows === 1 && natural > 0 ? { flexBasis: natural } : {}), ...style }}
      >
        {pills.slice(0, visible)}
        {hidden.length > 0 ? <GroupPill hidden={hidden} size={size} /> : null}
        {hasTail ? (
          <span data-lo-tail="" className="inline-flex shrink-0">
            {trailing}
          </span>
        ) : null}
        {pills.slice(visible)}
        {n > 1 ? (
          <span data-lo-probe="" aria-hidden className={cx(PILL[size], 'pointer-events-none invisible absolute left-0 top-0 tabular-nums')}>
            <span className="flex shrink-0 items-center">
              {[0, 1, 2].slice(0, Math.min(3, probe)).map((i) => (
                <span key={i} className={cx('size-2.5 rounded-full', i > 0 && '-ml-1')} />
              ))}
            </span>
            +{probe}
          </span>
        ) : null}
      </div>
    );
  }),
);

/** «+N» with the dots of the hidden labels; hover / click / Enter / Space opens the list. */
function GroupPill({ hidden, size }: { hidden: readonly LabelItem[]; size: Size }): ReactNode {
  const [open, setOpen] = useState(false);
  const pinned = useRef(false);
  const kbd = useRef(false);
  const button = useRef<HTMLButtonElement | null>(null);
  const content = useRef<HTMLDivElement | null>(null);
  const into = (e: PointerEvent, el: Element | null): boolean => !!el && e.relatedTarget instanceof Node && el.contains(e.relatedTarget);
  const label = t('boards.labelsMore', { n: hidden.length });
  return (
    <Popover.Root
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          pinned.current = false;
          setOpen(false);
        }
      }}
      modal={false}
    >
      <Popover.Anchor asChild>
        <button
          ref={button}
          type="button"
          data-testid="labels-more"
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={open}
          className={cx(PILL[size], 'tap-hit cursor-default tabular-nums hover:border-[var(--color-fill-hover)] hover:text-fg', open && 'border-[var(--color-fill-hover)] text-fg')}
          onPointerEnter={(e) => {
            if (e.pointerType !== 'mouse') return;
            kbd.current = false;
            if (!open) setOpen(true);
          }}
          onPointerLeave={(e) => {
            if (e.pointerType === 'mouse' && !pinned.current && !into(e, content.current)) setOpen(false);
          }}
          onClick={(e: MouseEvent) => {
            e.stopPropagation(); // not the parent's label menu
            kbd.current = e.detail === 0;
            const next = !(open && pinned.current);
            pinned.current = next;
            setOpen(next);
          }}
        >
          <Dots labels={hidden} />
          <span aria-hidden>+{hidden.length}</span>
        </button>
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          ref={content}
          side="bottom"
          align="start"
          sideOffset={4}
          collisionPadding={8}
          aria-label={label}
          data-testid="labels-more-list"
          onOpenAutoFocus={(e) => {
            if (!kbd.current) e.preventDefault(); // a hover must not steal the focus
          }}
          onCloseAutoFocus={(e) => {
            if (!kbd.current) e.preventDefault();
          }}
          onClick={(e) => e.stopPropagation()}
          onPointerLeave={(e) => {
            if (e.pointerType === 'mouse' && !pinned.current && !into(e, button.current)) setOpen(false);
          }}
          className="mat-popover anim-in relative outline-none z-[var(--z-modal-popover)] flex max-w-[280px] flex-col items-start gap-1 overflow-y-auto rounded-[var(--radius-card)] p-1.5 before:absolute before:inset-x-0 before:-top-1.5 before:h-1.5 after:absolute after:inset-x-0 after:-bottom-1.5 after:h-1.5"
          style={{ maxHeight: 'min(320px, var(--radix-popover-content-available-height))' }}
        >
          {hidden.map((l) => (
            <LabelPill key={l.id} label={l} size={size} />
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

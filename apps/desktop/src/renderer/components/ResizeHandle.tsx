import { useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { cx } from './ui';

/**
 * The draggable edge between two panes: drag, ←/→ (8 px), optional double-click reset. Zero layout
 * width: the 6 px grab area overlaps both panes, so they touch and the 1 px line is the border.
 * `edge="right"` is the right edge of the column on the left of the handle (drag right grows it);
 * `edge="left"` the left edge of a column on the right (drag left grows it).
 *
 * `onChange(w, final)` gets the clamped width: `final` is false while dragging (the owner may only
 * preview it, e.g. write the style of one element) and true on release / key / reset.
 */
export function ResizeHandle({
  edge = 'right',
  width,
  min,
  max,
  label,
  onChange,
  onReset,
  testId,
}: {
  edge?: 'left' | 'right';
  /** Current width, read on demand (the handle never subscribes, so a drag does not re-render it). */
  width: () => number;
  min: number;
  max: number | (() => number);
  label: string;
  onChange: (w: number, final: boolean) => void;
  onReset?: () => void;
  testId?: string;
}): ReactNode {
  const start = useRef<{ x: number; w: number } | null>(null);
  const last = useRef(0);
  const sign = edge === 'right' ? 1 : -1;
  const top = (): number => Math.max(min, typeof max === 'function' ? max() : max);
  const clamp = (w: number): number => Math.round(Math.max(min, Math.min(top(), w)));
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={typeof max === 'function' ? undefined : max}
      aria-valuenow={width()}
      tabIndex={0}
      onKeyDown={(e) => {
        const step = e.key === 'ArrowRight' ? 8 : e.key === 'ArrowLeft' ? -8 : 0;
        if (step) onChange(clamp(width() + sign * step), true);
      }}
      onPointerDown={(e: ReactPointerEvent<HTMLDivElement>) => {
        start.current = { x: e.clientX, w: width() };
        last.current = start.current.w;
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        const w = clamp(start.current.w + sign * (e.clientX - start.current.x));
        if (w === last.current) return;
        last.current = w;
        onChange(w, false);
      }}
      onPointerUp={() => {
        if (!start.current) return;
        start.current = null;
        onChange(last.current, true);
      }}
      onPointerCancel={() => {
        if (!start.current) return;
        const w = start.current.w;
        start.current = null;
        onChange(w, true);
      }}
      onDoubleClick={onReset}
      className={cx(
        'relative z-[var(--z-sticky)] -ml-[3px] -mr-[3px] w-[6px] shrink-0 cursor-col-resize after:absolute after:inset-y-0 after:left-[2.5px] after:w-px after:bg-line hover:after:bg-accent focus-visible:after:bg-accent',
      )}
      data-testid={testId}
    />
  );
}

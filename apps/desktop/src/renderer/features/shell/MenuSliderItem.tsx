import * as Dropdown from '../../components/radix/dropdown-menu';
import type { ReactNode } from 'react';
import { Slider } from '../../components/ui';

/**
 * A slider row inside a dropdown menu. Only menu items are allowed in a menu (axe
 * aria-required-children), so the row is one — like «Громкость» in the member menu: ↑/↓ reach it,
 * ←/→ step the value, the mouse drags the (pointer-only) slider, selecting keeps the menu open.
 */
export function MenuSliderItem({
  label,
  valueText,
  value,
  min,
  max,
  step = 1,
  onChange,
  testId,
}: {
  label: string;
  valueText: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  testId?: string;
}): ReactNode {
  return (
    <Dropdown.Item
      className="rounded-[5px] px-2 pb-2 pt-1 outline-none data-[highlighted]:bg-hover"
      aria-label={`${label}: ${valueText}`}
      data-testid={testId}
      onSelect={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        onChange(Math.min(max, Math.max(min, value + (e.key === 'ArrowRight' ? step : -step))));
      }}
    >
      <div className="mb-1 flex justify-between text-caption text-muted">
        <span>{label}</span>
        <span className="tabular-nums">{valueText}</span>
      </div>
      <Slider label={label} value={value} min={min} max={max} step={step} pointerOnly onChange={onChange} />
    </Dropdown.Item>
  );
}

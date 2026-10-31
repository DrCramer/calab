import { memo, useRef, type ReactNode } from 'react';
import { cx } from '../../../components/ui';
import { t } from '../../../i18n';
import { haptics } from '../../../lib/haptics';

/**
 * The 3×4 phone keypad (ADR-0137 §6–§7): round keys, the digit only (no Latin letters), «0» with
 * a small «+» under it — a long press (500 ms) types «+». `size`: the phone's dial screen (circles
 * clamp(60px, 9.5dvh, 78px): an iPhone SE fits without scrolling), the desktop's dial card (56), the
 * call band's tone keypad (48). Every key is a `tap` haptic, «+» an `impact`; no key sounds
 * (WebAudio on the output is forbidden, docs/02). Memo: the field's changes never re-render it.
 */

export const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'] as const;
export type KeypadSize = 'phone' | 'desktop' | 'compact';

const PLUS_MS = 500;

const KEY_SIZE: Record<KeypadSize, string> = {
  phone: 'size-[clamp(60px,9.5dvh,78px)] text-[32px] font-normal',
  desktop: 'size-14 text-[22px] font-medium',
  compact: 'size-12 text-[20px] font-medium',
};
const GRID: Record<KeypadSize, string> = {
  phone: 'gap-x-6 gap-y-[clamp(10px,2.2dvh,18px)]',
  desktop: 'gap-x-5 gap-y-3',
  compact: 'gap-x-4 gap-y-2.5',
};

export const Keypad = memo(function Keypad({ size, onKey, onPlus, testId }: { size: KeypadSize; onKey: (k: string) => void; onPlus?: () => void; testId?: string }): ReactNode {
  return (
    <div className={cx('grid w-max grid-cols-3 justify-items-center', GRID[size])} role="group" aria-label={t('telc.keypad')} data-testid={testId}>
      {KEYS.map((k) => (
        <Key key={k} k={k} size={size} onKey={onKey} {...(k === '0' && onPlus ? { onPlus } : {})} />
      ))}
    </div>
  );
});

function Key({ k, size, onKey, onPlus }: { k: string; size: KeypadSize; onKey: (k: string) => void; onPlus?: () => void }): ReactNode {
  // «0» held: «+» instead (the click that follows the release is swallowed).
  const hold = useRef<{ timer: number; fired: boolean } | null>(null);
  const cancel = (): void => {
    if (hold.current) window.clearTimeout(hold.current.timer);
  };
  return (
    <button
      type="button"
      aria-label={k === '0' && onPlus ? t('telc.key0') : k === '*' ? t('telc.keyStar') : k === '#' ? t('telc.keyHash') : k}
      className={cx(
        'relative flex select-none flex-col items-center justify-center rounded-full bg-[var(--color-fill)] leading-none tabular-nums text-fg transition-colors duration-[var(--motion-fast)] hover:bg-[var(--color-fill-hover)] active:bg-[var(--color-fill-hover)] [-webkit-touch-callout:none]',
        KEY_SIZE[size],
      )}
      onPointerDown={
        onPlus
          ? () => {
              cancel();
              const h = { fired: false, timer: 0 };
              h.timer = window.setTimeout(() => {
                h.fired = true;
                haptics.impact();
                onPlus();
              }, PLUS_MS);
              hold.current = h;
            }
          : undefined
      }
      onPointerUp={onPlus ? cancel : undefined}
      onPointerLeave={onPlus ? cancel : undefined}
      onPointerCancel={onPlus ? cancel : undefined}
      onContextMenu={onPlus ? (e) => e.preventDefault() : undefined}
      onClick={() => {
        if (hold.current?.fired) {
          hold.current = null;
          return;
        }
        hold.current = null;
        haptics.tap();
        onKey(k);
      }}
      data-key={k}
    >
      {/* «*» of the font sits high and small: one size up, lowered to the digits' middle. */}
      <span aria-hidden className={k === '*' ? 'translate-y-[0.18em] text-[1.3em]' : undefined}>
        {k}
      </span>
      {k === '0' && onPlus ? (
        <span className={cx('font-medium leading-none text-muted', size === 'phone' ? 'mt-0.5 text-[13px]' : 'text-[10px]')} aria-hidden>
          +
        </span>
      ) : null}
    </button>
  );
}

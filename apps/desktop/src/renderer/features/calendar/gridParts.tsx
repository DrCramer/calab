import { memo, type ReactNode } from 'react';
import { cx } from '../../components/ui';
import { t, useLocale } from '../../i18n';
import { dayKey, dayStart, formatMinutes, formatTime } from '../../lib/calendar/time';
import { usePageVisible } from '../../lib/pageVisible';
import { useNow } from '../shell/voiceFormat';

/*
 * The hour grid shared by the day view and «Подобрать время» (ADR-0038 §7, ADR-0041 §3): the
 * scale, the hour lines and the red «now» line — each a memo leaf.
 */

/** One hour of the grid (px): 24 h = 1152 px, like Apple Calendar's default zoom. */
export const HOUR_PX = 48;
export const PX_PER_MIN = HOUR_PX / 60;
/** The time scale left of the grid. */
export const GUTTER = 'w-[60px]';

export const HourScale = memo(function HourScale(): ReactNode {
  useLocale();
  return (
    <div className={cx(GUTTER, 'relative mt-2 shrink-0 select-none')} aria-hidden style={{ height: 24 * HOUR_PX }}>
      {Array.from({ length: 23 }, (_, i) => i + 1).map((h) => (
        <span key={h} className="absolute right-2 -translate-y-1/2 text-micro tabular-nums text-faint" style={{ top: h * HOUR_PX }}>
          {formatMinutes(h * 60)}
        </span>
      ))}
    </div>
  );
});

export const HourLines = memo(function HourLines(): ReactNode {
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden>
      {Array.from({ length: 24 }, (_, h) => (
        <div key={h} className="absolute inset-x-0 border-t border-line" style={{ top: h * HOUR_PX }} />
      ))}
      <div className="absolute inset-x-0 border-t border-line" style={{ top: 24 * HOUR_PX }} />
    </div>
  );
});

/**
 * The red «now» line (Apple): its own minute ticker — the only thing re-rendered by time; no ticker
 * while the window is hidden (docs/14), the line is placed again when it shows.
 */
export const NowLine = memo(function NowLine({ day }: { day: string }): ReactNode {
  const visible = usePageVisible();
  const now = useNow(visible ? 60_000 : 0);
  if (!visible || dayKey(now) !== day) return null;
  const min = (now - dayStart(day)) / 60_000;
  return (
    <div className="pointer-events-none absolute inset-x-0 z-[2]" style={{ top: min * PX_PER_MIN }} data-testid="now-line" aria-label={t('cal.now', { time: formatTime(now) })} role="img">
      <span className="absolute -left-[5px] -top-[5px] size-2.5 rounded-full bg-danger" />
      <div className="h-0.5 -translate-y-1/2 bg-danger" />
    </div>
  );
});

import { memo, useMemo, type ReactNode } from 'react';
import { Tip, cx } from '../../components/ui';
import { t, useLocale } from '../../i18n';
import { atMinutes, dayKey, dayStart, shortWeekday } from '../../lib/calendar/time';
import { hourLines, parseZonesSig, zoneOffsetLabel, zoneOffsetShort, zoneRows, zonesSig, zoneTime, zoneTitle } from '../../lib/calendar/zones';
import { dateTimeFormat } from '../../lib/format';
import { useMobile } from '../../lib/mobile';
import { usePageVisible } from '../../lib/pageVisible';
import { useSession } from '../../stores/session';
import { useNow } from '../shell/voiceFormat';
import { HOUR_PX, PX_PER_MIN } from './gridParts';

/*
 * Extra time zones of the hour axis (board #85, «как в Яндексе»): muted hour columns left of the
 * main scale, one per zone of Me.settings.calendar_zones, each label the zone's wall time at that
 * row of the main grid (half-hour zones read «14:30»), the zone's next / previous day marked at
 * the row it starts. Without extra zones nothing here renders (the same DOM as before). Each part
 * is a memo leaf keyed by primitives; the «now» tick rides the «now» line's shared minute ticker.
 */

/** Width of an extra column (px): desktop / phone. */
const COL_PX = 60;
const PHONE_COL_PX = 44;
/** The main scale's width (gridParts GUTTER), crossed by the axis «now» line. */
const MAIN_GUTTER_PX = 60;

/** The user's extra zones as a primitive ("" = none): re-renders only when the list changes. */
export function useZonesSig(): string {
  return useSession((s) => zonesSig(s.me?.settings?.calendarZones));
}

export function useZoneColPx(): number {
  return useMobile() ? PHONE_COL_PX : COL_PX;
}

const MUTED = 'text-faint';

/**
 * The header cells of the extra columns (the week's day row, the day view's all-day row): the
 * zone's label (or city) over its offset at `at`. `bare`: empty cells of the same width.
 */
export const ZoneHeads = memo(function ZoneHeads({ sig, at, bare = false }: { sig: string; at: number; bare?: boolean }): ReactNode {
  useLocale();
  const width = useZoneColPx();
  const mobile = width === PHONE_COL_PX;
  const zones = useMemo(() => parseZonesSig(sig), [sig]);
  if (bare) return <span className="shrink-0" style={{ width: zones.length * width }} aria-hidden />;
  return (
    <>
      {zones.map((z) => {
        const title = zoneTitle(z);
        const offset = zoneOffsetLabel(z.zone, at);
        return (
          <Tip key={z.zone} label={t('cal.tz.tip', { zone: z.zone, offset })}>
            <span
              className={cx('flex shrink-0 flex-col items-center justify-center self-stretch overflow-hidden text-center text-micro leading-3', MUTED)}
              style={{ width }}
              tabIndex={-1}
              data-testid="zone-head"
            >
              <span className="w-full truncate">{title}</span>
              <span className="w-full truncate tabular-nums">{mobile ? zoneOffsetShort(z.zone, at) : offset}</span>
            </span>
          </Tip>
        );
      })}
    </>
  );
});

/**
 * The extra hour columns of a grid showing the 24 hours of `day` (a week: its anchor day). The
 * zone's date shows where it starts and at the top when it is not the main day's; in the `week`
 * it reads «+1 д» / «−1 д» (relative to each day column) and only while it differs.
 * `nowDay`: the day whose «now» the axis line marks ("" = none in view).
 */
export const ZoneScales = memo(function ZoneScales({ sig, day, week = false, nowDay }: { sig: string; day: string; week?: boolean; nowDay: string }): ReactNode {
  const locale = useLocale();
  const width = useZoneColPx();
  const zones = useMemo(() => parseZonesSig(sig), [sig]);
  const columns = useMemo(() => {
    const lines = hourLines(day);
    return zones.map((z) => ({ zone: z.zone, rows: zoneRows(lines, z.zone, locale) }));
  }, [zones, day, locale]);
  const dateFmt = dateTimeFormat({ weekday: 'short', day: 'numeric' });
  return (
    <div className="relative mt-2 flex shrink-0 select-none" style={{ height: 24 * HOUR_PX, width: zones.length * width }} data-testid="zone-scales">
      {columns.map((c) => (
        <div key={c.zone} className="relative h-full shrink-0" style={{ width }} aria-hidden data-testid="zone-scale">
          {c.rows.map((r) => (
            <span key={r.hour} className="absolute inset-x-0 flex -translate-y-1/2 flex-col items-center leading-3" style={{ top: r.hour * HOUR_PX }}>
              <span className={cx('text-micro tabular-nums', MUTED)}>{r.time}</span>
              {r.newDay && (!week || r.shift !== 0) ? (
                <span className="mt-0.5 max-w-full truncate rounded-full bg-[var(--color-fill)] px-1 text-micro font-medium text-muted" data-testid="zone-newday">
                  {week ? t(r.shift > 0 ? 'cal.tz.nextDay' : 'cal.tz.prevDay') : shortWeekday(dateFmt.format(dayStart(r.newDay)))}
                </span>
              ) : null}
            </span>
          ))}
        </div>
      ))}
      {nowDay ? <AxisNow day={nowDay} /> : null}
    </div>
  );
});

/**
 * The «now» line across the extra columns and the main scale, up to the grid's own red line: the
 * same shared minute ticker as NowLine (no timer of its own), nothing while the window is hidden.
 */
const AxisNow = memo(function AxisNow({ day }: { day: string }): ReactNode {
  const visible = usePageVisible();
  const now = useNow(visible ? 60_000 : 0);
  if (!visible || dayKey(now) !== day) return null;
  const min = (now - dayStart(day)) / 60_000;
  return (
    <div
      className="pointer-events-none absolute left-0 z-[1] h-px -translate-y-1/2 bg-danger opacity-60"
      style={{ top: min * PX_PER_MIN, width: `calc(100% + ${MAIN_GUTTER_PX}px)` }}
      aria-hidden
      data-testid="zone-now"
    />
  );
});

/**
 * The meeting dialog: the chosen time in each extra zone under the main zone's line, «Дели
 * 18:30–19:30 · New York 09:00–10:00» (a «(+1)» / «(−1)» when the zone is on another date).
 * Nothing without extra zones.
 */
export const ZoneSpan = memo(function ZoneSpan({ day, start, end }: { day: string; start: number; end: number }): ReactNode {
  const locale = useLocale();
  const sig = useZonesSig();
  if (!sig) return null;
  const from = atMinutes(day, start).getTime();
  const to = atMinutes(day, end).getTime();
  const parts = parseZonesSig(sig).map((z) => {
    const shift = Math.sign(dayKey(from, z.zone).localeCompare(day));
    const mark = shift > 0 ? ' (+1)' : shift < 0 ? ' (−1)' : '';
    return `${zoneTitle(z)} ${zoneTime(from, z.zone, locale)}–${zoneTime(to, z.zone, locale)}${mark}`;
  });
  return (
    <p className="min-w-0 truncate text-caption tabular-nums text-faint" data-testid="event-zone-span">
      {parts.join(' · ')}
    </p>
  );
});

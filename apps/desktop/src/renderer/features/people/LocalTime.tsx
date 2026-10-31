import { Clock } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { fmt, useTimeFormat } from '../../lib/format';
import { formatWorkDays, formatWorkRange, localClock, localTimeZone, zoneDiffHint } from '../../lib/timezone';
import { getLocale, t } from '../../i18n';
import { hoursSignature, parseHoursSignature } from '../../services/freebusy';
import { entryKey, useFreeBusy } from '../../stores/freebusy';
import { useWorkspaces } from '../../stores/workspaces';
import { useNow } from '../shell/voiceFormat';
import { askHours } from './useColleagueClocks';

type Variant = 'row' | 'line' | 'menu';

/**
 * A member's local time (docs/09 #48): «UTC+3 · 14:05», and «на 2 ч впереди» in grey when their
 * offset differs from mine. Nothing when their zone is unset / unknown. `row` is a dt/dd pair for
 * the profile card's list, `line` sits under the name in the profile dialog, `menu` under the
 * member menu's title. The clock ticks on the shared 60 s ticker (one timer for all, docs/14; it
 * sleeps while the window is hidden). With a `workspaceId` the person's working hours (ADR-0041,
 * from the free/busy answer, one cached request) follow: «рабочие 10–19» (#85).
 */
export function LocalTime({ userId, variant, workspaceId }: { userId: string; variant: Variant; workspaceId?: string }): ReactNode {
  const tz = useWorkspaces((s) => s.users[userId]?.timezone ?? '');
  // The ticker is subscribed only while a zone is known (the inner component mounts).
  return tz ? <Clockline tz={tz} variant={variant} userId={userId} workspaceId={workspaceId ?? ''} /> : null;
}

/** The person's working hours as «10–19» and «Пн–Пт» (from free/busy); null until loaded. */
function useWorkHours(workspaceId: string, userId: string): { range: string; days: string } | null {
  useEffect(() => {
    if (workspaceId) askHours(workspaceId, [userId]);
  }, [workspaceId, userId]);
  const sig = useFreeBusy((s) => (workspaceId ? hoursSignature(s.entries[entryKey(workspaceId, userId)]) : ''));
  const h = parseHoursSignature(sig)?.workHours;
  if (!h || !h.days.length) return null;
  return { range: formatWorkRange(h.startMin, h.endMin), days: formatWorkDays(h.days, getLocale()) };
}

function Clockline({ tz, variant, userId, workspaceId }: { tz: string; variant: Variant; userId: string; workspaceId: string }): ReactNode {
  const work = useWorkHours(workspaceId, userId);
  const now = useNow(60_000);
  useTimeFormat();
  const c = localClock(tz, localTimeZone(), new Date(now), fmt.timeIn);
  if (!c) return null;
  const hint = zoneDiffHint(c.diff);
  const main = (
    <span className="tabular-nums">
      {c.zone} · {c.time}
    </span>
  );
  const extra = hint ? <span className="text-muted"> · {hint}</span> : null;
  if (variant === 'row') {
    return (
      <>
        <dt className="text-muted">{t('people.tz.title')}</dt>
        <dd className="min-w-0 truncate" data-testid="local-time">
          {main}
          {extra}
        </dd>
        {work ? (
          <>
            <dt className="text-muted">{t('people.tz.workTitle')}</dt>
            <dd className="min-w-0 truncate tabular-nums" data-testid="work-hours">
              {work.range}
              {work.days ? <span className="text-muted"> · {work.days}</span> : null}
            </dd>
          </>
        ) : null}
      </>
    );
  }
  if (variant === 'menu') {
    return (
      <div className="truncate px-2 pb-1 text-micro text-muted" data-testid="local-time">
        {main}
        {hint ? ` · ${hint}` : null}
      </div>
    );
  }
  return (
    <div className="mt-1 flex min-w-0 items-center gap-1.5 text-body" title={t('people.tz.title')} data-testid="local-time">
      <Clock className="size-3.5 shrink-0 text-muted" aria-label={t('people.tz.title')} role="img" />
      <span className="min-w-0 truncate">
        {main}
        {extra}
        {work ? (
          <span className="tabular-nums text-muted" data-testid="work-hours">
            {' · '}
            {t('people.tz.work', { range: work.range })}
          </span>
        ) : null}
      </span>
    </div>
  );
}

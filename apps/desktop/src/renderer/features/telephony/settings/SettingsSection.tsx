import type { SipSettings } from '@calaba/protocol';
import { ChevronRight, Settings } from 'lucide-react';
import { memo, type ReactNode } from 'react';
import { Bar } from '../../../components/Bar';
import { PlanLock } from '../../../components/PlanLock';
import { Button, Card, Row, Spinner, cx } from '../../../components/ui';
import { t, useLocale } from '../../../i18n';
import { planHas } from '../../../lib/plan';
import { useTelephonyUi } from '../../../stores/telephonyUi';
import { useWorkspaces } from '../../../stores/workspaces';
import { ROW_HOVER, ROW_SELECTED } from '../../shell/ColumnHeader';
import { ConnectionPage, useSipSettings } from './Connection';
import { Exchange, WithExchange } from './Exchange';
import { SET_PAGES, useTelSettingsUi, type SetPage, type SetPageDef } from './pages';
import { PolicyPage } from './Policy';
import { RecordingCard } from './Recording';
import { SchedulePage, useScheduleSummary } from './Schedule';
import { StateDot, usePhoneSettings } from './ui';

/*
 * The station's settings on the desktop (ADR-0137 §5–§6; MANAGE_INTEGRATIONS): the «Настройки» group
 * of the section's column (rows 36 px, «Подключение» with its state dot) and the open page in the
 * centre (≤ 720 px wide, the existing cards). Below the telephony plan every page is under PlanLock
 * — a saved account stays readable. The account is read once per section visit; «Входящие» over a
 * registration re-reads it every 15 s while the window is seen (ADR-0121).
 */

/** The connection's state for the dot and the phone's list: works, an error, or off. */
export function connectionTone(s: SipSettings | undefined): 'ok' | 'error' | 'off' {
  if (!s) return 'off';
  if (s.lastError) return 'error';
  return s.enabled && s.trunkSaved ? 'ok' : 'off';
}

export function connectionText(s: SipSettings | undefined): string {
  const tone = connectionTone(s);
  return t(tone === 'ok' ? 'sip.state.on' : tone === 'error' ? 'tset.state.error' : s?.updatedAt ? 'sip.state.off' : 'tset.state.none');
}

/** The «Настройки» group of the column. */
export function TelSettingsNav({ workspaceId, active }: { workspaceId: string; active: boolean }): ReactNode {
  useLocale();
  const page = useTelSettingsUi((s) => s.page);
  const tone = connectionTone(useSipSettings(workspaceId).data?.settings);
  return (
    <li className="mt-3" data-testid="tel-nav-settings">
      <span className="flex h-7 items-center gap-1.5 px-2 text-caption font-medium text-muted">
        <Settings className="size-3.5" strokeWidth={1.75} aria-hidden />
        {t('tset.title')}
      </span>
      <ul className="flex flex-col gap-px">
        {SET_PAGES.map((p) => (
          <SetNavRow key={p.id} def={p} active={active && p.id === page} tone={p.id === 'connection' ? tone : null} />
        ))}
      </ul>
    </li>
  );
}

const SetNavRow = memo(function SetNavRow({ def, active, tone }: { def: SetPageDef; active: boolean; tone: 'ok' | 'error' | 'off' | null }): ReactNode {
  const Icon = def.icon;
  return (
    <li>
      <button
        type="button"
        onClick={() => {
          useTelSettingsUi.getState().setPage(def.id);
          useTelephonyUi.getState().setPage('settings');
        }}
        aria-current={active ? 'page' : undefined}
        className={cx('flex h-9 w-full min-w-0 items-center gap-2 rounded-[8px] pl-2 pr-2.5 text-left text-list', active ? cx(ROW_SELECTED, 'font-medium text-fg') : cx(ROW_HOVER, 'text-fg'))}
        data-testid={`tel-nav-set-${def.id}`}
      >
        <Icon className={cx('size-[18px] shrink-0', active ? 'text-fg' : 'text-muted')} strokeWidth={1.75} aria-hidden />
        <span className="min-w-0 flex-1 truncate">{t(def.label)}</span>
        {tone ? <StateDot tone={tone} /> : null}
      </button>
    </li>
  );
});

/** The centre: the open settings page. */
export function TelSettingsPage({ workspaceId }: { workspaceId: string }): ReactNode {
  useLocale();
  const page = useTelSettingsUi((s) => s.page);
  const def = SET_PAGES.find((p) => p.id === page) ?? SET_PAGES[0];
  const q = useSipSettings(workspaceId, page === 'inbound');
  const allowed = useWorkspaces((s) => planHas(s.byId[workspaceId]?.ws.plan, 'telephony'));
  const settings = q.data?.settings;
  const body = q.isPending ? (
    <div className="grid place-items-center py-6">
      <Spinner />
    </div>
  ) : q.isError || !settings ? (
    <LoadFailed onRetry={() => void q.refetch()} />
  ) : (
    <Locked allowed={allowed}>
      <PageBody workspaceId={workspaceId} page={page} settings={settings} />
    </Locked>
  );
  return (
    <section className="flex min-w-0 flex-1 flex-col" aria-label={def ? t(def.label) : undefined} data-testid="tel-settings">
      <Bar className="px-4">
        <h2 className="min-w-0 flex-1 truncate text-headline font-semibold">{def ? t(def.label) : ''}</h2>
      </Bar>
      {/* The grouped background of System Settings: the cards stand out in the light theme too. */}
      <div className="min-h-0 flex-1 overflow-y-auto bg-[var(--color-sheet-pane)]">
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-6 px-6 pb-10 pt-5" data-testid={`tel-settings-${page}`}>
          {body}
        </div>
      </div>
    </section>
  );
}

export function Locked({ allowed, children }: { allowed: boolean; children: ReactNode }): ReactNode {
  return allowed ? (
    children
  ) : (
    <PlanLock plan="business" testId="sip-plan-lock">
      <div className="flex flex-col gap-6">{children}</div>
    </PlanLock>
  );
}

export function LoadFailed({ onRetry }: { onRetry: () => void }): ReactNode {
  return (
    <Card>
      <div className="flex items-center justify-between gap-3 px-3 py-2.5">
        <span className="text-body text-danger-text" role="alert">
          {t('sip.loadFailed')}
        </span>
        <Button variant="secondary" size="sm" onClick={onRetry}>
          {t('common.retry')}
        </Button>
      </div>
    </Card>
  );
}

/** One settings page's content (the desktop centre and a phone screen). */
export function PageBody({ workspaceId, page, settings }: { workspaceId: string; page: SetPage; settings: SipSettings }): ReactNode {
  const phone = usePhoneSettings();
  switch (page) {
    case 'connection':
      return <ConnectionPage workspaceId={workspaceId} settings={settings} />;
    case 'inbound':
      return (
        <>
          <Exchange workspaceId={workspaceId} settings={settings} part="inbound" />
          {phone ? null : <ScheduleLink workspaceId={workspaceId} settings={settings} />}
        </>
      );
    case 'schedule':
      return <WithExchange workspaceId={workspaceId}>{(lists) => <SchedulePage key={scheduleKey(settings)} workspaceId={workspaceId} settings={settings} lists={lists} />}</WithExchange>;
    case 'numbers':
    case 'groups':
    case 'ivr':
      return <Exchange workspaceId={workspaceId} settings={settings} part={page} />;
    case 'recording':
      return <RecordingCard workspaceId={workspaceId} settings={settings} />;
    case 'policy':
      return <PolicyPage key={`${settings.retentionMonths}:${settings.outPerHour}:${settings.outPerUserHour}`} workspaceId={workspaceId} settings={settings} />;
  }
}

/** The saved schedule (not the notice): a save from elsewhere re-mounts the form on it. */
const scheduleKey = (s: SipSettings): string => {
  const x = s.schedule;
  return x ? `${x.enabled}|${x.timeZone}|${x.productionCalendarRu}|${x.offHours?.kind ?? ''}:${x.offHours?.id ?? ''}|${x.hours.map((h) => `${h.weekday}.${h.startMin}.${h.endMin}`).join(',')}` : '';
};

/** Desktop «Входящие»: the working hours in one line with a way to them (the phone's list has its own row). */
function ScheduleLink({ workspaceId, settings }: { workspaceId: string; settings: SipSettings }): ReactNode {
  return (
    <WithExchange workspaceId={workspaceId}>
      {(lists) => (
        <Card>
          <ScheduleLinkRow settings={settings} lists={lists} />
        </Card>
      )}
    </WithExchange>
  );
}

function ScheduleLinkRow({ settings, lists }: { settings: SipSettings; lists: Parameters<typeof useScheduleSummary>[1] }): ReactNode {
  const summary = useScheduleSummary(settings.schedule, lists);
  return (
    <Row label={t('tset.page.schedule')} hint={summary}>
      <Button variant="secondary" size="sm" onClick={() => useTelSettingsUi.getState().setPage('schedule')} data-testid="tset-schedule-open">
        {t('tset.sched.open')}
        <ChevronRight className="size-3.5" aria-hidden />
      </Button>
    </Row>
  );
}

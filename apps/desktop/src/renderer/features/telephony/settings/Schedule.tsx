import { create, type MessageInitShape } from '@bufbuild/protobuf';
import { GetSipSettingsResponseSchema, type SipSchedule, type SipScheduleSchema, type SipSettings } from '@calaba/protocol';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CopyCheck, Plus, X } from 'lucide-react';
import { useId, useMemo, useState, type ReactNode } from 'react';
import { Button, Card, IconButton, Input, Row, Select, Switch, cx } from '../../../components/ui';
import { t, useLocale, type MessageKey } from '../../../i18n';
import { ApiError } from '../../../lib/api/client';
import { describeError } from '../../../lib/api/errors';
import { api } from '../../../lib/api/endpoints';
import { targetInit, targetValue } from '../../../lib/sipPbx';
import { reportPlanError } from '../../../services/plan';
import { toast } from '../../../stores/toasts';
import { formatDuration } from '../../shell/voiceFormat';
import { sipSettingsKey } from './Connection';
import { PromptPicker, PromptPlayer, type ExchangeLists } from './Exchange';
import { clearPromptError, SCHEDULE_NOTICE, uploadScheduleNotice, usePromptUpload } from './promptUpload';
import { MAX_PER_DAY, WEEKDAYS, crossesMidnight, endOf, hoursProblem, parseTime, timeValue, weekSummary, type Hours } from './hours';
import { MissingNote, TargetField, useTargetLabel } from './Targets';
import { ErrLine, FormShell, usePhoneSettings } from './ui';

/*
 * «Телефония → Настройки → Рабочие часы» (ADR-0138; MANAGE_INTEGRATIONS, PUT …/sip/schedule): the
 * working hours of the entry point — the time zone, per weekday up to six intervals (one may run
 * past midnight: 22:00–02:00), «по производственному календарю РФ», and where an off-hours call
 * goes (a menu, a person or a bot number, a group, or hang up) after the optional notice. The form
 * replaces the schedule as a whole; the notice uploads at once over the saved schedule (like a
 * menu's greeting). The server's interval rules are checked before a save (schedule.ts).
 */

/** The weekday names, Monday first: short (the summary, the phone) and full (the desktop rows). */
const DAY_SHORT: readonly MessageKey[] = ['tset.wd.1', 'tset.wd.2', 'tset.wd.3', 'tset.wd.4', 'tset.wd.5', 'tset.wd.6', 'tset.wd.7'];
const DAY_LONG: readonly MessageKey[] = ['tset.wdl.1', 'tset.wdl.2', 'tset.wdl.3', 'tset.wdl.4', 'tset.wdl.5', 'tset.wdl.6', 'tset.wdl.7'];

export const DEFAULT_TZ = 'Europe/Moscow';

/** The zones offered first: Russia west to east, then the neighbours the teams work with. */
const ZONES = [
  'Europe/Kaliningrad',
  'Europe/Moscow',
  'Europe/Samara',
  'Asia/Yekaterinburg',
  'Asia/Omsk',
  'Asia/Novosibirsk',
  'Asia/Krasnoyarsk',
  'Asia/Irkutsk',
  'Asia/Yakutsk',
  'Asia/Vladivostok',
  'Asia/Magadan',
  'Asia/Kamchatka',
  'Europe/Minsk',
  'Asia/Almaty',
  'Asia/Tashkent',
  'Asia/Tbilisi',
  'Asia/Yerevan',
  'Asia/Baku',
  'Asia/Dubai',
  'Europe/Istanbul',
  'Europe/Berlin',
  'Europe/London',
  'UTC',
];

/** «(UTC+3) Москва, стандартное время» in the UI's language. */
function zoneLabel(zone: string, locale: string): string {
  try {
    const part = (style: 'shortOffset' | 'longGeneric', loc: string): string =>
      new Intl.DateTimeFormat(loc, { timeZone: zone, timeZoneName: style }).formatToParts(new Date()).find((x) => x.type === 'timeZoneName')?.value ?? '';
    const offset = part('shortOffset', 'en').replace('GMT', 'UTC');
    const name = zone === 'UTC' ? 'UTC' : part('longGeneric', locale) || zone;
    return `(${offset === 'UTC' ? 'UTC+0' : offset}) ${name}`;
  } catch {
    return zone;
  }
}

/** The summary of a saved schedule: «Пн–Пт 9:00–18:00 · РФ календарь → Гром», or «Выключено». */
export function useScheduleSummary(s: SipSchedule | undefined, lists: ExchangeLists | null): string {
  useLocale();
  const target = useTargetLabel(targetValue(s?.offHours) || 'hangup', lists ?? { exts: [], groups: [], menus: [] });
  if (!s?.enabled) return t('tset.sched.off');
  const week = weekSummary(hoursOf(s), DAY_SHORT.map((k) => t(k)));
  return [week || t('tset.sched.noHours'), s.productionCalendarRu ? t('tset.sched.ruShort') : ''].filter(Boolean).join(' · ') + ` → ${target}`;
}

const hoursOf = (s: SipSchedule | undefined): Hours[] => (s?.hours ?? []).map((h) => ({ weekday: h.weekday, start: h.startMin, end: h.endMin }));

/** The saved schedule as a request (the notice's own PUT keeps everything else as it is). */
export function scheduleInit(s: SipSchedule | undefined): MessageInitShape<typeof SipScheduleSchema> {
  return {
    enabled: s?.enabled ?? false,
    timeZone: s?.timeZone || DEFAULT_TZ,
    hours: (s?.hours ?? []).map((h) => ({ weekday: h.weekday, startMin: h.startMin, endMin: h.endMin })),
    productionCalendarRu: s?.productionCalendarRu ?? false,
    offHours: targetInit(targetValue(s?.offHours) === 'missing' ? 'hangup' : targetValue(s?.offHours) || 'hangup'),
  };
}

/** A row of the form: the field values as typed («09:00»), a key that survives removals. */
interface Draft {
  key: number;
  weekday: number;
  from: string;
  to: string;
}

const NEW_INTERVAL = { from: '09:00', to: '18:00' };

/** Row keys: unique for the session (a removed row's key is never reused while the form lives). */
let lastKey = 0;
const nextKey = (): number => ++lastKey;

export function SchedulePage({ workspaceId, settings, lists }: { workspaceId: string; settings: SipSettings; lists: ExchangeLists }): ReactNode {
  const locale = useLocale();
  const phone = usePhoneSettings();
  const qc = useQueryClient();
  const id = useId();
  const s = settings.schedule;
  const [enabled, setEnabled] = useState(s?.enabled ?? false);
  const [zone, setZone] = useState(s?.timeZone || DEFAULT_TZ);
  const [ru, setRu] = useState(s?.productionCalendarRu ?? false);
  const [target, setTarget] = useState(targetValue(s?.offHours) || 'hangup');
  const [rows, setRows] = useState<Draft[]>(() =>
    hoursOf(s)
      .sort((a, b) => a.weekday - b.weekday || a.start - b.start)
      .map((h) => ({ key: nextKey(), weekday: h.weekday, from: timeValue(h.start), to: timeValue(h.end) })),
  );
  const [serverErr, setServerErr] = useState<{ field: string; text: string } | null>(null);
  const [formErr, setFormErr] = useState<string | null>(null);
  const saved = !!settings.updatedAt;
  const zones = useMemo(() => {
    const list = [...ZONES];
    for (const z of [zone, Intl.DateTimeFormat().resolvedOptions().timeZone]) if (z && !list.includes(z)) list.unshift(z);
    return list.map((z) => ({ value: z, label: zoneLabel(z, locale) }));
  }, [zone, locale]);

  // The typed values → the request's intervals; an empty field is a problem of its day.
  const parsed = rows.map((r) => ({ r, start: parseTime(r.from), end: parseTime(r.to) }));
  const blank = parsed.find((p) => p.start === null || p.end === null)?.r.weekday ?? 0;
  const hours: Hours[] = parsed.filter((p) => p.start !== null && p.end !== null).map((p) => ({ weekday: p.r.weekday, start: p.start as number, end: endOf(p.end as number) }));
  const problem = blank ? { weekday: blank, kind: 'blank' as const } : hoursProblem(hours);
  const none = enabled && rows.length === 0;

  const save = useMutation({
    mutationFn: () =>
      api.sip.saveSchedule(workspaceId, {
        schedule: {
          enabled,
          timeZone: zone,
          hours: hours.map((h) => ({ weekday: h.weekday, startMin: h.start, endMin: h.end })),
          productionCalendarRu: ru,
          offHours: targetInit(target === 'missing' ? 'hangup' : target),
        },
      }),
    onSuccess: (r) => {
      setServerErr(null);
      setFormErr(null);
      if (r.settings) qc.setQueryData(sipSettingsKey(workspaceId), create(GetSipSettingsResponseSchema, { settings: r.settings }));
      toast.success(t('pbx.saved'));
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'ERROR_CODE_VALIDATION' && e.field) {
        const key: MessageKey | undefined = e.field === 'timeZone' ? 'tset.sched.err.zone' : e.field === 'hours' ? 'tset.sched.err.hours' : e.field === 'offHours' ? 'pbx.err.target' : undefined;
        setServerErr({ field: e.field, text: key ? t(key) : describeError(e).text });
        return;
      }
      if (reportPlanError(e, workspaceId)) return;
      setFormErr(e instanceof ApiError && e.code === 'ERROR_CODE_CONFLICT' ? t('pbx.rec.notSaved') : describeError(e).text);
    },
  });
  const touched = (): void => {
    setServerErr(null);
    setFormErr(null);
  };
  const setDay = (weekday: number, next: (cur: Draft[]) => Draft[]): void => {
    touched();
    setRows((all) => [...all.filter((r) => r.weekday !== weekday), ...next(all.filter((r) => r.weekday === weekday))].sort((a, b) => a.weekday - b.weekday));
  };
  const add = (weekday: number): void =>
    setDay(weekday, (cur) => {
      const last = cur.at(-1);
      // A second interval starts an hour after the first one ends (a lunch break reads naturally).
      const from = last ? (parseTime(last.to) ?? 0) + 60 : null;
      const next = from !== null && from < 1440 - 60 ? { from: timeValue(from), to: timeValue(Math.min(from + 180, 1439)) } : NEW_INTERVAL;
      return [...cur, { key: nextKey(), weekday, ...next }];
    });
  // «Как в понедельник» on Tuesday–Friday (the usual working week in one tap).
  const copyMonday = (): void => {
    touched();
    setRows((all) => {
      const mon = all.filter((r) => r.weekday === 1);
      const rest = all.filter((r) => r.weekday === 1 || r.weekday > 5);
      return [...rest, ...[2, 3, 4, 5].flatMap((weekday) => mon.map((r) => ({ key: nextKey(), weekday, from: r.from, to: r.to })))].sort((a, b) => a.weekday - b.weekday);
    });
  };
  const problemText = (weekday: number): string | null => {
    if (!problem || problem.weekday !== weekday) return null;
    return t(problem.kind === 'blank' ? 'tset.sched.err.blank' : problem.kind === 'overlap' ? 'tset.sched.err.overlap' : problem.kind === 'tooMany' ? 'tset.sched.err.tooMany' : 'tset.sched.err.range');
  };
  const summary = useScheduleSummary(s, lists);
  return (
    <FormShell
      testId="tset-schedule"
      className="gap-6"
      onSubmit={() => save.mutate()}
      error={formErr ?? (saved ? (none ? t('tset.sched.err.none') : null) : t('pbx.rec.notSaved'))}
      errorTestId="tset-schedule-error"
      saveBusy={save.isPending}
      saveDisabled={!saved || !!problem || none}
      saveTestId="tset-schedule-save"
    >
      <p className="px-1 text-body text-muted" data-testid="tset-schedule-summary">
        <span className="text-fg">{t('tset.sched.now')}</span> {summary}
      </p>
      <Card footer={t('tset.sched.footer')}>
        <div className="px-3 py-1.5" data-testid="tset-schedule-enabled">
          <Switch
            checked={enabled}
            onChange={(v) => {
              setEnabled(v);
              touched();
            }}
            label={t('tset.sched.enabled')}
            hint={t('tset.sched.enabledHint')}
          />
        </div>
        <Row label={t('tset.sched.zone')} htmlFor={`${id}-zone`}>
          <span className="flex min-w-0 flex-col items-end gap-1 mobile:w-full mobile:items-stretch">
            <Select
              id={`${id}-zone`}
              value={zone}
              onChange={(e) => {
                setZone(e.target.value);
                touched();
              }}
              className="w-72 mobile:w-full"
              data-testid="tset-schedule-zone"
            >
              {zones.map((z) => (
                <option key={z.value} value={z.value}>
                  {z.label}
                </option>
              ))}
            </Select>
            <ErrLine text={serverErr?.field === 'timeZone' ? serverErr.text : null} />
          </span>
        </Row>
        <div className="px-3 py-1.5" data-testid="tset-schedule-ru">
          <Switch
            checked={ru}
            onChange={(v) => {
              setRu(v);
              touched();
            }}
            label={t('tset.sched.ru')}
            hint={t('tset.sched.ruHint')}
          />
        </div>
      </Card>

      <section className="flex flex-col gap-1.5" data-testid="tset-schedule-week">
        <div className="flex items-center justify-between gap-2 px-1">
          <h3 className="text-caption font-semibold text-muted">{t('tset.sched.hours')}</h3>
          <Button variant="ghost" size="sm" onClick={copyMonday} disabled={!rows.some((r) => r.weekday === 1)} data-testid="tset-schedule-copy">
            <CopyCheck className="size-3.5" aria-hidden />
            {t('tset.sched.copyMonday')}
          </Button>
        </div>
        <div className="divide-y divide-[var(--color-card-line)] overflow-hidden rounded-[var(--radius-card)] bg-[var(--color-card)]">
          {WEEKDAYS.map((wd) => (
            <DayRow
              key={wd}
              weekday={wd}
              rows={rows.filter((r) => r.weekday === wd)}
              phone={phone}
              error={problemText(wd)}
              onChange={(key, patch) => setDay(wd, (cur) => cur.map((r) => (r.key === key ? { ...r, ...patch } : r)))}
              onRemove={(key) => setDay(wd, (cur) => cur.filter((r) => r.key !== key))}
              onAdd={() => add(wd)}
            />
          ))}
        </div>
        <ErrLine text={serverErr?.field === 'hours' ? serverErr.text : null} testId="tset-schedule-hours-error" />
        <p className="px-1 text-caption text-faint">{t('tset.sched.hoursHint')}</p>
      </section>

      <Card title={t('tset.sched.offTitle')} footer={t('tset.sched.offFooter')}>
        <Row label={t('tset.sched.offTarget')}>
          <span className="flex min-w-0 flex-col items-end gap-1 mobile:w-full mobile:items-stretch">
            <TargetField
              value={target}
              onChange={(v) => {
                setTarget(v);
                touched();
              }}
              {...lists}
              label={t('tset.sched.offTarget')}
              className="w-64"
              testId="tset-schedule-target"
            />
            {target === 'missing' ? <MissingNote target={s?.offHours} /> : null}
            <ErrLine text={serverErr?.field === 'offHours' ? serverErr.text : null} />
          </span>
        </Row>
        <NoticeRow workspaceId={workspaceId} settings={settings} />
      </Card>
    </FormShell>
  );
}

/** A weekday: its intervals (two time fields and ×), «+ интервал»; none — «Выходной». */
function DayRow({
  weekday,
  rows,
  phone,
  error,
  onChange,
  onRemove,
  onAdd,
}: {
  weekday: number;
  rows: Draft[];
  phone: boolean;
  error: string | null;
  onChange: (key: number, patch: Partial<Draft>) => void;
  onRemove: (key: number) => void;
  onAdd: () => void;
}): ReactNode {
  const day = t(DAY_LONG[weekday - 1] as MessageKey);
  const next = t(DAY_SHORT[weekday % 7] as MessageKey);
  return (
    <div className={cx('flex gap-3 px-3 py-2', phone ? 'flex-col' : 'items-start')} data-testid={`tset-day-${weekday}`}>
      <span className={cx('shrink-0 text-body', phone ? 'font-medium' : 'w-28 pt-1')}>{day}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {rows.length === 0 ? <span className={cx('text-body text-muted', !phone && 'pt-1')}>{t('tset.sched.dayOff')}</span> : null}
        {rows.map((r) => {
          const start = parseTime(r.from);
          const end = parseTime(r.to);
          const night = start !== null && end !== null && crossesMidnight({ weekday, start, end: endOf(end) });
          return (
            <div key={r.key} className="flex min-w-0 flex-wrap items-center gap-2" data-testid="tset-interval">
              <Input
                type="time"
                aria-label={t('tset.sched.from', { day })}
                value={r.from}
                onChange={(e) => onChange(r.key, { from: e.target.value })}
                className="w-28! tabular-nums mobile:flex-1"
                data-testid="tset-interval-from"
              />
              <span className="text-muted" aria-hidden>
                –
              </span>
              <Input
                type="time"
                aria-label={t('tset.sched.to', { day })}
                value={r.to}
                onChange={(e) => onChange(r.key, { to: e.target.value })}
                className="w-28! tabular-nums mobile:flex-1"
                data-testid="tset-interval-to"
              />
              <IconButton label={t('tset.sched.remove')} onClick={() => onRemove(r.key)} className="mobile:size-11">
                <X className="size-3.5" aria-hidden />
              </IconButton>
              {night ? (
                <span className="basis-full text-caption text-muted" data-testid="tset-interval-night">
                  {t('tset.sched.nextDay', { day: next })}
                </span>
              ) : null}
            </div>
          );
        })}
        {error ? (
          <span className="text-caption text-danger-text" role="alert" data-testid="tset-day-error">
            {error}
          </span>
        ) : null}
        {rows.length < MAX_PER_DAY ? (
          <button type="button" onClick={onAdd} className="flex min-h-7 items-center gap-1 self-start text-body font-medium text-accent-text hover:underline mobile:min-h-11" data-testid="tset-interval-add">
            <Plus className="size-3.5" aria-hidden />
            {t('tset.sched.add')}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** The off-hours notice: ▶, its length, «Загрузить» / «Заменить», «Удалить» — saved at once over the saved schedule. */
function NoticeRow({ workspaceId, settings }: { workspaceId: string; settings: SipSettings }): ReactNode {
  const qc = useQueryClient();
  const phone = usePhoneSettings();
  const s = settings.schedule;
  const busy = usePromptUpload((x) => x.menuId === SCHEDULE_NOTICE);
  const pct = usePromptUpload((x) => (x.menuId === SCHEDULE_NOTICE ? x.pct : null));
  const err = usePromptUpload((x) => (x.errMenu === SCHEDULE_NOTICE ? x.err : ''));
  const ready = !!s?.noticeFileId;
  const put = (r: SipSettings): void => void qc.setQueryData(sipSettingsKey(workspaceId), create(GetSipSettingsResponseSchema, { settings: r }));
  const clear = useMutation({
    mutationFn: () => api.sip.saveSchedule(workspaceId, { schedule: scheduleInit(s), noticeSourceFileId: '' }),
    onMutate: () => clearPromptError(SCHEDULE_NOTICE),
    onSuccess: (r) => {
      if (r.settings) put(r.settings);
    },
    onError: (e) => {
      if (!reportPlanError(e, workspaceId)) usePromptUpload.setState({ errMenu: SCHEDULE_NOTICE, err: describeError(e).text });
    },
  });
  const status = busy ? (pct !== null ? t('pbx.menu.uploading', { pct }) : t('pbx.menu.processing')) : ready ? formatDuration(s.noticeDurationMs) : t('pbx.menu.noNotice');
  return (
    <div className="flex flex-col gap-1 px-3 py-2" data-testid="tset-schedule-notice" data-settings-row>
      <span className="text-body" data-settings-label>
        {t('tset.sched.notice')}
      </span>
      <div className="flex flex-wrap items-center gap-2">
        {ready ? <PromptPlayer fileId={s.noticeFileId} testId="tset-schedule-notice-listen" /> : null}
        <span className={cx('min-w-0 max-w-full truncate text-body', ready && !busy ? 'tabular-nums' : 'text-muted')}>{status}</span>
        <PromptPicker
          label={t(ready ? 'pbx.menu.replace' : 'pbx.menu.noticeUpload')}
          busy={busy}
          onFile={(f) => void uploadScheduleNotice(workspaceId, f, scheduleInit(s), put)}
          testId="tset-schedule-notice-upload"
          inputTestId="tset-schedule-notice-file"
        />
        {ready ? (
          <Button variant={phone ? 'secondary' : 'ghost'} size="sm" busy={clear.isPending} onClick={() => clear.mutate()} data-testid="tset-schedule-notice-remove">
            {t('tset.sched.noticeRemove')}
          </Button>
        ) : null}
      </div>
      <span className="text-caption text-faint">{t('tset.sched.noticeHint')}</span>
      <ErrLine text={err || null} testId="tset-schedule-notice-error" />
    </div>
  );
}

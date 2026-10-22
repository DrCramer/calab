import { create, type MessageInitShape } from '@bufbuild/protobuf';
import { timestampDate, timestampMs } from '@bufbuild/protobuf/wkt';
import {
  GetSipSettingsResponseSchema,
  SipCallStatus,
  SipInboundMode,
  SipTransport,
  type PutSipSettingsRequestSchema,
  type SipCall,
  type SipSettings,
  type TestSipResponse,
} from '@calaba/protocol';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { TriangleAlert, X } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { PlanLock } from '../../components/PlanLock';
import { Button, Card, Input, PasswordInput, Row, Select, Spinner, Switch, cx } from '../../components/ui';
import { t, type MessageKey } from '../../i18n';
import { ApiError } from '../../lib/api/client';
import { describeError } from '../../lib/api/errors';
import { api } from '../../lib/api/endpoints';
import { fmt } from '../../lib/format';
import { planHas } from '../../lib/plan';
import { callDurationMs, formatPhone, isLiveStatus, normalizePrefix, reasonCode, reasonKey, statusKey } from '../../lib/sip';
import { useRooms } from '../../stores/rooms';
import { toast } from '../../stores/toasts';
import { memberName, useWorkspaces } from '../../stores/workspaces';
import { formatDuration } from '../shell/voiceFormat';
import { Exchange } from './TelephonyExchange';

/*
 * Workspace settings → «Телефония» (ADR-0046, docs/08 «Телефония»; MANAGE_WORKSPACE): the SIP
 * provider account as one form saved with PUT (the password is write-only: empty keeps the stored
 * one), «Проверить подключение» (a real short call to the Caller ID), the last provider error and
 * the call journal (100 per page, «Показать ещё» by cursor). A primitive screen by the owner's
 * word (30.09); the exchange (internal numbers, groups, voice menus — ADR-0117) is in
 * TelephonyExchange. Business plan only (owner, 02.10): below it the
 * form and the test are locked (PlanLock) — a saved trunk stays readable, the journal stays open.
 */

/** SipSettings.port when never set (sip.proto: PUT 0 = 5060). */
export const DEFAULT_SIP_PORT = 5060;

const settingsKey = (workspaceId: string): readonly unknown[] => ['sip', workspaceId];
const journalKey = (workspaceId: string): readonly unknown[] => ['sipJournal', workspaceId];

const TRANSPORTS: ReadonlyArray<{ value: SipTransport; label: string }> = [
  { value: SipTransport.UDP, label: 'UDP' },
  { value: SipTransport.TCP, label: 'TCP' },
  { value: SipTransport.TLS, label: 'TLS' },
];

/** 422 VALIDATION `field` → its text (docs/09 #16: no raw server strings). */
const FIELD_ERROR: Record<string, MessageKey> = {
  host: 'sip.err.field.host',
  port: 'sip.err.field.port',
  callerId: 'sip.err.field.callerId',
  username: 'sip.err.field.username',
  authUsername: 'sip.err.field.authUsername',
  password: 'sip.err.field.password',
  outboundPrefix: 'sip.err.field.outboundPrefix',
  allowedPrefixes: 'sip.err.field.allowedPrefixes',
  provider: 'sip.err.field.provider',
  transport: 'sip.err.field.transport',
};

export function TelephonyTab({ workspaceId }: { workspaceId: string }): ReactNode {
  // REGISTER mode (ADR-0121): the registration's state is re-read every 15 s while the window is
  // visible (react-query pauses intervals in the background); no gateway event for it.
  const q = useQuery({
    queryKey: settingsKey(workspaceId),
    queryFn: () => api.sip.settings(workspaceId),
    refetchInterval: (query) => (query.state.data?.settings?.inboundMode === SipInboundMode.REGISTER && query.state.data.settings.inboundEnabled ? 15_000 : false),
  });
  const settings = q.data?.settings;
  const allowed = useWorkspaces((s) => planHas(s.byId[workspaceId]?.ws.plan, 'telephony'));
  const setup = settings ? (
    <>
      {/* Re-mounted when the server's copy changes: the form starts from what is saved. */}
      <SettingsForm key={settings.updatedAt ? String(timestampMs(settings.updatedAt)) : 'new'} workspaceId={workspaceId} settings={settings} />
      <TestCard workspaceId={workspaceId} settings={settings} />
      <Exchange workspaceId={workspaceId} settings={settings} />
    </>
  ) : null;
  return (
    <>
      <p className="px-1 text-body text-muted">{t('sip.intro')}</p>
      {q.isPending ? (
        <div className="grid place-items-center py-6">
          <Spinner />
        </div>
      ) : q.isError || !settings ? (
        <Card>
          <div className="flex items-center justify-between gap-3 px-3 py-2.5">
            <span className="text-body text-danger-text" role="alert">
              {t('sip.loadFailed')}
            </span>
            <Button variant="secondary" size="sm" onClick={() => void q.refetch()}>
              {t('common.retry')}
            </Button>
          </div>
        </Card>
      ) : (
        <>
          {settings.lastError ? <LastError text={settings.lastError} /> : null}
          {allowed ? (
            setup
          ) : (
            <PlanLock plan="business" testId="sip-plan-lock">
              <div className="flex flex-col gap-6">{setup}</div>
            </PlanLock>
          )}
          <Journal workspaceId={workspaceId} />
        </>
      )}
    </>
  );
}

function LastError({ text }: { text: string }): ReactNode {
  return (
    <div
      role="alert"
      data-testid="sip-last-error"
      className="flex items-start gap-2 rounded-[var(--radius-card)] bg-[color-mix(in_srgb,var(--color-danger)_12%,transparent)] px-3 py-2.5"
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
      <p className="min-w-0 text-body text-fg">
        <span className="font-semibold">{t('sip.lastError')}:</span> <span className="selectable break-words">{text}</span>
      </p>
    </div>
  );
}

function StatePill({ settings }: { settings: SipSettings }): ReactNode {
  const on = settings.enabled && settings.trunkSaved;
  const key: MessageKey = on ? 'sip.state.on' : settings.enabled ? 'sip.state.notSaved' : 'sip.state.off';
  return (
    <span
      data-testid="sip-state"
      className={cx('inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full px-2 text-caption font-semibold', on ? 'bg-ok-fill text-white' : 'bg-[var(--color-fill-hover)] text-fg')}
    >
      <span aria-hidden className={cx('size-1.5 rounded-full', on ? 'bg-white' : 'bg-muted')} />
      {t(key)}
    </span>
  );
}

interface Draft {
  enabled: boolean;
  provider: string;
  host: string;
  port: string;
  transport: SipTransport;
  username: string;
  authUsername: string;
  /** '' = keep the stored password. */
  password: string;
  callerId: string;
  outboundPrefix: string;
  allowed: string[];
}

function draftOf(s: SipSettings): Draft {
  return {
    enabled: s.enabled,
    provider: s.provider,
    host: s.host,
    port: s.port && s.port !== DEFAULT_SIP_PORT ? String(s.port) : '',
    transport: s.transport === SipTransport.UNSPECIFIED ? SipTransport.UDP : s.transport,
    username: s.username,
    authUsername: s.authUsername,
    password: '',
    callerId: s.callerId,
    outboundPrefix: s.outboundPrefix,
    allowed: [...s.allowedPrefixes],
  };
}

function requestOf(d: Draft): MessageInitShape<typeof PutSipSettingsRequestSchema> {
  const port = Number.parseInt(d.port, 10);
  return {
    enabled: d.enabled,
    provider: d.provider.trim(),
    host: d.host.trim(),
    transport: d.transport,
    username: d.username.trim(),
    callerId: d.callerId.trim(),
    outboundPrefix: d.outboundPrefix.trim(),
    allowedPrefixes: d.allowed,
    // Write-only: an empty field keeps the stored password (the field is left out of the PUT).
    ...(d.password ? { password: d.password } : {}),
    authUsername: d.authUsername.trim(),
    // Empty = 0 = 5060 (the server's default).
    port: Number.isFinite(port) && port > 0 ? port : 0,
  };
}

function SettingsForm({ workspaceId, settings }: { workspaceId: string; settings: SipSettings }): ReactNode {
  const qc = useQueryClient();
  const [d, setD] = useState<Draft>(() => draftOf(settings));
  const [fieldErr, setFieldErr] = useState<Record<string, string>>({});
  const [formErr, setFormErr] = useState<string | null>(null);
  const id = useId();
  const set = <K extends keyof Draft>(k: K, v: Draft[K]): void => {
    setD((cur) => ({ ...cur, [k]: v }));
    if (fieldErr[k]) setFieldErr(({ [k]: _gone, ...rest }) => rest);
    if (formErr) setFormErr(null);
  };
  const save = useMutation({
    mutationFn: () => api.sip.save(workspaceId, requestOf(d)),
    onSuccess: (r) => {
      setFieldErr({});
      setFormErr(null);
      if (r.settings) qc.setQueryData(settingsKey(workspaceId), create(GetSipSettingsResponseSchema, { settings: r.settings }));
      toast.success(t('sip.saved'));
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'ERROR_CODE_VALIDATION' && e.field) {
        const key = FIELD_ERROR[e.field];
        setFieldErr({ [e.field === 'allowedPrefixes' ? 'allowed' : e.field]: key ? t(key) : describeError(e).text });
        return;
      }
      if (e instanceof ApiError && e.code === 'ERROR_CODE_SIP_PROVIDER_ERROR') {
        setFormErr(t('sip.err.providerSave', { message: e.message }));
        // Nothing but last_error changed on the server: show it.
        void qc.invalidateQueries({ queryKey: settingsKey(workspaceId) });
        return;
      }
      setFormErr(describeError(e).text);
    },
  });
  const f = (name: string): string => `${id}-${name}`;
  const err = (k: string): ReactNode =>
    fieldErr[k] ? (
      <span className="text-caption text-danger-text" role="alert" data-testid={`sip-err-${k}`}>
        {fieldErr[k]}
      </span>
    ) : null;
  const box = 'flex w-64 flex-col gap-1 mobile:w-full';
  return (
    <form
      className="flex flex-col gap-4"
      data-testid="sip-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!save.isPending) save.mutate();
      }}
    >
      <Card title={t('sip.card.provider')}>
        <div className="px-3 py-1">
          <Switch checked={d.enabled} onChange={(v) => set('enabled', v)} label={t('sip.enabled')} hint={t('sip.enabledHint')} />
        </div>
        <Row label={t('sip.state')}>
          <StatePill settings={settings} />
        </Row>
        <Row label={t('sip.provider')} htmlFor={f('provider')}>
          <span className={box}>
            <Input id={f('provider')} value={d.provider} maxLength={64} placeholder={t('sip.providerPlaceholder')} onChange={(e) => set('provider', e.target.value)} />
            {err('provider')}
          </span>
        </Row>
        <Row label={t('sip.host')} hint={t('sip.hostHint')} htmlFor={f('host')}>
          <span className={box}>
            <span className="flex gap-2">
              <Input
                id={f('host')}
                data-testid="sip-host"
                value={d.host}
                placeholder="sip.example.com"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={fieldErr['host'] ? true : undefined}
                onChange={(e) => set('host', e.target.value)}
              />
              <Input
                id={f('port')}
                aria-label={t('sip.port')}
                title={t('sip.port')}
                data-testid="sip-port"
                value={d.port}
                inputMode="numeric"
                placeholder={String(DEFAULT_SIP_PORT)}
                className="w-20! shrink-0 tabular-nums"
                aria-invalid={fieldErr['port'] ? true : undefined}
                onChange={(e) => set('port', e.target.value.replace(/\D/g, '').slice(0, 5))}
              />
            </span>
            {err('host')}
            {err('port')}
          </span>
        </Row>
        <Row label={t('sip.transport')} htmlFor={f('transport')}>
          <span className={box}>
            <Select id={f('transport')} value={String(d.transport)} onChange={(e) => set('transport', Number(e.target.value))}>
              {TRANSPORTS.map((o) => (
                <option key={o.value} value={String(o.value)}>
                  {o.label}
                </option>
              ))}
            </Select>
            {err('transport')}
          </span>
        </Row>
        <Row label={t('sip.username')} htmlFor={f('username')}>
          <span className={box}>
            <Input id={f('username')} value={d.username} autoComplete="off" spellCheck={false} onChange={(e) => set('username', e.target.value)} />
            {err('username')}
          </span>
        </Row>
        <Row label={t('sip.authUsername')} hint={t('sip.authUsernameHint')} htmlFor={f('auth')}>
          <span className={box}>
            <Input id={f('auth')} data-testid="sip-auth-username" value={d.authUsername} autoComplete="off" spellCheck={false} onChange={(e) => set('authUsername', e.target.value)} />
            {err('authUsername')}
          </span>
        </Row>
        <Row label={t('sip.password')} hint={settings.hasPassword ? t('sip.passwordHint') : undefined} htmlFor={f('password')}>
          <span className={box}>
            <PasswordInput
              id={f('password')}
              data-testid="sip-password"
              value={d.password}
              maxLength={256}
              autoComplete="new-password"
              placeholder={settings.hasPassword ? t('sip.passwordSaved') : ''}
              onChange={(e) => set('password', e.target.value)}
            />
            {err('password')}
          </span>
        </Row>
      </Card>
      <Card title={t('sip.card.calls')}>
        <Row label={t('sip.callerId')} hint={t('sip.callerIdHint')} htmlFor={f('caller')}>
          <span className={box}>
            <Input
              id={f('caller')}
              data-testid="sip-caller-id"
              type="tel"
              inputMode="tel"
              value={d.callerId}
              placeholder="+74951234567"
              className="tabular-nums"
              aria-invalid={fieldErr['callerId'] ? true : undefined}
              onChange={(e) => set('callerId', e.target.value)}
            />
            {err('callerId')}
          </span>
        </Row>
        <Row label={t('sip.prefix')} hint={t('sip.prefixHint')} htmlFor={f('prefix')}>
          <span className={box}>
            <Input
              id={f('prefix')}
              value={d.outboundPrefix}
              inputMode="tel"
              maxLength={9}
              className="w-24 tabular-nums"
              onChange={(e) => set('outboundPrefix', e.target.value.replace(/[^\d+]/g, ''))}
            />
            {err('outboundPrefix')}
          </span>
        </Row>
        <AllowedPrefixes value={d.allowed} onChange={(v) => set('allowed', v)} error={fieldErr['allowed'] ?? null} />
      </Card>
      <div className="flex flex-wrap items-center justify-end gap-3">
        {formErr ? (
          <span className="mr-auto min-w-0 text-caption text-danger-text" role="alert" data-testid="sip-form-error">
            {formErr}
          </span>
        ) : null}
        <Button type="submit" busy={save.isPending} data-testid="sip-save">
          {t('sip.save')}
        </Button>
      </div>
    </form>
  );
}

/** «Разрешённые направления»: prefix chips (+7, +7495…) and a field that adds one on Enter. */
function AllowedPrefixes({ value, onChange, error }: { value: string[]; onChange: (v: string[]) => void; error: string | null }): ReactNode {
  const [text, setText] = useState('');
  const [bad, setBad] = useState(false);
  const id = useId();
  const add = (): void => {
    if (!text.trim()) return;
    const p = normalizePrefix(text);
    if (!p) {
      setBad(true);
      return;
    }
    if (!value.includes(p)) onChange([...value, p]);
    setText('');
  };
  return (
    <div className="flex flex-col gap-2 px-3 py-2" data-settings-row>
      <div className="flex flex-col">
        <label htmlFor={id} className="text-body" data-settings-label>
          {t('sip.allowed')}
        </label>
        <span className="text-caption text-faint">{t('sip.allowedHint')}</span>
      </div>
      {value.length ? (
        <ul className="flex flex-wrap gap-1.5" data-testid="sip-allowed">
          {value.map((p) => (
            <li key={p} className="inline-flex h-7 items-center gap-1 rounded-full border border-line bg-elev pl-2.5 pr-1 text-body tabular-nums">
              {p}
              <button
                type="button"
                aria-label={t('sip.allowedRemove', { prefix: p })}
                className="grid size-5 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg"
                onClick={() => onChange(value.filter((x) => x !== p))}
              >
                <X className="size-3" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex items-center gap-2">
        <Input
          id={id}
          data-testid="sip-allowed-input"
          value={text}
          inputMode="tel"
          placeholder="+7"
          className="w-28 tabular-nums"
          aria-invalid={bad ? true : undefined}
          onChange={(e) => {
            setText(e.target.value);
            setBad(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              add();
            }
          }}
        />
        <Button variant="secondary" size="sm" onClick={add} disabled={!text.trim()}>
          {t('sip.allowedAdd')}
        </Button>
      </div>
      {bad ? (
        <span className="text-caption text-danger-text" role="alert">
          {t('sip.allowedInvalid')}
        </span>
      ) : error ? (
        <span className="text-caption text-danger-text" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

/** «Проверить подключение»: a real call to the Caller ID (≤ 5 s talk, up to ~25 s in total). */
function TestCard({ workspaceId, settings }: { workspaceId: string; settings: SipSettings }): ReactNode {
  const qc = useQueryClient();
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const ready = settings.enabled && settings.trunkSaved;
  const test = useMutation({
    mutationFn: () => api.sip.test(workspaceId),
    onMutate: () => setResult(null),
    onSuccess: (r: TestSipResponse) => {
      setResult({ ok: r.ok, text: t(r.ok ? 'sip.testOk' : 'sip.testFail', { message: r.message || (r.sipStatus ? String(r.sipStatus) : '—') }) });
    },
    onError: (e) => {
      const code = e instanceof ApiError ? e.code : '';
      const text = code === 'ERROR_CODE_SIP_RATE_LIMITED' ? t('sip.testRate') : code === 'ERROR_CODE_SIP_DISABLED' ? t('sip.err.disabled') : describeError(e).text;
      setResult({ ok: false, text });
    },
    onSettled: () => {
      // last_error is set / cleared by the test; the journal has a new row.
      void qc.invalidateQueries({ queryKey: settingsKey(workspaceId) });
      void qc.invalidateQueries({ queryKey: journalKey(workspaceId) });
    },
  });
  return (
    <Card footer={ready ? t('sip.testHint') : t('sip.testNeedsSave')}>
      <div className="flex flex-wrap items-center gap-3 px-3 py-2.5">
        <Button variant="secondary" busy={test.isPending} disabled={!ready} onClick={() => test.mutate()} data-testid="sip-test">
          {t('sip.test')}
        </Button>
        {result ? (
          <span className={cx('min-w-0 flex-1 text-body', result.ok ? 'text-[var(--color-green-text)]' : 'text-danger-text')} role="status" data-testid="sip-test-result">
            {result.text}
          </span>
        ) : null}
      </div>
    </Card>
  );
}

/** The call journal: newest first, 100 a page, «Показать ещё» by `next_cursor`. */
function Journal({ workspaceId }: { workspaceId: string }): ReactNode {
  const q = useInfiniteQuery({
    queryKey: journalKey(workspaceId),
    queryFn: ({ pageParam, signal }) => api.sip.journal(workspaceId, pageParam || undefined, signal),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor || undefined,
  });
  const calls = q.data?.pages.flatMap((p) => p.calls) ?? [];
  return (
    <section className="flex flex-col gap-1.5" data-settings-row>
      <h3 className="px-1 text-caption font-semibold text-muted" data-settings-label>
        {t('sip.journal')}
      </h3>
      {q.isPending ? (
        <div className="grid place-items-center py-4">
          <Spinner />
        </div>
      ) : q.isError ? (
        <p className="px-1 text-body text-danger-text" role="alert">
          {t('sip.journal.loadFailed')}
        </p>
      ) : calls.length === 0 ? (
        <p className="rounded-[var(--radius-card)] bg-[var(--color-card)] px-3 py-4 text-center text-body text-muted" data-testid="sip-journal-empty">
          {t('sip.journal.empty')}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-[var(--radius-card)] bg-[var(--color-card)]">
          <table className="w-full min-w-[560px] text-body" data-testid="sip-journal">
            <caption className="sr-only">{t('sip.journal')}</caption>
            <thead>
              <tr className="border-b border-[var(--color-card-line)] text-left text-caption text-muted">
                <th scope="col" className="px-2 py-2 font-medium">
                  {t('sip.journal.when')}
                </th>
                <th scope="col" className="px-2 py-2 font-medium">
                  {t('sip.journal.room')}
                </th>
                <th scope="col" className="px-2 py-2 font-medium">
                  {t('sip.journal.number')}
                </th>
                <th scope="col" className="px-2 py-2 font-medium">
                  {t('sip.journal.who')}
                </th>
                <th scope="col" className="min-w-36 px-2 py-2 font-medium">
                  {t('sip.journal.status')}
                </th>
                <th scope="col" className="px-2 py-2 text-right font-medium">
                  {t('sip.journal.duration')}
                </th>
              </tr>
            </thead>
            <tbody>
              {calls.map((c) => (
                <JournalRow key={c.id} workspaceId={workspaceId} call={c} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {q.hasNextPage ? (
        <Button variant="secondary" size="sm" className="self-center" busy={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()} data-testid="sip-journal-more">
          {t('sip.journal.more')}
        </Button>
      ) : null}
    </section>
  );
}

function JournalRow({ workspaceId, call }: { workspaceId: string; call: SipCall }): ReactNode {
  const roomName = useRooms((s) => (call.roomId ? (s.byId[call.roomId]?.name ?? '') : ''));
  // Names re-read when the members change (a rare event; the table is not a live list).
  const who = useWorkspaces(() => (call.startedBy ? memberName(workspaceId, call.startedBy) : '—'));
  const started = call.startedAt ? timestampDate(call.startedAt) : null;
  const duration = callDurationMs({
    answeredAt: call.answeredAt ? timestampMs(call.answeredAt) : 0,
    endedAt: call.endedAt ? timestampMs(call.endedAt) : 0,
  });
  const status = journalStatus(call);
  return (
    <tr className="border-b border-[var(--color-card-line)] last:border-b-0" data-testid="sip-journal-row">
      <td className="px-2 py-2 min-w-[5.5rem] max-sm:whitespace-nowrap tabular-nums text-muted">{started ? fmt.dateTime(started, 'short') : '—'}</td>
      <td className="px-2 py-2">
        <span className="block max-w-20 truncate" title={roomName || undefined}>
          {call.roomId ? roomName || '—' : <span className="text-muted">{t('sip.journal.test')}</span>}
        </span>
      </td>
      <td className="whitespace-nowrap px-2 py-2 tabular-nums">{formatPhone(call.number)}</td>
      <td className="px-2 py-2">
        <span className="block max-w-20 truncate" title={who}>
          {who}
        </span>
      </td>
      <td className="min-w-36 px-2 py-2">
        <span className="line-clamp-2 max-w-72 first-letter:uppercase" title={status}>
          {status}
        </span>
      </td>
      <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-muted">{duration ? formatDuration(duration) : '—'}</td>
    </tr>
  );
}

/** The journal's «Итог»: live — its status; ended after an answer — «Разговор · reason»; else why. */
function journalStatus(c: SipCall): string {
  if (isLiveStatus(c.status)) return c.status === SipCallStatus.ACTIVE ? t('sip.journal.live') : t(statusKey(c.status));
  const code = reasonCode(c.reason);
  const reason = `${t(reasonKey(c.status, c.reason))}${code ? ` ${code}` : ''}`;
  return c.status === SipCallStatus.ENDED && c.answeredAt ? `${t('sip.journal.answered')} · ${reason}` : reason;
}

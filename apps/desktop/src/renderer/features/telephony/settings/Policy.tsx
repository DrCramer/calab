import { create } from '@bufbuild/protobuf';
import { GetSipSettingsResponseSchema, type SipSettings } from '@calaba/protocol';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { Card, Input, Row, cx } from '../../../components/ui';
import { t, type MessageKey } from '../../../i18n';
import { ApiError } from '../../../lib/api/client';
import { describeError } from '../../../lib/api/errors';
import { api } from '../../../lib/api/endpoints';
import { haptics } from '../../../lib/haptics';
import { reportPlanError } from '../../../services/plan';
import { toast } from '../../../stores/toasts';
import { sipSettingsKey } from './Connection';
import { ErrLine, FormShell } from './ui';

/*
 * «Телефония → Настройки → Хранение и лимиты» (ADR-0137 «Решения владельца» 1–2, PUT …/sip/policy;
 * MANAGE_INTEGRATIONS): how long the journal (and the contacts with outside numbers) are kept —
 * 1, 3, 6 months, 1, 2, 3 years, a year by default, no «forever» — and the outbound limits per hour
 * for the workspace and for one member (120 / 30 by default). One form, one save.
 */

export const RETENTION_MONTHS = [1, 3, 6, 12, 24, 36] as const;
export const DEFAULT_RETENTION: (typeof RETENTION_MONTHS)[number] = 12;
export const DEFAULT_OUT_PER_HOUR = 120;
export const DEFAULT_OUT_PER_USER_HOUR = 30;

const RETENTION_LABEL: Record<(typeof RETENTION_MONTHS)[number], MessageKey> = {
  1: 'tset.ret.1',
  3: 'tset.ret.3',
  6: 'tset.ret.6',
  12: 'tset.ret.12',
  24: 'tset.ret.24',
  36: 'tset.ret.36',
};

/** «1 год» of a stored value (0 = the default year). */
export function retentionLabel(months: number): string {
  const m = RETENTION_MONTHS.find((x) => x === months) ?? DEFAULT_RETENTION;
  return t(RETENTION_LABEL[m]);
}

const FIELD: Record<string, MessageKey> = {
  retentionMonths: 'tset.err.retention',
  outPerHour: 'tset.err.limit',
  outPerUserHour: 'tset.err.limit',
};

const limitOf = (s: string): number => Number.parseInt(s, 10) || 0;
const limitOk = (s: string): boolean => {
  const n = limitOf(s);
  return n >= 1 && n <= 1000;
};

export function PolicyPage({ workspaceId, settings }: { workspaceId: string; settings: SipSettings }): ReactNode {
  const qc = useQueryClient();
  const id = useId();
  const [months, setMonths] = useState<number>(settings.retentionMonths || DEFAULT_RETENTION);
  const [perHour, setPerHour] = useState(String(settings.outPerHour || DEFAULT_OUT_PER_HOUR));
  const [perUser, setPerUser] = useState(String(settings.outPerUserHour || DEFAULT_OUT_PER_USER_HOUR));
  const [fieldErr, setFieldErr] = useState<Record<string, string>>({});
  const [formErr, setFormErr] = useState<string | null>(null);
  const saved = !!settings.updatedAt;
  const save = useMutation({
    mutationFn: () => api.sip.savePolicy(workspaceId, { retentionMonths: months, outPerHour: limitOf(perHour), outPerUserHour: limitOf(perUser) }),
    onSuccess: (r) => {
      setFieldErr({});
      setFormErr(null);
      if (r.settings) qc.setQueryData(sipSettingsKey(workspaceId), create(GetSipSettingsResponseSchema, { settings: r.settings }));
      toast.success(t('pbx.saved'));
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'ERROR_CODE_VALIDATION' && e.field && FIELD[e.field]) {
        setFieldErr({ [e.field]: t(FIELD[e.field] as MessageKey) });
        return;
      }
      if (reportPlanError(e, workspaceId)) return;
      setFormErr(e instanceof ApiError && e.code === 'ERROR_CODE_CONFLICT' ? t('pbx.rec.notSaved') : describeError(e).text);
    },
  });
  const clear = (k: string): void => {
    if (fieldErr[k]) setFieldErr(({ [k]: _gone, ...rest }) => rest);
    setFormErr(null);
  };
  const badLimits = !limitOk(perHour) || !limitOk(perUser);
  return (
    <FormShell
      testId="tset-policy"
      className="gap-6"
      onSubmit={() => save.mutate()}
      error={formErr ?? (saved ? null : t('pbx.rec.notSaved'))}
      errorTestId="tset-policy-error"
      saveBusy={save.isPending}
      saveDisabled={!saved || badLimits}
      saveTestId="tset-policy-save"
    >
      <Card title={t('tset.ret.title')} footer={t('tset.ret.footer')}>
        <div role="radiogroup" aria-label={t('tset.ret.title')} data-testid="tset-retention">
          {RETENTION_MONTHS.map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={months === m}
              onClick={() => {
                if (months !== m) haptics.select();
                setMonths(m);
                clear('retentionMonths');
              }}
              className="flex min-h-9 w-full items-center gap-2 border-b border-[var(--color-card-line)] px-3 text-left text-body last:border-b-0 hover:bg-hover mobile:min-h-11 mobile:text-list"
            >
              <span className="min-w-0 flex-1">{t(RETENTION_LABEL[m])}</span>
              {months === m ? <Check className="size-4 shrink-0 text-accent-text" aria-hidden /> : null}
            </button>
          ))}
        </div>
      </Card>
      <ErrLine text={fieldErr['retentionMonths']} />
      <Card title={t('tset.limits.title')} footer={t('tset.limits.footer')}>
        <Row label={t('tset.limits.workspace')} htmlFor={`${id}-ws`}>
          <LimitInput id={`${id}-ws`} value={perHour} onChange={(v) => {
              setPerHour(v);
              clear('outPerHour');
            }} error={fieldErr['outPerHour'] ?? (limitOk(perHour) ? null : t('tset.err.limit'))} testId="tset-limit-workspace" />
        </Row>
        <Row label={t('tset.limits.member')} htmlFor={`${id}-member`}>
          <LimitInput id={`${id}-member`} value={perUser} onChange={(v) => {
              setPerUser(v);
              clear('outPerUserHour');
            }} error={fieldErr['outPerUserHour'] ?? (limitOk(perUser) ? null : t('tset.err.limit'))} testId="tset-limit-member" />
        </Row>
      </Card>
    </FormShell>
  );
}

function LimitInput({ id, value, onChange, error, testId }: { id: string; value: string; onChange: (v: string) => void; error: string | null; testId: string }): ReactNode {
  return (
    <span className="flex min-w-0 flex-col items-end gap-1">
      <span className="flex items-center gap-2 text-body">
        <Input
          id={id}
          value={value}
          inputMode="numeric"
          className={cx('w-20! tabular-nums')}
          aria-invalid={error ? true : undefined}
          onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 4))}
          data-testid={testId}
        />
        <span className="text-muted">{t('tset.limits.perHour')}</span>
      </span>
      <ErrLine text={error} />
    </span>
  );
}

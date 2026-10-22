import { create } from '@bufbuild/protobuf';
import { GetGptunnelIntegrationResponseSchema, type GptunnelIntegration } from '@calaba/protocol';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { confirmAction } from '../../components/Confirm';
import { Button, Card, Input, Row, Spinner, cx } from '../../components/ui';
import { t } from '../../i18n';
import { describeError } from '../../lib/api/errors';
import { api } from '../../lib/api/endpoints';
import { fmt } from '../../lib/format';
import { formatPairCode, pairCodeComplete, pairErrorKey } from '../../lib/recording';
import { platform } from '../../platform';
import { toast } from '../../stores/toasts';
import { useMemberName } from '../../stores/workspaces';
import { AiCard } from './AiCard';

/**
 * The product site when the server has not told us the account's web address yet (not paired):
 * where the pairing code is. The server's GPTUNNEL_API_URL decides the real one after pairing.
 */
const GPTUNNEL_SITE = 'https://gptunnel.ru';

const queryKey = (workspaceId: string): readonly unknown[] => ['gptunnel', workspaceId];

/**
 * Workspace settings → «AI интеграция» (CBF-60): on top the AI model (AiCard: provider tabs, key,
 * model, check — MANAGE_INTEGRATIONS), below the GPTunneL connection (ADR-0025, docs/08 «Запись
 * встреч») that meeting recordings are uploaded with. Not connected: the pairing code field (ABCD-EFGH mask) and where to
 * get the code; connected: device, account, who / when, «Открыть в GPTunneL», «Отключить». Only
 * MANAGE_INTEGRATIONS (ADR-0048) changes it (`canManage`); the other members see the status (guests: no tab).
 */
export function GptunnelTab({ workspaceId, canManage }: { workspaceId: string; canManage: boolean }): ReactNode {
  const q = useQuery({ queryKey: queryKey(workspaceId), queryFn: () => api.recording.integration(workspaceId) });
  const it = q.data?.integration;
  return (
    <>
      <p className="px-1 text-body text-muted">{t('ai.intro')}</p>
      {canManage ? <AiCard workspaceId={workspaceId} /> : <p className="px-1 text-caption text-faint">{t('ai.memberHint')}</p>}
      <p className="mt-3 px-1 text-body text-muted">{t('gpt.intro')}</p>
      {q.isPending ? (
        <div className="grid place-items-center py-6">
          <Spinner />
        </div>
      ) : q.isError ? (
        <Card>
          <div className="flex items-center justify-between gap-3 px-3 py-2.5">
            <span className="text-body text-danger-text" role="alert">
              {t('gpt.loadFailed')}
            </span>
            <Button variant="secondary" size="sm" onClick={() => void q.refetch()}>
              {t('common.retry')}
            </Button>
          </div>
        </Card>
      ) : it?.paired ? (
        <Connected workspaceId={workspaceId} it={it} canManage={canManage} />
      ) : canManage ? (
        <PairForm workspaceId={workspaceId} />
      ) : (
        <Card title={t('gpt.card')} footer={t('gpt.memberOff')}>
          <Row label={t('gpt.status')}>
            <StatusPill on={false} />
          </Row>
        </Card>
      )}
    </>
  );
}

function StatusPill({ on }: { on: boolean }): ReactNode {
  return (
    <span
      data-testid="gptunnel-status"
      className={cx(
        'inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full px-2 text-caption font-semibold',
        on ? 'bg-ok-fill text-white' : 'bg-[var(--color-fill-hover)] text-fg',
      )}
    >
      <span aria-hidden className={cx('size-1.5 rounded-full', on ? 'bg-white' : 'bg-muted')} />
      {on ? t('gpt.connected') : t('gpt.notConnected')}
    </span>
  );
}

function openSite(url: string): void {
  void platform.app.openExternal(url || GPTUNNEL_SITE);
}

function PairForm({ workspaceId }: { workspaceId: string }): ReactNode {
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const pair = useMutation({
    mutationFn: () => api.recording.pair(workspaceId, code),
    onSuccess: (r) => {
      qc.setQueryData(queryKey(workspaceId), create(GetGptunnelIntegrationResponseSchema, r.integration ? { integration: r.integration } : {}));
      setCode('');
      setError(null);
      toast.success(t('gpt.connected'));
    },
    onError: (e) => {
      const key = pairErrorKey(e);
      setError(key ? t(key) : describeError(e).text);
    },
  });
  const ready = pairCodeComplete(code) && !pair.isPending;
  const hintId = 'gptunnel-code-hint';
  return (
    <Card title={t('gpt.card')}>
      <Row label={t('gpt.status')}>
        <StatusPill on={false} />
      </Row>
      <form
        className="flex flex-col gap-1.5 px-3 py-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) pair.mutate();
        }}
      >
        <label htmlFor="gptunnel-code" className="text-body" data-settings-label>
          {t('gpt.code')}
        </label>
        <div className="flex items-center gap-2">
          <Input
            id="gptunnel-code"
            data-testid="gptunnel-code"
            value={code}
            placeholder="ABCD-EFGH"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            inputMode="text"
            aria-describedby={hintId}
            aria-invalid={error ? true : undefined}
            className="w-40 font-mono tracking-[0.12em] uppercase"
            onChange={(e) => {
              setCode(formatPairCode(e.target.value));
              if (error) setError(null);
            }}
          />
          <Button type="submit" busy={pair.isPending} disabled={!ready}>
            {t('gpt.connect')}
          </Button>
        </div>
        {error ? (
          <span className="text-caption text-danger-text" role="alert" data-testid="gptunnel-error">
            {error}
          </span>
        ) : null}
        <span id={hintId} className="text-caption text-faint">
          {t('gpt.codeHint')}{' '}
          <button type="button" className="inline-flex items-center gap-0.5 text-accent-text hover:underline" onClick={() => openSite('')}>
            {t('gpt.site')}
            <ExternalLink className="size-3" aria-hidden />
          </button>
        </span>
      </form>
    </Card>
  );
}

function Connected({ workspaceId, it, canManage }: { workspaceId: string; it: GptunnelIntegration; canManage: boolean }): ReactNode {
  const qc = useQueryClient();
  const by = useMemberName(workspaceId, it.pairedBy);
  const at = it.pairedAt ? fmt.date(timestampDate(it.pairedAt)) : '';
  const unpair = useMutation({
    mutationFn: () => api.recording.unpair(workspaceId),
    onSuccess: () => qc.setQueryData(queryKey(workspaceId), create(GetGptunnelIntegrationResponseSchema, { integration: { paired: false } })),
    onError: (e) => toast.fail(e),
  });
  const disconnect = (): void =>
    void confirmAction(t('gpt.disconnectTitle'), t('gpt.disconnectText'), t('gpt.disconnect')).then((ok) => ok && unpair.mutate());
  return (
    <Card title={t('gpt.card')} footer={canManage ? undefined : t('gpt.memberHint')}>
      <Row label={t('gpt.status')}>
        <StatusPill on />
      </Row>
      {it.deviceName ? (
        <Row label={t('gpt.device')}>
          <span className="max-w-72 truncate text-body text-muted" title={it.deviceName}>
            {it.deviceName}
          </span>
        </Row>
      ) : null}
      {it.account ? (
        <Row label={t('gpt.account')}>
          <span className="max-w-72 truncate text-body text-muted" title={it.account}>
            {it.account}
          </span>
        </Row>
      ) : null}
      <Row label={t('gpt.pairedBy')}>
        <span className="text-body text-muted">{[it.pairedBy ? by : '', at].filter(Boolean).join(' · ')}</span>
      </Row>
      <div className="flex flex-wrap items-center justify-end gap-2 px-3 py-2.5">
        <Button variant="secondary" onClick={() => openSite(it.webUrl)}>
          {t('gpt.open')}
          <ExternalLink className="size-3.5" aria-hidden />
        </Button>
        {canManage ? (
          <Button variant="destructive" busy={unpair.isPending} onClick={disconnect}>
            {t('gpt.disconnect')}
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

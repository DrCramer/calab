import { create } from '@bufbuild/protobuf';
import { AiProvider, GetAiSettingsResponseSchema, type AiSettings, type CheckAiResponse } from '@calaba/protocol';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type ReactNode } from 'react';
import { Button, Card, Input, PasswordInput, Row, Segmented, Spinner, cx } from '../../components/ui';
import { t } from '../../i18n';
import { ApiError } from '../../lib/api/client';
import { describeError } from '../../lib/api/errors';
import { api } from '../../lib/api/endpoints';
import { aiStatusKey, checkSeconds, draftError, draftOf, fieldErrorKey, keyApplies, reasonKey, requestOf, tabOf, type AiDraft, type AiTab } from '../../lib/ai';
import { fmt } from '../../lib/format';
import { toast } from '../../stores/toasts';

const aiKey = (workspaceId: string): readonly unknown[] => ['ai', workspaceId];

/**
 * Workspace settings → «AI интеграция» → the model (CBF-60, ai.proto): provider tabs «GPTunneL» /
 * «OpenAI compatible», API key (write-only: the saved one shows as a mask), model (gpt-6-astra by
 * default), «Проверить» (the server sends «hi» to the model of the form, even unsaved) and
 * «Сохранить». MANAGE_INTEGRATIONS only (the host renders it for `canManage`).
 */
export function AiCard({ workspaceId }: { workspaceId: string }): ReactNode {
  const q = useQuery({ queryKey: aiKey(workspaceId), queryFn: () => api.ai.settings(workspaceId) });
  if (q.isPending) {
    return (
      <div className="grid place-items-center py-6">
        <Spinner />
      </div>
    );
  }
  if (q.isError) {
    return (
      <Card>
        <div className="flex items-center justify-between gap-3 px-3 py-2.5">
          <span className="text-body text-danger-text" role="alert">
            {t('ai.loadFailed')}
          </span>
          <Button variant="secondary" size="sm" onClick={() => void q.refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      </Card>
    );
  }
  const s = q.data.settings;
  // Re-mounted when the saved copy changes: the form starts from what is saved.
  return <AiForm key={s?.updatedAt ? `${String(s.updatedAt.seconds)}-${String(s.updatedAt.nanos)}` : 'new'} workspaceId={workspaceId} settings={s} />;
}

type Field = 'baseUrl' | 'apiKey' | 'model';

function AiForm({ workspaceId, settings }: { workspaceId: string; settings: AiSettings | undefined }): ReactNode {
  const qc = useQueryClient();
  const id = useId();
  const [tab, setTab] = useState<AiTab>(() => tabOf(settings?.provider ?? AiProvider.UNSPECIFIED));
  // One draft per tab: switching tabs keeps what was typed in each.
  const [drafts, setDrafts] = useState<Record<AiTab, AiDraft>>(() => ({ gptunnel: draftOf(settings, 'gptunnel'), openai: draftOf(settings, 'openai') }));
  const [fieldErr, setFieldErr] = useState<{ field: Field; text: string } | null>(null);
  const [result, setResult] = useState<{ ok: boolean; lines: string[] } | null>(null);
  const d = drafts[tab];
  const set = (k: keyof AiDraft, v: string): void => {
    setDrafts((cur) => ({ ...cur, [tab]: { ...cur[tab], [k]: v } }));
    if (fieldErr) setFieldErr(null);
    if (result) setResult(null);
  };
  const switchTab = (v: AiTab): void => {
    setTab(v);
    setFieldErr(null);
    setResult(null);
  };
  const local = (needKey: boolean): boolean => {
    const e = draftError(d, settings, tab, needKey);
    if (e) setFieldErr({ field: e.field, text: t(e.key) });
    return !e;
  };
  const serverField = (e: unknown): boolean => {
    if (e instanceof ApiError && e.code === 'ERROR_CODE_VALIDATION' && e.field) {
      const key = fieldErrorKey(e.field, settings, d.key.trim() !== '');
      if (e.field === 'baseUrl' || e.field === 'apiKey' || e.field === 'model') {
        setFieldErr({ field: e.field, text: key ? t(key) : describeError(e).text });
        return true;
      }
    }
    return false;
  };
  const save = useMutation({
    mutationFn: () => api.ai.save(workspaceId, requestOf(d, tab)),
    onSuccess: (r) => {
      if (r.settings) qc.setQueryData(aiKey(workspaceId), create(GetAiSettingsResponseSchema, { settings: r.settings }));
      void qc.invalidateQueries({ queryKey: aiStatusKey(workspaceId) });
      toast.success(t('ai.saved'));
    },
    onError: (e) => {
      if (!serverField(e)) toast.fail(e);
    },
  });
  const check = useMutation({
    mutationFn: () => api.ai.check(workspaceId, requestOf(d, tab)),
    onMutate: () => setResult(null),
    onSuccess: (r: CheckAiResponse) => {
      setResult(resultOf(r));
      void qc.invalidateQueries({ queryKey: aiStatusKey(workspaceId) });
    },
    onError: (e) => {
      if (serverField(e)) return;
      const rate = e instanceof ApiError && e.code === 'ERROR_CODE_RATE_LIMITED';
      setResult({ ok: false, lines: [rate ? t('ai.checkRate') : describeError(e).text] });
    },
  });
  const f = (name: string): string => `${id}-${name}`;
  const err = (k: Field): ReactNode =>
    fieldErr?.field === k ? (
      <span className="text-caption text-danger-text" role="alert" data-testid={`ai-err-${k}`}>
        {fieldErr.text}
      </span>
    ) : null;
  const invalid = (k: Field): true | undefined => (fieldErr?.field === k ? true : undefined);
  const saved = keyApplies(settings, tab, d.baseUrl);
  const active = settings?.provider !== undefined && settings.provider !== AiProvider.UNSPECIFIED && tabOf(settings.provider) === tab;
  const box = 'flex w-64 flex-col gap-1 mobile:w-full';
  return (
    <form
      className="flex flex-col gap-3"
      data-testid="ai-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!save.isPending && local(false)) save.mutate();
      }}
    >
      <div className="self-start px-1">
        <Segmented<AiTab>
          value={tab}
          onChange={switchTab}
          label={t('ai.providers')}
          testId="ai-provider"
          options={[
            { value: 'gptunnel', label: t('ai.provider.gptunnel') },
            { value: 'openai', label: t('ai.provider.openai') },
          ]}
        />
      </div>
      <Card title={t('ai.card')} footer={t('ai.checkHint')}>
        <Row label={t('ai.status')}>
          <span
            data-testid="ai-status"
            className={cx(
              'inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full px-2 text-caption font-semibold',
              active ? 'bg-ok-fill text-white' : 'bg-[var(--color-fill-hover)] text-fg',
            )}
          >
            <span aria-hidden className={cx('size-1.5 rounded-full', active ? 'bg-white' : 'bg-muted')} />
            {active ? t('ai.active') : t('ai.inactive')}
          </span>
        </Row>
        {tab === 'openai' ? (
          <Row label={t('ai.baseUrl')} hint={t('ai.baseUrlHint')} htmlFor={f('url')}>
            <span className={box}>
              <Input
                id={f('url')}
                data-testid="ai-base-url"
                value={d.baseUrl}
                inputMode="url"
                maxLength={500}
                autoComplete="off"
                spellCheck={false}
                placeholder="https://api.openai.com/v1"
                aria-invalid={invalid('baseUrl')}
                onChange={(e) => set('baseUrl', e.target.value)}
              />
              {err('baseUrl')}
            </span>
          </Row>
        ) : null}
        <Row label={t('ai.key')} hint={saved ? t('ai.keyKeep') : tab === 'gptunnel' ? t('ai.keyGptunnel') : undefined} htmlFor={f('key')}>
          <span className={box}>
            <PasswordInput
              id={f('key')}
              data-testid="ai-key"
              value={d.key}
              maxLength={512}
              autoComplete="new-password"
              spellCheck={false}
              placeholder={saved ? t('ai.keySaved', { mask: settings?.keyMask ?? '' }) : ''}
              aria-invalid={invalid('apiKey')}
              onChange={(e) => set('key', e.target.value)}
            />
            {err('apiKey')}
          </span>
        </Row>
        <Row label={t('ai.model')} hint={tab === 'gptunnel' ? t('ai.modelHint') : undefined} htmlFor={f('model')}>
          <span className={box}>
            <Input
              id={f('model')}
              data-testid="ai-model"
              value={d.model}
              maxLength={128}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={invalid('model')}
              onChange={(e) => set('model', e.target.value)}
            />
            {err('model')}
          </span>
        </Row>
        <div className="flex flex-wrap items-center gap-3 px-3 py-2.5">
          <Button variant="secondary" busy={check.isPending} data-testid="ai-check" onClick={() => local(true) && check.mutate()}>
            {t('ai.check')}
          </Button>
          <span className="min-w-0 flex-1" role="status" data-testid="ai-check-result">
            {result
              ? result.lines.map((line, i) => (
                  <span key={i} className={cx('block text-body', i > 0 ? 'text-caption text-muted' : result.ok ? 'text-[var(--color-green-text)]' : 'text-danger-text')}>
                    {line}
                  </span>
                ))
              : null}
          </span>
          <Button type="submit" busy={save.isPending} data-testid="ai-save">
            {t('ai.save')}
          </Button>
        </div>
      </Card>
    </form>
  );
}

function resultOf(r: CheckAiResponse): { ok: boolean; lines: string[] } {
  const sec = fmt.number(checkSeconds(r), { maximumFractionDigits: 1 });
  if (r.ok) return { ok: true, lines: [t('ai.checkOk', { sec }), ...(r.reply ? [t('ai.checkReply', { reply: r.reply })] : [])] };
  const lines = [t('ai.checkFail', { reason: t(reasonKey(r.error)) })];
  if (r.httpStatus || r.message) lines.push(t('ai.checkDetail', { status: r.httpStatus || '—', message: r.message || '—' }));
  return { ok: false, lines };
}

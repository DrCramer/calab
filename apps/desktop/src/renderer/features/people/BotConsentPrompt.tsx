import { useQuery, useQueryClient } from '@tanstack/react-query';
import { memo, useState, type ReactNode } from 'react';
import { Button } from '../../components/ui';
import { t } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { useMemberName } from '../../stores/workspaces';
import { BotDelegationDialog, delegationsKey } from './BotDelegationDialog';

/*
 * CBF-41: «Бот хочет действовать от вашего имени: разрешить?» inside a card the bot made.
 * «Разрешить» is the same server action as in «Делегировать права» (PUT …/delegations/{me}); the
 * server records only the member's own click and checks everything. The prompt disappears once
 * the member has allowed it; «Подробнее» opens the delegation dialog.
 */
export const BotConsentPrompt = memo(function BotConsentPrompt({ workspaceId, botUserId }: { workspaceId: string; botUserId: string }): ReactNode {
  const me = useSession((s) => s.me?.user?.id ?? '');
  const bot = useMemberName(workspaceId, botUserId);
  const qc = useQueryClient();
  const state = useQuery({
    queryKey: delegationsKey(workspaceId, botUserId),
    queryFn: ({ signal }) => api.bots.delegations(workspaceId, botUserId, signal),
    staleTime: 60_000,
  });
  const [busy, setBusy] = useState(false);
  const [details, setDetails] = useState(false);
  const data = state.data;
  // Until the state is known (or when the server refuses to show it) nothing is offered.
  if (!data || me === '' || data.delegations.some((d) => d.userId === me)) return null;
  const allow = (): void => {
    setBusy(true);
    api.bots.grantDelegation(workspaceId, botUserId, me).then(
      (r) => {
        qc.setQueryData(delegationsKey(workspaceId, botUserId), r);
        toast.success(t('bots.delegate.granted'));
      },
      (e: unknown) => {
        setBusy(false);
        toast.fail(e);
      },
    );
  };
  return (
    <div className="flex flex-wrap items-center gap-2 py-1" data-testid="bot-consent-prompt">
      <span className="min-w-0 flex-1 text-control">{t('bots.delegate.ask', { bot })}</span>
      <Button size="sm" busy={busy} onClick={allow} data-testid="bot-consent-allow">
        {t('bots.delegate.allow')}
      </Button>
      <Button variant="secondary" size="sm" onClick={() => setDetails(true)}>
        {t('bots.delegate.askDetails')}
      </Button>
      {details ? <BotDelegationDialog workspaceId={workspaceId} botUserId={botUserId} onClose={() => setDetails(false)} /> : null}
    </div>
  );
});

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldQuestion } from 'lucide-react';
import { memo, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import { Button, Modal } from '../../components/ui';
import { t } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { useMemberName, useWorkspaces } from '../../stores/workspaces';
import { MemberAvatar } from '../boards/menus';
import { delegationsKey } from './BotDelegationDialog';
import { BotHandle, useBotCard } from './BotProfile';

/*
 * CBF-41 / board #115: the bot's «act on your behalf» request inside a card it made. A warning
 * block (warn border and surface, docs/08) with ONE button, «Рассмотреть запрос», that opens a
 * window: who asks, what the permission allows, «Разрешить» (PUT …/delegations/{me}) or
 * «Отклонить». Declining is the invitee's own «Отказаться» (DELETE …/delegation-invites/{me}:
 * remembered for 7 days, the bot is told, ADR-0119 §3) when the bot has invited me; a card the
 * bot merely created has no invitation on the server, so the decline only hides the block for
 * this session. The server records only the member's own click and checks everything.
 */

/** Requests declined in this session (`workspace:bot`): the block stays hidden. */
const useDeclined = create<{ keys: Record<string, true> }>()(() => ({ keys: {} }));

export const BotConsentPrompt = memo(function BotConsentPrompt({ workspaceId, botUserId }: { workspaceId: string; botUserId: string }): ReactNode {
  const me = useSession((s) => s.me?.user?.id ?? '');
  const bot = useMemberName(workspaceId, botUserId);
  const declined = useDeclined((s) => s.keys[`${workspaceId}:${botUserId}`] === true);
  const state = useQuery({
    queryKey: delegationsKey(workspaceId, botUserId),
    queryFn: ({ signal }) => api.bots.delegations(workspaceId, botUserId, signal),
    staleTime: 60_000,
  });
  const [open, setOpen] = useState(false);
  const data = state.data;
  // Until the state is known (or when the server refuses to show it) nothing is offered.
  if (!data || me === '' || declined || data.delegations.some((d) => d.userId === me)) return null;
  return (
    <div className="flex items-start gap-2.5 rounded-[var(--radius-card)] my-1.5 border border-warn bg-warn-surface px-3 py-2.5" data-testid="bot-consent-prompt">
      <ShieldQuestion className="mt-0.5 size-[18px] shrink-0 text-warn-text" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col items-start gap-2">
        <div className="min-w-0">
          <p className="break-words text-control font-medium text-fg">{t('bots.consent.lead', { bot })}</p>
          <p className="mt-0.5 break-words text-caption text-muted">{t('bots.consent.hint')}</p>
        </div>
        <Button variant="attention" size="sm" onClick={() => setOpen(true)} data-testid="bot-consent-review">
          {t('bots.consent.review')}
        </Button>
      </div>
      {open ? <BotConsentDialog workspaceId={workspaceId} botUserId={botUserId} me={me} invited={data.invites.some((i) => i.userId === me)} onClose={() => setOpen(false)} /> : null}
    </div>
  );
});

function BotConsentDialog({ workspaceId, botUserId, me, invited, onClose }: { workspaceId: string; botUserId: string; me: string; invited: boolean; onClose: () => void }): ReactNode {
  const bot = useMemberName(workspaceId, botUserId);
  const card = useBotCard(botUserId);
  const owner = useWorkspaces((s) => (card?.ownerUserId ? (s.users[card.ownerUserId]?.displayName ?? '') : ''));
  const qc = useQueryClient();
  const [busy, setBusy] = useState<'allow' | 'deny' | null>(null);
  const key = delegationsKey(workspaceId, botUserId);
  const allow = (): void => {
    setBusy('allow');
    api.bots.grantDelegation(workspaceId, botUserId, me).then(
      (r) => {
        qc.setQueryData(key, r);
        toast.success(t('bots.delegate.granted'));
        onClose();
      },
      (e: unknown) => {
        setBusy(null);
        toast.fail(e);
      },
    );
  };
  const hide = (): void => {
    useDeclined.setState((s) => ({ keys: { ...s.keys, [`${workspaceId}:${botUserId}`]: true } }));
    toast.success(t('bots.consent.declined'));
    onClose();
  };
  const deny = (): void => {
    if (!invited) {
      hide();
      return;
    }
    setBusy('deny');
    api.bots.cancelDelegationInvite(workspaceId, botUserId, me).then(
      (r) => {
        qc.setQueryData(key, r);
        hide();
      },
      (e: unknown) => {
        setBusy(null);
        toast.fail(e);
      },
    );
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={t('bots.consent.title')}
      description={t('bots.consent.intro', { bot })}
      initialFocus="body"
      footer={
        <>
          <Button variant="secondary" busy={busy === 'deny'} disabled={busy !== null} onClick={deny} data-testid="bot-consent-deny">
            {t('bots.consent.deny')}
          </Button>
          <Button busy={busy === 'allow'} disabled={busy !== null} onClick={allow} data-testid="bot-consent-allow">
            {t('bots.delegate.allow')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4" data-testid="bot-consent-dialog">
        <div className="flex items-center gap-3">
          <MemberAvatar workspaceId={workspaceId} userId={botUserId} size={40} />
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-body font-medium">{bot}</span>
            <BotHandle botUserId={botUserId} />
            {owner ? <span className="truncate text-caption text-muted">{t('bots.consent.owner', { name: owner })}</span> : null}
          </div>
        </div>
        <section>
          <h3 className="pb-1 text-caption font-medium text-muted">{t('bots.consent.allows')}</h3>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-body">
            <li>{t('bots.consent.allow1')}</li>
            <li>{t('bots.consent.allow2')}</li>
            <li>{t('bots.consent.allow3')}</li>
          </ul>
        </section>
        <p className="rounded-[var(--radius-card)] bg-warn-surface px-3 py-2 text-caption text-fg">{t('bots.consent.trust')}</p>
        <p className="text-caption text-muted">{t('bots.consent.revoke')}</p>
      </div>
    </Modal>
  );
}

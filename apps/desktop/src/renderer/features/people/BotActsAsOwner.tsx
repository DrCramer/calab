import type { Bot } from '@calaba/protocol';
import { UserCheck } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { confirmAction } from '../../components/Confirm';
import { Switch, cx } from '../../components/ui';
import { t } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { useBots } from '../../stores/bots';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';

/*
 * «Действовать от моего имени» (ADR-0106): the bot's owner lets it act on their behalf (REST
 * requests with Calab-On-Behalf: owner), with the warning that a leaked token then acts as them.
 * Only the owner sees the switch (the server refuses anyone else, ON_BEHALF_OWNER_ONLY); whoever
 * else sees the bot's settings (its managers) gets the read-only line. Used by the bot's row in
 * «Настройки пространства → Боты» and by the bot profile. Turning it on asks once more.
 */
export function BotActsAsOwner({ bot, className }: { bot: Bot; className?: string }): ReactNode {
  const me = useSession((s) => s.me?.user?.id ?? '');
  const [busy, setBusy] = useState(false);
  const botId = bot.user?.id ?? '';
  const mine = me !== '' && bot.ownerUserId === me && bot.workspaceId !== '';
  if (!mine) {
    return bot.actsAsOwner ? (
      <p className={cx('flex min-w-0 items-center gap-1 text-caption text-muted', className)} data-testid="bot-acts-as-owner-line">
        <UserCheck className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">{t('bots.actsAsOwnerOn')}</span>
      </p>
    ) : null;
  }
  const change = async (on: boolean): Promise<void> => {
    if (busy || !botId) return;
    if (on && !(await confirmAction(t('bots.actsAsOwnerConfirmTitle', { name: bot.user?.displayName ?? '' }), t('bots.actsAsOwnerWarning'), t('bots.actsAsOwnerConfirm'), 'primary'))) return;
    setBusy(true);
    try {
      const r = await api.bots.update(bot.workspaceId, botId, { actsAsOwner: on });
      if (r.bot) useBots.getState().upsert(bot.workspaceId, r.bot);
    } catch (e) {
      toast.fail(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={cx('min-w-0', className)} data-testid="bot-acts-as-owner">
      <Switch checked={bot.actsAsOwner} onChange={(v) => void change(v)} disabled={busy} label={t('bots.actsAsOwner')} hint={t('bots.actsAsOwnerHint')} />
    </div>
  );
}

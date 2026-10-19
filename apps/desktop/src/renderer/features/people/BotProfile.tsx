import type { Bot } from '@calaba/protocol';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { Ban, Plus, ShieldCheck } from 'lucide-react';
import { useEffect, useMemo, type ReactNode } from 'react';
import { AvatarButtons } from '../../components/AvatarPicker';
import { Button, cx } from '../../components/ui';
import { t } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { mayManageBots } from '../../lib/permissions';
import { botAvatarChanged, loadBlockedBots, loadBotCard, loadWorkspaceBots, setBotBlocked } from '../../services/bots';
import { reportPlanError } from '../../services/plan';
import { useBots } from '../../stores/bots';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { rolesOf, useWorkspaces } from '../../stores/workspaces';
import { menuBox, menuItem, menuLabel } from '../shell/menu';
import { BotActsAsOwnerNote } from './MemberBits';

/*
 * A bot's profile (ADR-0031 §7, docs/08 «Боты»): its @username, description, «Команды» (what it
 * registered), «Владелец» (when the managers' list told us), «Добавить в пространство…» (to a
 * workspace where I have MANAGE_WORKSPACE and it is not yet) and «Заблокировать бота». Used by
 * the member card (ProfileCard) and the full profile (ProfileDialog); the full profile also has
 * the avatar for the bot's managers (BotAvatarControls). The server checks it all.
 */

/** The bot's card from the store, fetched once when first shown. */
export function useBotCard(botUserId: string): Bot | undefined {
  const card = useBots((s) => s.cards[botUserId]);
  useEffect(() => {
    void loadBotCard(botUserId);
  }, [botUserId]);
  return card;
}

/** «@username» under the name ('' until the card is in). */
export function BotHandle({ botUserId, className }: { botUserId: string; className?: string }): ReactNode {
  const username = useBots((s) => s.cards[botUserId]?.username ?? '');
  return username ? <div className={cx('truncate font-mono text-caption text-muted', className)}>@{username}</div> : null;
}

/** Description, commands and owner. `compact` — the member card's smaller type. */
export function BotDetails({ botUserId, compact = false }: { botUserId: string; compact?: boolean }): ReactNode {
  const card = useBotCard(botUserId);
  const owner = useWorkspaces((s) => (card?.ownerUserId ? (s.users[card.ownerUserId]?.displayName ?? '') : ''));
  if (!card) return null;
  const title = compact ? 'mb-1 text-caption font-semibold text-muted' : 'mb-1.5 text-caption font-semibold text-muted';
  return (
    <div className="flex flex-col gap-3" data-testid="bot-details">
      {card.description ? <p className={cx('selectable whitespace-pre-wrap break-words', compact ? 'text-body' : 'text-list')}>{card.description}</p> : null}
      {card.commands.length ? (
        <section>
          <h4 className={title}>{t('bots.commands')}</h4>
          <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto" data-testid="bot-commands">
            {card.commands.map((c) => (
              <li key={c.name} className="flex min-w-0 items-baseline gap-2 text-body">
                <code className="shrink-0 rounded-[4px] bg-[var(--color-code)] px-1 font-mono text-caption">/{c.name}</code>
                <span className="min-w-0 truncate text-muted" title={c.description}>
                  {c.description}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {owner ? (
        <section className="flex items-baseline gap-2 text-body">
          <h4 className="text-caption font-semibold text-muted">{t('bots.owner')}</h4>
          <span className="min-w-0 truncate">{owner}</span>
        </section>
      ) : null}
      <BotActsAsOwnerNote bot={card} />
    </div>
  );
}

/** Workspaces I manage that the bot is not in (the «Добавить в пространство…» menu). */
function useAddTargets(botUserId: string): Array<{ id: string; name: string }> {
  const me = useSession((s) => s.me?.user?.id ?? '');
  const byId = useWorkspaces((s) => s.byId);
  return useMemo(
    () =>
      Object.values(byId)
        .filter((e) => !e.members[botUserId] && mayManageBots(rolesOf(e, me)))
        .map((e) => ({ id: e.ws.id, name: e.ws.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [byId, botUserId, me],
  );
}

async function addTo(workspaceId: string, botUserId: string, wsName: string): Promise<void> {
  try {
    const r = await api.bots.add(workspaceId, { botUserId });
    if (r.bot) useBots.getState().upsert(workspaceId, r.bot);
    toast.success(t('bots.addedTo', { ws: wsName }));
  } catch (e) {
    if (!reportPlanError(e, workspaceId)) toast.fail(e);
  }
}

/** «Добавить в пространство…» and «Заблокировать бота» / «Разблокировать». */
export function BotActions({ botUserId, size = 'md' }: { botUserId: string; size?: 'md' | 'lg' }): ReactNode {
  const targets = useAddTargets(botUserId);
  const blocked = useBots((s) => (s.blocked ? !!s.blocked[botUserId] : null));
  useEffect(() => {
    void loadBlockedBots();
  }, []);
  return (
    <div className="flex flex-wrap gap-2">
      {targets.length ? (
        <Dropdown.Root modal={false}>
          <Dropdown.Trigger asChild>
            <Button variant="secondary" size={size} data-testid="bot-add-to">
              <Plus className="size-3.5" aria-hidden />
              {t('bots.addTo')}
            </Button>
          </Dropdown.Trigger>
          <Dropdown.Portal>
            <Dropdown.Content align="start" sideOffset={6} collisionPadding={16} className={menuBox}>
              <div className={menuLabel}>{t('bots.addToLabel')}</div>
              {targets.map((w) => (
                <Dropdown.Item key={w.id} className={menuItem} onSelect={() => void addTo(w.id, botUserId, w.name)}>
                  <span className="truncate">{w.name}</span>
                </Dropdown.Item>
              ))}
            </Dropdown.Content>
          </Dropdown.Portal>
        </Dropdown.Root>
      ) : null}
      {blocked !== null ? (
        <Button
          variant={blocked ? 'secondary' : 'destructive'}
          size={size}
          onClick={() => void setBotBlocked(botUserId, !blocked)}
          data-testid="bot-block"
        >
          {blocked ? <ShieldCheck className="size-3.5" aria-hidden /> : <Ban className="size-3.5" aria-hidden />}
          {t(blocked ? 'bots.unblock' : 'bots.block')}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * «Загрузить аватар» / «Убрать аватар» for whoever manages the bot (docs/09 #87): its owner or
 * MANAGE_BOTS (ADR-0048) of its home workspace. The home workspace comes from the managers' bot list
 * (the public card hides it), fetched once when I manage the workspace the profile is open in.
 */
export function BotAvatarControls({ workspaceId, botUserId }: { workspaceId: string; botUserId: string }): ReactNode {
  const me = useSession((s) => s.me?.user?.id ?? '');
  const manageHere = useWorkspaces((s) => mayManageBots(rolesOf(s.byId[workspaceId], me)));
  const listed = useBots((s) => workspaceId in s.byWorkspace);
  const home = useBots((s) => s.cards[botUserId]?.workspaceId ?? '');
  const owner = useBots((s) => s.cards[botUserId]?.ownerUserId ?? '');
  const manageHome = useWorkspaces((s) => (home ? mayManageBots(rolesOf(s.byId[home], me)) : false));
  const avatar = useWorkspaces((s) => s.users[botUserId]?.avatarFileId ?? '');
  useEffect(() => {
    if (manageHere && !listed) void loadWorkspaceBots(workspaceId);
  }, [manageHere, listed, workspaceId]);
  if (!home || !(manageHome || (owner !== '' && owner === me))) return null;
  return (
    <AvatarButtons
      hasAvatar={!!avatar}
      size="sm"
      removeLabel={t('bots.avatarRemove')}
      testId="bot-profile-avatar"
      onUpload={async (f) => botAvatarChanged(home, (await api.bots.setAvatar(home, botUserId, f, f.name)).bot)}
      onRemove={async () => botAvatarChanged(home, (await api.bots.clearAvatar(home, botUserId)).bot)}
    />
  );
}

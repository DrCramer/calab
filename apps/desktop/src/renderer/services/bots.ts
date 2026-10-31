import type { Bot, DispatchEvent } from '@calaba/protocol';
import { api } from '../lib/api/endpoints';
import { log } from '../lib/log';
import { commandsFresh, useBots } from '../stores/bots';
import { myUserId } from '../stores/session';
import { toast } from '../stores/toasts';
import { useWorkspaces } from '../stores/workspaces';

/**
 * Bots on the client (ADR-0031): loading the managers' list, bot cards, the composer's command
 * hints and my blocked bots, and applying BOT_* events. The server checks every right.
 */

/** «Настройки пространства → Боты»: the workspace's bots (MANAGE_WORKSPACE). */
export async function loadWorkspaceBots(workspaceId: string): Promise<void> {
  try {
    const r = await api.bots.list(workspaceId);
    useBots.getState().setWorkspace(workspaceId, r.bots);
    for (const b of r.bots) if (b.user) useWorkspaces.getState().upsertUser(b.user);
  } catch (e) {
    toast.fail(e);
  }
}

/** A bot's avatar changed (docs/09 #87): the managers' list and its user at once (USER_UPDATE follows). */
export function botAvatarChanged(workspaceId: string, bot: Bot | undefined): void {
  if (!bot?.user) return;
  useBots.getState().upsert(workspaceId, bot);
  useWorkspaces.getState().upsertUser(bot.user);
}

const cardLoads = new Map<string, Promise<Bot | null>>();

/** A bot's public card (description, commands), once per session unless `force`. */
export function loadBotCard(botUserId: string, force = false): Promise<Bot | null> {
  const have = useBots.getState().cards[botUserId];
  if (have && !force) return Promise.resolve(have);
  let p = cardLoads.get(botUserId);
  if (!p) {
    p = api.bots
      .get(botUserId)
      .then((r) => {
        if (r.bot) useBots.getState().setCard(r.bot);
        return r.bot ?? null;
      })
      .catch((e: unknown) => {
        log.warn('bot card', e);
        return null;
      })
      .finally(() => cardLoads.delete(botUserId));
    cardLoads.set(botUserId, p);
  }
  return p;
}

const commandLoads = new Map<string, Promise<void>>();

/** Composer hints of a room: cached per room (COMMANDS_TTL_MS; BOT_* events drop the cache). */
export function loadRoomCommands(roomId: string): Promise<void> {
  if (commandsFresh(useBots.getState().commands[roomId])) return Promise.resolve();
  let p = commandLoads.get(roomId);
  if (!p) {
    p = api.bots
      .roomCommands(roomId)
      .then((r) => useBots.getState().setRoomCommands(roomId, r.bots))
      .catch((e: unknown) => {
        // No hints is not an error worth a toast: the message is sent as typed.
        log.warn('bot commands', e);
        useBots.getState().setRoomCommands(roomId, []);
      })
      .finally(() => commandLoads.delete(roomId));
    commandLoads.set(roomId, p);
  }
  return p;
}

let blockedLoad: Promise<void> | null = null;

/** GET /api/me/blocked-bots once per session. */
export function loadBlockedBots(): Promise<void> {
  if (useBots.getState().blocked) return Promise.resolve();
  blockedLoad ??= api.bots
    .blocked()
    .then((r) => useBots.getState().setBlocked(r.botUserIds))
    .catch((e: unknown) => log.warn('blocked bots', e))
    .finally(() => {
      blockedLoad = null;
    });
  return blockedLoad;
}

/** «Заблокировать бота» / «Разблокировать»: optimistic, rolled back on an error. */
export async function setBotBlocked(botUserId: string, blocked: boolean): Promise<void> {
  const s = useBots.getState();
  s.setBlockedOne(botUserId, blocked);
  try {
    await (blocked ? api.bots.block(botUserId) : api.bots.unblock(botUserId));
  } catch (e) {
    useBots.getState().setBlockedOne(botUserId, !blocked);
    toast.fail(e);
  }
}

/** BOT_CREATE / BOT_UPDATE / BOT_DELETE (to MANAGE_WORKSPACE members and the bot's owner). */
export function applyBotEvent(e: DispatchEvent['event']): void {
  const s = useBots.getState();
  switch (e.case) {
    case 'botCreate':
    case 'botUpdate': {
      const bot = e.value.bot;
      if (!bot) return;
      s.upsert(e.value.workspaceId, bot);
      if (bot.user) useWorkspaces.getState().upsertUser(bot.user);
      // ADR-0151: a bot I own — its tasks are mine for author rights. A deleted one stays until
      // the next READY (the server decides; BOT_DELETE does not tell a removal from a deletion).
      if (bot.user?.id && bot.ownerUserId !== '' && bot.ownerUserId === myUserId()) s.addMine(bot.user.id);
      return;
    }
    case 'botDelete':
      s.remove(e.value.workspaceId, e.value.botUserId);
      return;
    default:
      return;
  }
}

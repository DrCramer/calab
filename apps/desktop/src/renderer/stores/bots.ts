import type { Bot, RoomBotCommands } from '@calaba/protocol';
import { create } from 'zustand';

/*
 * Bots (ADR-0031). A bot is a user (`User.is_bot`, in stores/workspaces `users` and members);
 * this store keeps what only bots have, loaded on demand:
 *   - `byWorkspace` — «Настройки пространства → Боты» (GET …/bots, MANAGE_WORKSPACE);
 *   - `cards` — bot cards by user id (description, commands; owner only when the list gave it);
 *   - `commands` — composer hints per room (GET /api/rooms/{id}/bot-commands), refetched after
 *     COMMANDS_TTL_MS or when a BOT_* event / a bot joining or leaving drops them;
 *   - `blocked` — bots I blocked (GET /api/me/blocked-bots), null until loaded.
 * BOT_CREATE / BOT_UPDATE / BOT_DELETE patch it (services/bots.ts).
 */

export const COMMANDS_TTL_MS = 5 * 60_000;

export interface RoomCommands {
  bots: RoomBotCommands[];
  /** Date.now() of the fetch. */
  at: number;
}

interface BotsState {
  byWorkspace: Record<string, Bot[]>;
  cards: Record<string, Bot>;
  commands: Record<string, RoomCommands>;
  blocked: Record<string, true> | null;
  setWorkspace: (workspaceId: string, bots: readonly Bot[]) => void;
  /** A bot joined or changed (BOT_CREATE / BOT_UPDATE, or a mutation's response). */
  upsert: (workspaceId: string, bot: Bot) => void;
  /** BOT_DELETE: deleted, or removed from that workspace. */
  remove: (workspaceId: string, botUserId: string) => void;
  setCard: (bot: Bot) => void;
  setRoomCommands: (roomId: string, bots: readonly RoomBotCommands[], at?: number) => void;
  /** Forget the composer hints (all rooms): the next `/` refetches them. */
  dropCommands: () => void;
  setBlocked: (ids: readonly string[]) => void;
  setBlockedOne: (botUserId: string, blocked: boolean) => void;
  reset: () => void;
}

const idOf = (b: Bot): string => b.user?.id ?? '';

/**
 * A card keeps what a later, thinner copy of the bot lacks: the public card (GET /api/bots/{id})
 * hides the owner and the home workspace, the managers' list has them.
 */
function mergeCard(prev: Bot | undefined, next: Bot): Bot {
  if (!prev) return next;
  const merged = { ...next, ownerUserId: next.ownerUserId || prev.ownerUserId, workspaceId: next.workspaceId || prev.workspaceId };
  // acts_as_owner (ADR-0106) comes only with the owner's / the managers' copies: a public one
  // (no owner) does not switch it off.
  if (!next.ownerUserId) {
    merged.actsAsOwner = prev.actsAsOwner;
    if (prev.actsAsOwnerSince) merged.actsAsOwnerSince = prev.actsAsOwnerSince;
  }
  return merged;
}

export const useBots = create<BotsState>()((set) => ({
  byWorkspace: {},
  cards: {},
  commands: {},
  blocked: null,
  setWorkspace: (workspaceId, bots) =>
    set((s) => {
      const cards = { ...s.cards };
      for (const b of bots) if (idOf(b)) cards[idOf(b)] = mergeCard(cards[idOf(b)], b);
      return { byWorkspace: { ...s.byWorkspace, [workspaceId]: [...bots] }, cards };
    }),
  upsert: (workspaceId, bot) =>
    set((s) => {
      const id = idOf(bot);
      if (!id) return {};
      const list = s.byWorkspace[workspaceId];
      // A loaded list follows; an unloaded one stays unloaded (the tab fetches it when opened).
      const byWorkspace = list
        ? { ...s.byWorkspace, [workspaceId]: list.some((b) => idOf(b) === id) ? list.map((b) => (idOf(b) === id ? bot : b)) : [...list, bot] }
        : s.byWorkspace;
      return { byWorkspace, cards: { ...s.cards, [id]: mergeCard(s.cards[id], bot) }, commands: {} };
    }),
  remove: (workspaceId, botUserId) =>
    set((s) => {
      const list = s.byWorkspace[workspaceId];
      return {
        byWorkspace: list ? { ...s.byWorkspace, [workspaceId]: list.filter((b) => idOf(b) !== botUserId) } : s.byWorkspace,
        commands: {},
      };
    }),
  setCard: (bot) =>
    set((s) => {
      const id = idOf(bot);
      return id ? { cards: { ...s.cards, [id]: mergeCard(s.cards[id], bot) } } : {};
    }),
  setRoomCommands: (roomId, bots, at = Date.now()) => set((s) => ({ commands: { ...s.commands, [roomId]: { bots: [...bots], at } } })),
  dropCommands: () => set((s) => (Object.keys(s.commands).length ? { commands: {} } : {})),
  setBlocked: (ids) => set({ blocked: Object.fromEntries(ids.map((id) => [id, true as const])) }),
  setBlockedOne: (botUserId, blocked) =>
    set((s) => {
      const next = { ...(s.blocked ?? {}) };
      if (blocked) next[botUserId] = true;
      else delete next[botUserId];
      return { blocked: next };
    }),
  reset: () => set({ byWorkspace: {}, cards: {}, commands: {}, blocked: null }),
}));

/** Cached hints of a room are still fresh (not dropped, younger than the TTL). */
export function commandsFresh(entry: RoomCommands | undefined, now = Date.now()): boolean {
  return !!entry && now - entry.at < COMMANDS_TTL_MS;
}

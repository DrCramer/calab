import { boardsApi } from '../../services/boardsApi';

/** Who of a task's workspace sees the board / would get only this card if @mentioned (ADR-0076 §5). */
export interface MentionAccess {
  see: ReadonlySet<string>;
  card: ReadonlySet<string>;
  /** Everyone the answer was asked about: others (new members) fall back to the local guess. */
  asked: ReadonlySet<string>;
}

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; value: MentionAccess }>();
const inflight = new Map<string, Promise<MentionAccess | null>>();

/** The last answer for the task, if it is still fresh (a board's roles / overrides change rarely). */
export function cachedMentionAccess(taskId: string, now = Date.now()): MentionAccess | undefined {
  const hit = cache.get(taskId);
  return hit && now - hit.at < TTL_MS ? hit.value : undefined;
}

/** Drops the answers (board permission or role changes): the next popover asks again. */
export function invalidateMentionAccess(): void {
  cache.clear();
}

/**
 * Asks the server once per stale cache (the server knows the board's overrides, which a commenter
 * without MANAGE_BOARD never receives). Null on failure: the caller keeps its local guess.
 */
export function loadMentionAccess(taskId: string, userIds: readonly string[]): Promise<MentionAccess | null> {
  const fresh = cachedMentionAccess(taskId);
  if (fresh) return Promise.resolve(fresh);
  const running = inflight.get(taskId);
  if (running) return running;
  const p = boardsApi.tasks
    .mentionAccess(taskId, userIds.slice(0, 200))
    .then((r): MentionAccess => {
      const value = { see: new Set(r.seeIds), card: new Set(r.cardIds), asked: new Set(userIds) };
      cache.set(taskId, { at: Date.now(), value });
      return value;
    })
    .catch(() => null)
    .finally(() => inflight.delete(taskId));
  inflight.set(taskId, p);
  return p;
}

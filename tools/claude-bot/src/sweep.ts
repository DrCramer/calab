// The daily board sweep (README «Board sweep»): no model. The poller only wakes on changes, so a task that
// sat in Todo before the daemon started, or was never triaged, is never looked at. Twice a day, at the
// first poll after 10:00 and after 15:00 (local; not in quiet hours), the sweep lists Todo tasks that lack
// a type label or a priority, or whose last comment is not the bot's, and queues them for the next wake as
// `sweep:#N`. A task is not swept again until it changes (its signature: status, comments, labels,
// priority), so an untouched backlog costs one wake, not one a day.
import type { BoardItem, Change } from './poll.js';

export const SWEEP_HOURS: readonly number[] = [10, 15];
/** Tasks queued per sweep (the rest wait for the next one) and comment-author lookups per sweep. */
export const SWEEP_MAX = 15;
export const SWEEP_LOOKUPS = 30;
const TYPE_LABELS = new Set(['bug', 'feature']);

export interface SweepState {
  /** The local day of `slots`. */
  day: string;
  /** Sweep hours already done that day. */
  slots: number[];
  /** Tasks the bot has looked at: key → their signature right after that wake. */
  seen: Record<string, string>;
  /** Found by a sweep, waiting for a wake: key → signature when found and why. */
  pending: Record<string, { sig: string; what: string[] }>;
}

export const emptySweep = (): SweepState => ({ day: '', slots: [], seen: {}, pending: {} });

const isTodo = (t: BoardItem): boolean => t.status.trim().toLowerCase() === 'todo';

/** What a change of a task looks like to the sweep. */
export function taskSig(t: BoardItem): string {
  return [t.status, String(t.comments), [...(t.labels ?? [])].sort().join(','), String(t.priority ?? 0)].join('|');
}

/** The sweep hour due now (the latest passed hour not yet done today), or null. */
export function sweepDue(st: SweepState, hour: number, day: string, hours: readonly number[] = SWEEP_HOURS): number | null {
  const done = st.day === day ? st.slots : [];
  const latest = hours.filter((h) => hour >= h).at(-1);
  return latest === undefined || done.includes(latest) ? null : latest;
}

/** Marks `slot` and every earlier hour done for `day` (a daemon started at 16:00 sweeps once). */
export function markSweep(st: SweepState, day: string, slot: number, hours: readonly number[] = SWEEP_HOURS): void {
  if (st.day !== day) {
    st.day = day;
    st.slots = [];
  }
  for (const h of hours) if (h <= slot && !st.slots.includes(h)) st.slots.push(h);
}

/** Why a Todo task needs a look ([] = it does not). `lastAuthor` is checked only when it has comments. */
export function reasons(t: BoardItem, lastAuthor: string | undefined, botId: string): string[] {
  if (!isTodo(t)) return [];
  const out: string[] = [];
  if (t.labels !== undefined && !t.labels.some((l) => TYPE_LABELS.has(l.toLowerCase()))) out.push('no type label');
  if (t.priority !== undefined && t.priority === 0) out.push('no priority');
  if (t.comments > 0 && lastAuthor && lastAuthor !== botId) out.push('last comment not by the bot');
  return out;
}

const byNumber = (a: string, b: string): number => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, ''));

/**
 * One sweep over the board: adds the Todo tasks that need a look and changed since the bot last looked to
 * `st.pending`. Returns how many were added.
 */
export async function sweepBoard(
  board: Record<string, BoardItem>,
  st: SweepState,
  deps: { lastAuthor: (roomId: string) => Promise<string | undefined>; botId: string; max?: number; lookups?: number },
): Promise<number> {
  let added = 0;
  let lookups = 0;
  for (const key of Object.keys(board).sort(byNumber)) {
    if (added >= (deps.max ?? SWEEP_MAX)) break;
    const t = board[key];
    if (!t || !isTodo(t)) continue;
    const sig = taskSig(t);
    if (st.seen[key] === sig || st.pending[key]?.sig === sig) continue;
    let last: string | undefined;
    if (t.comments > 0 && lookups < (deps.lookups ?? SWEEP_LOOKUPS)) {
      lookups++;
      last = await deps.lastAuthor(t.roomId).catch(() => undefined);
    }
    const why = reasons(t, last, deps.botId);
    if (why.length === 0) continue;
    st.pending[key] = { sig, what: why };
    added++;
  }
  return added;
}

/**
 * The pending sweep entries as changes for the next wake (`sweep:#N`). Entries whose task left Todo or
 * vanished are dropped; tasks that already have a regular change (`skip`) are not listed twice.
 */
export function sweepChanges(st: SweepState, board: Record<string, BoardItem>, skip: ReadonlySet<string>): Change[] {
  const out: Change[] = [];
  for (const [key, p] of Object.entries(st.pending)) {
    const t = board[key];
    if (!t || !isTodo(t)) {
      Reflect.deleteProperty(st.pending, key);
      continue;
    }
    if (skip.has(key)) continue;
    out.push({ source: 'board', key: `sweep:${key}`, title: t.title, author: t.createdBy, what: [`sweep: ${p.what.join(', ')}`], newComments: 0, ref: t.roomId, trusted: true });
  }
  return out.sort((a, b) => byNumber(a.key, b.key));
}

/**
 * After a wake: the tasks it looked at (its board changes and sweep entries) are seen with their state
 * after the run, so the sweep does not bring them up again until they change.
 */
export function markSeen(st: SweepState, board: Record<string, BoardItem>, keys: readonly string[]): void {
  for (const raw of keys) {
    const key = raw.replace(/^sweep:/, '');
    Reflect.deleteProperty(st.pending, key);
    const t = board[key];
    if (t) st.seen[key] = taskSig(t);
  }
  // Forget tasks that left the board, so the state does not grow forever.
  for (const key of Object.keys(st.seen)) if (!(key in board)) Reflect.deleteProperty(st.seen, key);
}

import { timestampMs } from '@bufbuild/protobuf/wkt';
import { SipCallDirection, SipCallStatus, type SipJournalEntry } from '@calaba/protocol';
import { create } from 'zustand';
import type { JournalFilter, Period } from './telephonyUi';

/**
 * «Телефония → Недавние» data (ADR-0137 §1, §8): the loaded page(s) of the journal for the open
 * list and the missed badge of each workspace. Entries are kept by call id, the list holds ids:
 * a SIP_JOURNAL_ENTRY replaces one entry, so only the row subscribed to that id re-renders; the list
 * itself re-renders only when an id comes or goes (or a live call ends and leaves «Сейчас»).
 * Loading and the gateway events are in services/sipJournal.ts; the pure rules below are tested.
 */

export interface JournalList {
  /** Workspace + filters: a list for other filters is a different list (a new first page). */
  key: string;
  ws: string;
  ids: readonly string[];
  cursor: string;
  status: 'loading' | 'ready' | 'error';
  /** The next page is being read. */
  more: boolean;
}

interface SipJournalState {
  entries: Readonly<Record<string, SipJournalEntry>>;
  list: JournalList | null;
  /** Workspace → my missed calls since I last looked at «Недавние» (WorkspaceSnapshot.sip_missed, SIP_MISSED_CHANGED). */
  missed: Readonly<Record<string, number>>;
}

export const useSipJournal = create<SipJournalState>()(() => ({ entries: {}, list: null, missed: {} }));

// ---------------------------------------------------------------- pure rules

export const startMs = (e: SipJournalEntry | undefined): number => (e?.call?.startedAt ? timestampMs(e.call.startedAt) : 0);

export const isLiveEntry = (e: SipJournalEntry | undefined): boolean => {
  const s = e?.call?.status;
  return s === SipCallStatus.DIALING || s === SipCallStatus.RINGING || s === SipCallStatus.ACTIVE;
};

/** Local midnight of the day of `ms`. */
const dayStart = (ms: number): number => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** The [from, to) of a period at `now` (local days), nulls = open. */
export function periodRange(p: Period, now: number): { from: number | null; to: number | null } {
  const today = dayStart(now);
  switch (p) {
    case 'today':
      return { from: today, to: null };
    case 'yesterday':
      return { from: dayStart(today - 1), to: today };
    case 'week':
      return { from: dayStart(now - 6 * 86_400_000), to: null };
    case 'month':
      return { from: dayStart(now - 29 * 86_400_000), to: null };
    default:
      return { from: null, to: null };
  }
}

/** The digits of a search (a number typed or pasted «+7 (916) 12…»); '' when the text has none. */
export const queryDigits = (q: string): string => q.replace(/\D/g, '');

/** The request of a filter (sip.proto ListSipJournal): scope, filter, user, q, from, to. */
export function journalParams(f: JournalFilter, now: number): { scope: 'mine' | 'all'; filter?: 'missed' | 'in' | 'out'; user?: string; q?: string; from?: string; to?: string } {
  const user = f.scope.startsWith('user:') ? f.scope.slice(5) : '';
  const { from, to } = periodRange(f.period, now);
  const filter = f.segment === 'missed' ? 'missed' : f.direction === 'all' ? undefined : f.direction;
  return {
    scope: f.scope === 'mine' ? 'mine' : 'all',
    ...(filter ? { filter } : {}),
    ...(user ? { user } : {}),
    ...(f.q.trim() ? { q: f.q.trim() } : {}),
    ...(from !== null ? { from: new Date(from).toISOString() } : {}),
    ...(to !== null ? { to: new Date(to).toISOString() } : {}),
  };
}

/** The key of a list: the same workspace and filters → the same list (no reload). */
export const listKey = (ws: string, f: JournalFilter): string => `${ws}|${f.segment}|${f.direction}|${f.scope}|${f.period}|${f.q.trim()}`;

/**
 * Would the server's list hold this entry (a live event decides whether to put it in)? The same
 * rules as ListSipJournal: scope mine / user — a party; missed — missed (with mine / user: they
 * were rung); direction; digits of the number; the period. A text query (names, T2) is never
 * matched here: the event waits for the next load.
 */
export function entryMatches(e: SipJournalEntry, f: JournalFilter, me: string, now: number): boolean {
  const c = e.call;
  if (!c) return false;
  const who = f.scope === 'mine' ? me : f.scope.startsWith('user:') ? f.scope.slice(5) : '';
  const party = who ? e.parties.find((p) => p.userId === who) : undefined;
  if (who && !party) return false;
  if (f.segment === 'missed') {
    if (!e.missed) return false;
    if (who && !party?.rang) return false;
  } else if (f.direction !== 'all') {
    if ((c.direction === SipCallDirection.IN) !== (f.direction === 'in')) return false;
  }
  const q = f.q.trim();
  if (q) {
    const d = queryDigits(q);
    if (!d || ![e.peerE164, c.number].some((n) => n.replace(/\D/g, '').includes(d))) return false;
  }
  const { from, to } = periodRange(f.period, now);
  const at = startMs(e);
  if (from !== null && at < from) return false;
  if (to !== null && at >= to) return false;
  return true;
}

/** Ids newest first (the server's order: started_at desc, id desc). */
export function sortIds(ids: Iterable<string>, entries: Readonly<Record<string, SipJournalEntry>>): string[] {
  return [...ids].sort((a, b) => startMs(entries[b]) - startMs(entries[a]) || (b > a ? 1 : b < a ? -1 : 0));
}

/**
 * An entry from SIP_JOURNAL_ENTRY into the open list: replaces a known one; a new one goes in
 * (in order) when the filters let it in; a known one that no longer passes leaves the list.
 * Returns the same state when nothing changes.
 */
export function withEntry(s: SipJournalState, e: SipJournalEntry, f: JournalFilter, me: string, now: number): SipJournalState {
  const id = e.call?.id;
  if (!id) return s;
  const list = s.list;
  const inList = !!list && list.ids.includes(id);
  const known = id in s.entries;
  const pass = !!list && list.ws === e.call?.workspaceId && list.status === 'ready' && entryMatches(e, f, me, now);
  if (!known && !pass) return s;
  const entries = { ...s.entries, [id]: e };
  if (!list || inList === pass) return { ...s, entries };
  const ids = pass ? sortIds([...list.ids, id], entries) : list.ids.filter((x) => x !== id);
  return { ...s, entries, list: { ...list, ids } };
}

/** The groups of the list: «Сейчас» (live calls) first, then one per local day, newest first. */
export interface ListGroup {
  /** 'now' or the day's local midnight in ms. */
  key: 'now' | number;
  ids: string[];
}

export function groupIds(ids: readonly string[], live: ReadonlySet<string>, entries: Readonly<Record<string, SipJournalEntry>>): ListGroup[] {
  const out: ListGroup[] = [];
  const now = ids.filter((id) => live.has(id));
  if (now.length) out.push({ key: 'now', ids: now });
  let cur: ListGroup | null = null;
  for (const id of ids) {
    if (live.has(id)) continue;
    const day = dayStart(startMs(entries[id]));
    if (!cur || cur.key !== day) {
      cur = { key: day, ids: [] };
      out.push(cur);
    }
    cur.ids.push(id);
  }
  return out;
}

/** The live ids of the open list, joined (a primitive for selectors). */
export const liveKey = (s: SipJournalState): string => (s.list ? s.list.ids.filter((id) => isLiveEntry(s.entries[id])).join(',') : '');

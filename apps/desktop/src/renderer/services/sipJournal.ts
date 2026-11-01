import type { SipJournalEntry, WorkspaceSnapshot } from '@calaba/protocol';
import { api } from '../lib/api/endpoints';
import { log } from '../lib/log';
import { queryClient } from '../lib/queryClient';
import { myUserId } from '../stores/session';
import { journalParams, listKey, sortIds, useSipJournal, withEntry } from '../stores/sipJournal';
import { useTelephonyUi, type JournalFilter } from '../stores/telephonyUi';

/**
 * «Телефония → Недавние» (ADR-0137 §1, §8): the first page of the journal when the list opens (and
 * when its filters change), the next pages on scroll, SIP_JOURNAL_ENTRY into the loaded list, an
 * open detail re-read on its call's event, and the missed badge (READY / WORKSPACE_CREATE,
 * SIP_MISSED_CHANGED, «seen»). Nothing is polled.
 */

const PAGE = 50;
/** The detail of a call (react-query): re-read on its SIP_JOURNAL_ENTRY while it is on screen. */
export const journalEntryKey = (ws: string, callId: string): readonly unknown[] => ['sipJournalEntry', ws, callId];

let seq = 0;
let ctl: AbortController | null = null;

/** The first page of `ws` for the filters (the same list already loaded or loading: nothing). */
export function loadJournal(ws: string, f: JournalFilter, force = false): void {
  const key = listKey(ws, f);
  const cur = useSipJournal.getState().list;
  if (!force && cur?.key === key && cur.status !== 'error') return;
  ctl?.abort();
  ctl = new AbortController();
  const my = ++seq;
  useSipJournal.setState({ list: { key, ws, ids: [], cursor: '', status: 'loading', more: false } });
  api.sip
    .journalList(ws, { ...journalParams(f, Date.now()), limit: PAGE }, ctl.signal)
    .then((r) => {
      if (my !== seq) return;
      const entries: Record<string, SipJournalEntry> = {};
      for (const e of r.entries) if (e.call?.id) entries[e.call.id] = e;
      // Only this list's entries are kept: the previous list's go with it.
      useSipJournal.setState({ entries, list: { key, ws, ids: sortIds(Object.keys(entries), entries), cursor: r.nextCursor, status: 'ready', more: false } });
    })
    .catch((e: unknown) => {
      if (my !== seq || (e instanceof DOMException && e.name === 'AbortError')) return;
      log.warn('sip journal load failed', e);
      useSipJournal.setState((s) => (s.list?.key === key ? { list: { ...s.list, status: 'error' } } : s));
    });
}

/** The next page of the open list (the end of the list scrolled into view). */
export function loadMoreJournal(f: JournalFilter): void {
  const list = useSipJournal.getState().list;
  if (!list || list.status !== 'ready' || list.more || !list.cursor) return;
  const my = seq;
  useSipJournal.setState({ list: { ...list, more: true } });
  api.sip
    .journalList(list.ws, { ...journalParams(f, Date.now()), cursor: list.cursor, limit: PAGE })
    .then((r) => {
      const cur = useSipJournal.getState().list;
      if (my !== seq || cur?.key !== list.key) return;
      const entries = { ...useSipJournal.getState().entries };
      for (const e of r.entries) if (e.call?.id) entries[e.call.id] = e;
      const ids = new Set([...cur.ids, ...r.entries.flatMap((e) => (e.call?.id ? [e.call.id] : []))]);
      useSipJournal.setState({ entries, list: { ...cur, ids: sortIds(ids, entries), cursor: r.nextCursor, more: false } });
    })
    .catch((e: unknown) => {
      log.warn('sip journal page failed', e);
      const cur = useSipJournal.getState().list;
      if (cur?.key === list.key) useSipJournal.setState({ list: { ...cur, more: false } });
    });
}

/** The list closed (the section left): nothing is held, nothing to update. */
export function dropJournal(): void {
  ctl?.abort();
  seq++;
  useSipJournal.setState({ entries: {}, list: null });
}

/** SIP_JOURNAL_ENTRY: into the open list; an open detail of the call re-reads (1 request, only while on screen). */
export function onJournalEntry(entry: SipJournalEntry | undefined): void {
  const c = entry?.call;
  if (!entry || !c) return;
  const s = useSipJournal.getState();
  const next = withEntry(s, entry, useTelephonyUi.getState().filter, myUserId(), Date.now());
  if (next !== s) useSipJournal.setState({ entries: next.entries, list: next.list });
  void queryClient.invalidateQueries({ queryKey: journalEntryKey(c.workspaceId, c.id), refetchType: 'active' });
}

// ---------------------------------------------------------------- the missed badge

function setMissed(ws: string, n: number): void {
  const cur = useSipJournal.getState().missed;
  if ((cur[ws] ?? 0) === n) return;
  useSipJournal.setState({ missed: { ...cur, [ws]: n } });
}

/** READY: every workspace's badge (anything known before is replaced). */
export function resetSipMissed(snaps: readonly WorkspaceSnapshot[]): void {
  const missed: Record<string, number> = {};
  for (const s of snaps) if (s.workspace && s.sipMissed > 0) missed[s.workspace.id] = s.sipMissed;
  useSipJournal.setState({ missed });
}

/** WORKSPACE_CREATE (joined a workspace). */
export function applySnapshotSipMissed(snap: WorkspaceSnapshot): void {
  if (snap.workspace) setMissed(snap.workspace.id, snap.sipMissed);
}

/** SIP_MISSED_CHANGED. */
export function onSipMissedChanged(ws: string, count: number): void {
  setMissed(ws, count);
}

/** A workspace I left / that was deleted. */
export function dropSipMissed(ws: string): void {
  const cur = useSipJournal.getState().missed;
  if (!(ws in cur)) return;
  const { [ws]: _gone, ...rest } = cur;
  useSipJournal.setState({ missed: rest });
}

/** «Недавние» looked at (or «Отметить просмотренными»): the badge is 0 at once, the server records it. */
export function markJournalSeen(ws: string): void {
  if ((useSipJournal.getState().missed[ws] ?? 0) === 0) return;
  setMissed(ws, 0);
  api.sip.journalSeen(ws).catch((e: unknown) => log.warn('sip journal seen failed', e));
}

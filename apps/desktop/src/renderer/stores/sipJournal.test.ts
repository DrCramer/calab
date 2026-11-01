import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { SipCallDirection, SipCallPartySchema, SipCallSchema, SipCallStatus, SipJournalEntrySchema, type SipJournalEntry } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { entryMatches, groupIds, journalParams, periodRange, sortIds, withEntry, type JournalList } from './sipJournal';
import { DEFAULT_FILTER, type JournalFilter } from './telephonyUi';

const NOW = new Date(2026, 0, 15, 13, 30).getTime();
const H = 3_600_000;

const entry = (id: string, o: { at?: number; dir?: SipCallDirection; status?: SipCallStatus; missed?: boolean; peer?: string; parties?: Array<{ userId: string; rang?: boolean }> } = {}): SipJournalEntry =>
  create(SipJournalEntrySchema, {
    call: create(SipCallSchema, { id, workspaceId: 'ws', direction: o.dir ?? SipCallDirection.IN, status: o.status ?? SipCallStatus.ENDED, number: o.peer ?? '+79161234567', startedAt: timestampFromMs(o.at ?? NOW - H) }),
    peerE164: o.peer ?? '+79161234567',
    missed: o.missed ?? false,
    parties: (o.parties ?? [{ userId: 'me', rang: true }]).map((p) => create(SipCallPartySchema, p)),
  });

const f = (patch: Partial<JournalFilter> = {}): JournalFilter => ({ ...DEFAULT_FILTER, ...patch });

describe('journal filters (ADR-0137 §1 ListSipJournal)', () => {
  it('the request of a filter', () => {
    expect(journalParams(f(), NOW)).toEqual({ scope: 'mine' });
    expect(journalParams(f({ segment: 'missed', direction: 'out' }), NOW)).toEqual({ scope: 'mine', filter: 'missed' });
    expect(journalParams(f({ direction: 'in', scope: 'user:u2', q: ' 916 ' }), NOW)).toEqual({ scope: 'all', filter: 'in', user: 'u2', q: '916' });
    const y = journalParams(f({ period: 'yesterday' }), NOW);
    expect(new Date(y.from ?? '').getDate()).toBe(14);
    expect(new Date(y.to ?? '').getDate()).toBe(15);
  });

  it('periods are local days', () => {
    const r = periodRange('week', NOW);
    expect(new Date(r.from ?? 0).getDate()).toBe(9);
    expect(r.to).toBeNull();
  });

  it('a live event matches the list the server would return', () => {
    expect(entryMatches(entry('a'), f(), 'me', NOW)).toBe(true);
    expect(entryMatches(entry('a', { parties: [{ userId: 'other' }] }), f(), 'me', NOW)).toBe(false);
    expect(entryMatches(entry('a', { parties: [{ userId: 'other' }] }), f({ scope: 'all' }), 'me', NOW)).toBe(true);
    expect(entryMatches(entry('a', { missed: true, parties: [{ userId: 'me', rang: false }] }), f({ segment: 'missed' }), 'me', NOW)).toBe(false);
    expect(entryMatches(entry('a', { dir: SipCallDirection.OUT }), f({ direction: 'in' }), 'me', NOW)).toBe(false);
    expect(entryMatches(entry('a'), f({ q: '123-45' }), 'me', NOW)).toBe(true);
    expect(entryMatches(entry('a'), f({ q: 'Ромашка' }), 'me', NOW)).toBe(false);
    expect(entryMatches(entry('a', { at: NOW - 30 * H }), f({ period: 'today' }), 'me', NOW)).toBe(false);
  });
});

describe('the open list', () => {
  const list = (ids: string[]): JournalList => ({ key: 'k', ws: 'ws', ids, cursor: '', status: 'ready', more: false });

  it('a new entry goes in, in order; a known one is replaced without touching the ids', () => {
    const a = entry('a', { at: NOW - 2 * H });
    const s0 = { entries: { a }, list: list(['a']), missed: {} };
    const b = entry('b', { at: NOW - H });
    const s1 = withEntry(s0, b, f(), 'me', NOW);
    expect(s1.list?.ids).toEqual(['b', 'a']);
    const a2 = entry('a', { at: NOW - 2 * H, status: SipCallStatus.ENDED });
    const s2 = withEntry(s1, a2, f(), 'me', NOW);
    expect(s2.list?.ids).toBe(s1.list?.ids);
    expect(s2.entries['a']).toBe(a2);
  });

  it('an entry the filters do not let in is ignored; a known one that no longer passes leaves', () => {
    const s0 = { entries: {}, list: list([]), missed: {} };
    expect(withEntry(s0, entry('x', { parties: [{ userId: 'other' }] }), f(), 'me', NOW)).toBe(s0);
    const m = entry('m', { missed: true });
    const s1 = { entries: { m }, list: list(['m']), missed: {} };
    const s2 = withEntry(s1, entry('m', { missed: false }), f({ segment: 'missed' }), 'me', NOW);
    expect(s2.list?.ids).toEqual([]);
  });

  it('groups: «Сейчас» first, then one per day', () => {
    const e = { l: entry('l', { at: NOW - 60_000, status: SipCallStatus.RINGING }), t1: entry('t1', { at: NOW - H }), t2: entry('t2', { at: NOW - 2 * H }), y: entry('y', { at: NOW - 20 * H }) };
    const ids = sortIds(Object.keys(e), e);
    const g = groupIds(ids, new Set(['l']), e);
    expect(g.map((x) => x.ids)).toEqual([['l'], ['t1', 't2'], ['y']]);
    expect(g[0]?.key).toBe('now');
  });
});

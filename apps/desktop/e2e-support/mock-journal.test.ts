import { SipCallStatus } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { advanceCall, listJournal, mayReadCall, missedCount, seedJournal, type JournalQuery } from './mock-journal';

const NOW = Date.parse('2026-01-15T13:30:00+03:00');
const people = { ws: 'ws1', anna: 'anna', boris: 'boris', vera: 'vera', room: 'room1', roomName: 'Созвон', borisPhone: '+79125550202' };
const rows = seedJournal(NOW, people);
const q = (o: Partial<JournalQuery> = {}): JournalQuery => ({ ws: 'ws1', me: 'anna', scope: 'mine', filter: '', user: '', q: '', from: null, to: null, cursor: 0, limit: 50, ...o });

describe('mock journal (ADR-0137 §1)', () => {
  it('mine: every call of the fixture but the connection test, newest first', () => {
    const { entries } = listJournal(rows, q());
    expect(entries).toHaveLength(rows.length - 1);
    const starts = entries.map((e) => Number(e.call?.startedAt?.seconds));
    expect([...starts].sort((a, b) => b - a)).toEqual(starts);
    expect(entries[0]?.call?.status).toBe(SipCallStatus.RINGING);
  });

  it('all calls include the test; one employee — only their calls', () => {
    expect(listJournal(rows, q({ scope: 'all' })).entries).toHaveLength(rows.length);
    const vera = listJournal(rows, q({ scope: 'all', user: 'vera' })).entries;
    expect(vera.length).toBe(2);
    expect(vera.every((e) => e.parties.some((p) => p.userId === 'vera'))).toBe(true);
  });

  it('missed: missed calls that rang me; digits of a number; a text matches contacts', () => {
    const missed = listJournal(rows, q({ filter: 'missed' })).entries;
    expect(missed.map((e) => e.peerE164)).toEqual(['+74957654321', '+79250001020']);
    expect(listJournal(rows, q({ q: '765 43' })).entries).toHaveLength(1);
    expect(listJournal(rows, q({ q: 'ромашка' })).entries[0]?.contact?.company).toBe('ООО Ромашка');
    expect(listJournal(rows, q({ filter: 'out' })).entries.every((e) => e.call?.startedBy === 'anna')).toBe(true);
  });

  it('the period and the cursor', () => {
    const today = new Date(NOW);
    today.setHours(0, 0, 0, 0);
    expect(listJournal(rows, q({ from: today.getTime() })).entries).toHaveLength(6);
    const p1 = listJournal(rows, q({ limit: 4 }));
    expect(p1.entries).toHaveLength(4);
    expect(p1.nextCursor).toBe('4');
    const p2 = listJournal(rows, q({ limit: 4, cursor: 4 }));
    expect(p2.entries[0]?.call?.id).not.toBe(p1.entries[3]?.call?.id);
  });

  it('the missed badge counts after my «seen»; a party or VIEW_JOURNALS reads a call', () => {
    expect(missedCount(rows, 'ws1', 'anna', 0)).toBe(2);
    expect(missedCount(rows, 'ws1', 'anna', NOW)).toBe(0);
    const test = rows.find((r) => r.entry.parties.length === 0);
    expect(test && mayReadCall(test, 'anna', false)).toBe(false);
    expect(test && mayReadCall(test, 'anna', true)).toBe(true);
  });

  it('a ringing call is answered, then ends', () => {
    const live = rows[0];
    if (!live) throw new Error('no live call in the fixture');
    const answered = advanceCall(live, NOW + 10_000, 'boris');
    expect(answered.entry.call?.status).toBe(SipCallStatus.ACTIVE);
    expect(answered.entry.call?.answeredBy).toBe('boris');
    const ended = advanceCall(answered, NOW + 70_000, '');
    expect(ended.entry.call?.status).toBe(SipCallStatus.ENDED);
    expect(ended.entry.talkMs).toBe(60_000);
    expect(ended.entry.missed).toBe(false);
    expect(advanceCall(live, NOW + 5_000, '').entry.missed).toBe(true);
  });
});

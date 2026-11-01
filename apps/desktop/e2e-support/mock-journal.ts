import { create } from '@bufbuild/protobuf';
import { timestampFromMs, timestampMs } from '@bufbuild/protobuf/wkt';
import {
  SipCallDirection,
  SipCallEventKind as K,
  SipCallEventSchema,
  SipCallOrigin,
  SipCallPartySchema,
  SipCallSchema,
  SipCallStatus,
  SipCallTargetKind as T,
  SipContactRefSchema,
  SipJournalEntrySchema,
  SipJournalRecordingSchema,
  type SipCallEvent,
  type SipJournalEntry,
  type SipJournalRecording,
} from '@calaba/protocol';

/**
 * The call journal of the mock API (ADR-0137 §1, sip.proto ListSipJournal / GetSipJournalEntry):
 * rows (the entry, its events, the recording) in memory and the server's list rules — scope
 * mine / all / user, filter missed / in / out, digits of the number, the period, newest first,
 * an index cursor; the missed badge since a member's «seen». Contacts and employees' phones are
 * already filled in the fixture (they arrive with T2 on the server), so the screens show the
 * final look. Wired into mock-server.ts (`sipJournalRoutes`).
 */

export interface JournalRow {
  entry: SipJournalEntry;
  events: SipCallEvent[];
  recording?: SipJournalRecording;
}

export interface JournalQuery {
  ws: string;
  me: string;
  scope: 'mine' | 'all';
  filter: '' | 'missed' | 'in' | 'out';
  user: string;
  q: string;
  from: number | null;
  to: number | null;
  cursor: number;
  limit: number;
}

const startOf = (r: JournalRow): number => (r.entry.call?.startedAt ? timestampMs(r.entry.call.startedAt) : 0);

/** The rows a reader sees, newest first (the server's order: started_at desc, id desc). */
export function listJournal(rows: Iterable<JournalRow>, q: JournalQuery): { entries: SipJournalEntry[]; nextCursor: string } {
  const who = q.scope === 'mine' ? q.me : q.user;
  const digits = q.q.replace(/\D/g, '');
  const list = [...rows]
    .filter((r) => {
      const e = r.entry;
      const c = e.call;
      if (!c || c.workspaceId !== q.ws) return false;
      const party = who ? e.parties.find((p) => p.userId === who) : undefined;
      if (who && !party) return false;
      if (q.filter === 'missed' && (!e.missed || (who && !party?.rang))) return false;
      if (q.filter === 'in' && c.direction !== SipCallDirection.IN) return false;
      if (q.filter === 'out' && c.direction !== SipCallDirection.OUT) return false;
      if (q.q.trim()) {
        if (digits) {
          if (![e.peerE164, c.number].some((n) => n.replace(/\D/g, '').includes(digits))) return false;
        } else {
          // T2: a text matches contacts by name / company.
          const t = q.q.trim().toLowerCase();
          if (!e.contact || ![e.contact.name, e.contact.company].some((s) => s.toLowerCase().includes(t))) return false;
        }
      }
      const at = startOf(r);
      if (q.from !== null && at < q.from) return false;
      if (q.to !== null && at >= q.to) return false;
      return true;
    })
    .sort((a, b) => startOf(b) - startOf(a) || ((b.entry.call?.id ?? '') > (a.entry.call?.id ?? '') ? 1 : -1));
  const page = list.slice(q.cursor, q.cursor + q.limit);
  return { entries: page.map((r) => r.entry), nextCursor: q.cursor + q.limit < list.length ? String(q.cursor + q.limit) : '' };
}

/** My missed calls of a workspace after `since` (WorkspaceSnapshot.sip_missed). */
export function missedCount(rows: Iterable<JournalRow>, ws: string, me: string, since: number): number {
  let n = 0;
  for (const r of rows) {
    const e = r.entry;
    if (e.call?.workspaceId !== ws || !e.missed || startOf(r) <= since) continue;
    if (e.parties.some((p) => p.userId === me && p.rang)) n++;
  }
  return n;
}

/** May the reader open this call (VIEW_JOURNALS, or a party of it)? */
export const mayReadCall = (r: JournalRow, me: string, viewJournals: boolean): boolean => viewJournals || r.entry.parties.some((p) => p.userId === me);

// ---------------------------------------------------------------- the fixture

export interface JournalPeople {
  ws: string;
  anna: string;
  boris: string;
  vera: string;
  /** «Созвон»: the room of a room call. */
  room: string;
  roomName: string;
  /** Борис's profile phone (the employee whose phone calls in). */
  borisPhone: string;
}

type Party = { user: string; placed?: boolean; rang?: boolean; answered?: boolean; transferred?: boolean };

/**
 * «Недавние» of the visual tests (NOW = 15 Jan 2026 13:30 MSK, `base`): a call ringing now, a
 * transfer through the main menu and a group «по очереди» (the detail frame), a missed one, an
 * outbound one to a company, a long name with a long company, a hidden number, a busy outbound, an
 * employee's phone, a room call, a call from before the journal (no times), an older missed one
 * and the connection test. Анна (owner@) is a party of all of them but the test.
 */
export function seedJournal(base: number, p: JournalPeople): JournalRow[] {
  const S = 1000;
  const M = 60 * S;
  const H = 60 * M;
  const D = 24 * H;
  const rows: JournalRow[] = [];
  let n = 0;
  const row = (o: {
    at: number;
    dir: SipCallDirection;
    status?: SipCallStatus;
    number: string;
    peer?: string;
    origin: SipCallOrigin;
    contact?: { name: string; company: string };
    member?: string;
    startedBy?: string;
    answeredBy?: string;
    answeredAfter?: number;
    talk?: number;
    wait?: number;
    missed?: boolean;
    reason?: string;
    via?: string;
    roomId?: string;
    ringing?: string[];
    parties: Party[];
    events?: Array<[K, number | null, Partial<Omit<SipCallEvent, '$typeName' | 'at' | 'kind' | 'seq'>>]>;
    legacy?: boolean;
    recording?: number;
  }): string => {
    const id = `mock-call-${String(++n).padStart(2, '0')}`;
    const status = o.status ?? (o.dir === SipCallDirection.OUT && o.reason && !o.talk ? SipCallStatus.FAILED : SipCallStatus.ENDED);
    const live = status === SipCallStatus.RINGING || status === SipCallStatus.ACTIVE || status === SipCallStatus.DIALING;
    const answered = o.answeredAfter !== undefined ? o.at + o.answeredAfter : 0;
    const ended = live ? 0 : (answered || o.at) + (o.talk ?? o.wait ?? 0);
    const call = create(SipCallSchema, {
      id,
      workspaceId: p.ws,
      roomId: o.roomId ?? '',
      number: o.number,
      direction: o.dir,
      startedBy: o.startedBy ?? '',
      status,
      reason: o.reason ?? '',
      startedAt: timestampFromMs(o.at),
      ...(answered ? { answeredAt: timestampFromMs(answered) } : {}),
      ...(ended ? { endedAt: timestampFromMs(ended) } : {}),
      participantIdentity: `sip:${id}`,
      answeredBy: o.answeredBy ?? '',
      ringingUserIds: o.ringing ?? [],
      via: o.via ?? '',
    });
    let seq = 0;
    const events = (o.events ?? []).map(([kind, sec, f]) => create(SipCallEventSchema, { seq: ++seq, kind, ...(sec === null ? {} : { at: timestampFromMs(o.at + sec * S) }), ...f }));
    const entry = create(SipJournalEntrySchema, {
      call,
      origin: o.origin,
      peerE164: o.peer ?? (/^\+\d+$/.test(o.number) ? o.number : ''),
      ...(o.contact ? { contact: create(SipContactRefSchema, { id: `mock-contact-${n}`, ...o.contact }) } : {}),
      memberUserId: o.member ?? '',
      waitMs: o.wait ?? (answered ? answered - o.at : 0),
      talkMs: o.talk ?? 0,
      missed: o.missed ?? false,
      parties: o.parties.map((x) => create(SipCallPartySchema, { userId: x.user, placed: !!x.placed, rang: !!x.rang, answered: !!x.answered, transferred: !!x.transferred })),
      hasEvents: !o.legacy,
    });
    rows.push({ entry, events, ...(o.recording ? { recording: create(SipJournalRecordingSchema, { fileId: `mock-rec-${n}`, diskItemId: `mock-rec-item-${n}`, durationMs: o.recording }) } : {}) });
    return id;
  };
  const IN = SipCallDirection.IN;
  const OUT = SipCallDirection.OUT;
  const menu = { targetKind: T.MENU, targetName: 'Главное меню', targetId: 'mock-menu-main' };
  const sales = { targetKind: T.GROUP, targetName: 'Отдел продаж', targetId: 'mock-group-sales' };
  const today = (h: number, m: number): number => base - (13 * H + 30 * M) + h * H + m * M;

  // «Сейчас»: a caller rings «Отдел продаж» (Анна and Борис) for 42 s.
  row({ at: base - 42 * S, dir: IN, status: SipCallStatus.RINGING, number: '+79167001122', origin: SipCallOrigin.INBOUND, via: 'Отдел продаж', ringing: [p.anna, p.boris], parties: [{ user: p.anna, rang: true }, { user: p.boris, rang: true }] });
  // Missed at 13:05: «Отдел продаж», everyone rung, the caller gave up after 1:15.
  row({
    at: today(13, 5),
    dir: IN,
    number: '+74957654321',
    origin: SipCallOrigin.INBOUND,
    missed: true,
    wait: 75 * S,
    via: 'Отдел продаж',
    reason: 'remote',
    parties: [{ user: p.anna, rang: true }, { user: p.boris, rang: true }],
    events: [
      [K.STARTED, 0, { digits: '+74951234567', reason: 'register' }],
      [K.GROUP, 1, { ...sales, reason: 'ring_all' }],
      [K.RING, 1, { userId: p.anna, ...sales }],
      [K.RING, 1, { userId: p.boris, ...sales }],
      [K.RING_END, 75, { userId: p.anna, reason: 'caller_left' }],
      [K.RING_END, 75, { userId: p.boris, reason: 'caller_left' }],
      [K.ENDED, 75, { reason: 'remote' }],
    ],
  });
  // 12:58, the transfer: main menu → key 1 → «Отдел продаж» one by one (Вера, Борис, Анна) → Анна
  // answers → transfers to Борис → he takes it → the caller hangs up. Recorded.
  row({
    at: today(12, 58),
    dir: IN,
    number: '+79161234567',
    origin: SipCallOrigin.INBOUND,
    contact: { name: 'Анна Петрова', company: 'ООО Ромашка' },
    answeredBy: p.boris,
    answeredAfter: 38 * S,
    talk: 6 * M + 24 * S,
    reason: 'remote',
    recording: 6 * M + 20 * S,
    parties: [{ user: p.vera, rang: true }, { user: p.boris, rang: true, answered: true }, { user: p.anna, rang: true, answered: true, transferred: true }],
    events: [
      [K.STARTED, 0, { digits: '+74951234567', reason: 'direct' }],
      [K.MENU, 0, { ...menu, digits: '1' }],
      [K.NOTICE, 0, menu],
      [K.KEY, 7, { digits: '1' }],
      [K.GROUP, 7, { ...sales, reason: 'round_robin' }],
      [K.RING, 7, { userId: p.vera, ...sales }],
      [K.RING_END, 22, { userId: p.vera, reason: 'no_answer' }],
      [K.RING, 22, { userId: p.boris, ...sales }],
      [K.RING_END, 31, { userId: p.boris, reason: 'declined' }],
      [K.RING, 31, { userId: p.anna, ...sales }],
      [K.ANSWERED, 38, { userId: p.anna }],
      [K.RECORDING, 38, { reason: 'started' }],
      [K.TRANSFER, 190, { userId: p.anna, peerUserId: p.boris, targetKind: T.USER, targetId: p.boris }],
      [K.RING, 190, { userId: p.boris }],
      [K.TRANSFER_END, 198, { userId: p.boris, reason: 'answered' }],
      [K.ENDED, 422, { reason: 'remote' }],
      [K.RECORDING, 430, { reason: 'stored' }],
    ],
  });
  // 12:40: I called «ООО Лютик» (a company contact without a person) from the section.
  row({
    at: today(12, 40),
    dir: OUT,
    number: '+74959990011',
    origin: SipCallOrigin.PERSONAL,
    contact: { name: '', company: 'ООО Лютик' },
    startedBy: p.anna,
    answeredAfter: 9 * S,
    talk: 2 * M + 3 * S,
    reason: 'hangup',
    parties: [{ user: p.anna, placed: true }],
    events: [
      [K.STARTED, 0, { userId: p.anna }],
      [K.DIALING, 1, {}],
      [K.PROVIDER_RINGING, 3, {}],
      [K.ANSWERED, 9, {}],
      [K.ENDED, 132, { reason: 'hangup', userId: p.anna }],
    ],
  });
  // 11:20: a long name with a long company, I answered.
  row({
    at: today(11, 20),
    dir: IN,
    number: '+78123334455',
    origin: SipCallOrigin.INBOUND,
    contact: { name: 'Константин Константинович Константинопольский-Длинноимённый', company: 'Общество с ограниченной ответственностью «Северо-Западная Логистическая Компания»' },
    answeredBy: p.anna,
    answeredAfter: 12 * S,
    talk: 12 * M + 40 * S,
    reason: 'hangup',
    parties: [{ user: p.anna, rang: true, answered: true }],
    events: [
      [K.STARTED, 0, { digits: '+74951234567', reason: 'direct' }],
      [K.DIALED, 4, { digits: '100', reason: 'found' }],
      [K.RING, 4, { userId: p.anna, targetKind: T.EXTENSION, targetName: '100' }],
      [K.ANSWERED, 12, { userId: p.anna }],
      [K.ENDED, 772, { reason: 'hangup', userId: p.anna }],
    ],
  });
  // 10:02: a hidden number; Вера took it while it rang me too.
  row({
    at: today(10, 2),
    dir: IN,
    number: 'anonymous',
    peer: '',
    origin: SipCallOrigin.INBOUND,
    answeredBy: p.vera,
    answeredAfter: 14 * S,
    talk: 3 * M + 5 * S,
    reason: 'remote',
    parties: [{ user: p.anna, rang: true }, { user: p.vera, rang: true, answered: true }],
    events: [
      [K.STARTED, 0, { digits: '+74951234567', reason: 'direct' }],
      [K.GROUP, 1, { ...sales, reason: 'ring_all' }],
      [K.RING, 1, { userId: p.anna, ...sales }],
      [K.RING, 1, { userId: p.vera, ...sales }],
      [K.ANSWERED, 15, { userId: p.vera }],
      [K.RING_END, 15, { userId: p.anna, reason: 'answered_elsewhere' }],
      [K.ENDED, 200, { reason: 'remote' }],
    ],
  });
  // Yesterday 18:45: I called, busy.
  row({
    at: today(18, 45) - D,
    dir: OUT,
    number: '+79035550142',
    origin: SipCallOrigin.PERSONAL,
    startedBy: p.anna,
    reason: 'busy',
    status: SipCallStatus.FAILED,
    parties: [{ user: p.anna, placed: true }],
    events: [
      [K.STARTED, 0, { userId: p.anna }],
      [K.DIALING, 1, {}],
      [K.ENDED, 6, { reason: 'busy' }],
    ],
  });
  // Yesterday 16:10: Борис's own phone (an employee's number) rang me.
  row({
    at: today(16, 10) - D,
    dir: IN,
    number: p.borisPhone,
    origin: SipCallOrigin.INBOUND,
    member: p.boris,
    answeredBy: p.anna,
    answeredAfter: 5 * S,
    talk: 1 * M + 48 * S,
    reason: 'hangup',
    parties: [{ user: p.anna, rang: true, answered: true }],
    events: [
      [K.STARTED, 0, { digits: '+74951234567', reason: 'direct' }],
      [K.RING, 0, { userId: p.anna, targetKind: T.EXTENSION, targetName: '100' }],
      [K.ANSWERED, 5, { userId: p.anna }],
      [K.ENDED, 113, { reason: 'hangup', userId: p.anna }],
    ],
  });
  // Two days ago 15:00: the line of «Созвон» (a room call I placed).
  row({
    at: today(15, 0) - 2 * D,
    dir: OUT,
    number: '+79262223344',
    origin: SipCallOrigin.ROOM,
    roomId: p.room,
    startedBy: p.anna,
    answeredAfter: 7 * S,
    talk: 5 * M + 10 * S,
    reason: 'empty',
    parties: [{ user: p.anna, placed: true }],
    events: [
      [K.STARTED, 0, { userId: p.anna, targetKind: T.ROOM, targetId: p.room, targetName: p.roomName }],
      [K.DIALING, 0, {}],
      [K.PROVIDER_RINGING, 2, {}],
      [K.ANSWERED, 7, {}],
      [K.ENDED, 317, { reason: 'empty' }],
    ],
  });
  // Three days ago: a call from before the journal — its route parsed, no times.
  row({
    at: today(11, 15) - 3 * D,
    dir: IN,
    number: '+74951112233',
    origin: SipCallOrigin.INBOUND,
    answeredBy: p.anna,
    answeredAfter: 20 * S,
    talk: 4 * M,
    reason: 'remote',
    legacy: true,
    parties: [{ user: p.anna, answered: true }],
    events: [
      [K.MENU, null, { targetKind: T.MENU, targetName: 'Главное меню' }],
      [K.KEY, null, { digits: '2' }],
      [K.GROUP, null, { targetKind: T.GROUP, targetName: 'Отдел продаж' }],
      [K.ANSWERED, null, { userId: p.anna }],
    ],
  });
  // Five days ago: another missed call (the «Пропущенные» list).
  row({
    at: today(9, 40) - 5 * D,
    dir: IN,
    number: '+79250001020',
    origin: SipCallOrigin.INBOUND,
    contact: { name: 'Игорь Савельев', company: '' },
    missed: true,
    wait: 32 * S,
    via: 'Отдел продаж',
    reason: 'remote',
    parties: [{ user: p.anna, rang: true }],
    events: [
      [K.STARTED, 0, { digits: '+74951234567', reason: 'direct' }],
      [K.MENU, 0, { ...menu, digits: '1' }],
      [K.NO_INPUT, 10, {}],
      [K.GROUP, 10, { ...sales, reason: 'ring_all' }],
      [K.RING, 10, { userId: p.anna, ...sales }],
      [K.RING_END, 32, { userId: p.anna, reason: 'caller_left' }],
      [K.ENDED, 32, { reason: 'remote' }],
    ],
  });
  // A week ago: the connection test (all calls only).
  row({
    at: today(17, 0) - 7 * D,
    dir: OUT,
    number: '+74951234567',
    origin: SipCallOrigin.TEST,
    startedBy: p.anna,
    answeredAfter: 3 * S,
    talk: 2 * S,
    reason: 'hangup',
    parties: [],
    events: [
      [K.STARTED, 0, { userId: p.anna }],
      [K.DIALING, 0, {}],
      [K.ANSWERED, 3, {}],
      [K.ENDED, 5, { reason: 'hangup' }],
    ],
  });
  return rows;
}

/**
 * A live call moves on (the perf scene and the tests): RINGING → answered by `by`, or → ended
 * (answered: talked so far; else missed). Returns the new row (events appended).
 */
export function advanceCall(r: JournalRow, now: number, by: string): JournalRow {
  const c = r.entry.call;
  if (!c) return r;
  const call = create(SipCallSchema, { ...c });
  const entry = create(SipJournalEntrySchema, { ...r.entry, call });
  const events = [...r.events];
  const seq = events.length + 1;
  if (c.status === SipCallStatus.RINGING && by) {
    call.status = SipCallStatus.ACTIVE;
    call.answeredBy = by;
    call.answeredAt = timestampFromMs(now);
    call.ringingUserIds = [];
    entry.waitMs = now - timestampMs(c.startedAt ?? timestampFromMs(now));
    entry.parties = entry.parties.map((x) => (x.userId === by ? create(SipCallPartySchema, { ...x, answered: true }) : x));
    events.push(create(SipCallEventSchema, { seq, kind: K.ANSWERED, at: timestampFromMs(now), userId: by }));
  } else {
    call.status = SipCallStatus.ENDED;
    call.reason = 'remote';
    call.endedAt = timestampFromMs(now);
    call.ringingUserIds = [];
    const start = timestampMs(c.startedAt ?? timestampFromMs(now));
    if (c.answeredAt) entry.talkMs = now - timestampMs(c.answeredAt);
    else {
      entry.missed = true;
      entry.waitMs = now - start;
    }
    events.push(create(SipCallEventSchema, { seq, kind: K.ENDED, at: timestampFromMs(now), reason: 'remote' }));
  }
  return { ...r, entry, events };
}

import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { SipCallDirection, SipCallEventKind as K, SipCallEventSchema, SipCallOrigin, SipCallSchema, SipCallStatus, SipCallTargetKind, SipJournalEntrySchema, type SipCallEvent } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { buildTimeline, dialable, directionOf, numberOf, outcomeOf, sortEvents } from './timeline';

const T0 = Date.parse('2026-01-15T10:00:00Z');
let seq = 0;
const ev = (kind: K, sec: number | null, f: Partial<Omit<SipCallEvent, 'at' | 'kind' | 'seq' | '$typeName'>> = {}): SipCallEvent =>
  create(SipCallEventSchema, { seq: ++seq, kind, ...(sec === null ? {} : { at: timestampFromMs(T0 + sec * 1000) }), ...f });

const anna = 'u-anna';
const boris = 'u-boris';
const vera = 'u-vera';

describe('buildTimeline (ADR-0137 §6 «Маршрут»)', () => {
  it('menu → key → round robin over three employees → transfer → end', () => {
    seq = 0;
    const events = [
      ev(K.STARTED, 0, { digits: '+74951234567', reason: 'direct' }),
      ev(K.MENU, 0, { targetKind: SipCallTargetKind.MENU, targetName: 'Главное меню', digits: '1' }),
      ev(K.KEY, 7, { digits: '1' }),
      ev(K.GROUP, 7, { targetKind: SipCallTargetKind.GROUP, targetName: 'Отдел продаж', reason: 'round_robin' }),
      ev(K.RING, 7, { userId: anna }),
      ev(K.RING_END, 22, { userId: anna, reason: 'no_answer' }),
      ev(K.RING, 22, { userId: boris }),
      ev(K.RING_END, 37, { userId: boris, reason: 'declined' }),
      ev(K.RING, 37, { userId: vera }),
      ev(K.ANSWERED, 45, { userId: vera }),
      ev(K.TRANSFER, 120, { userId: vera, peerUserId: boris }),
      ev(K.RING, 120, { userId: boris }),
      ev(K.TRANSFER_END, 128, { userId: boris, reason: 'answered' }),
      ev(K.ENDED, 380, { reason: 'remote' }),
    ];
    const steps = buildTimeline(events, T0);
    expect(steps.map((s) => s.kind)).toEqual(['started', 'menu', 'key', 'group', 'rings', 'answered', 'transfer', 'rings', 'transferEnd', 'ended']);
    const rings = steps[4]?.rings;
    expect(rings?.mode).toBe('order');
    expect(rings?.attempts).toEqual([
      { userId: anna, durMs: 15_000, outcome: 'no_answer' },
      { userId: boris, durMs: 15_000, outcome: 'declined' },
      { userId: vera, durMs: 8_000, outcome: 'answered' },
    ]);
    expect(rings?.answeredBy).toBe(vera);
    expect(rings?.answeredAfterMs).toBe(38_000);
    // Offsets from the start; the transfer's steps nested, the transfer itself and the end not.
    expect(steps.map((s) => s.offsetMs)).toEqual([0, 0, 7_000, 7_000, 7_000, 45_000, 120_000, 120_000, 128_000, 380_000]);
    expect(steps.map((s) => s.nested)).toEqual([false, false, false, false, false, false, false, true, true, false]);
    expect(steps[7]?.rings?.mode).toBe('one');
    // The transfer's ring is settled by its end: Борис took it after 8 s.
    expect(steps[7]?.rings?.attempts).toEqual([{ userId: boris, durMs: 8_000, outcome: 'answered' }]);
    expect(steps.some((s) => s.danger)).toBe(false);
  });

  it('ring all, nobody answers: one folded step, the system end is not red', () => {
    seq = 0;
    const steps = buildTimeline(
      [
        ev(K.STARTED, 0),
        ev(K.GROUP, 1, { targetName: 'Поддержка', reason: 'ring_all' }),
        ev(K.RING, 1, { userId: anna }),
        ev(K.RING, 1, { userId: boris }),
        ev(K.RING_END, 76, { userId: anna, reason: 'caller_left' }),
        ev(K.RING_END, 76, { userId: boris, reason: 'caller_left' }),
        ev(K.ENDED, 76, { reason: 'remote' }),
      ],
      T0,
    );
    expect(steps.map((s) => s.kind)).toEqual(['started', 'group', 'rings', 'ended']);
    expect(steps[2]?.rings).toEqual({
      mode: 'all',
      attempts: [
        { userId: anna, durMs: 75_000, outcome: 'caller_left' },
        { userId: boris, durMs: 75_000, outcome: 'caller_left' },
      ],
      answeredBy: '',
      answeredAfterMs: null,
    });
    expect(steps[3]?.danger).toBe(false);
  });

  it('an outbound call: dialing, ringing, answered by the callee, a failed recording is red', () => {
    seq = 0;
    const steps = buildTimeline(
      [ev(K.STARTED, 0, { userId: anna }), ev(K.DIALING, 1), ev(K.PROVIDER_RINGING, 3), ev(K.ANSWERED, 9), ev(K.RECORDING, 9, { reason: 'failed_egress' }), ev(K.ENDED, 132, { reason: 'hangup', userId: anna })],
      T0,
    );
    expect(steps.map((s) => s.kind)).toEqual(['started', 'dialing', 'providerRinging', 'answered', 'recording', 'ended']);
    expect(steps[4]?.danger).toBe(true);
    expect(steps[5]?.offsetMs).toBe(132_000);
  });

  it('a provider failure at the end is red', () => {
    seq = 0;
    const steps = buildTimeline([ev(K.STARTED, 0), ev(K.ENDED, 2, { reason: 'error 503' })], T0);
    expect(steps[1]?.danger).toBe(true);
  });

  it('a call from before the journal: the parsed route in order, no times', () => {
    seq = 0;
    const steps = buildTimeline([ev(K.MENU, null, { targetName: '' }), ev(K.KEY, null, { digits: '2' }), ev(K.GROUP, null, { reason: 'ring_all' }), ev(K.ANSWERED, null, { userId: boris })], null);
    expect(steps.map((s) => s.kind)).toEqual(['menu', 'key', 'group', 'answered']);
    expect(steps.every((s) => s.offsetMs === null && s.at === null)).toBe(true);
  });

  it('events outside the machine sort by time, then seq', () => {
    seq = 0;
    const a = ev(K.RECORDING, 10, { reason: 'stored' });
    a.seq = 1_000_001;
    const b = ev(K.ENDED, 10);
    b.seq = 5;
    expect(sortEvents([a, b]).map((e) => e.seq)).toEqual([5, 1_000_001]);
  });
});

const entry = (f: { dir?: SipCallDirection; status?: SipCallStatus; answeredBy?: string; answered?: boolean; missed?: boolean; origin?: SipCallOrigin; reason?: string; via?: string; peer?: string; number?: string }) =>
  create(SipJournalEntrySchema, {
    call: create(SipCallSchema, {
      id: 'c1',
      direction: f.dir ?? SipCallDirection.IN,
      status: f.status ?? SipCallStatus.ENDED,
      answeredBy: f.answeredBy ?? '',
      startedBy: anna,
      number: f.number ?? '+79161234567',
      reason: f.reason ?? '',
      via: f.via ?? '',
      startedAt: timestampFromMs(T0),
      ...(f.answered ? { answeredAt: timestampFromMs(T0 + 31_000) } : {}),
    }),
    origin: f.origin ?? SipCallOrigin.INBOUND,
    peerE164: f.peer ?? '+79161234567',
    missed: f.missed ?? false,
    waitMs: 31_000,
    talkMs: 252_000,
  });

describe('outcomeOf (a row of «Недавние»)', () => {
  it('inbound answered / missed / refused', () => {
    expect(outcomeOf(entry({ answered: true, answeredBy: boris }))).toEqual({ kind: 'answered', by: boris, waitMs: 31_000, talkMs: 252_000 });
    expect(outcomeOf(entry({ missed: true, via: 'Отдел продаж' }))).toEqual({ kind: 'missed', waitMs: 31_000, via: 'Отдел продаж' });
    expect(outcomeOf(entry({ status: SipCallStatus.FAILED, reason: 'busy_limit' }))).toEqual({ kind: 'refused', reason: 'busy_limit' });
  });

  it('outbound: talked, failed, from a room; the connection test', () => {
    expect(outcomeOf(entry({ dir: SipCallDirection.OUT, origin: SipCallOrigin.PERSONAL, answered: true }))).toMatchObject({ kind: 'outbound', by: anna, failed: '', roomId: '' });
    expect(outcomeOf(entry({ dir: SipCallDirection.OUT, origin: SipCallOrigin.PERSONAL, status: SipCallStatus.FAILED, reason: 'busy' }))).toMatchObject({ kind: 'outbound', failed: 'busy' });
    expect(outcomeOf(entry({ dir: SipCallDirection.OUT, origin: SipCallOrigin.TEST }))).toEqual({ kind: 'test' });
  });

  it('a live call goes to «Сейчас»', () => {
    expect(outcomeOf(entry({ status: SipCallStatus.RINGING })).kind).toBe('live');
  });

  it('direction, number, dialable', () => {
    expect(directionOf(entry({ missed: true }))).toBe('missed');
    expect(directionOf(entry({ dir: SipCallDirection.OUT }))).toBe('out');
    expect(numberOf(entry({ peer: '', number: 'anonymous' }))).toBe('');
    expect(dialable(entry({ peer: '' }))).toBe(false);
    expect(dialable(entry({}))).toBe(true);
  });
});

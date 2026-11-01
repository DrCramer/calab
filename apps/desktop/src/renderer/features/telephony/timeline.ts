import { timestampMs } from '@bufbuild/protobuf/wkt';
import { SipCallDirection, SipCallEventKind, SipCallOrigin, SipCallStatus, type SipCallEvent, type SipJournalEntry } from '@calaba/protocol';

/*
 * «Телефония» (ADR-0137 §6–§7): the pure part of the journal's UI — a call's events turned into
 * the steps of «Маршрут» (rings to employees folded into one step, a transfer's steps nested,
 * offsets from the start), and the outcome line of a «Недавние» row. No i18n and no stores here:
 * the components map the structures to text. Unit-tested (timeline.test.ts).
 */

export type StepKind =
  | 'started'
  | 'menu'
  | 'key'
  | 'dialed'
  | 'noInput'
  | 'notice'
  | 'group'
  | 'rings'
  | 'fallback'
  | 'answered'
  | 'transfer'
  | 'transferEnd'
  | 'dialing'
  | 'providerRinging'
  | 'recording'
  | 'ended';

/** One employee rung within a folded run: how long and how it ended. */
export interface RingAttempt {
  userId: string;
  /** Ring length, null when unknown (an old call, or still ringing). */
  durMs: number | null;
  /** RING_END reason, 'answered' for the one who took the call, '' while still ringing. */
  outcome: string;
}

export interface Rings {
  /** 'all' — rung together (ring_all); 'order' — one after another (round_robin); 'one' — a single person. */
  mode: 'all' | 'order' | 'one';
  attempts: RingAttempt[];
  /** Who answered within this run ('' nobody), and after how long from its first ring. */
  answeredBy: string;
  answeredAfterMs: number | null;
}

export interface Step {
  /** Stable key: the seq of the step's first event. */
  key: string;
  kind: StepKind;
  /** From the call's start; null = no time (a call from before the journal). */
  offsetMs: number | null;
  /** Absolute time, ms; null as above. */
  at: number | null;
  /** Inside a transfer (indented under «Борис переводит…»). */
  nested: boolean;
  /** A system refusal (red): a failed end, a failed recording. */
  danger: boolean;
  /** The step's event (the first one of a folded run). */
  ev: SipCallEvent;
  rings?: Rings;
}

const atOf = (e: SipCallEvent): number | null => (e.at ? timestampMs(e.at) : null);

/** The order of «Маршрут»: by time, then seq (events outside the state machine have seq ≥ 1000001). */
export function sortEvents(events: readonly SipCallEvent[]): SipCallEvent[] {
  return [...events].sort((a, b) => {
    const ta = atOf(a);
    const tb = atOf(b);
    if (ta !== null && tb !== null && ta !== tb) return ta - tb;
    return a.seq - b.seq;
  });
}

/** Ends that are the system's failure, not a person's choice (sip.proto SipCall.reason). */
const SYSTEM_FAILURES = new Set(['error', 'unavailable', 'provider_auth', 'busy_limit', 'agent_unavailable', 'loop', 'no_members', 'plan', 'disabled', 'lost', 'not_connected']);

export const isSystemFailure = (reason: string): boolean => SYSTEM_FAILURES.has(reason.startsWith('error') ? 'error' : reason);

const KIND: Partial<Record<SipCallEventKind, StepKind>> = {
  [SipCallEventKind.STARTED]: 'started',
  [SipCallEventKind.MENU]: 'menu',
  [SipCallEventKind.KEY]: 'key',
  [SipCallEventKind.DIALED]: 'dialed',
  [SipCallEventKind.NO_INPUT]: 'noInput',
  [SipCallEventKind.NOTICE]: 'notice',
  [SipCallEventKind.GROUP]: 'group',
  [SipCallEventKind.FALLBACK]: 'fallback',
  [SipCallEventKind.ANSWERED]: 'answered',
  [SipCallEventKind.TRANSFER]: 'transfer',
  [SipCallEventKind.TRANSFER_END]: 'transferEnd',
  [SipCallEventKind.DIALING]: 'dialing',
  [SipCallEventKind.PROVIDER_RINGING]: 'providerRinging',
  [SipCallEventKind.RECORDING]: 'recording',
  [SipCallEventKind.ENDED]: 'ended',
};

const isRing = (e: SipCallEvent): boolean => e.kind === SipCallEventKind.RING || e.kind === SipCallEventKind.RING_END;

/**
 * The steps of «Маршрут» (ADR-0137 §6): one step per event, except that consecutive RING /
 * RING_END events fold into one «rings» step (who was rung, how long, how it ended; the answer
 * that follows is credited to it), and every step after a TRANSFER up to its TRANSFER_END is
 * nested. `startMs`: the call's start (offsets count from it; the first event's time without it).
 */
export function buildTimeline(events: readonly SipCallEvent[], startMs: number | null): Step[] {
  const sorted = sortEvents(events);
  const origin = startMs ?? sorted.map(atOf).find((x): x is number => x !== null) ?? null;
  const offset = (at: number | null): number | null => (at === null || origin === null ? null : Math.max(0, at - origin));
  const steps: Step[] = [];
  let nested = false;
  let groupMode: Rings['mode'] | null = null;
  let run: (Step & { rings: Rings }) | null = null;
  /** The last folded run (a transfer's end / the call's end settle what is still ringing in it). */
  let lastRun: (Step & { rings: Rings }) | null = null;
  const ringStart = new Map<string, number | null>();
  const settle = (at: number | null, outcome: (userId: string) => string): void => {
    for (const a of lastRun?.rings.attempts ?? []) {
      if (a.outcome) continue;
      a.outcome = outcome(a.userId);
      const from = ringStart.get(a.userId) ?? null;
      a.durMs = from !== null && at !== null ? Math.max(0, at - from) : null;
    }
  };

  for (const e of sorted) {
    const at = atOf(e);
    if (isRing(e)) {
      if (!run) {
        run = { key: String(e.seq), kind: 'rings', offsetMs: offset(at), at, nested, danger: false, ev: e, rings: { mode: groupMode ?? 'one', attempts: [], answeredBy: '', answeredAfterMs: null } };
        ringStart.clear();
        steps.push(run);
        lastRun = run;
      }
      const list = run.rings.attempts;
      if (e.kind === SipCallEventKind.RING) {
        ringStart.set(e.userId, at);
        list.push({ userId: e.userId, durMs: null, outcome: '' });
      } else {
        // The latest open attempt of this person (round robin may ring them twice).
        const a = [...list].reverse().find((x) => x.userId === e.userId && x.outcome === '');
        const from = ringStart.get(e.userId) ?? null;
        const dur = from !== null && at !== null ? Math.max(0, at - from) : null;
        if (a) {
          a.outcome = e.reason || 'no_answer';
          a.durMs = dur;
        } else list.push({ userId: e.userId, durMs: dur, outcome: e.reason || 'no_answer' });
      }
      continue;
    }
    if (e.kind === SipCallEventKind.ANSWERED && run && e.userId) {
      // The answer closes the run: credited to the person rung, «ответил Борис через 8 с».
      const a = [...run.rings.attempts].reverse().find((x) => x.userId === e.userId && (x.outcome === '' || x.outcome === 'answered'));
      const from = ringStart.get(e.userId) ?? null;
      if (a) {
        a.outcome = 'answered';
        a.durMs = from !== null && at !== null ? Math.max(0, at - from) : a.durMs;
      }
      if (a || run.rings.attempts.some((x) => x.userId === e.userId)) {
        run.rings.answeredBy = e.userId;
        run.rings.answeredAfterMs = run.at !== null && at !== null ? Math.max(0, at - run.at) : null;
      }
    }
    // Any other step ends the run; a run of one person reads «Звонит Анна», not «Звонят: Анна».
    if (run) {
      finishRun(run);
      run = null;
    }
    const kind = KIND[e.kind];
    if (!kind) continue;
    if (kind === 'transferEnd') settle(at, (u) => (u === e.userId && e.reason === 'answered' ? 'answered' : e.reason || 'no_answer'));
    if (kind === 'ended') settle(at, () => 'ended');
    if (kind === 'group') groupMode = e.reason === 'round_robin' ? 'order' : 'all';
    const isEnd = kind === 'transferEnd';
    const danger = (kind === 'ended' && isSystemFailure(e.reason)) || (kind === 'recording' && e.reason.startsWith('failed'));
    steps.push({ key: String(e.seq), kind, offsetMs: offset(at), at, nested: nested || isEnd, danger, ev: e });
    if (kind === 'transfer') nested = true;
    if (isEnd) nested = false;
    // A group's rings end with the group (a fallback / an answer); a transfer's rings are their own.
    if (kind === 'fallback' || kind === 'answered' || kind === 'ended') groupMode = null;
  }
  if (run) finishRun(run);
  return steps;
}

function finishRun(run: Step & { rings: Rings }): void {
  const people = new Set(run.rings.attempts.map((a) => a.userId));
  if (people.size <= 1) run.rings.mode = 'one';
}

// ---------------------------------------------------------------- a row of «Недавние»

export type Outcome =
  /** Inbound, somebody took it: who, how long the caller waited, how long they talked. */
  | { kind: 'answered'; by: string; waitMs: number; talkMs: number }
  /** Inbound, nobody answered (ADR-0137 §1 «Пропущенный»): the wait and where it came in. */
  | { kind: 'missed'; waitMs: number; via: string }
  /** Inbound, refused by the system before anyone (busy limit, plan…). */
  | { kind: 'refused'; reason: string }
  /** Outbound from the section or a room: who placed it; talked, or why it failed. */
  | { kind: 'outbound'; by: string; roomId: string; talkMs: number; failed: string }
  | { kind: 'test' }
  /** Going on now (the «Сейчас» block). */
  | { kind: 'live'; status: SipCallStatus; by: string; ringing: number };

const ms = (t: Parameters<typeof timestampMs>[0] | undefined): number => (t ? timestampMs(t) : 0);

export const isLiveCall = (s: SipCallStatus): boolean => s === SipCallStatus.DIALING || s === SipCallStatus.RINGING || s === SipCallStatus.ACTIVE;

/** What a row says under the name (ADR-0137 §6 «Строка 52 px»). */
export function outcomeOf(e: SipJournalEntry): Outcome {
  const c = e.call;
  if (!c) return { kind: 'test' };
  if (e.origin === SipCallOrigin.TEST) return { kind: 'test' };
  if (isLiveCall(c.status)) return { kind: 'live', status: c.status, by: c.answeredBy || (c.direction === SipCallDirection.OUT ? c.startedBy : ''), ringing: c.ringingUserIds.length };
  if (c.direction === SipCallDirection.IN) {
    if (c.answeredAt) return { kind: 'answered', by: c.answeredBy, waitMs: e.waitMs, talkMs: e.talkMs };
    if (e.missed) return { kind: 'missed', waitMs: e.waitMs, via: c.via };
    return { kind: 'refused', reason: c.reason };
  }
  const failed = c.status === SipCallStatus.FAILED ? c.reason || 'error' : !c.answeredAt ? c.reason || 'no_answer' : '';
  return { kind: 'outbound', by: c.startedBy, roomId: e.origin === SipCallOrigin.ROOM ? c.roomId : '', talkMs: e.talkMs, failed };
}

/** The direction glyph of a row: ↙ inbound, ↗ outbound, the missed-call one for a missed call. */
export function directionOf(e: SipJournalEntry): 'in' | 'out' | 'missed' {
  if (e.missed) return 'missed';
  return e.call?.direction === SipCallDirection.IN ? 'in' : 'out';
}

/** The call's start, ms (0 = unknown). */
export const startOf = (e: SipJournalEntry): number => ms(e.call?.startedAt);

/** The number a row shows: the E.164 of the outside party, else what was received ('' = a hidden number). */
export function numberOf(e: SipJournalEntry): string {
  return e.peerE164 || (e.call?.number && /^\+?\d{3,}$/.test(e.call.number) ? e.call.number : '');
}

/**
 * Can a call to this entry's number be offered (the row tap on a phone, «Позвонить» in the
 * detail)? A real number only: a hidden caller opens the detail instead (ADR-0137 §7).
 */
export const dialable = (e: SipJournalEntry): boolean => /^\+[1-9]\d{6,14}$/.test(e.peerE164);

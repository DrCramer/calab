import { timestampMs } from '@bufbuild/protobuf/wkt';
import { SipCallStatus, type SipCall } from '@calaba/protocol';
import type { MessageKey } from '../i18n/types';

/**
 * Telephony on the client (ADR-0046, docs/08 «Телефония»): the pure parts — the phone number
 * input mask and normaliser, the «which rooms have a phone line» map built from READY and
 * SIP_CALL_UPDATE, the status line of the phone participant, the «Позвонить на номер» gate and the
 * human texts of the errors. No stores, no i18n runtime here: unit-tested.
 */

// ---------------------------------------------------------------- numbers

/** E.164: «+» and 8..15 digits (the server's check is the source of truth). */
const E164 = /^\+[1-9]\d{7,14}$/;

/** Everything a person pastes around a number: spaces (incl. NBSP), dashes, dots, brackets. */
const SEPARATORS = /[\s\u00a0\u2010-\u2015\-.()]/g;

/**
 * The number as the server will dial it, or null when it is not a phone number: separators
 * dropped, a Russian national number (11 digits starting with 8 or 7) → +7…, «00…» → «+…»;
 * otherwise it needs a «+». Mirrors the server's normalisation (sip.proto PlaceSipCallRequest).
 */
export function normalizeNumber(input: string): string | null {
  const s = input.trim().replace(SEPARATORS, '');
  if (!s) return null;
  let out: string;
  if (s.startsWith('+')) out = s;
  else if (/^00\d+$/.test(s)) out = `+${s.slice(2)}`;
  else if (/^[78]\d{10}$/.test(s)) out = `+7${s.slice(1)}`;
  else return null;
  return E164.test(out) ? out : null;
}

/**
 * The dial field's mask: keeps a leading «+» and the digits (a pasted «+7 (916) 123-45-67»,
 * «8 916 123 45 67» or «Тел.: +7…» works), at most 15 digits, and shows a Russian number grouped
 * «+7 916 123-45-67» / «8 916 123-45-67»; other numbers stay «+» + digits.
 */
export function formatNumberInput(input: string): string {
  const plus = /^\s*\+/.test(input) || (!/^\s*[\d(]/.test(input) && input.includes('+'));
  const digits = input.replace(/\D/g, '').slice(0, 15);
  if (!digits) return plus ? '+' : '';
  if (plus && digits.startsWith('7')) return `+7${groupRu(digits.slice(1, 11))}`;
  if (!plus && digits.startsWith('8') && digits.length <= 11) return `8${groupRu(digits.slice(1))}`;
  return plus ? `+${digits}` : digits;
}

/**
 * One edit of the masked field: a Backspace that only removed a separator of the mask (the digits
 * are the same) removes the digit before it instead — otherwise the mask would put it back.
 */
export function maskEdit(prev: string, next: string): string {
  // An extension typed after the number («… доб. 101», «…,101»): the number keeps its mask, the
  // rest stays as typed (sip.SplitExtension checks it on the server and in the form).
  const at = extensionAt(next);
  if (at >= 0) {
    const tail = next.slice(at).trimStart().slice(0, EXT_TAIL_MAX);
    return `${formatNumberInput(next.slice(0, at))}${/^[,;]/.test(tail) ? '' : ' '}${tail}`;
  }
  const a = prev.replace(/\D/g, '');
  const b = next.replace(/\D/g, '');
  if (next.length < prev.length && a === b && b.length > 0) {
    const plus = next.trimStart().startsWith('+');
    return formatNumberInput(`${plus ? '+' : ''}${b.slice(0, -1)}`);
  }
  return formatNumberInput(next);
}

/** What the dial field keeps after the number: «доб. » and 20 keys and pauses, with room to spare. */
const EXT_TAIL_MAX = 32;

/** Characters of the number part itself: digits, «+», separators of the mask and of a paste. */
const NUMBER_CHAR = /[\d+\s\u00a0\u2010-\u2015\-.()]/;

/**
 * Where an extension begins in the dial field: the first character that cannot be part of a
 * number, after at least one digit (a pasted «Тел.: +7 …» keeps its prefix for the mask to drop).
 * -1: none.
 */
export function extensionAt(s: string): number {
  let digit = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i] ?? '';
    if (c >= '0' && c <= '9') digit = true;
    else if (digit && !NUMBER_CHAR.test(c)) return i;
  }
  return -1;
}

/** « 916 123-45-67» for up to 10 national digits (as typed so far). */
function groupRu(d: string): string {
  if (!d) return '';
  const parts = [d.slice(0, 3), d.slice(3, 6), d.slice(6, 8), d.slice(8, 10)].filter(Boolean);
  const [code = '', a, ...rest] = parts;
  return ` ${code}${a ? ` ${a}` : ''}${rest.length ? `-${rest.join('-')}` : ''}`;
}

/** An E.164 number for people: «+7 916 123-45-67» for Russia, as is otherwise. */
export function formatPhone(e164: string): string {
  if (/^\+7\d{10}$/.test(e164)) return formatNumberInput(e164);
  return e164;
}

/** The allowed prefix chips (Настройки → Телефония): «+» and 1..15 digits, e.g. «+7», «+7495». */
export function normalizePrefix(input: string): string | null {
  const d = input.replace(/\D/g, '');
  if (!d || d.length > 15) return null;
  return `+${d}`;
}

// ---------------------------------------------------------------- live calls

/** The phone line of a room as the UI needs it. */
export interface LiveSipCall {
  id: string;
  workspaceId: string;
  roomId: string;
  /** E.164. */
  number: string;
  startedBy: string;
  status: SipCallStatus;
  /** ENDED / FAILED: why (sip.proto SipCall.reason). */
  reason: string;
  /** ms; «В разговоре 02:14» counts from it (0 = not answered). */
  answeredAt: number;
  /** LiveKit identity of the line: `sip:<id>`. */
  identity: string;
  /** Keys dialed after the answer («101», «,2#»: «,» = a 2 s pause); '' = none. */
  extension: string;
}

/** roomId → the room's phone line (one per room, ADR-0046); a final one lingers briefly. */
export type SipCallMap = Readonly<Record<string, LiveSipCall>>;

export const isLiveStatus = (s: SipCallStatus): boolean =>
  s === SipCallStatus.DIALING || s === SipCallStatus.RINGING || s === SipCallStatus.ACTIVE;

export const isFinalStatus = (s: SipCallStatus): boolean => s === SipCallStatus.ENDED || s === SipCallStatus.FAILED;

/** Progress order: a late event never moves a call back (RINGING after ACTIVE, ACTIVE after ENDED). */
function rank(s: SipCallStatus): number {
  if (isFinalStatus(s)) return 3;
  if (s === SipCallStatus.ACTIVE) return 2;
  if (s === SipCallStatus.RINGING) return 1;
  return 0;
}

export function liveOf(c: SipCall): LiveSipCall {
  return {
    id: c.id,
    workspaceId: c.workspaceId,
    roomId: c.roomId,
    number: c.number,
    startedBy: c.startedBy,
    status: c.status,
    reason: c.reason,
    answeredAt: c.answeredAt ? timestampMs(c.answeredAt) : 0,
    identity: c.participantIdentity || `sip:${c.id}`,
    extension: c.extension,
  };
}

/**
 * The live calls of one workspace from its snapshot (READY / WORKSPACE_CREATE `sip_calls`, only
 * live ones): replaces what the map had for that workspace.
 */
export function withSnapshot(map: SipCallMap, workspaceId: string, calls: readonly SipCall[]): SipCallMap {
  const out: Record<string, LiveSipCall> = {};
  for (const [roomId, c] of Object.entries(map)) if (c.workspaceId !== workspaceId) out[roomId] = c;
  for (const c of calls) if (c.roomId && isLiveStatus(c.status)) out[c.roomId] = liveOf(c);
  return out;
}

/**
 * SIP_CALL_UPDATE (or a POST / DELETE answer): one line per room. A newer live call replaces the
 * room's entry; the same call only moves forward; a final status is kept (the row shows
 * «Завершён · причина» until `withoutCall`); a final event of another call is ignored. Connection
 * tests (no room) never reach the map. Returns the same map when nothing changed.
 */
export function withEvent(map: SipCallMap, c: SipCall): SipCallMap {
  if (!c.roomId) return map;
  const cur = map[c.roomId];
  if (cur && cur.id === c.id) {
    if (rank(c.status) < rank(cur.status)) return map;
    const next = liveOf(c);
    if (next.status === cur.status && next.answeredAt === cur.answeredAt && next.reason === cur.reason) return map;
    return { ...map, [c.roomId]: next };
  }
  if (!isLiveStatus(c.status)) return map;
  // Another call of the room: a new live one takes the place of a lingering final one (or of a
  // live one the server has meanwhile ended without us seeing it — one live call per room).
  return { ...map, [c.roomId]: liveOf(c) };
}

/** Drops a room's line when it is still this call (the linger timer of a final status). */
export function withoutCall(map: SipCallMap, roomId: string, callId: string): SipCallMap {
  if (map[roomId]?.id !== callId) return map;
  const { [roomId]: _gone, ...rest } = map;
  return rest;
}

/** Drops rooms (deleted room, left workspace). */
export function withoutRooms(map: SipCallMap, drop: (roomId: string, c: LiveSipCall) => boolean): SipCallMap {
  const entries = Object.entries(map).filter(([id, c]) => !drop(id, c));
  return entries.length === Object.keys(map).length ? map : Object.fromEntries(entries);
}

/** How long a finished line stays in the list with «Завершён · причина». */
export const ENDED_LINGER_MS = 6000;

// ---------------------------------------------------------------- texts

/** The reason of a final status → its text key (sip.proto SipCall.reason). */
export function reasonKey(status: SipCallStatus, reason: string): MessageKey {
  const r = reason.startsWith('error') ? 'error' : reason;
  switch (r) {
    case 'hangup':
      return 'sip.reason.hangup';
    case 'hangup_moderator':
      return 'sip.reason.moderator';
    case 'cancelled':
      return 'sip.reason.cancelled';
    case 'remote':
      return 'sip.reason.remote';
    case 'empty':
      return 'sip.reason.empty';
    case 'room_closed':
      return 'sip.reason.roomClosed';
    case 'disabled':
      return 'sip.reason.disabled';
    case 'lost':
      return 'sip.reason.lost';
    case 'busy':
      return 'sip.reason.busy';
    case 'no_answer':
      return 'sip.reason.noAnswer';
    case 'declined':
      return 'sip.reason.declined';
    case 'invalid_number':
      return 'sip.reason.invalidNumber';
    case 'provider_auth':
      return 'sip.reason.providerAuth';
    case 'unavailable':
      return 'sip.reason.unavailable';
    case 'error':
      return 'sip.reason.error';
    default:
      return status === SipCallStatus.FAILED ? 'sip.reason.error' : 'sip.reason.hangup';
  }
}

/** The SIP code of an «error 503» reason (the journal shows it), '' otherwise. */
export const reasonCode = (reason: string): string => /^error\s+(\d{3})$/.exec(reason)?.[1] ?? '';

/**
 * The phone participant's status line: «Набираем…» (RINGING may never come — ADR-0046), «Звонит…»,
 * «В разговоре» (+ the timer leaf), «Завершён · причина».
 */
export function statusKey(status: SipCallStatus): MessageKey {
  switch (status) {
    case SipCallStatus.RINGING:
      return 'sip.status.ringing';
    case SipCallStatus.ACTIVE:
      return 'sip.status.active';
    case SipCallStatus.ENDED:
    case SipCallStatus.FAILED:
      return 'sip.status.ended';
    default:
      return 'sip.status.dialing';
  }
}

/**
 * The one toast a finished call gets in the room's call: FAILED — why nobody answered
 * («Абонент не ответил», «Не дозвонились: занято»…); ENDED — «Звонок завершён». A call I ended
 * myself with «Завершить» says nothing (I pressed the button).
 */
export function endToast(c: Pick<LiveSipCall, 'status' | 'reason'>, endedByMe: boolean): { key: MessageKey; reason?: MessageKey } | null {
  if (c.status === SipCallStatus.FAILED) return c.reason === 'no_answer' ? { key: 'sip.toast.noAnswer' } : { key: 'sip.toast.failed', reason: reasonKey(c.status, c.reason) };
  if (c.status !== SipCallStatus.ENDED) return null;
  if (endedByMe && (c.reason === 'hangup' || c.reason === 'cancelled' || c.reason === 'hangup_moderator')) return null;
  return { key: 'sip.toast.ended' };
}

/** Whole-call duration for the journal: «2:14», '' when never answered. */
export function callDurationMs(c: { answeredAt?: number; endedAt?: number }): number {
  if (!c.answeredAt || !c.endedAt) return 0;
  return Math.max(0, c.endedAt - c.answeredAt);
}

// ---------------------------------------------------------------- who may

/**
 * «Позвонить на номер» (ADR-0046 «Контракт для клиента»): telephony on in the workspace,
 * PLACE_CALLS (+ VIEW_ROOM, CONNECT) in the room, not a guest, I am in this room's call, and the
 * room has no live line. The client only hides the button — the server checks all of it.
 */
export function mayDial(a: { sipEnabled: boolean; placeCalls: boolean; connect: boolean; guest: boolean; inCall: boolean; liveCall: boolean }): boolean {
  return a.sipEnabled && a.placeCalls && a.connect && !a.guest && a.inCall && !a.liveCall;
}

/** «Завершить»: the caller, or MUTE_MEMBERS in the room (the server's DELETE rule); a live line only. */
export function mayHangUp(a: { me: string; startedBy: string; muteMembers: boolean; live: boolean }): boolean {
  return a.live && (a.muteMembers || (!!a.me && a.me === a.startedBy));
}

/**
 * The tone keypad of a room's phone line (ADR-0046 addendum «Тональный набор»): the same people
 * as «Завершить» — the caller or MUTE_MEMBERS — while the line is answered and I am in this
 * room's call (the tones go from my connection). The client only hides the button; livekit/sip
 * cannot check the sender of a tone (see the ADR).
 */
export function mayKeypad(a: { me: string; startedBy: string; muteMembers: boolean; active: boolean; inCall: boolean }): boolean {
  return a.active && a.inCall && (a.muteMembers || (!!a.me && a.me === a.startedBy));
}

// ---------------------------------------------------------------- extension

/** The pause a «,» (and the marker itself) stands for, like a phone's «,». */
export const EXT_PAUSE_MS = 2000;
/** Between two keys of an extension: a tone (RFC 2833, ~100 ms) and a gap the far end can count. */
export const EXT_KEY_GAP_MS = 400;

/**
 * The extension as tones: each key with the wait before it. The first key waits the marker's
 * pause after the answer (plus a pause per leading «,»); the next ones EXT_KEY_GAP_MS, or a pause
 * per «,» between them. «,1,2» → [1 after 4 s, 2 after 2 s].
 */
export function extensionPlan(ext: string): Array<{ key: string; waitMs: number }> {
  const out: Array<{ key: string; waitMs: number }> = [];
  let wait = EXT_PAUSE_MS;
  let afterKey = false;
  for (const c of ext) {
    if (c === ',') {
      // After a key a pause replaces the gap; before the first key pauses add up.
      wait = (afterKey ? 0 : wait) + EXT_PAUSE_MS;
      afterKey = false;
    } else if (/^[0-9*#]$/.test(c)) {
      out.push({ key: c, waitMs: wait });
      wait = EXT_KEY_GAP_MS;
      afterKey = true;
    }
  }
  return out;
}

/** «101» for «доб. 101» on the line (the pauses are not shown). */
export const extensionLabel = (ext: string): string => ext.replace(/,/g, '');

/**
 * A refused dial → the inline text under the number (sip.proto PlaceSipCallRequest errors); null
 * = no specific text (the generic error mapping). Structural: lib/api/client pulls in the
 * platform layer, which unit tests lack.
 */
export function dialErrorKey(e: unknown): MessageKey | null {
  if (!(e instanceof Error) || !('code' in e) || !('status' in e)) return null;
  const { code, status } = e as { code: unknown; status: unknown };
  switch (code) {
    case 'ERROR_CODE_SIP_DISABLED':
      return 'sip.err.disabled';
    case 'ERROR_CODE_SIP_CALL_ACTIVE':
      return 'sip.err.active';
    case 'ERROR_CODE_SIP_NUMBER_NOT_ALLOWED':
      return 'sip.err.notAllowed';
    case 'ERROR_CODE_SIP_RATE_LIMITED':
      return 'sip.err.rate';
    case 'ERROR_CODE_SIP_PROVIDER_ERROR':
      return 'sip.err.provider';
    case 'ERROR_CODE_VALIDATION':
      return 'sip.err.number';
    case 'ERROR_CODE_CONFLICT':
      // 409 PLAN_LIMIT: telephony is Business only (ADR-0046, owner 02.10).
      return (e as { extra?: { reason?: string } }).extra?.reason === 'PLAN_LIMIT' ? 'plan.telephonyLocked' : 'sip.err.notInCall';
    case 'ERROR_CODE_FORBIDDEN':
      return 'sip.err.forbidden';
    default:
      return status === 429 ? 'sip.err.rate' : null;
  }
}

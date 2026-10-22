import { SipCallDirection, SipCallStatus, type JoinVoiceResponse, type SipCall } from '@calaba/protocol';

/**
 * Inbound phone calls on this device (ADR-0117 §7): the pure part — which inbound calls ring me
 * and which one I took, from SIP_INBOUND_RING / SIP_CALL_UPDATE / READY (`sip_calls` of a
 * workspace). The voice session of a taken call is a «phone room» `sipin:<call id>`: the voice
 * engine joins it like a room, its token comes from POST /api/sip/inbound/{cid}/join instead of
 * the room's /join (services/voice.ts), and it is in no workspace's voice list.
 */

export const PHONE_ROOM_PREFIX = 'sipin:';

/** The voice session of inbound call `callId`. */
export function phoneRoomId(callId: string): string {
  return PHONE_ROOM_PREFIX + callId;
}

export function isPhoneRoom(roomId: string | null | undefined): roomId is string {
  return !!roomId && roomId.startsWith(PHONE_ROOM_PREFIX);
}

/** The call of a phone room ('' for any other room). */
export function phoneCallId(roomId: string): string {
  return isPhoneRoom(roomId) ? roomId.slice(PHONE_ROOM_PREFIX.length) : '';
}

/** The join answer of an accept, used once by the voice engine's first /join of that room. */
const pendingJoins = new Map<string, JoinVoiceResponse>();

export function setPhoneJoin(roomId: string, join: JoinVoiceResponse): void {
  pendingJoins.set(roomId, join);
}

export function takePhoneJoin(roomId: string): JoinVoiceResponse | undefined {
  const j = pendingJoins.get(roomId);
  pendingJoins.delete(roomId);
  return j;
}

export interface InboundState {
  /** Calls that ring me now, oldest first. */
  ringing: readonly SipCall[];
  /** The call I answered (ACTIVE), if any. */
  active: SipCall | null;
}

export const NO_INBOUND: InboundState = { ringing: [], active: null };

const LIVE = new Set<SipCallStatus>([SipCallStatus.DIALING, SipCallStatus.RINGING, SipCallStatus.ACTIVE]);

/**
 * One inbound call's news for user `me`. A ringing call stays in `ringing` while `me` is in its
 * ringing_user_ids; the call I answered is `active` until it ends. A late RINGING of a call
 * already active here (the ring event after the accept answer) changes nothing. Same state back
 * when nothing changed.
 */
export function applyInbound(s: InboundState, c: SipCall, me: string): InboundState {
  if (c.direction !== SipCallDirection.IN || !me) return s;
  if (s.active?.id === c.id && c.status === SipCallStatus.RINGING) return s;
  const live = LIVE.has(c.status);
  const ringsMe = live && c.status !== SipCallStatus.ACTIVE && c.ringingUserIds.includes(me);
  const mine = live && c.status === SipCallStatus.ACTIVE && c.answeredBy === me;
  const had = s.ringing.findIndex((x) => x.id === c.id);
  let ringing = s.ringing;
  if (had >= 0 && !ringsMe) ringing = ringing.filter((x) => x.id !== c.id);
  else if (had >= 0 && ringsMe) ringing = ringing.map((x) => (x.id === c.id ? c : x));
  else if (ringsMe) ringing = [...ringing, c];
  let active = s.active;
  if (mine) active = c;
  else if (active?.id === c.id) active = null;
  if (ringing === s.ringing && active === s.active) return s;
  return { ringing, active };
}

/** READY: the inbound calls of every workspace snapshot (anything known before is replaced). */
export function inboundOf(calls: readonly SipCall[], me: string): InboundState {
  let s = NO_INBOUND;
  for (const c of calls) s = applyInbound(s, c, me);
  return s;
}

import { SipCallStatus, type SipCall, type WorkspaceSnapshot } from '@calaba/protocol';
import { t, type MessageKey } from '../i18n';
import { ApiError } from '../lib/api/client';
import { api } from '../lib/api/endpoints';
import { haptics } from '../lib/haptics';
import { log } from '../lib/log';
import { reasonKey } from '../lib/sip';
import { dropPhoneJoin, isPhoneRoom, personalRoomId, setPhoneJoin } from '../lib/sipInbound';
import { applyOutbound, isDialing, isLivePersonal } from '../lib/sipOutbound';
import { currentRing, startRing, stopRing } from '../lib/sounds';
import { useCall } from '../stores/call';
import { useSipInbound } from '../stores/sipInbound';
import { useSipOutbound } from '../stores/sipOutbound';
import { toast } from '../stores/toasts';
import { useVoice } from '../stores/voice';
import { voice } from './voice';

/**
 * A personal call from «Телефония» (ADR-0137 §3) — the mirror of an accepted inbound call
 * (services/sipInbound.ts): POST …/sip/calls gives the call (DIALING) and the token of its own
 * room `sipout:<call>`; the room I am in is parked (ADR-0133) and I join the call's room with the
 * microphone on voice activation (voice.join `call: true`); the server dials the number once I am
 * in. Until the answer the ring-back `call-outgoing` plays through a plain <audio> (docs/02 echo
 * rules unchanged). SIP_CALL_UPDATE moves the call; a final status leaves its voice session (the
 * parked room comes back), FAILED says why. Leaving the session from the band hangs up. One call at
 * a time: none while a one-to-one or an inbound phone call goes on, nor a second one.
 */

export interface PersonalTarget {
  workspaceId: string;
  /** As typed / as stored (the server normalises it, ADR-0137 §2). */
  number: string;
  /** The contact called (the number must be one of its numbers). */
  contactId?: string;
  /** The name the band shows until the server's caller ID arrives. */
  name?: string;
}

/** Calls I hung up from this device: no second DELETE, no «ended» toast for my own button. */
const hungUp = new Set<string>();

function setCall(next: SipCall | null): void {
  const prev = useSipOutbound.getState().call;
  if (next === prev) return;
  useSipOutbound.setState({ call: next });
  effects(next);
}

function effects(next: SipCall | null): void {
  // The ring-back plays while the line dials, never over another ringing (a one-to-one call's).
  if (isDialing(next)) {
    if (!currentRing()) startRing('call-outgoing');
  } else if (currentRing() === 'call-outgoing' && useCall.getState().phase === 'idle') stopRing();
  if (!next || isLivePersonal(next)) return;
  // Over: out of its voice session (the parked room comes back, services/voice.ts), the token goes.
  const room = personalRoomId(next.id);
  const byMe = hungUp.has(next.id);
  dropPhoneJoin(room);
  if (useVoice.getState().roomId === room || useVoice.getState().joining?.roomId === room) {
    hungUp.add(next.id);
    void voice.leave();
  }
  if (next.status === SipCallStatus.FAILED && !byMe) {
    haptics.impact();
    toast.info(t('telc.call.failed', { reason: t(reasonKey(SipCallStatus.FAILED, next.reason)) }));
  }
  // The final call goes from the store at once: the band has nothing to show after the leave.
  useSipOutbound.setState({ call: null, name: '' });
}

/** Another call goes on here: a one-to-one call, an inbound phone call, or my personal call. */
export function phoneBusyHere(): boolean {
  const s = useSipOutbound.getState();
  if (s.placing || isLivePersonal(s.call)) return true;
  if (useCall.getState().phase !== 'idle' || useSipInbound.getState().active) return true;
  return isPhoneRoom(useVoice.getState().roomId);
}

/** A refused POST → the text of the toast (sip.proto PlaceSipPersonalCallRequest errors). */
export function placeErrorKey(e: unknown): MessageKey {
  if (!(e instanceof ApiError)) return 'telc.err.failed';
  switch (e.code) {
    case 'ERROR_CODE_SIP_BUSY':
      return 'telc.err.busy';
    case 'ERROR_CODE_SIP_NUMBER_NOT_ALLOWED':
      return 'sip.err.notAllowed';
    case 'ERROR_CODE_SIP_RATE_LIMITED':
    case 'ERROR_CODE_RATE_LIMITED':
      return 'sip.err.rate';
    case 'ERROR_CODE_SIP_DISABLED':
      return 'sip.err.disabled';
    case 'ERROR_CODE_FORBIDDEN':
      return 'telc.err.forbidden';
    case 'ERROR_CODE_VALIDATION':
      return 'telc.err.number';
    case 'ERROR_CODE_PLAN_LIMIT':
      return 'plan.telephonyLocked';
    case 'ERROR_CODE_CONFLICT':
      return e.reason === 'PLAN_LIMIT' ? 'plan.telephonyLocked' : 'telc.err.failed';
    default:
      return e.status === 429 ? 'sip.err.rate' : 'telc.err.failed';
  }
}

/**
 * «Позвонить» a number from the section (a row, the detail, a contact, the dial pad). Returns
 * whether the call was placed (its voice session then connects; the band follows it).
 */
export async function placePersonalCall(target: PersonalTarget): Promise<boolean> {
  if (phoneBusyHere()) {
    toast.info(t('telc.err.inCall'));
    return false;
  }
  haptics.impact();
  useSipOutbound.setState({ placing: true, name: target.name ?? '' });
  try {
    const r = await api.sip.placePersonal(target.workspaceId, { number: target.number, ...(target.contactId ? { contactId: target.contactId } : {}) });
    const c = r.call;
    if (!c) throw new Error('no call in the answer');
    const room = personalRoomId(c.id);
    if (r.join) setPhoneJoin(room, r.join);
    useSipOutbound.setState({ call: c, placing: false });
    effects(c);
    // The room I am in is parked (ADR-0133), as for an accepted inbound call; what cannot be
    // parked (a one-to-one call is refused above) is left.
    const v = useVoice.getState();
    if (v.roomId && v.roomId !== room && !isPhoneRoom(v.roomId) && !(await voice.park())) await voice.leave();
    voice.unmuteForAnswer(); // an explicit call: a muted / deafened user talks
    // The call may have ended meanwhile (refused at once): no session for a call that is over.
    if (useSipOutbound.getState().call?.id !== c.id) return true;
    await voice.join(room, '', { call: true });
    return true;
  } catch (e) {
    log.warn('sip outbound: place failed', e);
    toast.error(t(placeErrorKey(e)));
    useSipOutbound.setState({ placing: false, name: '' });
    return false;
  }
}

/** «Завершить» (the calling screen, the band) or its voice session ended here. */
export async function hangupPersonal(): Promise<void> {
  const c = useSipOutbound.getState().call;
  if (!c || hungUp.has(c.id)) return;
  hungUp.add(c.id);
  try {
    const r = await api.sip.hangupPersonal(c.workspaceId, c.id);
    if (r.call) setCall(applyOutbound(useSipOutbound.getState().call, r.call));
  } catch (e) {
    // 409: already over; 404: gone. The server ends a call whose caller is away 30 s anyway.
    if (!(e instanceof ApiError && (e.status === 409 || e.status === 404))) log.warn('sip outbound: hang up failed', e);
  }
  // Whatever the answer: it is over here.
  const cur = useSipOutbound.getState().call;
  if (cur?.id === c.id) setCall({ ...cur, status: SipCallStatus.ENDED, reason: 'hangup' });
}

/** A tone digit to the line (the band's keypad); false when the call cannot take it now. */
export function sendDtmf(digit: string): boolean {
  const c = useSipOutbound.getState().call;
  if (!c || c.status !== SipCallStatus.ACTIVE) return false;
  return voice.publishDtmf(digit, c.participantIdentity || `sip:${c.id}`);
}

// ---------------------------------------------------------------- gateway

/** SIP_CALL_UPDATE of a personal call (services/sip.ts routes it here). */
export function onPersonalCallUpdate(c: SipCall): void {
  setCall(applyOutbound(useSipOutbound.getState().call, c));
}

/** READY: my followed call is in a snapshot (it goes on) or it ended while I was away. */
export function resetOutbound(snaps: readonly WorkspaceSnapshot[]): void {
  const cur = useSipOutbound.getState().call;
  if (!cur) return;
  const live = snaps.flatMap((s) => s.sipCalls).find((x) => x.id === cur.id);
  setCall(live ? applyOutbound(cur, live) : { ...cur, status: SipCallStatus.ENDED, reason: 'lost' });
}

let installed = false;

/** Once per app: leaving a personal call's voice session hangs that call up. */
export function installSipOutbound(): void {
  if (installed) return;
  installed = true;
  // Only a room change matters (the voice store changes many times a second: levels).
  useVoice.subscribe((s, p) => {
    if (s.roomId === p.roomId || !p.roomId) return;
    const c = useSipOutbound.getState().call;
    if (c && p.roomId === personalRoomId(c.id) && !hungUp.has(c.id) && isLivePersonal(c)) void hangupPersonal();
  });
}

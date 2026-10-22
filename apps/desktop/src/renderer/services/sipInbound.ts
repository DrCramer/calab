import { PresenceStatus, type SipCall, type WorkspaceSnapshot } from '@calaba/protocol';
import { t } from '../i18n';
import { ApiError } from '../lib/api/client';
import { api } from '../lib/api/endpoints';
import { holdNotification } from '../lib/notifyHold';
import { log } from '../lib/log';
import { formatPhone } from '../lib/sip';
import { applyInbound, inboundOf, isPhoneRoom, phoneCallId, phoneRoomId, setPhoneJoin, type InboundState } from '../lib/sipInbound';
import { currentRing, startRing, stopRing } from '../lib/sounds';
import { platform } from '../platform';
import { useCall } from '../stores/call';
import { prefs } from '../stores/prefs';
import { myUserId } from '../stores/session';
import { useSipInbound } from '../stores/sipInbound';
import { toast } from '../stores/toasts';
import { useVoice } from '../stores/voice';
import { voice } from './voice';

/**
 * Inbound phone calls on this device (ADR-0117 §7, docs/08 «Звонок»): SIP_INBOUND_RING,
 * SIP_CALL_UPDATE of inbound calls and READY feed stores/sipInbound (lib/sipInbound.ts); the
 * effects of a change — the incoming ringtone (`call-incoming`, silent on «Не беспокоить», never
 * over a one-to-one call's own ringing), a system notification while the window is hidden, and the
 * call's voice session: «Принять» takes it (the room I am in is left first, like a DM call), the
 * session is the phone room `sipin:<call>` with the microphone on voice activation only
 * (voice.join `call: true`). Leaving that session (the panel's hang-up, another room) hangs up.
 */

function set(next: InboundState): void {
  const prev = useSipInbound.getState();
  if (next.ringing === prev.ringing && next.active === prev.active) return;
  useSipInbound.setState({ ringing: next.ringing, active: next.active });
  effects(prev, next);
}

function effects(prev: InboundState, next: InboundState): void {
  syncRing();
  const first = next.ringing[0];
  if (first && first.id !== prev.ringing[0]?.id) notify(first);
  if (!first) closeNotice();
  // Over (the caller hung up, the call was lost): out of its voice session.
  const was = prev.active;
  if (was && next.active?.id !== was.id && useVoice.getState().roomId === phoneRoomId(was.id)) {
    hungUp.add(was.id);
    void voice.leave();
  }
}

/** The ringtone while something rings me — unless a one-to-one call already rings or talks. */
function syncRing(): void {
  const ringing = useSipInbound.getState().ringing.length > 0;
  const dm = useCall.getState().phase !== 'idle';
  if (ringing && !dm) {
    if (prefs().presence !== PresenceStatus.DND) startRing('call-incoming');
  } else if (!dm && currentRing() === 'call-incoming') stopRing();
}

/** Something of mine rings (a one-to-one call's service keeps the ringtone then). */
export function sipInboundRinging(): boolean {
  return useSipInbound.getState().ringing.length > 0;
}

let notice: Notification | null = null;

function notify(c: SipCall): void {
  platform.app.attention();
  if (document.visibilityState === 'visible' && document.hasFocus()) return;
  if (prefs().presence === PresenceStatus.DND) return;
  try {
    closeNotice();
    const n = holdNotification(new Notification(t('call.sipNotify', { number: c.number ? formatPhone(c.number) : t('call.sipUnknown') }), {
      tag: `sipin:${c.id}`,
      silent: true,
      requireInteraction: true,
    }));
    n.onclick = () => {
      window.focus();
      n.close();
    };
    notice = n;
  } catch {
    // notifications unavailable
  }
}

function closeNotice(): void {
  notice?.close();
  notice = null;
}

// ---------------------------------------------------------------- gateway

/** SIP_INBOUND_RING. */
export function onSipInboundRing(c: SipCall | undefined): void {
  if (c) set(applyInbound(useSipInbound.getState(), c, myUserId()));
}

/** SIP_CALL_UPDATE of an inbound call (outbound ones belong to services/sip.ts). */
export function onInboundCallUpdate(c: SipCall): void {
  set(applyInbound(useSipInbound.getState(), c, myUserId()));
}

/** READY: the inbound calls in every workspace snapshot. */
export function resetInbound(snaps: readonly WorkspaceSnapshot[]): void {
  set(inboundOf(snaps.flatMap((s) => s.sipCalls), myUserId()));
}

/** WORKSPACE_CREATE: its inbound calls (none, in practice: a new member has no number yet). */
export function applySnapshotInbound(snap: WorkspaceSnapshot): void {
  let s: InboundState = useSipInbound.getState();
  for (const c of snap.sipCalls) s = applyInbound(s, c, myUserId());
  set(s);
}

// ---------------------------------------------------------------- actions

/** Calls I ended (or whose session I left) from this device: no second DELETE. */
const hungUp = new Set<string>();

function busy(on: boolean): void {
  useSipInbound.setState({ busy: on });
}

/** «Принять»: the call is mine; its voice session starts (the room I am in is left first). */
export async function acceptInbound(callId: string): Promise<void> {
  if (useSipInbound.getState().busy) return;
  busy(true);
  try {
    const r = await api.sip.acceptInbound(callId);
    const room = phoneRoomId(callId);
    if (r.join) setPhoneJoin(room, r.join);
    if (r.call) set(applyInbound(useSipInbound.getState(), r.call, myUserId()));
    const v = useVoice.getState();
    if (v.roomId && v.roomId !== room) await voice.leave();
    await voice.join(room, '', { call: true });
  } catch (e) {
    log.warn('sip inbound: accept failed', e);
    toast.error(e instanceof ApiError && (e.status === 409 || e.status === 404) ? t('call.sipTaken') : t('call.sipFailed'));
    // The call may have moved on: drop it here; the server's next event tells the truth.
    const s = useSipInbound.getState();
    set({ ringing: s.ringing.filter((c) => c.id !== callId), active: s.active });
  } finally {
    busy(false);
  }
}

/** «Отклонить» (this user stops ringing; the route goes on for the others). */
export async function declineInbound(callId: string): Promise<void> {
  if (useSipInbound.getState().busy) return;
  busy(true);
  const s = useSipInbound.getState();
  set({ ringing: s.ringing.filter((c) => c.id !== callId), active: s.active });
  try {
    await api.sip.declineInbound(callId);
  } catch (e) {
    log.warn('sip inbound: decline failed', e);
  } finally {
    busy(false);
  }
}

/** Hang up the call I took (the strip's «Завершить», or its voice session ended here). */
export async function hangupInbound(callId: string): Promise<void> {
  if (hungUp.has(callId)) return;
  hungUp.add(callId);
  try {
    const r = await api.sip.hangupInbound(callId);
    if (r.call) set(applyInbound(useSipInbound.getState(), r.call, myUserId()));
  } catch (e) {
    // 409: already over. The server ends a call whose member stays away 30 s anyway.
    if (!(e instanceof ApiError && e.status === 409)) log.warn('sip inbound: hang up failed', e);
  }
  if (useVoice.getState().roomId === phoneRoomId(callId)) await voice.leave();
}

let installed = false;

/** Once per app: leaving a phone room's voice session hangs that call up. */
export function installSipInbound(): void {
  if (installed) return;
  installed = true;
  // Only a room change matters (the voice store changes many times a second: levels).
  useVoice.subscribe((s, p) => {
    if (s.roomId === p.roomId || !isPhoneRoom(p.roomId)) return;
    const id = phoneCallId(p.roomId);
    if (useSipInbound.getState().active?.id === id && !hungUp.has(id)) void hangupInbound(id);
  });
  useCall.subscribe((s, p) => {
    if (s.phase !== p.phase) syncRing();
  });
}

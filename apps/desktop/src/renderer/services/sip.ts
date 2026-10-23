import { SipCallDirection, SipCallStatus, type SipCall, type WorkspaceSnapshot } from '@calaba/protocol';
import { t } from '../i18n';
import { ApiError } from '../lib/api/client';
import { describeError } from '../lib/api/errors';
import { api } from '../lib/api/endpoints';
import { currentRing, startRing, stopRing } from '../lib/sounds';
import {
  ENDED_LINGER_MS,
  dialErrorKey,
  endToast,
  isFinalStatus,
  normalizeNumber,
  withEvent,
  withSnapshot,
  withoutCall,
  withoutRooms,
  type LiveSipCall,
  type SipCallMap,
} from '../lib/sip';
import { myUserId } from '../stores/session';
import { useSipCalls } from '../stores/sipCalls';
import { toast } from '../stores/toasts';
import { useVoice } from '../stores/voice';
import { applySnapshotInbound, onInboundCallUpdate, resetInbound } from './sipInbound';

/**
 * Telephony on the client (ADR-0046): the server's phone lines (READY / WORKSPACE_CREATE
 * `sip_calls[]`, SIP_CALL_UPDATE) → stores/sipCalls; «Позвонить на номер» and «Завершить» with
 * human errors; the ring-back tone for the caller while the line dials (a plain <audio>, docs/02 —
 * lib/sounds startRing) and one toast when a call of my room ends.
 */

/** READY: the live lines of every workspace (anything known before is dropped). */
export function resetSipCalls(snaps: readonly WorkspaceSnapshot[]): void {
  let map: SipCallMap = {};
  for (const s of snaps) if (s.workspace) map = withSnapshot(map, s.workspace.id, s.sipCalls);
  commit(map);
  resetInbound(snaps); // inbound calls that ring me / I took (ADR-0117)
}

/** WORKSPACE_CREATE (joined a workspace): its live lines. */
export function applySnapshotSipCalls(snap: WorkspaceSnapshot): void {
  if (!snap.workspace) return;
  applySnapshotInbound(snap);
  commit(withSnapshot(useSipCalls.getState().byRoom, snap.workspace.id, snap.sipCalls));
}

/** SIP_CALL_UPDATE, and the answers of POST / DELETE (the same call, whichever comes first). */
export function onSipCallUpdate(call: SipCall | undefined): void {
  if (!call) return;
  if (call.direction === SipCallDirection.IN) {
    onInboundCallUpdate(call);
    return;
  }
  commit(withEvent(useSipCalls.getState().byRoom, call));
}

/** A deleted room / a workspace I left. */
export function dropSipCalls(drop: (roomId: string, c: LiveSipCall) => boolean): void {
  commit(withoutRooms(useSipCalls.getState().byRoom, drop));
}

/** Calls whose end was already announced (the DELETE answer and the event are the same end). */
const announced = new Set<string>();
/** Calls I hung up from this device: no «Звонок завершён» for my own button. */
const hungUpByMe = new Set<string>();

function commit(next: SipCallMap): void {
  const prev = useSipCalls.getState().byRoom;
  if (next === prev) return;
  useSipCalls.getState().set(next);
  for (const [roomId, c] of Object.entries(next)) {
    if (!isFinalStatus(c.status) || prev[roomId] === c) continue;
    // A final status stays in the list briefly («Завершён · причина»), then goes.
    window.setTimeout(() => {
      const cur = useSipCalls.getState().byRoom;
      const out = withoutCall(cur, roomId, c.id);
      if (out !== cur) useSipCalls.getState().set(out);
    }, ENDED_LINGER_MS);
    announceEnd(c);
  }
  syncRingback();
}

/** One toast per finished call, only for those in that room's call. */
function announceEnd(c: LiveSipCall): void {
  if (announced.has(c.id)) return;
  announced.add(c.id);
  if (useVoice.getState().roomId !== c.roomId) return;
  const m = endToast(c, hungUpByMe.has(c.id));
  if (m) toast.info(m.reason ? t(m.key, { reason: t(m.reason) }) : t(m.key));
}

// ---------------------------------------------------------------- ring-back

let ringingFor: string | null = null;

/**
 * The caller hears the local ring-back (`call-outgoing`, ADR-0034's file) while their line is
 * DIALING / RINGING and they are in that room's call; it stops when the line answers or ends, or
 * when they leave the room. Nobody else hears it (the provider's own early media, if any, comes
 * through the line's track to everyone).
 */
function syncRingback(): void {
  const { roomId } = useVoice.getState();
  const c = roomId ? useSipCalls.getState().byRoom[roomId] : undefined;
  const me = myUserId();
  const want = c && me && c.startedBy === me && (c.status === SipCallStatus.DIALING || c.status === SipCallStatus.RINGING) ? c.id : null;
  if (want === ringingFor) return;
  if (ringingFor && currentRing() === 'call-outgoing') stopRing();
  ringingFor = want;
  if (want) startRing('call-outgoing');
}

let started = false;

/** Subscribes the ring-back to my room (app start; idempotent). */
export function startSipSync(): void {
  if (started) return;
  started = true;
  // Only a room change matters (the voice store changes many times a second: levels).
  useVoice.subscribe((s, p) => {
    if (s.roomId !== p.roomId) syncRingback();
  });
}

// ---------------------------------------------------------------- actions

/**
 * «Позвонить на номер»: POST /api/rooms/{id}/calls. null = placed (the row follows the call); a
 * string = the inline error under the number.
 */
export async function placeSipCall(roomId: string, input: string): Promise<string | null> {
  // The server normalises too; this only catches what is certainly not a number.
  const number = normalizeNumber(input) ?? input.trim();
  if (!number) return t('sip.err.number');
  try {
    const r = await api.sip.place(roomId, number);
    onSipCallUpdate(r.call);
    return null;
  } catch (e) {
    const key = dialErrorKey(e);
    if (key === 'sip.err.rate' && e instanceof ApiError && e.retryAfter) {
      return t('sip.err.rateIn', { min: Math.max(1, Math.ceil(e.retryAfter / 60)) });
    }
    if (key === 'sip.err.provider' && e instanceof ApiError && e.message) return `${t(key)}: ${e.message}`;
    return key ? t(key) : describeError(e).text;
  }
}

/** «Завершить»: DELETE …/calls/{cid}; 409 — already over (the event follows). */
export async function hangUpSipCall(roomId: string, callId: string): Promise<void> {
  hungUpByMe.add(callId);
  try {
    const r = await api.sip.hangup(roomId, callId);
    onSipCallUpdate(r.call);
  } catch (e) {
    if (e instanceof ApiError && (e.code === 'ERROR_CODE_CONFLICT' || e.status === 404)) return;
    hungUpByMe.delete(callId);
    toast.fail(e, t('sip.hangupFailed'));
  }
}

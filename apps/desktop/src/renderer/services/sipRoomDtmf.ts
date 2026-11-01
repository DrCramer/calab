import { SipCallStatus } from '@calaba/protocol';
import { extensionPlan, type LiveSipCall } from '../lib/sip';
import { useSipCalls } from '../stores/sipCalls';
import { useVoice } from '../stores/voice';
import { voice } from './voice';

/**
 * Tones on a voice room's phone line (ADR-0046 addendum «Тональный набор»): the keypad's keys and
 * the extension dialed after the number («доб. 101»). Each key goes to that one line only
 * (voice.publishDtmf → a SipDTMF addressed to the line's identity). The extension is sent once,
 * by the device that placed the call, when the line answers; nothing runs otherwise.
 */

/**
 * A key to the room's answered line (`callId`: only while that call is the room's line) from my
 * connection in that room; false = not now.
 */
export function sendRoomDtmf(roomId: string, key: string, callId?: string): boolean {
  const c = useSipCalls.getState().byRoom[roomId];
  if (!c || c.status !== SipCallStatus.ACTIVE || (callId && c.id !== callId) || useVoice.getState().roomId !== roomId) return false;
  return voice.publishDtmf(key, c.identity);
}

/** Calls placed from this device with an extension still to send: call id → extension. */
const pending = new Map<string, string>();
/** The running extension: its call and the timer of the next key. */
let run: { callId: string; timer: ReturnType<typeof setTimeout> } | null = null;

/** «Позвонить на номер» answered 201 with an extension: send it once the line answers. */
export function expectExtension(c: LiveSipCall): void {
  if (!c.extension) return;
  pending.set(c.id, c.extension);
  // The answer may have come over the gateway before this response.
  const cur = useSipCalls.getState().byRoom[c.roomId];
  onRoomCall(cur?.id === c.id ? cur : c);
}

/** Every change of a room's line (services/sip commit): start or stop the extension. */
export function onRoomCall(c: LiveSipCall): void {
  if (c.status === SipCallStatus.ACTIVE) {
    const ext = pending.get(c.id);
    if (ext === undefined) return;
    pending.delete(c.id);
    start(c, ext);
  } else if (c.status === SipCallStatus.ENDED || c.status === SipCallStatus.FAILED) {
    pending.delete(c.id);
    if (run?.callId === c.id) stop();
  }
}

function start(c: LiveSipCall, ext: string): void {
  stop();
  const steps = extensionPlan(ext);
  let i = 0;
  const next = (): void => {
    const step = steps[i];
    if (!step) {
      run = null;
      return;
    }
    run = {
      callId: c.id,
      timer: setTimeout(() => {
        // Left the room or the line went away meanwhile: the rest is dropped.
        if (!sendRoomDtmf(c.roomId, step.key, c.id)) {
          run = null;
          return;
        }
        i++;
        next();
      }, step.waitMs),
    };
  };
  next();
}

function stop(): void {
  if (run) clearTimeout(run.timer);
  run = null;
}

/** Tests. */
export function resetRoomDtmf(): void {
  stop();
  pending.clear();
}
